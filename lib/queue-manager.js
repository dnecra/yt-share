const { logEvent } = require('./logger');

let queueCache = null;
let queueCacheTimestamp = 0;
const QUEUE_CACHE_TTL = 500;
let isNavigating = false;

const videoIdToIpMap = new Map();
const VIDEO_ID_IP_MAP_MAX_SIZE = 1000;
const VIDEO_ID_IP_MAP_TTL = 24 * 60 * 60 * 1000;

function invalidateQueueCache() {
    queueCache = null;
    queueCacheTimestamp = 0;
}

function getQueueCache() {
    return queueCache;
}

function getQueueCacheTimestamp() {
    return queueCacheTimestamp;
}

function setQueueCache(data) {
    queueCache = data;
    queueCacheTimestamp = Date.now();
}

function getVideoIdToIpMap() {
    return videoIdToIpMap;
}

/**
 * Recursively search an object for a YouTube videoId or id field.
 */
function findVideoIdRecursive(obj, depth = 0, maxDepth = 5) {
    if (!obj || typeof obj !== 'object' || depth > maxDepth) {
        return null;
    }
    if (obj.videoId && typeof obj.videoId === 'string' && obj.videoId.length > 0) {
        return obj.videoId;
    }
    if (obj.id && typeof obj.id === 'string' && obj.id.length === 11) {
        return obj.id;
    }
    for (const key in obj) {
        if (obj.hasOwnProperty(key) && typeof obj[key] === 'object') {
            const found = findVideoIdRecursive(obj[key], depth + 1, maxDepth);
            if (found) {
                return found;
            }
        }
    }
    return null;
}

/**
 * Extract a videoId from common item shapes (with several fallback paths).
 */
function extractVideoIdFromItem(item) {
    if (!item || typeof item !== 'object') {
        return null;
    }
    const commonPaths = [
        item.playlistPanelVideoRenderer?.videoId,
        item.videoId,
        item.id,
        item.playlistPanelVideoRenderer?.navigationEndpoint?.watchEndpoint?.videoId,
        item.content?.playlistPanelVideoRenderer?.videoId,
        item.content?.videoId
    ];
    for (const videoId of commonPaths) {
        if (videoId && typeof videoId === 'string' && videoId.length > 0) {
            return videoId;
        }
    }
    return findVideoIdRecursive(item);
}

/**
 * Enrich queue items with tracked IP information for display purposes.
 */
async function enrichQueueItemsWithIpInfo(queueItems, getRandomNameForIp, normalizeIpAddress) {
    if (!Array.isArray(queueItems)) {
        return queueItems;
    }
    let enrichedCount = 0;
    let totalItems = queueItems.length;
    const enriched = queueItems.map((item, index) => {
        const videoId = extractVideoIdFromItem(item);
        if (!videoId) {
            return item;
        }
        const ipData = videoIdToIpMap.get(videoId);
        const ipAddress = ipData && typeof ipData === 'object' ? ipData.ip : ipData;
        if (ipData && typeof ipData === 'object' && ipData.timestamp) {
            const now = Date.now();
            if (now - ipData.timestamp > VIDEO_ID_IP_MAP_TTL) {
                videoIdToIpMap.delete(videoId);
                return item;
            }
        }
        if (ipAddress) {
            const normalized = normalizeIpAddress(ipAddress) || ipAddress;
            const display = (ipData && ipData.displayName) || getRandomNameForIp(normalized) || ipAddress;
            const ipInfo = {
                ip: ipAddress,
                hostname: display
            };
            item._ipInfo = ipInfo;
            if (item.playlistPanelVideoRenderer && typeof item.playlistPanelVideoRenderer === 'object') {
                item.playlistPanelVideoRenderer._ipInfo = ipInfo;
            }
            enrichedCount++;
        }
        return item;
    });
    if (enrichedCount > 0) {
        console.log(`[IP-ENRICH] Enriched ${enrichedCount} of ${totalItems} queue items with IP info`);
    }
    return enriched;
}

/**
 * Fetch queue items from the backend API, handling pagination and fallbacks.
 */
