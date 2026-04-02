const { Hono } = require('hono');
const { cors } = require('hono/cors');
const http = require('http');
const WebSocket = require('ws');
const { WritableStream } = require('stream/web');

// Import all modules
const { LOG_COLORS, logEvent, logOnce, logAction, logLyricsCacheHit } = require('./lib/logger');
const { 
    normalizeIpAddress, 
    getClientIpFromContext, 
    getRandomNameForIp, 
    forceAssignNameForIp,
    startRotation: startIpRotation 
} = require('./lib/ip-manager');
const { 
    getActiveApiUrl, 
    getActiveWebSocketUrl, 
    proxyRequest, 
    setApiUrlChangeCallback,
    YT_MUSIC_API_URLS 
} = require('./lib/youtube-api');
const {
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
    startVideoIdCleanup,
    QUEUE_CACHE_TTL,
    VIDEO_ID_IP_MAP_MAX_SIZE
} = require('./lib/queue-manager');
const {
    broadcast,
    getClients,
    isConnected: isWebSocketConnected,
    getLastIsPaused,
    setLastIsPaused,
    getLastVolume,
    setLastVolume,
    connectToYouTubeMusicWS,
    reconnectWebSocket,
    handleWebSocketMessage: handleYtMusicWebSocketMessage
} = require('./lib/websocket');
const {
    loadLyricsCacheFromDisk,
    fetchLyrics
} = require('./lib/lyrics');
const { fetchImage } = require('./lib/image-proxy');
// Floating Lyrics process detection/control is handled server-side (local machine).
const { startPolling } = require('./lib/polling');
const { setupRoutes } = require('./lib/routes');
const { setVolume: setVolumeManaged, toggleMute: toggleMuteManaged } = require('./lib/volume-manager');

const app = new Hono();
const PORT = process.env.PORT || 80;

// Apply CORS middleware
app.use('*', cors());

// Setup routes with all dependencies
setupRoutes(app, {
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
    fetchImage,
    QUEUE_CACHE_TTL,
    VIDEO_ID_IP_MAP_MAX_SIZE
});

// SWYH Launcher routes
const swyhLauncher = require('./lib/swyh-launcher');

app.post('/launch-swyh', async (c) => {
    try {
        let body = {};
        try { body = await c.req.json(); } catch (e) {}
        const executablePath = body && body.executablePath ? body.executablePath : 'C:\\Program Files\\swyh-rs\\swyh-rs.exe';
        if (!executablePath.endsWith('swyh-rs.exe')) {
            return c.json({ success: false, message: 'Invalid executable path' }, 400);
        }

        const running = await swyhLauncher.isRunning();
        if (running) {
            return c.json({ success: true, message: 'SWYH-RS is already running' });
        }

        const result = await swyhLauncher.launchWithExec(executablePath);
        if (!result.success) {
            return c.json({ success: false, message: result.error || 'Failed to launch' }, 500);
        }

        return c.json({ success: true, message: 'SWYH-RS launched successfully' });
    } catch (error) {
        console.error('Error in /launch-swyh:', error);
        return c.json({ success: false, message: error.message || 'Internal error' }, 500);
    }
});

app.post('/launch-swyh-spawn', async (c) => {
    try {
        let body = {};
        try { body = await c.req.json(); } catch (e) {}
        const executablePath = body && body.executablePath ? body.executablePath : 'C:\\Program Files\\swyh-rs\\swyh-rs.exe';
        if (!executablePath.endsWith('swyh-rs.exe')) {
            return c.json({ success: false, message: 'Invalid executable path' }, 400);
        }

        const running = await swyhLauncher.isRunning();
        if (running) {
            return c.json({ success: true, message: 'SWYH-RS is already running' });
        }

        const result = await swyhLauncher.launchWithSpawn(executablePath);
        if (!result.success) {
            return c.json({ success: false, message: result.error || 'Failed to spawn' }, 500);
        }

        return c.json({ success: true, message: 'SWYH-RS launched successfully', pid: result.pid });
    } catch (error) {
        console.error('Error in /launch-swyh-spawn:', error);
        return c.json({ success: false, message: error.message || 'Internal error' }, 500);
    }
});

