const axios = require('axios');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { execFile, exec, spawn } = require('child_process');
const { setVolume: setVolumeManaged, toggleMute: toggleMuteManaged } = require('./volume-manager');
const { resolveDownloadFilePath } = require('./downloads');
// NOTE: Floating Lyrics detection/control cannot be done from the browser without a local helper.
// We intentionally do NOT implement server-side process detection/control.

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

function resolvePublicDir() {
    const candidates = [
        path.resolve(__dirname, 'public'),
        path.resolve(__dirname, '..', 'public'),
        path.resolve(process.cwd(), 'public')
    ];

    if (process.pkg) {
        candidates.unshift(path.resolve(path.dirname(process.execPath), 'public'));
    }

    for (const dir of candidates) {
        try {
            if (fs.existsSync(path.join(dir, 'index.html'))) {
                return dir;
            }
        } catch (_) {
            // ignore and continue
        }
    }

    return candidates[0];
}

const PUBLIC_DIR = resolvePublicDir();
const SAMPLE_DIR = path.join(PUBLIC_DIR, 'welcome', 'sample');

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

    return html
        .replace(/id="close-window-control"/g, 'id="close-dummy-control"')
        .replace(/id="close-window-btn"/g, 'id="close-dummy-btn"');
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

/**
 * Safely parse and return JSON body from the request, returning {} on parse errors.
 */
async function getJsonBody(c) {
    try {
        return await c.req.json();
    } catch (error) {
        return {};
    }
}

/**
 * Setup all application routes.
 */