async function fetchAllQueueItems(proxyRequest) {
    let queueResult = await proxyRequest('GET', '/queue', null, { limit: 1000 });
    if (!queueResult.success || (queueResult.data && queueResult.data.items.length === 0)) {
        queueResult = await proxyRequest('GET', '/queue', null);
    }
    if (queueResult.success && queueResult.data) {
        const items = queueResult.data.items || [];
        const itemCount = items.length;
        if (itemCount === 50) {
            const continuationToken = queueResult.data.continuationToken || 
                                    queueResult.data.continuation || 
                                    queueResult.data.nextPageToken ||
                                    queueResult.data.continuationCommand?.token ||
                                    null;
            const totalCount = queueResult.data.totalCount || 
                             queueResult.data.total || 
                             queueResult.data.count ||
                             null;
            if (continuationToken) {
                const nextPageResult = await proxyRequest('GET', '/queue', null, { 
                    continuationToken: continuationToken,
                    limit: 1000 
                });
                if (nextPageResult.success && nextPageResult.data && nextPageResult.data.items) {
                    const nextItems = nextPageResult.data.items || [];
                    items.push(...nextItems);
                }
            }
        }
        return {
            success: true,
            data: {
                items: items,
                totalItems: items.length
            }
        };
    }
    return queueResult;
}

/**
 * Refresh the queue cache, enrich items, and broadcast a queue update.
 */
async function broadcastQueueUpdate(broadcast, proxyRequest, enrichQueueItemsWithIpInfoFn, songAdded = false) {
    invalidateQueueCache();
    const queueResult = await fetchAllQueueItems(proxyRequest);
    if (queueResult.success && queueResult.data) {
        queueResult.data.items = await enrichQueueItemsWithIpInfoFn(queueResult.data.items || []);
        
        // Mark the currently playing song
        try {
            const currentIndex = await getCurrentPlayingIndex(proxyRequest);
            if (currentIndex !== null && currentIndex >= 0 && currentIndex < queueResult.data.items.length) {
                queueResult.data.currentlyPlayingIndex = currentIndex;
                // Add a marker to the actual item as well
                if (queueResult.data.items[currentIndex]) {
                    queueResult.data.items[currentIndex]._isCurrentlyPlaying = true;
                }
            }
        } catch (e) {
            // Ignore errors in marking current song
        }
        
        queueCache = queueResult.data;
        queueCacheTimestamp = Date.now();
        broadcast({ type: 'queue_updated', data: queueResult.data, songAdded });
        return true;
    } else {
        broadcast({ type: 'queue_updated', songAdded });
        return false;
    }
}

/**
 * Extract the playlistPanelVideoRenderer from an item, handling both
 * direct and wrapped (playlistPanelVideoWrapperRenderer) structures.
 */
function getRenderer(item) {
    if (!item) return null;
    if (item.playlistPanelVideoRenderer) return item.playlistPanelVideoRenderer;
    const wrapped = item.playlistPanelVideoWrapperRenderer?.primaryRenderer;
    if (wrapped?.playlistPanelVideoRenderer) return wrapped.playlistPanelVideoRenderer;
    return null;
}

/**
 * Determine the index of the currently playing song.
 * Uses YouTube's own `selected` flag on the renderer as the primary signal —
 * it is set to true on exactly one item and is unambiguous even with duplicates.
 * Falls back to videoId matching only when selected is absent from all items.
 */
async function getCurrentPlayingIndex(proxyRequest) {
    try {
        const queueResult = await fetchAllQueueItems(proxyRequest);
        if (!queueResult.success || !queueResult.data || !queueResult.data.items) {
            return null;
        }
        const items = queueResult.data.items;

        // Primary: YouTube marks exactly one item as selected
        for (let i = 0; i < items.length; i++) {
            const renderer = getRenderer(items[i]);
            if (renderer && renderer.selected === true) {
                return i;
            }
        }

        // Fallback: match by videoId from /song (only when selected is missing)
        const songResult = await proxyRequest('GET', '/song');
        if (!songResult.success || !songResult.data?.videoId) {
            return null;
        }
        const currentVideoId = songResult.data.videoId;

        for (let i = 0; i < items.length; i++) {
            const renderer = getRenderer(items[i]);
            const videoId = renderer?.videoId || items[i].videoId;
            if (videoId === currentVideoId) {
                return i;
            }
        }

        return null;
    } catch (error) {
        console.error('Error getting current playing index:', error);
        return null;
    }
}

/**
 * Use sequential next/previous commands to reach the desired queue index.
 */
