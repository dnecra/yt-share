const WebSocket = require('ws');

let ytMusicWs = null;
let wsReconnectTimeout = null;
let wsReconnectAttempts = 0;
const WS_RECONNECT_DELAY = 3000;
const WS_MAX_RECONNECT_DELAY = 30000;
let isWebSocketConnected = false;

let lastQueueHash = null;
let lastSongId = null;
let lastSongProgress = null;
let lastIsPaused = null;
let lastVolume = null;
let lastProgressSnapshot = null;

const PROGRESS_SMOOTHING_TOLERANCE_SECONDS = 1.25;
const PROGRESS_SEEK_RESET_THRESHOLD_SECONDS = 2.0;

const clients = new Set();

/**
 * Broadcast a JSON-serializable message to all connected WebSocket clients.
 */
function broadcast(data) {
    const message = JSON.stringify(data);
    clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(message);
        }
    });
}

function getClients() {
    return clients;
}

function isConnected() {
    return isWebSocketConnected;
}

function getLastIsPaused() {
    return lastIsPaused;
}

function setLastIsPaused(value) {
    lastIsPaused = value;
}

function getLastVolume() {
    return lastVolume;
}

function setLastVolume(value) {
    lastVolume = value;
}

function buildProgressPayload(rawData = {}, nowMs = Date.now()) {
    const source = (rawData && typeof rawData === 'object') ? rawData : {};
    const rawElapsed = Number(source.elapsedSeconds ?? source.progress);
    if (!Number.isFinite(rawElapsed)) {
        return null;
    }

    const videoId = (source.videoId || source.id || lastSongId || lastProgressSnapshot?.videoId || '').toString().trim();
    const sampledAtMs = Number.isFinite(Number(source.sampledAtMs))
        ? Number(source.sampledAtMs)
        : nowMs;
    const isPaused = source.isPaused ?? lastIsPaused ?? lastProgressSnapshot?.isPaused;

    let elapsedSeconds = Math.max(0, rawElapsed);
    const previous = lastProgressSnapshot;
    const isSameSong = !!videoId && previous?.videoId === videoId;
    const previousElapsed = Number(previous?.elapsedSeconds);
    const previousSampledAt = Number(previous?.sampledAtMs);
    const wasPlaying = previous?.isPaused === false;
    const isPlaying = isPaused === false;

    if (
        isSameSong
        && Number.isFinite(previousElapsed)
        && Number.isFinite(previousSampledAt)
        && wasPlaying
        && isPlaying
        && sampledAtMs >= previousSampledAt
    ) {
        const elapsedWallClockSeconds = Math.max(0, (sampledAtMs - previousSampledAt) / 1000);
        const expectedElapsed = previousElapsed + elapsedWallClockSeconds;
        const lagBehindExpected = expectedElapsed - elapsedSeconds;
        const regression = previousElapsed - elapsedSeconds;

        // Keep small stale/quantized updates from pulling the client backwards.
        if (
            lagBehindExpected > 0
            && lagBehindExpected <= PROGRESS_SMOOTHING_TOLERANCE_SECONDS
            && regression < PROGRESS_SEEK_RESET_THRESHOLD_SECONDS
        ) {
            elapsedSeconds = expectedElapsed;
        }
    }

    const progressData = {
        elapsedSeconds,
        songDuration: source.songDuration ?? source.duration,
        videoId: videoId || undefined,
        isPaused
    };

    progressData.sampledAtMs = sampledAtMs;

    lastProgressSnapshot = {
        videoId: videoId || previous?.videoId || '',
        elapsedSeconds,
        sampledAtMs,
        isPaused
    };

    lastSongProgress = elapsedSeconds;
    if (isPaused !== undefined) {
        lastIsPaused = isPaused;
    }

    return progressData;
}

function buildSongStatePayload(songData = {}, nowMs = Date.now()) {
    const progressData = buildProgressPayload(songData, nowMs);
    if (!progressData) {
        return songData;
    }

    return {
        ...songData,
        elapsedSeconds: progressData.elapsedSeconds,
        sampledAtMs: progressData.sampledAtMs,
        videoId: progressData.videoId || songData.videoId || songData.id,
        isPaused: progressData.isPaused
    };
}

/**
 * Establish and manage the WebSocket connection to the YouTube Music API.
 */
