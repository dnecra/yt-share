let isPolling = false;
let isPlaybackPolling = false;
let isProgressPolling = false;
let isVolumePolling = false;
let isQueuePolling = false;
const { buildProgressPayload, buildSongStatePayload } = require('./websocket');

let lastPollTime = 0;
let lastPlaybackPollTime = 0;
let lastProgressPollTime = 0;
let lastVolumePollTime = 0;
let lastQueuePollTime = 0;

const MIN_POLL_INTERVAL = 500;
const POLL_INTERVAL = 10000;
const PLAYBACK_POLL_INTERVAL = 5000;
const PROGRESS_BROADCAST_INTERVAL = 1000;
const VOLUME_POLL_MIN_INTERVAL = 1000; // Increased from 500ms
const VOLUME_POLL_INTERVAL_WS = 10000; // Increased from 5000ms
const VOLUME_POLL_INTERVAL_FALLBACK = 15000;
const QUEUE_POLL_INTERVAL = 2000;
const QUEUE_POLL_MIN_INTERVAL = 2000;

let lastQueueHash = null;

function buildQueueSignature(queueData) {
    if (!queueData || typeof queueData !== 'object') {
        return 'invalid';
    }
    const items = Array.isArray(queueData.items) ? queueData.items : [];
    const ids = new Array(items.length);
    for (let i = 0; i < items.length; i++) {
        const item = items[i];
        const song = item?.playlistPanelVideoRenderer;
        const videoId = song?.videoId || item?.videoId || item?.id || '';
        const selected = song?.selected === true ? '1' : '0';
        ids[i] = `${videoId}:${selected}`;
    }
    const total = queueData.totalItems ?? items.length;
    const current = Number.isInteger(queueData.currentlyPlayingIndex) ? queueData.currentlyPlayingIndex : -1;
    return `${total}|${current}|${ids.join(',')}`;
}

/**
 * Poll backend endpoints for queue/song updates when WebSocket is unavailable.
 */
async function pollForUpdates(isWebSocketConnected, fetchAllQueueItems, proxyRequest, broadcast, setQueueCache, getLastIsPaused, setLastIsPaused) {
    if (isWebSocketConnected()) {
        return;
    }
    if (isPolling) {
        return;
    }
    const now = Date.now();
    if (now - lastPollTime < MIN_POLL_INTERVAL) {
        return;
    }
    isPolling = true;
    lastPollTime = now;
    try {
        const queueResult = await fetchAllQueueItems();
        if (queueResult.success) {
            const queueHash = buildQueueSignature(queueResult.data);
            if (queueHash !== lastQueueHash) {
                lastQueueHash = queueHash;
                setQueueCache(queueResult.data);
                broadcast({ type: 'queue_updated' });
            }
        }
        const songResult = await proxyRequest('GET', '/song');
        if (songResult.success && songResult.data) {
            const previousIsPaused = getLastIsPaused();
            const songData = buildSongStatePayload({
                ...songResult.data,
                sampledAtMs: Date.now()
            });
            const currentIsPaused = songData.isPaused ?? false;
            if (currentIsPaused !== previousIsPaused) {
                setLastIsPaused(currentIsPaused);
                broadcast({ type: 'playback_updated', data: songData });
            }
        }
    } catch (error) {
        console.error('Error polling for updates:', error);
    } finally {
        isPolling = false;
    }
}

/**
 * Poll for playback state changes.
 */
async function pollPlayback(isWebSocketConnected, proxyRequest, broadcast, getLastIsPaused, setLastIsPaused) {
    if (isWebSocketConnected()) {
        return;
    }
    if (isPlaybackPolling) {
        return;
    }
    const now = Date.now();
    if (now - lastPlaybackPollTime < 500) {
        return;
    }
    isPlaybackPolling = true;
    lastPlaybackPollTime = now;
    try {
        const songResult = await proxyRequest('GET', '/song');
        if (songResult.success && songResult.data) {
            const previousIsPaused = getLastIsPaused();
            const songData = buildSongStatePayload({
                ...songResult.data,
                sampledAtMs: Date.now()
            });
            const currentIsPaused = songData.isPaused ?? false;
            if (currentIsPaused !== previousIsPaused) {
                setLastIsPaused(currentIsPaused);
                broadcast({ type: 'playback_updated', data: songData });
            }
        }
    } catch (error) {
    } finally {
        isPlaybackPolling = false;
    }
}

/**
 * Poll for song progress updates.
 */