async function navigateWithCommands(currentIndex, finalTargetIndex, proxyRequest, broadcast, enrichQueueItemsWithIpInfoFn) {
    const steps = finalTargetIndex - currentIndex;
    const command = steps > 0 ? 'next' : 'previous';
    const absSteps = Math.abs(steps);
    for (let i = 0; i < absSteps; i++) {
        const result = await proxyRequest('POST', `/${command}`);
        if (!result.success) {
            throw new Error(`Failed to execute ${command} command: ${result.error}`);
        }
        await new Promise(resolve => setTimeout(resolve, 150));
        if (i % 3 === 2 || i === absSteps - 1) {
            const verifiedIndex = await getCurrentPlayingIndex(proxyRequest);
            if (verifiedIndex === finalTargetIndex) {
                await broadcastQueueUpdate(broadcast, proxyRequest, enrichQueueItemsWithIpInfoFn);
                broadcast({ type: 'playback_updated' });
                return { success: true, method: 'sequential_commands', currentIndex, targetIndex: finalTargetIndex };
            }
            if (verifiedIndex !== null) {
                if ((steps > 0 && verifiedIndex > finalTargetIndex) || (steps < 0 && verifiedIndex < finalTargetIndex)) {
                    throw new Error(`Navigation overshot: reached index ${verifiedIndex} instead of ${finalTargetIndex}`);
                }
            }
        }
    }
    const finalIndex = await getCurrentPlayingIndex(proxyRequest);
    if (finalIndex === finalTargetIndex) {
        await broadcastQueueUpdate(broadcast, proxyRequest, enrichQueueItemsWithIpInfoFn);
        broadcast({ type: 'playback_updated' });
        return { success: true, method: 'sequential_commands', currentIndex, targetIndex: finalTargetIndex };
    }
    if (finalIndex === null) {
        await broadcastQueueUpdate(broadcast, proxyRequest, enrichQueueItemsWithIpInfoFn);
        broadcast({ type: 'playback_updated' });
        return { success: true, method: 'sequential_commands', currentIndex, targetIndex: finalTargetIndex };
    }
    throw new Error(`Failed to navigate from index ${currentIndex} to ${finalTargetIndex}. Final position: ${finalIndex}`);
}

async function verifyTargetIndex(proxyRequest, expectedIndex, retries = 4, delayMs = 250) {
    for (let attempt = 0; attempt <= retries; attempt++) {
        const verified = await getCurrentPlayingIndex(proxyRequest);
        if (verified === expectedIndex) {
            return verified;
        }
        if (attempt < retries) {
            await new Promise(resolve => setTimeout(resolve, delayMs));
        }
    }
    return await getCurrentPlayingIndex(proxyRequest);
}

/**
 * Navigate the playback queue to a target index or by relative steps.
 */