function connectToYouTubeMusicWS(getActiveWebSocketUrl, handleWebSocketMessage) {
    if (ytMusicWs && (ytMusicWs.readyState === WebSocket.CONNECTING || ytMusicWs.readyState === WebSocket.OPEN)) {
        return;
    }
    const wsUrl = getActiveWebSocketUrl();
    console.log(`Connecting to YouTube Music WebSocket: ${wsUrl}`);
    try {
        ytMusicWs = new WebSocket(wsUrl);
        ytMusicWs.on('open', () => {
            console.log(`Connected to YouTube Music WebSocket: ${wsUrl}`);
            isWebSocketConnected = true;
            wsReconnectAttempts = 0;
        });
        ytMusicWs.on('message', async (data) => {
            try {
                const message = JSON.parse(data.toString());
                await handleWebSocketMessage(message);
            } catch (error) {
                console.error('Error parsing WebSocket message:', error);
            }
        });
        ytMusicWs.on('error', (error) => {
            console.error('YouTube Music WebSocket error:', error.message);
            isWebSocketConnected = false;
        });
        ytMusicWs.on('close', () => {
            isWebSocketConnected = false;
            ytMusicWs = null;
            scheduleReconnect(getActiveWebSocketUrl, handleWebSocketMessage);
        });
    } catch (error) {
        console.error('Error creating WebSocket connection:', error);
        isWebSocketConnected = false;
        scheduleReconnect(getActiveWebSocketUrl, handleWebSocketMessage);
    }
}

/**
 * Close and re-establish the YouTube Music WebSocket connection immediately.
 */
function reconnectWebSocket(getActiveWebSocketUrl, handleWebSocketMessage) {
    if (ytMusicWs) {
        ytMusicWs.close();
        ytMusicWs = null;
    }
    isWebSocketConnected = false;
    wsReconnectAttempts = 0;
    if (wsReconnectTimeout) {
        clearTimeout(wsReconnectTimeout);
        wsReconnectTimeout = null;
    }
    connectToYouTubeMusicWS(getActiveWebSocketUrl, handleWebSocketMessage);
}

/**
 * Schedule a reconnect attempt with exponential backoff.
 */
function scheduleReconnect(getActiveWebSocketUrl, handleWebSocketMessage) {
    if (wsReconnectTimeout) {
        clearTimeout(wsReconnectTimeout);
    }
    const delay = Math.min(WS_RECONNECT_DELAY * Math.pow(2, wsReconnectAttempts), WS_MAX_RECONNECT_DELAY);
    wsReconnectAttempts++;
    wsReconnectTimeout = setTimeout(() => {
        connectToYouTubeMusicWS(getActiveWebSocketUrl, handleWebSocketMessage);
    }, delay);
}

/**
 * Process messages from the YouTube Music WebSocket and translate them for clients.
 */