function setupRoutes(app, dependencies) {
    const {
        proxyRequest,
        getClientIpFromContext,
        normalizeIpAddress,
        getRandomNameForIp,
        forceAssignNameForIp,
        logEvent,
        logAction,
        logLyricsCacheHit,
        invalidateQueueCache,
        getQueueCache,
        getQueueCacheTimestamp,
        setQueueCache,
        getVideoIdToIpMap,
        enrichQueueItemsWithIpInfo,
        fetchAllQueueItems,
        broadcastQueueUpdate,
        navigateQueue,
        navigateQueueWithConfirmation,
        broadcast,
        getLastIsPaused,
        setLastIsPaused,
        getLastVolume,
        setLastVolume,
        fetchLyrics,
        fetchLyricsCandidate,
        fetchImage,
        QUEUE_CACHE_TTL,
        VIDEO_ID_IP_MAP_MAX_SIZE
    } = dependencies;

    // Audio proxy endpoint
    app.get('/audio-proxy', async (c) => {
        try {
            const src = c.req.query('url') || c.req.query('src');
            if (!src) return c.text('Missing url parameter', 400);
            const range = c.req.header('range');
            const resp = await axios.get(src, {
                responseType: 'stream',
                headers: range ? { Range: range } : {},
                timeout: 30000
            });
            const headers = {
                'Access-Control-Allow-Origin': '*',
                'Content-Type': resp.headers['content-type'] || 'application/octet-stream',
                'Accept-Ranges': resp.headers['accept-ranges'] || 'bytes'
            };
            if (resp.headers['content-length']) headers['Content-Length'] = resp.headers['content-length'];
            if (resp.headers['content-range']) headers['Content-Range'] = resp.headers['content-range'];
            return c.body(resp.data, 200, headers);
        } catch (err) {
            console.error('audio-proxy error:', err?.message || err);
            return c.text('Proxy error', 502);
        }
    });

    // Floating Lyrics installer download endpoint (serves the newest file in ./download)
    // - /download and /downloads are both supported
    app.get('/download', async (c) => {
        try {
            const downloadDir = process.pkg ? path.join(path.dirname(process.execPath), 'download') : path.resolve('download');
            const filePath = await resolveDownloadFilePath(downloadDir);
            if (!filePath) return c.text('No files found in /download', 404);

            const fileName = path.basename(filePath);
            const ext = path.extname(fileName).toLowerCase();
            const contentType = ext === '.exe' ? 'application/octet-stream' : (MIME_TYPES[ext] || 'application/octet-stream');
            const stat = await fsp.stat(filePath);

            const stream = fs.createReadStream(filePath);
            return c.body(stream, 200, {
                'Content-Type': contentType,
                'Content-Length': String(stat.size),
                'Content-Disposition': `attachment; filename="${fileName}"`
            });
        } catch (err) {
            return c.text('Download error', 500);
        }
    });
    app.get('/downloads', (c) => app.fetch(new Request(new URL('/download', c.req.url), { method: 'GET', headers: c.req.raw.headers })));

    // Floating Lyrics detection/control is intentionally NOT implemented server-side.
    // If you want per-client control, the client machine needs a local helper (e.g. localhost API)
    // or a custom URL protocol registered by the app.

    // Stream proxy endpoint
    app.get('/stream', async (c) => {
        try {
            const targetHost = '127.0.0.1';
            const targetPort = process.env.STREAM_PORT || 8765;
            const targetUrl = `http://${targetHost}:${targetPort}/stream`;
            const upstreamResponse = await fetch(targetUrl, {
                headers: {
                    host: `${targetHost}:${targetPort}`
                }
            });
            const headers = {};
            upstreamResponse.headers.forEach((value, key) => {
                headers[key] = value;
            });
            return new Response(upstreamResponse.body, {
                status: upstreamResponse.status || 200,
                headers
            });
        } catch (error) {
            console.error('Error handling /stream proxy:', error);
            return c.text('Internal server error', 500);
        }
    });

    // Queue endpoints
    app.get('/api/v1/queue', async (c) => {
        try {
            const now = Date.now();
            const queueCache = getQueueCache();
            const queueCacheTimestamp = getQueueCacheTimestamp();
            
            if (queueCache && (now - queueCacheTimestamp) < QUEUE_CACHE_TTL) {
                return c.json(queueCache);
            }
            const result = await fetchAllQueueItems(proxyRequest);
            if (result.success) {
                result.data.items = await enrichQueueItemsWithIpInfo(result.data.items || [], getRandomNameForIp, normalizeIpAddress);
                
                // Mark the currently playing song
                try {
                    const getCurrentPlayingIndex = require('./queue-manager').getCurrentPlayingIndex;
                    const currentIndex = await getCurrentPlayingIndex(proxyRequest);
                    if (currentIndex !== null && currentIndex >= 0 && currentIndex < result.data.items.length) {
                        result.data.currentlyPlayingIndex = currentIndex;
                        if (result.data.items[currentIndex]) {
                            result.data.items[currentIndex]._isCurrentlyPlaying = true;
                        }
                    }
                } catch (e) {
                    // Ignore errors in marking current song
                }
                
                setQueueCache(result.data);
                return c.json(result.data);
            }
            if (queueCache) {
                return c.json(queueCache);
            }
            return c.json({ error: result.error }, result.status);
        } catch (error) {
            console.error('Error getting queue:', error);
            const queueCache = getQueueCache();
            if (queueCache) {
                return c.json(queueCache);
            }
            return c.json({ error: error.message }, 500);
        }
    });

    app.post('/api/v1/queue', async (c) => {
        try {
            const body = await getJsonBody(c);
            const { videoId } = body;
            if (!videoId) {
                return c.json({ error: 'videoId is required' }, 400);
            }
            const clientIp = getClientIpFromContext(c);
            const videoIdToIpMap = getVideoIdToIpMap();
            
            if (clientIp) {
                if (videoIdToIpMap.size >= VIDEO_ID_IP_MAP_MAX_SIZE) {
                    const entriesToRemove = Math.floor(VIDEO_ID_IP_MAP_MAX_SIZE * 0.2);
                    let removed = 0;
                    for (const [vidId] of videoIdToIpMap) {
                        if (removed >= entriesToRemove) break;
                        videoIdToIpMap.delete(vidId);
                        removed++;
                    }
                }
                try {
                    const normalized = normalizeIpAddress(clientIp) || clientIp;
                    const assigned = forceAssignNameForIp(normalized) || getRandomNameForIp(normalized) || normalized;
                    videoIdToIpMap.set(videoId, { ip: clientIp, timestamp: Date.now(), displayName: assigned });
                    logEvent('info', 'IP-TRACK', `Song ${videoId} added by IP: ${clientIp} (display: ${assigned}) (Map size: ${videoIdToIpMap.size})`);
                    logAction('QUEUE:ADD', `Add request received for ${videoId}`, { videoId, ip: clientIp, displayName: assigned }, getRandomNameForIp, normalizeIpAddress);
                } catch (e) {
                    videoIdToIpMap.set(videoId, { ip: clientIp, timestamp: Date.now() });
                    logEvent('warn', 'IP-TRACK', `Song ${videoId} added by IP: ${clientIp} (Map size: ${videoIdToIpMap.size})`);
                    logAction('QUEUE:ADD', `Add request received for ${videoId}`, { videoId, ip: clientIp }, getRandomNameForIp, normalizeIpAddress);
                }
            } else {
                logEvent('warn', 'IP-TRACK', `Could not extract IP for videoId ${videoId}`);
                logAction('QUEUE:ADD', `Add request (unknown IP) for ${videoId}`, { videoId }, getRandomNameForIp, normalizeIpAddress);
            }
            const result = await proxyRequest('POST', '/queue', { videoId });
            if (result.success) {
                invalidateQueueCache();
                if (result.data && result.data.items && Array.isArray(result.data.items)) {
                    result.data.items = await enrichQueueItemsWithIpInfo(result.data.items, getRandomNameForIp, normalizeIpAddress);
                    setQueueCache(result.data);
                    broadcast({ type: 'queue_updated', data: result.data, songAdded: true });
                } else {
                    setTimeout(async () => {
                        await broadcastQueueUpdate(broadcast, proxyRequest, (items) => enrichQueueItemsWithIpInfo(items, getRandomNameForIp, normalizeIpAddress), true);
                    }, 1000);
                }
                logEvent('success', 'QUEUE', `Song ${videoId} successfully added to queue`);
                return c.json(result.data);
            }
            return c.json({ error: result.error }, result.status);
        } catch (error) {
            console.error('Error adding to queue:', error);
            return c.json({ error: error.message }, 500);
        }
    });

    app.delete('/api/v1/queue/:index', async (c) => {
        try {
            const index = parseInt(c.req.param('index'));
            const clientIp = getClientIpFromContext(c);
            const result = await proxyRequest('DELETE', `/queue/${index}`, null);
            if (result.success) {
                await broadcastQueueUpdate(broadcast, proxyRequest, (items) => enrichQueueItemsWithIpInfo(items, getRandomNameForIp, normalizeIpAddress));
                logAction('QUEUE:REMOVE', `Removed queue index ${index}`, { index, ip: clientIp }, getRandomNameForIp, normalizeIpAddress);
                return c.json(result.data);
            }
            return c.json({ error: result.error }, result.status);
        } catch (error) {
            return c.json({ error: error.message }, 500);
        }
    });

    app.patch('/api/v1/queue', async (c) => {
        try {
            const body = await getJsonBody(c);
            const { index } = body;
            if (index === undefined || index === null) {
                return c.json({ error: 'index is required' }, 400);
            }
            const targetIndex = parseInt(index);
            if (isNaN(targetIndex) || targetIndex < 0) {
                return c.json({ error: 'index must be a non-negative integer' }, 400);
            }
            const result = await navigateQueue(
                proxyRequest, 
                broadcast, 
                (items) => enrichQueueItemsWithIpInfo(items, getRandomNameForIp, normalizeIpAddress),
                targetIndex
            );
            return c.json({
                message: `Navigated to queue index ${targetIndex}`,
                index: result.targetIndex,
                targetIndex: result.targetIndex,
                method: result.method,
                currentIndex: result.currentIndex
            });
        } catch (error) {
            console.error('Error navigating queue:', error);
            return c.json({ error: error.message }, 500);
        }
    });

    app.post('/api/v1/queue/jump', async (c) => {
        try {
            const body = await getJsonBody(c);
            const { index } = body;
            if (index === undefined || index === null) {
                return c.json({ error: 'index is required' }, 400);
            }
            const targetIndex = parseInt(index);
            if (isNaN(targetIndex) || targetIndex < 0) {
                return c.json({ error: 'index must be a non-negative integer' }, 400);
            }
            const result = await navigateQueue(
                proxyRequest, 
                broadcast, 
                (items) => enrichQueueItemsWithIpInfo(items, getRandomNameForIp, normalizeIpAddress),
                targetIndex
            );
            return c.json({
                message: `Jumped to queue index ${targetIndex}`,
                index: result.targetIndex,
                targetIndex: result.targetIndex,
                method: result.method,
                currentIndex: result.currentIndex
            });
        } catch (error) {
            console.error('Error jumping to queue position:', error);
            return c.json({ error: error.message }, 500);
        }
    });

    app.patch('/api/v1/queue/:index', async (c) => {
        try {
            const index = parseInt(c.req.param('index'));
            const body = await getJsonBody(c);
            const { toIndex } = body;
            const clientIp = getClientIpFromContext(c);
            const result = await proxyRequest('PATCH', `/queue/${index}`, { toIndex });
            if (result.success) {
                await broadcastQueueUpdate(broadcast, proxyRequest, (items) => enrichQueueItemsWithIpInfo(items, getRandomNameForIp, normalizeIpAddress));
                logAction('QUEUE:MOVE', `Moved item from ${index} to ${toIndex}`, { from: index, to: toIndex, ip: clientIp }, getRandomNameForIp, normalizeIpAddress);
                return c.json(result.data);
            }
            return c.json({ error: result.error }, result.status);
        } catch (error) {
            return c.json({ error: error.message }, 500);
        }
    });

    // Song endpoint
    app.get('/api/v1/song', async (c) => {
        try {
            const result = await proxyRequest('GET', '/song');
            if (result.success) {
                return c.json(result.data);
            }
            return c.json({ error: result.error }, result.status);
        } catch (error) {
            return c.json({ error: error.message }, 500);
        }
    });

    // Playback control endpoints
    app.post('/api/v1/next', async (c) => {
        try {
            const body = await getJsonBody(c);
            const steps = body.count !== undefined ? parseInt(body.count) : 1;
            if (isNaN(steps) || steps < 1) {
                return c.json({ error: 'count must be a positive integer' }, 400);
            }
            const clientIp = getClientIpFromContext(c);
            logAction('CONTROL:NEXT', `Next pressed (${steps} step(s))`, { steps, ip: clientIp }, getRandomNameForIp, normalizeIpAddress);
            const result = await navigateQueue(
                proxyRequest, 
                broadcast, 
                (items) => enrichQueueItemsWithIpInfo(items, getRandomNameForIp, normalizeIpAddress),
                null, 
                steps
            );
            return c.json({
                message: `Moved forward ${steps} step(s)`,
                steps,
                fromIndex: result.currentIndex,
                toIndex: result.targetIndex,
                method: result.method
            });
        } catch (error) {
            console.error('Error moving to next song:', error);
            return c.json({ error: error.message }, 500);
        }
    });

    app.post('/api/v1/previous', async (c) => {
        try {
            const body = await getJsonBody(c);
            const steps = body.count !== undefined ? parseInt(body.count) : 1;
            if (isNaN(steps) || steps < 1) {
                return c.json({ error: 'count must be a positive integer' }, 400);
            }
            const clientIp = getClientIpFromContext(c);
            logAction('CONTROL:PREV', `Previous pressed (${steps} step(s))`, { steps, ip: clientIp }, getRandomNameForIp, normalizeIpAddress);
            const result = await navigateQueue(
                proxyRequest, 
                broadcast, 
                (items) => enrichQueueItemsWithIpInfo(items, getRandomNameForIp, normalizeIpAddress),
                null, 
                -steps
            );
            return c.json({
                message: `Moved backward ${steps} step(s)`,
                steps,
                fromIndex: result.currentIndex,
                toIndex: result.targetIndex,
                method: result.method
            });
        } catch (error) {
            console.error('Error moving to previous song:', error);
            return c.json({ error: error.message }, 500);
        }
    });

    app.post('/api/v1/toggle-play', async (c) => {
        try {
            const clientIp = getClientIpFromContext(c);
            logAction('CONTROL:TOGGLE-PLAY', `Toggle play requested`, { ip: clientIp }, getRandomNameForIp, normalizeIpAddress);
            const result = await proxyRequest('POST', '/toggle-play');
            if (result.success) {
                const songResult = await proxyRequest('GET', '/song');
                if (songResult.success && songResult.data) {
                    setLastIsPaused(songResult.data.isPaused ?? false);
                    broadcast({ type: 'playback_updated', data: songResult.data });
                } else {
                    broadcast({ type: 'playback_updated' });
                }
                return c.json(result.data);
            }
            return c.json({ error: result.error }, result.status);
        } catch (error) {
            return c.json({ error: error.message }, 500);
        }
    });

    app.post('/api/v1/shuffle', async (c) => {
        try {
            const clientIp = getClientIpFromContext(c);
            logAction('CONTROL:SHUFFLE', `Shuffle requested`, { ip: clientIp }, getRandomNameForIp, normalizeIpAddress);
            const result = await proxyRequest('POST', '/shuffle');
            if (result.success) {
                await broadcastQueueUpdate(broadcast, proxyRequest, (items) => enrichQueueItemsWithIpInfo(items, getRandomNameForIp, normalizeIpAddress));
                return c.json(result.data);
            }
            return c.json({ error: result.error }, result.status);
        } catch (error) {
            return c.json({ error: error.message }, 500);
        }
    });

    // Volume endpoints
    app.get('/api/v1/volume', async (c) => {
        try {
            const result = await proxyRequest('GET', '/volume');
            if (result.success) {
                return c.json(result.data);
            }
            return c.json({ error: result.error }, result.status);
        } catch (error) {
            return c.json({ error: error.message }, 500);
        }
    });

    app.post('/api/v1/volume', async (c) => {
        try {
            const body = await getJsonBody(c);
            const { volume } = body;
            const clientIp = getClientIpFromContext(c);
            logAction('CONTROL:VOLUME', `Volume change requested`, { volume, ip: clientIp }, getRandomNameForIp, normalizeIpAddress);
            
            // Use volume manager for debouncing
            const result = await setVolumeManaged(volume, proxyRequest, broadcast, setLastVolume);
            
            if (result.success) {
                return c.json(result.data);
            }
            return c.json({ error: result.error }, result.status);
        } catch (error) {
            return c.json({ error: error.message }, 500);
        }
    });

    app.post('/api/v1/toggle-mute', async (c) => {
        try {
            const clientIp = getClientIpFromContext(c);
            logAction('CONTROL:TOGGLE-MUTE', `Toggle mute requested`, { ip: clientIp }, getRandomNameForIp, normalizeIpAddress);
            
            // Use volume manager
            const result = await toggleMuteManaged(proxyRequest, broadcast, setLastVolume);
            
            if (result.success) {
                return c.json(result.data);
            }
            return c.json({ error: result.error }, result.status);
        } catch (error) {
            return c.json({ error: error.message }, 500);
        }
    });

    // Legacy endpoint
    app.get('/api/v1/queue/with-ips', async (c) => {
        return c.json([]);
    });

    // Lyrics endpoint
    app.get('/api/v1/lyrics', async (c) => {
        try {
            const videoId = c.req.query('videoId');
            const artist = c.req.query('artist');
            const title = c.req.query('title');
            const album = c.req.query('album') || '';
            const duration = parseFloat(c.req.query('duration') || '0');
            const translationExcludedLanguages = String(c.req.query('translationExclude') || '')
                .split(/[,\s]+/g)
                .map((value) => value.trim().toLowerCase())
                .filter(Boolean);
            if (!videoId || !artist || !title) {
                return c.json({ error: 'Missing required parameters: videoId, artist, title' }, 400);
            }
            const result = await fetchLyrics(videoId, artist, title, album, duration, broadcast, {
                excludedLanguages: translationExcludedLanguages
            });
            if (result.success) {
                return c.json(result);
            }
            return c.json({ success: false, error: result.error || 'No lyrics found' }, 404);
        } catch (error) {
            console.error('[LYRICS] Error fetching lyrics:', error);
            return c.json({ error: error.message }, 500);
        }
    });

    app.get('/api/v1/lyrics/candidate', async (c) => {
        try {
            const videoId = c.req.query('videoId');
            const artist = c.req.query('artist');
            const title = c.req.query('title');
            const album = c.req.query('album') || '';
            const duration = parseFloat(c.req.query('duration') || '0');
            const offset = parseInt(c.req.query('offset') || '0', 10);
            const translationExcludedLanguages = String(c.req.query('translationExclude') || '')
                .split(/[,\s]+/g)
                .map((value) => value.trim().toLowerCase())
                .filter(Boolean);

            if (!videoId || !artist || !title) {
                return c.json({ error: 'Missing required parameters: videoId, artist, title' }, 400);
            }

            const result = await fetchLyricsCandidate(videoId, artist, title, album, duration, offset, broadcast, {
                excludedLanguages: translationExcludedLanguages
            });
            if (result.success) {
                return c.json(result);
            }

            return c.json({
                success: false,
                error: result.error || 'No alternate lyrics found',
                candidateOffset: result.candidateOffset ?? offset,
                totalCandidates: result.totalCandidates ?? 0
            }, 404);
        } catch (error) {
            console.error('[LYRICS] Error fetching alternate lyrics candidate:', error);
            return c.json({ error: error.message }, 500);
        }
    });

    // Image proxy endpoint
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

    // HTML pages
    app.get('/lyrics', async (c) => {
        try {
            const htmlPath = path.join(PUBLIC_DIR, 'lyrics.html');
            const html = await fsp.readFile(htmlPath, 'utf-8');
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
            console.error('Error serving welcome page:', error);
            return c.text('Error loading welcome page', 500);
        }
    });

    app.get('/', async (c) => {
        try {
            const htmlPath = path.join(PUBLIC_DIR, 'index.html');
            const html = await fsp.readFile(htmlPath, 'utf-8');
            return c.html(html);
        } catch (error) {
            console.error('Error serving index.html:', error);
            return c.text('Error loading page', 500);
        }
    });

    // Static file serving
    app.get('*', async (c) => {
        try {
            const url = new URL(c.req.url);
            if (url.pathname.startsWith('/api') || url.pathname === '/stream') {
                return c.notFound();
            }
            const requestedPath = path.join(PUBLIC_DIR, decodeURIComponent(url.pathname));
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
        } catch (error) {
            return c.notFound();
        }
    });
}

module.exports = {
    setupRoutes
};