function createNodeRequest(req) {
    const protocol = req.socket.encrypted ? 'https' : 'http';
    const host = req.headers.host || 'localhost';
    const url = `${protocol}://${host}${req.url}`;
    const headers = new Headers();

    for (const [key, value] of Object.entries(req.headers)) {
        if (value === undefined) {
            continue;
        }
        if (Array.isArray(value)) {
            value.forEach((entry) => {
                if (entry !== undefined) {
                    headers.append(key, entry);
                }
            });
        } else {
            headers.set(key, value);
        }
    }

    const remoteAddress = req.socket?.remoteAddress;
    if (remoteAddress) {
        if (!headers.has('x-forwarded-for')) {
            headers.set('x-forwarded-for', remoteAddress);
        }
        if (!headers.has('x-real-ip')) {
            headers.set('x-real-ip', remoteAddress);
        }
    }

    const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
    const requestInit = {
        method: req.method,
        headers,
        body: hasBody ? req : undefined
    };

    if (hasBody) {
        requestInit.duplex = 'half';
    }

    return new Request(url, requestInit);
}

// Create HTTP server
const server = http.createServer((req, res) => {
    app.fetch(createNodeRequest(req))
        .then((response) => {
            const responseHeaders = Object.fromEntries(response.headers.entries());
            res.writeHead(response.status, responseHeaders);
            if (response.body) {
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
            } else {
                res.end();
            }
        })
        .catch((error) => {
            console.error('Error handling request:', error);
            if (!res.headersSent) {
                res.writeHead(500, { 'Content-Type': 'text/plain' });
            }
            res.end('Internal Server Error');
        });
});

// Setup WebSocket server for client connections
const wss = new WebSocket.Server({ server });
wss.on('connection', (ws, req) => {
    const rawForward = req.headers['x-forwarded-for'];
    const clientIpSource = rawForward ? rawForward.split(',')[0].trim() : req.socket.remoteAddress;
    const clientIp = clientIpSource || 'unknown';
    const clientDisplay = getRandomNameForIp(normalizeIpAddress(clientIp)) || clientIp;
    const displayColored = `${LOG_COLORS.success}${clientDisplay}${LOG_COLORS.reset}`;
    const ipColored = `${LOG_COLORS.info}${clientIp}${LOG_COLORS.reset}`;
    logEvent('info', 'WS', `WebSocket client connected from ${displayColored} (${ipColored})`);
    
    const clients = getClients();
    clients.add(ws);
    
    ws.on('message', async (data) => {
        try {
            const message = JSON.parse(data.toString());
            if (message.type === 'navigate_queue' || message.type === 'jump_to_index') {
                const targetIndex = message.index !== undefined ? parseInt(message.index) : null;
                const relativeSteps = message.steps !== undefined ? parseInt(message.steps) : null;
                if (targetIndex === null && relativeSteps === null) {
                    ws.send(JSON.stringify({
                        type: 'navigation_error',
                        error: 'Either index or steps must be provided'
                    }));
                    return;
                }
                try {
                    const result = await navigateQueueWithConfirmation(
                        ws, 
                        proxyRequest, 
                        broadcast, 
                        (items) => enrichQueueItemsWithIpInfo(items, getRandomNameForIp, normalizeIpAddress),
                        targetIndex, 
                        relativeSteps
                    );
                    ws.send(JSON.stringify({
                        type: 'navigation_success',
                        data: result
                    }));
                } catch (error) {
                    ws.send(JSON.stringify({
                        type: 'navigation_error',
                        error: error.message
                    }));
                }
            } else if (message.type === 'set_volume' || message.type === 'volume') {
                const volume = message.volume !== undefined ? parseInt(message.volume) : null;
                if (volume === null || isNaN(volume) || volume < 0 || volume > 100) {
                    ws.send(JSON.stringify({
                        type: 'volume_error',
                        error: 'Volume must be a number between 0 and 100'
                    }));
                    return;
                }
                try {
                    // Use volume manager for debouncing
                    const result = await setVolumeManaged(volume, proxyRequest, broadcast, setLastVolume);
                    if (result.success) {
                        ws.send(JSON.stringify({
                            type: 'volume_success',
                            data: { volume: result.data?.volume ?? result.data?.state ?? result.data?.value ?? volume }
                        }));
                    } else {
                        ws.send(JSON.stringify({
                            type: 'volume_error',
                            error: result.error || 'Failed to set volume'
                        }));
                    }
                } catch (error) {
                    ws.send(JSON.stringify({
                        type: 'volume_error',
                        error: error.message
                    }));
                }
            } else if (message.type === 'toggle_mute' || message.type === 'toggle-mute') {
                try {
                    // Use volume manager
                    const result = await toggleMuteManaged(proxyRequest, broadcast, setLastVolume);
                    if (result.success) {
                        ws.send(JSON.stringify({
                            type: 'volume_success',
                            data: {}
                        }));
                    } else {
                        ws.send(JSON.stringify({
                            type: 'volume_error',
                            error: result.error || 'Failed to toggle mute'
                        }));
                    }
                } catch (error) {
                    ws.send(JSON.stringify({
                        type: 'volume_error',
                        error: error.message
                    }));
                }
            }
        } catch (error) {
            console.error('Error handling client WebSocket message:', error);
        }
    });
    
    ws.on('close', () => {
        logEvent('info', 'WS', `WebSocket client disconnected from ${clientIp}`);
        clients.delete(ws);
    });
    
    ws.on('error', (error) => {
        console.error('WebSocket error:', error);
        clients.delete(ws);
    });
});