async function pollProgress(isWebSocketConnected, proxyRequest, broadcast, getLastIsPaused, setLastIsPaused) {
    if (!isWebSocketConnected()) {
        return;
    }
    if (isProgressPolling) {
        return;
    }
    const now = Date.now();
    if (now - lastProgressPollTime < PROGRESS_BROADCAST_INTERVAL) {
        return;
    }
    isProgressPolling = true;
    lastProgressPollTime = now;
    try {
        const songResult = await proxyRequest('GET', '/song');
        if (songResult.success && songResult.data) {
            const previousIsPaused = getLastIsPaused();
            const sampledAtMs = Date.now();
            const songData = buildSongStatePayload({
                ...songResult.data,
                sampledAtMs
            });
            const currentSongId = songData.videoId;
            const currentIsPaused = songData.isPaused ?? false;
            const currentProgress = songData.elapsedSeconds;
            const progressData = buildProgressPayload({
                ...songData,
                videoId: currentSongId,
                elapsedSeconds: currentProgress,
                isPaused: currentIsPaused,
                sampledAtMs
            });
            if (currentSongId && !currentIsPaused && progressData) {
                broadcast({
                    type: 'song_progress',
                    data: progressData
                });
            }
            if (currentIsPaused !== previousIsPaused) {
                setLastIsPaused(currentIsPaused);
                broadcast({ type: 'playback_updated', data: songData });
            }
        }
    } catch (error) {
    } finally {
        isProgressPolling = false;
    }
}

/**
 * Poll current volume periodically and broadcast changes.
 * Uses a tolerance threshold to avoid broadcasting tiny fluctuations.
 */
async function pollVolume(proxyRequest, broadcast, isWebSocketConnected, getLastVolume, setLastVolume) {
    if (isVolumePolling) {
        return;
    }
    const now = Date.now();
    const pollInterval = isWebSocketConnected() ? VOLUME_POLL_INTERVAL_WS : VOLUME_POLL_INTERVAL_FALLBACK;
    if (now - lastVolumePollTime < VOLUME_POLL_MIN_INTERVAL) {
        return;
    }
    if (now - lastVolumePollTime < pollInterval) {
        return;
    }
    isVolumePolling = true;
    lastVolumePollTime = now;
    try {
        const volumeResult = await proxyRequest('GET', '/volume');
        if (volumeResult.success && volumeResult.data) {
            const currentVolume = volumeResult.data?.volume ?? volumeResult.data?.state ?? volumeResult.data?.value;
            if (typeof currentVolume === 'number') {
                // Use volume manager to handle external updates with suppression
                const { handleExternalVolumeUpdate } = require('./volume-manager');
                handleExternalVolumeUpdate(currentVolume, setLastVolume, broadcast);
            }
        }
    } catch (error) {
    } finally {
        isVolumePolling = false;
    }
}

/**
 * Periodically poll the queue and broadcast when its contents change.
 */
async function pollQueueForChanges(fetchAllQueueItems, broadcastQueueUpdate) {
    if (isQueuePolling) {
        return;
    }
    const now = Date.now();
    if (now - lastQueuePollTime < QUEUE_POLL_MIN_INTERVAL) {
        return;
    }
    isQueuePolling = true;
    lastQueuePollTime = now;
    try {
        const queueResult = await fetchAllQueueItems();
        if (queueResult.success && queueResult.data) {
            const currentQueueHash = buildQueueSignature(queueResult.data);
            if (currentQueueHash !== lastQueueHash) {
                lastQueueHash = currentQueueHash;
                await broadcastQueueUpdate();
            }
        }
    } catch (error) {
        console.error('Error polling queue for changes:', error);
    } finally {
        isQueuePolling = false;
    }
}

/**
 * Start all polling intervals.
 */
function startPolling(dependencies) {
    const {
        isWebSocketConnected,
        fetchAllQueueItems,
        proxyRequest,
        broadcast,
        setQueueCache,
        getLastIsPaused,
        setLastIsPaused,
        getLastVolume,
        setLastVolume,
        broadcastQueueUpdate
    } = dependencies;

    let lastMainRun = 0;
    let lastPlaybackRun = 0;
    let lastProgressRun = 0;
    let lastVolumeRun = 0;
    let lastQueueRun = 0;

    // Single scheduler to reduce timer wakeups and closure overhead.
    setInterval(async () => {
        const now = Date.now();

        if (now - lastMainRun >= POLL_INTERVAL) {
            lastMainRun = now;
            await pollForUpdates(isWebSocketConnected, fetchAllQueueItems, proxyRequest, broadcast, setQueueCache, getLastIsPaused, setLastIsPaused);
        }

        if (now - lastPlaybackRun >= PLAYBACK_POLL_INTERVAL) {
            lastPlaybackRun = now;
            await pollPlayback(isWebSocketConnected, proxyRequest, broadcast, getLastIsPaused, setLastIsPaused);
        }

        if (now - lastProgressRun >= PROGRESS_BROADCAST_INTERVAL) {
            lastProgressRun = now;
            await pollProgress(isWebSocketConnected, proxyRequest, broadcast, getLastIsPaused, setLastIsPaused);
        }

        if (now - lastVolumeRun >= VOLUME_POLL_INTERVAL_WS) {
            lastVolumeRun = now;
            await pollVolume(proxyRequest, broadcast, isWebSocketConnected, getLastVolume, setLastVolume);
        }

        if (now - lastQueueRun >= QUEUE_POLL_INTERVAL) {
            lastQueueRun = now;
            await pollQueueForChanges(fetchAllQueueItems, broadcastQueueUpdate);
        }
    }, 1000);
}

module.exports = {
    pollForUpdates,
    pollPlayback,
    pollProgress,
    pollVolume,
    pollQueueForChanges,
    startPolling
};