async function navigateQueue(proxyRequest, broadcast, enrichQueueItemsWithIpInfoFn, targetIndex = null, relativeSteps = null) {
    if (isNavigating) {
        throw new Error('Navigation already in progress');
    }
    isNavigating = true;
    try {
        const queueResult = await fetchAllQueueItems(proxyRequest);
        if (!queueResult.success || !queueResult.data || !queueResult.data.items) {
            throw new Error('Could not fetch queue to validate target index');
        }
        const queueLength = queueResult.data.items.length;
        const currentIndex = await getCurrentPlayingIndex(proxyRequest);
        let finalTargetIndex;
        if (relativeSteps !== null) {
            if (currentIndex === null) {
                const steps = relativeSteps;
                const command = steps > 0 ? 'next' : 'previous';
                const absSteps = Math.abs(steps);
                for (let i = 0; i < absSteps; i++) {
                    try {
                        const cmdResult = await proxyRequest('POST', `/${command}`);
                        if (!cmdResult.success) {
                            console.warn(`[NAV-FALLBACK] ${command} failed at step ${i + 1}: ${cmdResult.error}`);
                        }
                    } catch (err) {
                        console.warn(`[NAV-FALLBACK] ${command} threw at step ${i + 1}: ${err?.message || err}`);
                    }
                    await new Promise(resolve => setTimeout(resolve, 150));
                }
                let verifiedIndex = null;
                try {
                    verifiedIndex = await getCurrentPlayingIndex(proxyRequest);
                } catch (e) {
                    /* ignore */
                }
                await broadcastQueueUpdate(broadcast, proxyRequest, enrichQueueItemsWithIpInfoFn);
                broadcast({ type: 'playback_updated' });
                return { success: true, method: 'commands_no_index', currentIndex: verifiedIndex, targetIndex: verifiedIndex };
            }
            finalTargetIndex = currentIndex + relativeSteps;
        } else if (targetIndex !== null) {
            finalTargetIndex = parseInt(targetIndex);
        } else {
            throw new Error('Either targetIndex or relativeSteps must be provided');
        }
        if (finalTargetIndex < 0 || finalTargetIndex >= queueLength) {
            throw new Error(`Target index ${finalTargetIndex} is out of bounds (queue length: ${queueLength})`);
        }
        if (currentIndex !== null && currentIndex === finalTargetIndex) {
            return { success: true, method: 'noop', currentIndex, targetIndex: finalTargetIndex };
        }
        const patchResult = await proxyRequest('PATCH', '/queue', { index: finalTargetIndex });
        if (patchResult.success) {
            const verifiedIndex = await verifyTargetIndex(proxyRequest, finalTargetIndex);
            if (verifiedIndex === finalTargetIndex) {
                await broadcastQueueUpdate(broadcast, proxyRequest, enrichQueueItemsWithIpInfoFn);
                broadcast({ type: 'playback_updated' });
                return { success: true, method: 'http_patch', currentIndex: currentIndex ?? verifiedIndex, targetIndex: finalTargetIndex };
            }
            // Song boundary races can move playback while PATCH is in-flight.
            // Fall back to explicit command stepping from the verified position.
            if (verifiedIndex !== null) {
                return await navigateWithCommands(verifiedIndex, finalTargetIndex, proxyRequest, broadcast, enrichQueueItemsWithIpInfoFn);
            }
            throw new Error(`Queue navigation could not be confirmed (expected ${finalTargetIndex}, got unknown current index)`);
        }
        let workingIndex = currentIndex;
        if (workingIndex === null) {
            workingIndex = await getCurrentPlayingIndex(proxyRequest);
            if (workingIndex === null) {
                throw new Error('Could not determine current queue position and PATCH method failed');
            }
        }
        if (workingIndex === finalTargetIndex) {
            await broadcastQueueUpdate(broadcast, proxyRequest, enrichQueueItemsWithIpInfoFn);
            broadcast({ type: 'playback_updated' });
            return { success: true, method: 'noop', currentIndex: workingIndex, targetIndex: finalTargetIndex };
        }
        return await navigateWithCommands(workingIndex, finalTargetIndex, proxyRequest, broadcast, enrichQueueItemsWithIpInfoFn);
    } finally {
        isNavigating = false;
    }
}

/**
 * Wrapper for navigating queue that may confirm actions via a client websocket.
 */
async function navigateQueueWithConfirmation(clientWs, proxyRequest, broadcast, enrichQueueItemsWithIpInfoFn, targetIndex = null, relativeSteps = null) {
    return await navigateQueue(proxyRequest, broadcast, enrichQueueItemsWithIpInfoFn, targetIndex, relativeSteps);
}

function startVideoIdCleanup() {
    setInterval(() => {
        const now = Date.now();
        let cleaned = 0;
        for (const [videoId, ipData] of videoIdToIpMap.entries()) {
            if (ipData && typeof ipData === 'object' && ipData.timestamp) {
                if (now - ipData.timestamp > VIDEO_ID_IP_MAP_TTL) {
                    videoIdToIpMap.delete(videoId);
                    cleaned++;
                }
            } else if (ipData) {
                if (videoIdToIpMap.size > VIDEO_ID_IP_MAP_MAX_SIZE * 0.8) {
                    videoIdToIpMap.delete(videoId);
                    cleaned++;
                }
            }
        }
        if (cleaned > 0) {
            console.log(`[CLEANUP] Removed ${cleaned} expired videoId-IP mappings`);
        }
    }, 60 * 60 * 1000);
}

module.exports = {
    invalidateQueueCache,
    getQueueCache,
    getQueueCacheTimestamp,
    setQueueCache,
    getVideoIdToIpMap,
    findVideoIdRecursive,
    extractVideoIdFromItem,
    enrichQueueItemsWithIpInfo,
    fetchAllQueueItems,
    broadcastQueueUpdate,
    getCurrentPlayingIndex,
    navigateQueue,
    navigateQueueWithConfirmation,
    startVideoIdCleanup,
    QUEUE_CACHE_TTL,
    VIDEO_ID_IP_MAP_MAX_SIZE,
    VIDEO_ID_IP_MAP_TTL
};
