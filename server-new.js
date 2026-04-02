const { Hono } = require('hono');
const { cors } = require('hono/cors');
const http = require('http');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const axios = require('axios');
const WebSocket = require('ws');
const { WritableStream } = require('stream/web');

const { logEvent } = require('./lib/logger');
const {
    loadLyricsCacheFromDisk,
    fetchLyrics
} = require('./lib/lyrics');
const { fetchImage } = require('./lib/image-proxy');

const app = new Hono();
const PORT = process.env.PORT || 1312;
const PUBLIC_DIR = process.env.PUBLIC_DIR
    ? path.resolve(process.env.PUBLIC_DIR)
    : (process.pkg ? path.join(__dirname, 'public') : path.resolve('public'));
const SAMPLE_DIR = path.join(PUBLIC_DIR, 'welcome', 'sample');
const YT_MUSIC_API_URLS = process.env.YT_MUSIC_API_URL
    ? [process.env.YT_MUSIC_API_URL]
    : ['http://127.0.0.1:26538/api/v1'];

const MIME_TYPES = {
    '.html': 'text/html',
    '.css': 'text/css',
    '.js': 'application/javascript',
    '.webmanifest': 'application/manifest+json',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.webp': 'image/webp',
    '.webm': 'audio/webm'
};

app.use('*', cors());

const clients = new Set();
let latestSongData = null;
let activeApiUrlIndex = 0;
let lastSongSnapshot = null;
let lastProgressSecond = null;
let lastPlaybackPaused = null;

let ytMusicWs = null;
let ytMusicWsReconnectTimeout = null;
let ytMusicWsReconnectAttempts = 0;
let songPollInterval = null;
let songPollInFlight = false;
let lastPollSucceeded = false;

const API_REQUEST_TIMEOUT_MS = 5000;
const API_MIN_CALL_INTERVAL_MS = 100;
const SONG_POLL_INTERVAL_MS = 1000;
const WS_RECONNECT_BASE_DELAY_MS = 3000;
const WS_RECONNECT_MAX_DELAY_MS = 30000;

let lastApiCallTime = 0;

async function readJsonFileSafe(filePath) {
    try {
        const raw = await fsp.readFile(filePath, 'utf8');
        if (!raw.trim()) return {};
        return JSON.parse(raw);
    } catch (_) {
        return {};
    }
}