// Wrapper for handleWebSocketMessage with dependencies
async function handleWebSocketMessageWrapper(message) {
    await handleYtMusicWebSocketMessage(
        message,
        invalidateQueueCache,
        async () => fetchAllQueueItems(proxyRequest),
        async (items) => enrichQueueItemsWithIpInfo(items, getRandomNameForIp, normalizeIpAddress),
        setQueueCache
    );
}

// Set up API URL change callback to reconnect WebSocket
setApiUrlChangeCallback(() => {
    reconnectWebSocket(getActiveWebSocketUrl, handleWebSocketMessageWrapper);
});

// Start all background tasks
startIpRotation();
startVideoIdCleanup();

// Load lyrics cache
loadLyricsCacheFromDisk().catch(() => {});

// Start polling
startPolling({
    isWebSocketConnected,
    fetchAllQueueItems: async () => fetchAllQueueItems(proxyRequest),
    proxyRequest,
    broadcast,
    setQueueCache,
    getLastIsPaused,
    setLastIsPaused,
    getLastVolume,
    setLastVolume,
    broadcastQueueUpdate: async () => broadcastQueueUpdate(
        broadcast, 
        proxyRequest, 
        async (items) => enrichQueueItemsWithIpInfo(items, getRandomNameForIp, normalizeIpAddress)
    ),
    extractVideoIdFromItem: require('./lib/queue-manager').extractVideoIdFromItem
});

// Start server
server.listen(PORT, () => {
    logEvent('success', 'SERVER', `Server running on http://localhost:${PORT}`);
    logEvent('info', 'SERVER', `YouTube Music API URLs: ${YT_MUSIC_API_URLS.join(', ')}`);
    logEvent('info', 'SERVER', `Active API: ${getActiveApiUrl()}`);
    logEvent('info', 'SERVER', `YouTube Music WebSocket: ${getActiveWebSocketUrl()}`);
    connectToYouTubeMusicWS(getActiveWebSocketUrl, handleWebSocketMessageWrapper);
});