async function handleWebSocketMessage(message, invalidateQueueCache, fetchAllQueueItems, enrichQueueItemsWithIpInfo, setQueueCache) {
    try {
        if (message.type) {
            switch (message.type) {
                case 'queue_updated':
                case 'queue':
                    invalidateQueueCache();
                    if (message.data && message.data.items && Array.isArray(message.data.items)) {
                        const queueData = message.data;
                        queueData.items = await enrichQueueItemsWithIpInfo(queueData.items || []);
                        setQueueCache(queueData);
                        broadcast({ type: 'queue_updated', data: queueData });
                        break;
                    }
                    const queueResult = await fetchAllQueueItems();
                    if (queueResult.success && queueResult.data) {
                        queueResult.data.items = await enrichQueueItemsWithIpInfo(queueResult.data.items || []);
                        setQueueCache(queueResult.data);
                        broadcast({ type: 'queue_updated', data: queueResult.data });
                    } else {
                        broadcast({ type: 'queue_updated' });
                    }
                    break;
                case 'song_updated':
                case 'song':
                case 'track_changed':
                    if (message.data) {
                        const songData = buildSongStatePayload(message.data);
                        const currentSongId = songData.videoId || songData.id;
                        if (currentSongId && currentSongId !== lastSongId) {
                            lastSongId = currentSongId;
                            lastSongProgress = songData.elapsedSeconds || 0;
                            lastIsPaused = songData.isPaused ?? false;
                            broadcast({ type: 'song_updated', data: songData });
                        }
                        const progressData = buildProgressPayload(songData);
                        if (progressData) {
                            broadcast({
                                type: 'song_progress',
                                data: progressData
                            });
                        }
                    }
                    break;
                case 'playback_updated':
                case 'playback':
                case 'playback_state':
                    if (message.data) {
                        const previousIsPaused = lastIsPaused;
                        const songData = buildSongStatePayload(message.data);
                        const currentIsPaused = songData.isPaused ?? false;
                        if (currentIsPaused !== previousIsPaused) {
                            lastIsPaused = currentIsPaused;
                            broadcast({ type: 'playback_updated', data: songData });
                        }
                        const progressData = buildProgressPayload(songData);
                        if (progressData) {
                            broadcast({
                                type: 'song_progress',
                                data: progressData
                            });
                        }
                    }
                    break;
                case 'volume_updated':
                case 'volume':
                    if (message.data) {
                        const volume = message.data.volume ?? message.data.value ?? message.data;
                        if (typeof volume === 'number') {
                            // Use volume manager to handle external updates with suppression
                            const { handleExternalVolumeUpdate } = require('./volume-manager');
                            handleExternalVolumeUpdate(volume, (v) => { lastVolume = v; }, broadcast);
                        }
                    } else if (typeof message.volume === 'number') {
                        // Use volume manager to handle external updates with suppression
                        const { handleExternalVolumeUpdate } = require('./volume-manager');
                        handleExternalVolumeUpdate(message.volume, (v) => { lastVolume = v; }, broadcast);
                    }
                    break;
                case 'progress':
                case 'song_progress':
                    if (message.data) {
                        const progressData = buildProgressPayload(message.data);
                        if (progressData) {
                            broadcast({ type: 'song_progress', data: progressData });
                        }
                    }
                    break;
                default:
                    if (message.queue !== undefined) {
                        invalidateQueueCache();
                        if (Array.isArray(message.queue)) {
                            broadcast({ type: 'queue_updated', data: { items: message.queue } });
                        } else {
                            const queueResult = await fetchAllQueueItems();
                            if (queueResult.success && queueResult.data) {
                                setQueueCache(queueResult.data);
                                broadcast({ type: 'queue_updated', data: queueResult.data });
                            } else {
                                broadcast({ type: 'queue_updated' });
                            }
                        }
                    }
                    if (message.song !== undefined || message.track !== undefined) {
                        const songData = buildSongStatePayload(message.song || message.track);
                        if (songData) {
                            const currentSongId = songData.videoId || songData.id;
                            if (currentSongId !== lastSongId) {
                                lastSongId = currentSongId;
                                broadcast({ type: 'song_updated', data: songData });
                            }
                        }
                    }
                    if (message.isPaused !== undefined) {
                        if (message.isPaused !== lastIsPaused) {
                            lastIsPaused = message.isPaused;
                            broadcast({ type: 'playback_updated', data: message });
                        }
                    }
                    if (message.volume !== undefined) {
                        if (typeof message.volume === 'number') {
                            // Use volume manager to handle external updates with suppression
                            const { handleExternalVolumeUpdate } = require('./volume-manager');
                            handleExternalVolumeUpdate(message.volume, (v) => { lastVolume = v; }, broadcast);
                        }
                    }
                    if (message.elapsedSeconds !== undefined || message.progress !== undefined) {
                        const progressData = buildProgressPayload(message);
                        if (progressData) {
                            broadcast({ type: 'song_progress', data: progressData });
                        }
                    }
                    break;
            }
        } else {
            if (message.queue !== undefined) {
                invalidateQueueCache();
                broadcast({ type: 'queue_updated' });
            }
            if (message.song !== undefined) {
                const songData = buildSongStatePayload(message.song);
                const currentSongId = songData.videoId || songData.id;
                if (currentSongId !== lastSongId) {
                    lastSongId = currentSongId;
                    broadcast({ type: 'song_updated', data: songData });
                }
            }
            if (message.elapsedSeconds !== undefined || message.progress !== undefined) {
                const progressData = buildProgressPayload(message);
                if (progressData) {
                    broadcast({ type: 'song_progress', data: progressData });
                }
            }
        }
    } catch (error) {
        console.error('Error handling WebSocket message:', error);
    }
}

module.exports = {
    broadcast,
    getClients,
    isConnected,
    getLastIsPaused,
    setLastIsPaused,
    getLastVolume,
    setLastVolume,
    buildProgressPayload,
    buildSongStatePayload,
    connectToYouTubeMusicWS,
    reconnectWebSocket,
    handleWebSocketMessage
};