async function buildLyricsVariantHtmlFromTemplate({
    title,
    bodyClass = '',
    bodyWrapperId = '',
    stylesheetHref,
    scriptHrefs = []
}) {
    const lyricsHtmlPath = path.join(PUBLIC_DIR, 'lyrics.html');
    let html = await fsp.readFile(lyricsHtmlPath, 'utf8');

    html = html.replace(/<title>[\s\S]*?<\/title>/i, `<title>${title}</title>`);
    html = html.replace(
        /<script[^>]*type=["']module["'][^>]*src=["']scripts\/lyrics\.js(?:\?[^"']*)?["'][^>]*><\/script>\s*/i,
        ''
    );

    const headAdditions = [
        `    <link rel="stylesheet" href="${stylesheetHref}">`,
        ...scriptHrefs.map((href) => `    <script type="module" src="${href}"></script>`)
    ].join('\n');
    html = html.replace('</head>', `${headAdditions}\n  </head>`);

    if (bodyClass || bodyWrapperId) {
        const bodyOpen = bodyClass ? `<body class="${bodyClass}">` : '<body>';
        html = html.replace('<body>', bodyOpen);
        if (bodyWrapperId) {
            html = html.replace(bodyOpen, `${bodyOpen}\n    <div id="${bodyWrapperId}">`);
            html = html.replace('</body>', '    </div>\n  </body>');
        }
    }

    html = html.replace(
        '<img id="song-info-cover" class="cover" src="" alt="Album Cover">',
        '<img id="song-info-cover" class="cover" src="/icons/album-cover-placeholder.png" alt="Album Cover">'
    );
    html = html
        .replace(/id="close-window-control"/g, 'id="close-dummy-control"')
        .replace(/id="close-window-btn"/g, 'id="close-dummy-btn"');
    return html;
}

async function buildWelcomeHtmlFromLyricsTemplate() {
    return buildLyricsVariantHtmlFromTemplate({
        title: 'Welcome!',
        stylesheetHref: '/welcome/welcome-tour.css',
        scriptHrefs: [
            '/welcome/welcome-song.js',
            '/welcome/welcome-tour.js'
        ]
    });
}

function broadcast(data) {
    const message = JSON.stringify(data);
    for (const client of clients) {
        if (client.readyState === WebSocket.OPEN) {
            client.send(message);
        }
    }
}

function materializeSongDataForDispatch(songData, nowMs = Date.now()) {
    if (!songData || typeof songData !== 'object') return songData;

    const sampledAtMs = Number(songData.sampledAtMs);
    const elapsedSeconds = Number(songData.elapsedSeconds);
    const songDuration = Number(songData.songDuration);
    const isPaused = !!songData.isPaused;

    if (!Number.isFinite(sampledAtMs) || !Number.isFinite(elapsedSeconds) || isPaused) {
        return songData;
    }

    const deltaSeconds = Math.max(0, (nowMs - sampledAtMs) / 1000);
    let projectedElapsed = elapsedSeconds + deltaSeconds;
    if (Number.isFinite(songDuration) && songDuration > 0) {
        projectedElapsed = Math.min(songDuration, projectedElapsed);
    }

    return {
        ...songData,
        elapsedSeconds: projectedElapsed,
        sampledAtMs: nowMs
    };
}

function getActiveApiUrl() {
    return YT_MUSIC_API_URLS[activeApiUrlIndex];
}

function getWebSocketUrl(apiUrl = getActiveApiUrl()) {
    try {
        const url = new URL(apiUrl);
        const protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
        const basePath = url.pathname.replace(/\/+$/, '');
        const wsPath = basePath.endsWith('/ws') ? basePath : `${basePath}/ws`;
        return `${protocol}//${url.host}${wsPath}`;
    } catch (_) {
        const normalized = String(apiUrl || '').replace(/^http:/, 'ws:').replace(/^https:/, 'wss:');
        return normalized.endsWith('/ws') ? normalized : `${normalized.replace(/\/+$/, '')}/ws`;
    }
}

async function waitForApiRateLimitWindow() {
    const now = Date.now();
    const delta = now - lastApiCallTime;
    if (delta < API_MIN_CALL_INTERVAL_MS) {
        await new Promise((resolve) => setTimeout(resolve, API_MIN_CALL_INTERVAL_MS - delta));
    }
}

async function proxyApiRequest(method, endpoint, data = null, params = null) {
    await waitForApiRateLimitWindow();

    const startIndex = activeApiUrlIndex;
    for (let attempt = 0; attempt < YT_MUSIC_API_URLS.length; attempt += 1) {
        const apiUrlIndex = (startIndex + attempt) % YT_MUSIC_API_URLS.length;
        const apiUrl = YT_MUSIC_API_URLS[apiUrlIndex];

        try {
            lastApiCallTime = Date.now();
            const response = await axios({
                method,
                url: `${apiUrl}${endpoint}`,
                data: data || undefined,
                params: params || undefined,
                timeout: API_REQUEST_TIMEOUT_MS,
                headers: {
                    'Content-Type': 'application/json'
                }
            });

            if (apiUrlIndex !== activeApiUrlIndex) {
                logEvent('warn', 'YTM', `Switched API endpoint to ${apiUrl}`);
                activeApiUrlIndex = apiUrlIndex;
                reconnectYouTubeMusicWebSocket();
            }

            return {
                success: true,
                data: response.data,
                status: response.status
            };
        } catch (error) {
            const isConnectionError =
                error.code === 'ECONNREFUSED' ||
                error.code === 'ETIMEDOUT' ||
                error.code === 'ENOTFOUND' ||
                error.code === 'ECONNRESET' ||
                String(error.message || '').toLowerCase().includes('timeout');

            if (isConnectionError && attempt < YT_MUSIC_API_URLS.length - 1) {
                continue;
            }

            return {
                success: false,
                error: error.message,
                status: error.response?.status || 500,
                data: error.response?.data || null
            };
        }
    }

    return {
        success: false,
        error: 'All YouTube Music API endpoints failed',
        status: 503,
        data: null
    };
}

function normalizeSongData(input) {
    if (!input || typeof input !== 'object') return null;

    const videoId = input.videoId || input.id || null;
    if (!videoId) return null;

    const elapsedSeconds = Number(input.elapsedSeconds ?? input.progress ?? 0);
    const songDuration = Number(input.songDuration ?? input.duration ?? 0);
    const sampledAtMs = Number(input.sampledAtMs ?? input.serverReceivedAtMs ?? Date.now());

    const imageCandidates = [
        input.imageSrc,
        input.thumbnail,
        input.thumbnailUrl,
        input.albumArt,
        input.coverArt,
        input.artwork
    ];

    let imageSrc = '';
    for (const candidate of imageCandidates) {
        if (typeof candidate === 'string' && candidate.trim()) {
            imageSrc = candidate.trim();
            break;
        }
    }

    return {
        ...input,
        videoId,
        title: input.title || input.name || '',
        artist: input.artist || input.author || input.artistName || '',
        album: input.album || '',
        imageSrc,
        elapsedSeconds: Number.isFinite(elapsedSeconds) ? elapsedSeconds : 0,
        songDuration: Number.isFinite(songDuration) ? songDuration : 0,
        isPaused: !!(input.isPaused ?? input.paused ?? false),
        albumArtist: input.albumArtist || '',
        trackNumber: Number(input.trackNumber ?? 0) || 0,
        albumTrackCount: Number(input.albumTrackCount ?? 0) || 0,
        genres: Array.isArray(input.genres) ? input.genres : [],
        playbackType: input.playbackType || input.mediaType || '',
        sampledAtMs: Number.isFinite(sampledAtMs) ? sampledAtMs : Date.now()
    };
}

function maybeBroadcastSongUpdate(songData) {
    latestSongData = songData;

    const comparable = {
        videoId: songData.videoId,
        title: songData.title || '',
        artist: songData.artist || '',
        album: songData.album || '',
        imageSrc: songData.imageSrc || '',
        isPaused: !!songData.isPaused
    };

    const snapshotChanged = JSON.stringify(comparable) !== JSON.stringify(lastSongSnapshot);
    if (snapshotChanged) {
        lastSongSnapshot = comparable;
        broadcast({ type: 'song_updated', data: songData });
    }

    const progressSecond = Math.floor(Number(songData.elapsedSeconds || 0));
    if (Number.isFinite(progressSecond) && progressSecond !== lastProgressSecond) {
        lastProgressSecond = progressSecond;
        broadcast({
            type: 'song_progress',
            data: {
                elapsedSeconds: songData.elapsedSeconds,
                songDuration: songData.songDuration,
                videoId: songData.videoId,
                isPaused: !!songData.isPaused,
                sampledAtMs: songData.sampledAtMs
            }
        });
    }

    const paused = !!songData.isPaused;
    if (paused !== lastPlaybackPaused) {
        lastPlaybackPaused = paused;
        broadcast({ type: 'playback_updated', data: songData });
    }
}

function markNoActiveSong() {
    if (!latestSongData) return;

    latestSongData = {
        ...latestSongData,
        isPaused: true,
        sampledAtMs: Date.now()
    };
    lastPlaybackPaused = true;
    broadcast({ type: 'playback_updated', data: latestSongData });
}

function consumePotentialSongPayload(payload) {
    const songData = normalizeSongData({
        ...payload,
        serverReceivedAtMs: Date.now()
    });

    if (!songData) return false;
    maybeBroadcastSongUpdate(songData);
    return true;
}

async function fetchCurrentSongFromApi() {
    const result = await proxyApiRequest('GET', '/song');
    if (!result.success) {
        if (result.status === 404) {
            lastPollSucceeded = true;
            markNoActiveSong();
            return null;
        }

        if (lastPollSucceeded) {
            logEvent('warn', 'YTM', `Song poll failed: ${result.error}`);
        }
        lastPollSucceeded = false;
        return null;
    }

    lastPollSucceeded = true;
    if (!consumePotentialSongPayload(result.data)) {
        if (result.status === 204 || result.data?.hasSession === false) {
            markNoActiveSong();
        }
        return null;
    }

    return latestSongData;
}

async function pollCurrentSong() {
    if (songPollInFlight) return;
    songPollInFlight = true;
    try {
        await fetchCurrentSongFromApi();
    } finally {
        songPollInFlight = false;
    }
}

function scheduleYouTubeMusicWsReconnect() {
    if (ytMusicWsReconnectTimeout) {
        clearTimeout(ytMusicWsReconnectTimeout);
    }

    const delay = Math.min(
        WS_RECONNECT_BASE_DELAY_MS * Math.pow(2, ytMusicWsReconnectAttempts),
        WS_RECONNECT_MAX_DELAY_MS
    );
    ytMusicWsReconnectAttempts += 1;

    ytMusicWsReconnectTimeout = setTimeout(() => {
        connectToYouTubeMusicWebSocket();
    }, delay);
}

async function handleYouTubeMusicWsMessage(message) {
    if (!message || typeof message !== 'object') return;

    if (message.type === 'song_updated' || message.type === 'song' || message.type === 'track_changed') {
        consumePotentialSongPayload(message.data || message.song || message.track || message);
        return;
    }

    if (message.type === 'playback_updated' || message.type === 'playback' || message.type === 'playback_state') {
        consumePotentialSongPayload(message.data || message.song || message.track || message);
        return;
    }

    if (message.type === 'song_progress' || message.type === 'progress') {
        if (!latestSongData) return;
        const elapsedSeconds = Number(message.data?.elapsedSeconds ?? message.elapsedSeconds ?? message.progress);
        const songDuration = Number(message.data?.songDuration ?? message.songDuration ?? message.duration);
        const isPaused = message.data?.isPaused ?? message.isPaused ?? latestSongData.isPaused;

        if (!Number.isFinite(elapsedSeconds)) return;

        maybeBroadcastSongUpdate({
            ...latestSongData,
            elapsedSeconds,
            songDuration: Number.isFinite(songDuration) ? songDuration : latestSongData.songDuration,
            isPaused: !!isPaused,
            sampledAtMs: Date.now()
        });
        return;
    }

    if (message.song || message.track || message.videoId || message.id) {
        consumePotentialSongPayload(message.song || message.track || message);
        return;
    }

    if (message.hasSession === false) {
        markNoActiveSong();
    }
}

function connectToYouTubeMusicWebSocket() {
    if (ytMusicWs && (ytMusicWs.readyState === WebSocket.CONNECTING || ytMusicWs.readyState === WebSocket.OPEN)) {
        return;
    }

    const wsUrl = getWebSocketUrl();
    try {
        ytMusicWs = new WebSocket(wsUrl);

        ytMusicWs.on('open', () => {
            ytMusicWsReconnectAttempts = 0;
            logEvent('success', 'YTM', `Connected to WebSocket ${wsUrl}`);
        });

        ytMusicWs.on('message', async (raw) => {
            try {
                const message = JSON.parse(raw.toString());
                await handleYouTubeMusicWsMessage(message);
            } catch (error) {
                logEvent('error', 'YTM', `Invalid WebSocket payload: ${error.message}`);
            }
        });

        ytMusicWs.on('close', () => {
            ytMusicWs = null;
            logEvent('warn', 'YTM', 'WebSocket disconnected');
            scheduleYouTubeMusicWsReconnect();
        });

        ytMusicWs.on('error', (error) => {
            logEvent('error', 'YTM', `WebSocket error: ${error.message}`);
        });
    } catch (error) {
        ytMusicWs = null;
        logEvent('error', 'YTM', `Failed to connect WebSocket: ${error.message}`);
        scheduleYouTubeMusicWsReconnect();
    }
}

function reconnectYouTubeMusicWebSocket() {
    if (ytMusicWsReconnectTimeout) {
        clearTimeout(ytMusicWsReconnectTimeout);
        ytMusicWsReconnectTimeout = null;
    }

    ytMusicWsReconnectAttempts = 0;

    if (ytMusicWs) {
        ytMusicWs.removeAllListeners();
        try {
            ytMusicWs.close();
        } catch (_) {}
        ytMusicWs = null;
    }

    connectToYouTubeMusicWebSocket();
}

function startSongPolling() {
    if (songPollInterval) return;
    songPollInterval = setInterval(() => {
        pollCurrentSong().catch((error) => {
            logEvent('error', 'YTM', `Polling error: ${error.message}`);
        });
    }, SONG_POLL_INTERVAL_MS);
}

app.get('/api/v1/song', async (c) => {
    try {
        if (latestSongData) {
            return c.json(materializeSongDataForDispatch(latestSongData));
        }

        const songData = await fetchCurrentSongFromApi();
        if (songData) {
            return c.json(materializeSongDataForDispatch(songData));
        }

        return c.json({ error: 'No active YouTube Music session' }, 404);
    } catch (error) {
        return c.json({ error: error.message }, 500);
    }
});

app.get('/api/v1/lyrics', async (c) => {
    try {
        const videoId = c.req.query('videoId');
        const artist = c.req.query('artist');
        const title = c.req.query('title');
        const album = c.req.query('album') || '';
        const duration = parseFloat(c.req.query('duration') || '0');

        if (!videoId || !artist || !title) {
            return c.json({ error: 'Missing required parameters: videoId, artist, title' }, 400);
        }

        const result = await fetchLyrics(videoId, artist, title, album, duration, broadcast);
        if (result.success) {
            return c.json(result);
        }

        return c.json({ success: false, error: result.error || 'No lyrics found' }, 404);
    } catch (error) {
        console.error('[LYRICS] Error fetching lyrics:', error);
        return c.json({ error: error.message }, 500);
    }
});

app.get('/api/v1/image-proxy', async (c) => {
    try {
        const imageUrl = c.req.query('url');
        if (!imageUrl) {
            return c.json({ error: 'URL parameter is required' }, 400);
        }

        const result = await fetchImage(imageUrl);
        c.header('Content-Type', result.contentType || 'image/jpeg');
        c.header('Cache-Control', 'public, max-age=3600');
        c.header('Content-Length', String(result.data.length));
        return c.body(result.data);
    } catch (error) {
        console.error('Error in image proxy:', error);
        return c.json({
            error: 'Failed to fetch image',
            message: error.message
        }, error.response?.status || 500);
    }
});

app.get('/api/v1/welcome-sample', async (c) => {
    try {
        const [lyricPayload, songPayload] = await Promise.all([
            readJsonFileSafe(path.join(SAMPLE_DIR, 'lyric-sample.json')),
            readJsonFileSafe(path.join(SAMPLE_DIR, 'song-info-sample.json'))
        ]);

        const lyricsData = lyricPayload?.data || lyricPayload || {};
        const songInfoData = songPayload?.data || songPayload || {};

        return c.json({
            success: true,
            data: {
                songInfo: songInfoData,
                lyrics: lyricsData,
                audio: {
                    src: '/sample/audio-sample.webm',
                    serverStartedAtMs: Date.now()
                }
            }
        });
    } catch (error) {
        return c.json({ success: false, error: error.message }, 500);
    }
});

app.get('/lyrics', async (c) => {
    try {
        const html = await fsp.readFile(path.join(PUBLIC_DIR, 'lyrics.html'), 'utf8');
        return c.html(html);
    } catch (error) {
        console.error('Error serving lyrics.html:', error);
        return c.text('Error loading lyrics page', 500);
    }
});

app.get('/welcome', async (c) => {
    try {
        const html = await buildWelcomeHtmlFromLyricsTemplate();
        return c.html(html);
    } catch (error) {
        console.error('Error serving welcome.html:', error);
        return c.text('Error loading welcome page', 500);
    }
});

app.get('/', (c) => c.redirect('/lyrics'));

app.get('*', async (c) => {
    try {
        const url = new URL(c.req.url);
        if (url.pathname.startsWith('/api')) {
            return c.notFound();
        }

        const relativePath = decodeURIComponent(url.pathname).replace(/^\/+/, '');
        const requestedPath = path.resolve(PUBLIC_DIR, relativePath);

        if (!requestedPath.startsWith(PUBLIC_DIR)) {
            return c.text('Forbidden', 403);
        }

        const stats = await fsp.stat(requestedPath);
        if (!stats.isFile()) {
            return c.notFound();
        }

        const ext = path.extname(requestedPath).toLowerCase();
        const file = await fsp.readFile(requestedPath);
        c.header('Content-Type', MIME_TYPES[ext] || 'application/octet-stream');
        return c.body(file);
    } catch (_) {
        return c.notFound();
    }
});

function createNodeRequest(req) {
    const protocol = req.socket.encrypted ? 'https' : 'http';
    const host = req.headers.host || '127.0.0.1';
    const url = `${protocol}://${host}${req.url}`;

    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
        if (value === undefined) continue;
        if (Array.isArray(value)) {
            for (const entry of value) {
                if (entry !== undefined) {
                    headers.append(key, entry);
                }
            }
        } else {
            headers.set(key, value);
        }
    }

    const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
    const init = {
        method: req.method,
        headers,
        body: hasBody ? req : undefined
    };

    if (hasBody) {
        init.duplex = 'half';
    }

    return new Request(url, init);
}

const server = http.createServer((req, res) => {
    app.fetch(createNodeRequest(req))
        .then((response) => {
            const responseHeaders = Object.fromEntries(response.headers.entries());
            res.writeHead(response.status, responseHeaders);

            if (!response.body) {
                res.end();
                return;
            }

            response.body.pipeTo(new WritableStream({
                write(chunk) {
                    res.write(Buffer.from(chunk));
                },
                close() {
                    res.end();
                },
                abort(err) {
                    console.error('Response stream aborted:', err);
                    res.end();
                }
            })).catch((error) => {
                console.error('Error piping response:', error);
                res.end();
            });
        })
        .catch((error) => {
            console.error('Error handling request:', error);
            if (!res.headersSent) {
                res.writeHead(500, { 'Content-Type': 'text/plain' });
            }
            res.end('Internal Server Error');
        });
});

const wss = new WebSocket.Server({ server });

function sendLatestStateToClient(client) {
    if (!client || client.readyState !== WebSocket.OPEN || !latestSongData) return;

    client.send(JSON.stringify({
        type: 'song_updated',
        data: materializeSongDataForDispatch(latestSongData)
    }));
}

wss.on('connection', (ws, req) => {
    if (req.url && !req.url.startsWith('/ws')) {
        ws.close(1008, 'Unsupported websocket endpoint');
        return;
    }

    clients.add(ws);
    logEvent('info', 'WS', `Client connected (${clients.size} total)`);
    sendLatestStateToClient(ws);

    ws.on('message', () => {
        // Lyrics page does not send control commands.
    });

    ws.on('close', () => {
        clients.delete(ws);
        logEvent('info', 'WS', `Client disconnected (${clients.size} total)`);
    });

    ws.on('error', () => {
        clients.delete(ws);
    });
});

loadLyricsCacheFromDisk().catch(() => {});

server.listen(PORT, () => {
    logEvent('success', 'SERVER', `Lyrics server running on http://127.0.0.1:${PORT}/lyrics`);
    logEvent('info', 'SERVER', `YouTube Music API endpoints: ${YT_MUSIC_API_URLS.join(', ')}`);
    logEvent('info', 'SERVER', `Active API endpoint: ${getActiveApiUrl()}`);
    logEvent('info', 'SERVER', `YouTube Music WebSocket: ${getWebSocketUrl()}`);
    connectToYouTubeMusicWebSocket();
    startSongPolling();
    pollCurrentSong().catch((error) => {
        logEvent('error', 'YTM', `Initial song fetch failed: ${error.message}`);
    });
});
