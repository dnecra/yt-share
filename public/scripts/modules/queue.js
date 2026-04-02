import { API_URL, state } from './config.js';
import { getThumbnailUrl } from './connection.js';
import { logMessage } from './utils.js';
import { updateNowPlayingHighlight } from './ui.js';

const QUEUE_AUTOSCROLL_IDLE_MS = 1800;
const QUEUE_AUTOSCROLL_ADD_DELAY_MS = 900;
const QUEUE_AUTOSCROLL_SONG_DELAY_MS = 450;
let queueInteractionListenersAttached = false;

function getEffectiveCurrentPlayingIndex(processedQueue = state.processedQueueData) {
    // Prefer server-provided/currently tracked index to avoid ambiguity with duplicate videoIds.
    if (Number.isInteger(state.currentPlayingIndex) && state.currentPlayingIndex >= 0) {
        return state.currentPlayingIndex;
    }

    if (!processedQueue || !Array.isArray(processedQueue) || processedQueue.length === 0) {
        return -1;
    }

    // If the backend or YouTube marked a specific queue item as currently playing, use that.
    const flaggedIndex = processedQueue.findIndex(s => s && s._isCurrentlyPlaying);
    if (flaggedIndex !== -1) return flaggedIndex;

    return -1;
}

function smoothScrollTo(element, targetPosition, duration = 800) {
    const startPosition = element.scrollTop;
    const distance = targetPosition - startPosition;
    let startTime = null;

    function easeInOutCubic(t) {
        return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
    }

    function step(currentTime) {
        if (startTime === null) startTime = currentTime;
        const timeElapsed = currentTime - startTime;
        const progress = Math.min(timeElapsed / duration, 1);
        const easedProgress = easeInOutCubic(progress);
        element.scrollTop = startPosition + (distance * easedProgress);

        if (progress < 1) {
            element._scrollAnimationId = requestAnimationFrame(step);
            return;
        }
        element._scrollAnimationId = null;
    }

    if (element._scrollAnimationId) {
        cancelAnimationFrame(element._scrollAnimationId);
    }
    element._scrollAnimationId = requestAnimationFrame(step);
}

function getQueueElement() {
    return document.getElementById('queue');
}

function cancelPendingQueueScroll() {
    if (state.scrollTimeout) {
        clearTimeout(state.scrollTimeout);
        state.scrollTimeout = null;
    }
}

function noteQueueInteraction(idleMs = QUEUE_AUTOSCROLL_IDLE_MS) {
    const now = Date.now();
    state.queueLastInteractionAt = now;
    state.queueAutoScrollResumeAt = Math.max(state.queueAutoScrollResumeAt || 0, now + Math.max(250, idleMs));
    state.queueUserInteracting = true;

    if (state.queueInteractionReleaseTimer) {
        clearTimeout(state.queueInteractionReleaseTimer);
    }
    state.queueInteractionReleaseTimer = setTimeout(() => {
        state.queueUserInteracting = false;
        state.queueInteractionReleaseTimer = null;
    }, Math.max(180, Math.min(idleMs, 1200)));
}

function canAutoScrollQueue({ ignoreCursorCheck = false } = {}) {
    const now = Date.now();
    if (!ignoreCursorCheck && state.isCursorOnPage) return false;
    if (state.queueUserInteracting) return false;
    if (now < (state.queueAutoScrollResumeAt || 0)) return false;
    return true;
}

function attachQueueInteractionListeners() {
    if (queueInteractionListenersAttached) return;
    const queueDiv = getQueueElement();
    if (!queueDiv) return;

    const markLightInteraction = () => noteQueueInteraction(QUEUE_AUTOSCROLL_IDLE_MS);
    const markStrongInteraction = () => noteQueueInteraction(QUEUE_AUTOSCROLL_IDLE_MS + 300);

    queueDiv.addEventListener('mouseenter', markLightInteraction);
    queueDiv.addEventListener('mousemove', markLightInteraction);
    queueDiv.addEventListener('wheel', markStrongInteraction, { passive: true });
    queueDiv.addEventListener('touchstart', markStrongInteraction, { passive: true });
    queueDiv.addEventListener('touchmove', markStrongInteraction, { passive: true });
    queueDiv.addEventListener('pointerdown', markStrongInteraction);
    queueDiv.addEventListener('scroll', () => {
        if (state.queueUserInteracting) {
            noteQueueInteraction(QUEUE_AUTOSCROLL_IDLE_MS);
        }
    }, { passive: true });

    queueInteractionListenersAttached = true;
}

function scheduleQueueAutoScroll(action, { delay = 0, ignoreCursorCheck = false, reason = '' } = {}) {
    cancelPendingQueueScroll();

    const run = () => {
        if (!canAutoScrollQueue({ ignoreCursorCheck })) {
            const retryDelay = Math.max(250, (state.queueAutoScrollResumeAt || 0) - Date.now(), QUEUE_AUTOSCROLL_SONG_DELAY_MS);
            state.scrollTimeout = setTimeout(() => {
                state.scrollTimeout = null;
                scheduleQueueAutoScroll(action, { delay: 0, ignoreCursorCheck, reason });
            }, retryDelay);
            return;
        }

        action();
        state.scrollTimeout = null;
        state.queueAutoScrollPendingReason = '';
    };

    state.queueAutoScrollPendingReason = reason;
    state.scrollTimeout = setTimeout(run, Math.max(0, delay));
}

export function scrollToCurrentSong(ignoreCursorCheck = false, delay = 0) {
    if (!canAutoScrollQueue({ ignoreCursorCheck }) && delay <= 0) return;

    scheduleQueueAutoScroll(() => {
        const queueDiv = document.getElementById('queue');
        const currentSong = document.querySelector('.song.now-playing');

        if (currentSong && queueDiv) {
            const queueRect = queueDiv.getBoundingClientRect();
            const songRect = currentSong.getBoundingClientRect();
            const scrollTop = queueDiv.scrollTop + songRect.top - queueRect.top;

            try {
                smoothScrollTo(queueDiv, scrollTop, 600);
            } catch (e) {
                queueDiv.scrollTo({ top: scrollTop, behavior: 'smooth' });
            }

            currentSong.style.transition = 'background-color 0.3s ease';
            currentSong.style.backgroundColor = '#630014';
            setTimeout(() => {
                currentSong.style.backgroundColor = '';
            }, 1000);
        }
    }, { delay, ignoreCursorCheck, reason: 'current-song' });
}

export function scrollToBottom(callback, options = {}) {
    const queueDiv = document.getElementById('queue');
    const delay = Number(options.delay) || 0;
    const ignoreCursorCheck = !!options.ignoreCursorCheck;
    if (queueDiv) {
        scheduleQueueAutoScroll(() => {
            try {
                smoothScrollTo(queueDiv, queueDiv.scrollHeight, 600);
            } catch (e) {
                queueDiv.scrollTo({ top: queueDiv.scrollHeight, behavior: 'smooth' });
            }
            if (callback) {
                setTimeout(callback, 500);
            }
        }, { delay, ignoreCursorCheck, reason: 'bottom' });
    } else if (callback) {
        callback();
    }
}



// Queue data processing
export function validateSongData(song, index) {
    const issues = [];
    if (!song) {
        issues.push('Song object is null/undefined');
        return { valid: false, issues };
    }
    if (!song.videoId) issues.push('Missing videoId');
    if (!song.title?.runs?.[0]?.text) issues.push('Missing/invalid title');
    if (!song.thumbnail?.thumbnails?.[0]?.url) issues.push('Missing/invalid thumbnail');
    return {
        valid: issues.length === 0,
        issues
    };
}

export function findSongObject(obj) {
    if (!obj || typeof obj !== 'object') return null;
    if (obj.videoId && obj.title) return obj;
    for (let key in obj) {
        const result = findSongObject(obj[key]);
        if (result) return result;
    }
    return null;
}

export function processQueueItem(item, index) {
    try {
        const song = item.playlistPanelVideoRenderer;
        if (!song) {
            const possibleSong = findSongObject(item);
            if (possibleSong) {
                if (item._ipInfo) {
                    possibleSong._ipInfo = item._ipInfo;
                }
                return possibleSong;
            }
            
            if (logMessage) logMessage(`Creating placeholder for unavailable song at index ${index}`);
            const placeholder = {
                videoId: `unavailable-${index}`,
                unavailable: true,
                title: "Video Unavailable",
                thumbnail: {
                    thumbnails: [{ url: null }]
                }
            };
            if (item._ipInfo) {
                placeholder._ipInfo = item._ipInfo;
            }
            return placeholder;
        }

        const validation = validateSongData(song, index);
        if (!validation.valid) {
            song.unavailable = true;
            if (logMessage) logMessage(`Marking song at index ${index} as unavailable: ${validation.issues.join(', ')}`);
        }

        if (item._ipInfo) {
            song._ipInfo = item._ipInfo;
        }
        if (item._isCurrentlyPlaying) {
            song._isCurrentlyPlaying = true;
        }
        // Preserve YouTube's own `selected` flag — authoritative even with duplicate videoIds
        if (song.selected === true) {
            song._isCurrentlyPlaying = true;
        }
        return song;
    } catch (error) {
        state.failedItems.push({ index, error: error.message, item });
        const placeholder = {
            videoId: `error-${index}`,
            unavailable: true,
            title: "Error Loading Track",
            thumbnail: {
                thumbnails: [{ url: null }]
            }
        };
        if (item._ipInfo) {
            placeholder._ipInfo = item._ipInfo;
        }
        return placeholder;
    }
}

// Create song element for queue
export function createSongElement(song, index, handlers = {}) {
    if (!song) return null;

    const div = document.createElement('div');
    div.className = 'song';
    div.dataset.videoId = song.videoId;
    div.setAttribute('data-video-id', song.videoId);
    div.dataset.index = index;

    if (state.newlyAddedIndex !== null && state.newlyAddedIndex === index) {
        div.classList.add('newly-added');
    }

    const isUnavailable = song.unavailable || 
                         song.shortBylineText?.runs?.[0]?.text === 'Video unavailable' || 
                         song.title?.accessibility?.accessibilityData?.label === 'Video unavailable';

    const isCurrent = (Number.isInteger(state.currentPlayingIndex) && state.currentPlayingIndex === index) || song._isCurrentlyPlaying === true;

    if (isUnavailable) {
        div.classList.add('unavailable');
        div.draggable = false;
    } else {
        div.draggable = true;
    }

    // Drag handlers
    if (handlers.onDragStart) div.addEventListener('dragstart', handlers.onDragStart);
    if (handlers.onDragEnd) div.addEventListener('dragend', handlers.onDragEnd);
    if (handlers.onDragOver) div.addEventListener('dragover', handlers.onDragOver);
    if (handlers.onDragEnter) div.addEventListener('dragenter', handlers.onDragEnter);
    if (handlers.onDragLeave) div.addEventListener('dragleave', handlers.onDragLeave);
    if (handlers.onDrop) div.addEventListener('drop', handlers.onDrop);

    // Click handler
    if (handlers.onClick) {
        div.addEventListener('click', (e) => handlers.onClick(e, div, index, isUnavailable));
    }

    const titleText = song.title?.runs?.[0]?.text || (typeof song.title === 'string' ? song.title : 'Unavailable Video');
    const artistText = song.longBylineText?.runs?.[0]?.text || '';
    const albumText = song.longBylineText?.runs?.[2]?.text || '';
    const originalThumbnailUrl = song.thumbnail?.thumbnails?.[0]?.url?.startsWith('http') 
        ? song.thumbnail.thumbnails[0].url 
        : (song.thumbnail?.thumbnails?.[0]?.url ? `https:${song.thumbnail.thumbnails[0].url}` : 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIxMjgiIGhlaWdodD0iMTI4IiB2aWV3Qm94PSIwIDAgMjQgMjQiIGZpbGw9Im5vbmUiIHN0cm9rZT0iI2ZkMDIzNCIgc3Ryb2tlLXdpZHRoPSIxLjUiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCIgc3Ryb2tlLWxpbmVqb2luPSJyb3VuZCI+PHBhdGggZD0iTTE4IDZMNiAxOE0xOCAxOEw2IDZNMTIgMkE1IDUgMCAwIDAgMyAxMkE1IDUgMCAwIDAgMTIgMjJBNSA1IDAgMCAwIDIxIDEyQTUgNSAwIDAgMCAxMiAyeiI+PC9wYXRoPjwvc3ZnPg==');
    const thumbnailUrl = getThumbnailUrl(originalThumbnailUrl);

    const ipInfo = song._ipInfo;
    const ipAddress = ipInfo?.ip || null;
    const displayText = ipInfo?.hostname || ipAddress || '';
    const ipDisplay = displayText ? `<span class="ip-address" title="Added by ${ipAddress || displayText}">${displayText}</span>` : '';

    div.innerHTML = `
        <span class="queue-number">${index + 1}</span>
        <img class="thumbnail" src="${thumbnailUrl}" alt="${titleText}">
        <div class="details">
            <div class="title">${isUnavailable ? '<span class="unavailable-label">Unavailable</span> ' : ''}${titleText}</div>
            <div class="artist-album">${artistText}${albumText ? ` • ${albumText}` : ''}</div>
        </div>
        ${ipDisplay}
        <div class="move-controls ${(isCurrent || isUnavailable) ? 'hidden' : ''}">
            <button class="control-button move-button" onclick="moveSongInQueue(${index}, 'up')" 
                    ${index === 0 ? 'disabled' : ''}>
                <span class="material-icons">arrow_upward</span>
            </button>
            <button class="control-button move-button" onclick="moveSongInQueue(${index}, 'down')" 
                    ${index === state.processedQueueData.length - 1 ? 'disabled' : ''}>
                <span class="material-icons">arrow_downward</span>
            </button>
        </div>
        <button class="control-button play-next-button ${(isCurrent || isUnavailable) ? 'hidden' : ''}" onclick="moveSongNext(${index})">
                <span class="material-icons">keyboard_double_arrow_up</span>
        </button>
        <button class="control-button delete-button ${isCurrent ? 'hidden' : ''}" onclick="deleteSongFromQueue(${index})">
                <span class="material-icons">close</span>
        </button>
        ${isCurrent ?
            '<span class="loader"></span>' :
            ''
            }
    `;

    return div;
}

// Queue API operations
export async function deleteSongFromQueue(index) {
    try {
        if (logMessage) logMessage(`Deleting song at index ${index}`);
        const response = await fetch(`${API_URL}/queue/${index}`, {
            method: 'DELETE',
            headers: {
                'Content-Type': 'application/json',
            }
        });

        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        if (logMessage) logMessage(`Successfully deleted song at index ${index}`);
    } catch (error) {
        if (logMessage) logMessage(`Error deleting song: ${error.message}`);
    }
}

export async function moveSongInQueue(currentIndex, direction) {
    try {
        const newIndex = direction === 'up' ? currentIndex - 1 : currentIndex + 1;
        
        if (newIndex < 0 || newIndex >= state.processedQueueData.length) {
            if (logMessage) logMessage(`Cannot move song ${direction} from position ${currentIndex}`);
            return;
        }

        if (logMessage) logMessage(`Moving song at index ${currentIndex} ${direction} to index ${newIndex}`);
        const response = await fetch(`${API_URL}/queue/${currentIndex}`, {
            method: 'PATCH',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ toIndex: newIndex })
        });

        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        if (logMessage) logMessage(`Successfully moved song ${direction}`);

        setTimeout(() => {
            const movedSong = document.querySelector(`.song[data-index="${newIndex}"]`);
            if (movedSong) {
                movedSong.style.transition = "background-color 0.5s ease";
                movedSong.style.backgroundColor = "rgba(253, 2, 52, 0.2)";
                setTimeout(() => {
                    movedSong.style.backgroundColor = "";
                }, 800);
            }
        }, 100);
    } catch (error) {
        if (logMessage) logMessage(`Error moving song: ${error.message}`);
    }
}

export async function moveSongNext(index) {
    try {
        const currentIndex = getEffectiveCurrentPlayingIndex();
        if (currentIndex === -1) {
            if (logMessage) logMessage('No currently playing song found.');
            return;
        }

        if (index === currentIndex + 1) {
            if (logMessage) logMessage('Song is already in the next position.');
            return;
        }

        const newIndex = currentIndex + 1;
        
        if (index === currentIndex) {
            if (logMessage) logMessage('Cannot move currently playing song');
            return;
        }

        if (logMessage) logMessage(`Moving song at index ${index} to play next (index ${newIndex})`);
        const response = await fetch(`${API_URL}/queue/${index}`, {
            method: 'PATCH',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ toIndex: newIndex })
        });

        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        if (logMessage) logMessage(`Successfully moved song to play next`);

        setTimeout(() => {
            const movedSong = document.querySelector(`.song[data-index="${newIndex}"]`);
            if (movedSong) {
                movedSong.style.transition = "background-color 0.5s ease";
                movedSong.style.backgroundColor = "rgba(253, 2, 52, 0.2)";
                setTimeout(() => {
                    movedSong.style.backgroundColor = "";
                }, 800);
            }
        }, 100);
    } catch (error) {
        if (logMessage) logMessage(`Error moving song to play next: ${error.message}`);
    }
}

export async function clearQueue() {
    try {
        const currentIndex = getEffectiveCurrentPlayingIndex();
        if (currentIndex === -1) {
            if (logMessage) logMessage('Error: Cannot determine current playing song position');
            return;
        }

        const indicesToRemove = [];
        for (let i = currentIndex + 1; i < state.processedQueueData.length; i++) {
            indicesToRemove.push(i);
        }

        if (logMessage) logMessage(`Clearing ${indicesToRemove.length} songs from queue`);

        for (const index of indicesToRemove.reverse()) {
            const response = await fetch(`${API_URL}/queue/${index}`, {
                method: 'DELETE',
                headers: {
                    'Content-Type': 'application/json',
                }
            });

            if (!response.ok) {
                throw new Error(`Failed to remove song at index ${index}`);
            }
        }

        if (logMessage) logMessage('Successfully cleared upcoming songs from queue');
    } catch (error) {
        if (logMessage) logMessage(`Error in clearQueue: ${error.message}`);
        console.error('Error in clearQueue:', error);
    }
}

export async function shuffleQueue() {
    try {
        const url = `${API_URL}/shuffle`;
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'accept': '*/*',
                'Content-Length': '0'
            }
        });

        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        await response.text();
    } catch (error) {
        console.error('Error in shuffleQueue:', error.message);
    }
}

export async function addToQueue(videoId) {
    if (logMessage) logMessage(`Adding video with ID: ${videoId}`);
    
    try {
        const response = await fetch(`${API_URL}/queue`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ videoId }),
        });

        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        if (logMessage) {
            logMessage('✓ Song added to queue!');
            const logDiv = document.getElementById('log');
            if (logDiv) {
                logDiv.style.color = '#4caf50';
                logDiv.style.transition = 'color 0.3s ease';
                setTimeout(() => {
                    logDiv.style.color = '';
                }, 2000);
            }
        }

        state.shouldScrollToBottom = true;
        state.queueAutoScrollResumeAt = Math.max(state.queueAutoScrollResumeAt || 0, Date.now() + QUEUE_AUTOSCROLL_ADD_DELAY_MS);
        return true;
    } catch (error) {
        if (logMessage) logMessage(`Failed to add song: ${error.message}`);
        return false;
    }
}

// Queue state and update constants
export let queueUpdateInProgress = false;
export let lastQueueUpdateTime = 0;
export const QUEUE_UPDATE_COOLDOWN = 100;
let lastStatsSignature = '';

export function renderQueue() {
    const queueDiv = document.getElementById('queue');
    if (!queueDiv) {
        console.error('Queue div not found');
        return;
    }
    attachQueueInteractionListeners();

    queueDiv.innerHTML = '<div class="queue-padding"></div>';

    if (!state.processedQueueData || state.processedQueueData.length === 0) {
        queueDiv.innerHTML = `
            <div class="queue-padding"></div>
            <div style="padding: 40px; text-align: center; color: var(--text-secondary);">
                Queue is empty
            </div>
            <div class="queue-padding"></div>
        `;
        return;
    }

    const dragHandlers = {
        onDragStart: handleDragStart,
        onDragEnd: handleDragEnd,
        onDragOver: handleDragOver,
        onDragEnter: handleDragEnter,
        onDragLeave: handleDragLeave,
        onDrop: handleDrop,
        onClick: async (e, div, index, isUnavailable) => {
            if (!e.target.closest('.move-controls') && 
                !e.target.closest('.play-next-button') && 
                !e.target.closest('.delete-button')) {
                if (isUnavailable) {
                    logMessage("This video is unavailable");
                    return;
                }
                
                const ripple = document.createElement('div');
                ripple.classList.add('click-ripple');
                ripple.style.left = `${e.offsetX}px`;
                ripple.style.top = `${e.offsetY}px`;
                div.appendChild(ripple);
                setTimeout(() => ripple.remove(), 600);
                
                await playQueueItem(index);
            }
        }
    };

    state.processedQueueData.forEach((song, index) => {
        try {
            const element = createSongElement(song, index, dragHandlers);
            if (element) {
                queueDiv.appendChild(element);
            }
        } catch (error) {
            console.error(`Error rendering queue item at index ${index}:`, error);
        }
    });

    queueDiv.appendChild(document.createElement('div')).className = 'queue-padding';

    if (state.newlyAddedIndex !== null) {
        const highlightedElement = document.querySelector(`.song[data-index="${state.newlyAddedIndex}"]`);
        if (!highlightedElement || !highlightedElement.classList.contains('newly-added')) {
            document.querySelectorAll('.song.newly-added').forEach(el => {
                el.classList.remove('newly-added');
            });
            if (state.highlightTimeout) {
                clearTimeout(state.highlightTimeout);
                state.highlightTimeout = null;
            }
            state.newlyAddedIndex = null;
        }
    } else {
        document.querySelectorAll('.song.newly-added').forEach(el => {
            el.classList.remove('newly-added');
        });
    }
}

export async function playQueueItem(targetIndex) {
    try {
        const song = state.processedQueueData[targetIndex];
        if (!song || song.unavailable) {
            logMessage(`Cannot play unavailable video at index ${targetIndex}`);
            return;
        }

        logMessage(`Playing song at index ${targetIndex}`);

        if (state.ws && state.ws.readyState === WebSocket.OPEN) {
            return new Promise((resolve, reject) => {
                let settled = false;
                const timeout = setTimeout(() => {
                    if (settled) return;
                    settled = true;
                    console.log('[NAV] WebSocket timeout, falling back to HTTP');
                    try {
                        state.ws.removeEventListener('message', responseHandler);
                    } catch (_) {}
                    playQueueItemHTTP(targetIndex).then(resolve).catch(reject);
                }, 3000);

                const responseHandler = (event) => {
                    if (settled) return;
                    try {
                        const message = JSON.parse(event.data);
                        if (message.type === 'navigation_success') {
                            settled = true;
                            clearTimeout(timeout);
                            state.ws.removeEventListener('message', responseHandler);
                            const result = message.data;
                            logMessage(result.message || `Navigated to queue index ${targetIndex}`);
                            state.currentPlayingIndex = result.targetIndex;
                            resolve(result);
                        } else if (message.type === 'navigation_error') {
                            settled = true;
                            clearTimeout(timeout);
                            state.ws.removeEventListener('message', responseHandler);
                            playQueueItemHTTP(targetIndex).then(resolve).catch(reject);
                        }
                    } catch (error) {
                        // Ignore
                    }
                };

                state.ws.addEventListener('message', responseHandler);
                state.ws.send(JSON.stringify({
                    type: 'navigate_queue',
                    index: targetIndex
                }));
            });
        } else {
            return await playQueueItemHTTP(targetIndex);
        }
    } catch (error) {
        logMessage(`Error playing queue item: ${error.message}`);
        throw error;
    }
}

export async function playQueueItemHTTP(targetIndex) {
    const response = await fetch(`${API_URL}/queue`, {
        method: 'PATCH',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({ index: targetIndex })
    });

    if (!response.ok) {
        const errorData = await response.json().catch(() => ({ error: 'Unknown error' }));
        throw new Error(errorData.error || `HTTP error! status: ${response.status}`);
    }

    const result = await response.json();
    if (result.message) {
        logMessage(result.message);
    } else {
        logMessage('Successfully navigated to queue position');
    }

    const resolvedTargetIndex = Number.isInteger(result.targetIndex)
        ? result.targetIndex
        : (Number.isInteger(result.index) ? result.index : targetIndex);
    state.currentPlayingIndex = resolvedTargetIndex;
    return result;
}

export function updateQueueFromData(data, source = 'websocket', songAddedFromServer = false) {
    if (queueUpdateInProgress) {
        console.log('Queue update already in progress, skipping...');
        return;
    }

    const now = Date.now();
    if (now - lastQueueUpdateTime < QUEUE_UPDATE_COOLDOWN) {
        const delay = QUEUE_UPDATE_COOLDOWN - (now - lastQueueUpdateTime);
        setTimeout(() => updateQueueFromData(data, source), delay);
        return;
    }

    queueUpdateInProgress = true;
    lastQueueUpdateTime = now;

    try {
        if (!data || typeof data !== 'object') {
            console.error('Invalid queue data:', data);
            queueUpdateInProgress = false;
            return;
        }

        const items = data.items || data.queue || [];
        if (Number.isInteger(data.currentlyPlayingIndex)) {
            state.currentPlayingIndex = data.currentlyPlayingIndex;
        }
        if (!Array.isArray(items)) {
            console.error('Queue items is not an array:', items);
            queueUpdateInProgress = false;
            return;
        }

        console.log(`[${source.toUpperCase()}] Updating queue with ${items.length} items`);

        state.rawQueueData = items;
        state.failedItems = [];

        const newProcessedQueue = items
            .map((item, index) => {
                try {
                    return processQueueItem(item, index);
                } catch (error) {
                    console.error(`Error processing queue item at index ${index}:`, error);
                    return null;
                }
            })
            .filter(item => item !== null);

        // Resolve currently playing index (duplicate-safe)
        const resolveCurrentIndex = () => {
            // 1) Trust server-provided index if present and in-bounds
            if (Number.isInteger(data.currentlyPlayingIndex) &&
                data.currentlyPlayingIndex >= 0 &&
                data.currentlyPlayingIndex < newProcessedQueue.length) {
                return data.currentlyPlayingIndex;
            }

            // 2) Trust item marked by server or by YouTube's own `selected` flag
            const flagged = newProcessedQueue.findIndex(s => s && s._isCurrentlyPlaying);
            if (flagged !== -1) return flagged;

            // 3) Fallback: videoId match, but only if unambiguous (single match)
            if (state.currentVideoId) {
                let matchIndex = -1;
                let matchCount = 0;
                for (let i = 0; i < newProcessedQueue.length; i++) {
                    if (newProcessedQueue[i]?.videoId === state.currentVideoId) {
                        matchIndex = i;
                        matchCount++;
                    }
                }
                if (matchCount === 1) return matchIndex;
            }

            return null;
        };

        state.currentPlayingIndex = resolveCurrentIndex();



        const currentQueueLength = newProcessedQueue.length;
        const queueLengthIncreased = state.previousQueueLength > 0 && currentQueueLength > state.previousQueueLength;
        const shouldScroll = songAddedFromServer || (queueLengthIncreased && state.shouldScrollToBottom);

        if (state.highlightTimeout) {
            clearTimeout(state.highlightTimeout);
            state.highlightTimeout = null;
        }

        document.querySelectorAll('.song.newly-added').forEach(el => {
            el.classList.remove('newly-added');
        });

        if (queueLengthIncreased && shouldScroll) {
            const newIndex = newProcessedQueue.length - 1;
            state.newlyAddedIndex = newIndex;
            state.highlightTimeout = setTimeout(() => {
                if (state.newlyAddedIndex !== null) {
                    const newlyAddedElement = document.querySelector(`.song[data-index="${state.newlyAddedIndex}"]`);
                    if (newlyAddedElement) {
                        newlyAddedElement.classList.remove('newly-added');
                    }
                }
                state.newlyAddedIndex = null;
                state.highlightTimeout = null;
            }, 3000);
        } else {
            if (state.newlyAddedIndex !== null) {
                const existingHighlight = document.querySelector(`.song[data-index="${state.newlyAddedIndex}"]`);
                if (existingHighlight) {
                    existingHighlight.classList.remove('newly-added');
                }
                state.newlyAddedIndex = null;
            }
        }

        state.processedQueueData = newProcessedQueue;
        renderQueue();
        updateNowPlayingHighlight();
        updateStats();

        if (queueLengthIncreased && shouldScroll) {
            console.log(`[${source.toUpperCase()}] New song added (${state.previousQueueLength} -> ${currentQueueLength}), scheduling gentle auto-scroll...`);
            scrollToBottom(null, {
                delay: QUEUE_AUTOSCROLL_ADD_DELAY_MS,
                ignoreCursorCheck: false
            });
            state.shouldScrollToBottom = false;
        } else {
            if (state.currentVideoId) {
                scrollToCurrentSong(false, QUEUE_AUTOSCROLL_SONG_DELAY_MS);
            }
        }

        state.previousQueueLength = currentQueueLength;
        console.log(`[${source.toUpperCase()}] Queue updated successfully: ${state.processedQueueData.length} items`);
    } catch (error) {
        console.error('Error updating queue:', error);
        const queueDiv = document.getElementById('queue');
        if (queueDiv) {
            queueDiv.innerHTML = `
                <div style="color: red; padding: 20px;">
                    Error updating queue: ${error.message}
                </div>
            `;
        }
    } finally {
        queueUpdateInProgress = false;
    }
}

export async function updateQueue() {
    if (state.ws && state.ws.readyState === WebSocket.OPEN && state.processedQueueData && state.processedQueueData.length > 0) {
        console.log('WebSocket is connected, skipping API fetch');
        return;
    }

    try {
        console.log('Fetching queue from API...');
        const response = await fetch(`${API_URL}/queue`, {
            method: 'GET',
            headers: {
                'Content-Type': 'application/json',
            },
            cache: 'no-cache'
        });

        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        const data = await response.json();
        if (!data || !data.items) {
            throw new Error('Invalid response format');
        }

        updateQueueFromData(data, 'api');
    } catch (error) {
        console.error('Error fetching queue:', error);
        const queueDiv = document.getElementById('queue');
        if (queueDiv) {
            if (!state.processedQueueData || state.processedQueueData.length === 0) {
                queueDiv.innerHTML = `
                    <div style="color: red; padding: 20px;">
                        Error loading queue: ${error.message}
                        <br><button onclick="window.updateQueue()" style="margin-top: 10px; padding: 5px 10px;">Retry</button>
                    </div>
                `;
            } else {
                console.log('Using cached queue data due to fetch error');
            }
        }
    }
}

export function updateStats() {
    const stats = document.getElementById('queue-stats');
    if (!stats) return;

    const rawCount = state.rawQueueData ? state.rawQueueData.length : 0;
    const processedCount = state.processedQueueData ? state.processedQueueData.length : 0;
    const failedCount = state.failedItems.length;
    const displayedCount = processedCount;
    const signature = `${rawCount}|${processedCount}|${failedCount}|${displayedCount}`;

    if (signature === lastStatsSignature) {
        return;
    }
    lastStatsSignature = signature;

    stats.textContent = `Raw Queue Items: ${rawCount} | Processed Items: ${processedCount} | Failed Items: ${failedCount} | Displayed Items: ${displayedCount}`;
}

// Drag and drop handlers
export function handleDragStart(e) {
    if (this.classList.contains('now-playing') || this.classList.contains('unavailable')) {
        e.preventDefault();
        return false;
    }
    noteQueueInteraction(QUEUE_AUTOSCROLL_IDLE_MS + 800);
    state.draggedItem = this;
    state.draggedIndex = parseInt(this.dataset.index);
    this.classList.add('dragging');
    this.style.opacity = '0.5';
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', state.draggedIndex);
    
    const dragImage = this.cloneNode(true);
    dragImage.style.width = this.offsetWidth + 'px';
    dragImage.style.position = 'absolute';
    dragImage.style.top = '-1000px';
    document.body.appendChild(dragImage);
    e.dataTransfer.setDragImage(dragImage, 0, 0);
    setTimeout(() => document.body.removeChild(dragImage), 0);
}

export function handleDragEnd(e) {
    this.classList.remove('dragging');
    this.style.opacity = '';
    noteQueueInteraction(QUEUE_AUTOSCROLL_IDLE_MS + 800);
    state.draggedItem = null;
    state.draggedIndex = null;
    
    document.querySelectorAll('.song').forEach(song => {
        song.classList.remove('drag-over');
        song.style.transform = '';
    });
}

export function handleDragOver(e) {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    
    const currentPlayingIndex = getEffectiveCurrentPlayingIndex();
    const targetIndex = parseInt(this.dataset.index);
    
    if (targetIndex <= currentPlayingIndex) {
        e.dataTransfer.dropEffect = 'none';
        return false;
    }
    
    this.classList.add('drag-over');
    this.style.transform = 'translateX(10px)';
    return false;
}

export function handleDragEnter(e) {
    e.preventDefault();
    const currentPlayingIndex = getEffectiveCurrentPlayingIndex();
    const targetIndex = parseInt(this.dataset.index);
    
    if (targetIndex > currentPlayingIndex && !this.classList.contains('unavailable') && !this.classList.contains('now-playing')) {
        this.classList.add('drag-over');
    }
}

export function handleDragLeave(e) {
    this.classList.remove('drag-over');
    this.style.transform = '';
}

export async function handleDrop(e) {
    e.preventDefault();
    e.stopPropagation();
    
    this.classList.remove('drag-over');
    this.style.transform = '';
    
    if (!state.draggedItem || state.draggedItem === this) return;
    
    const sourceIndex = state.draggedIndex;
    const targetIndex = parseInt(this.dataset.index);
    
    if (sourceIndex === targetIndex) return;
    
    const currentPlayingIndex = getEffectiveCurrentPlayingIndex();
    
    if (targetIndex <= currentPlayingIndex) {
        logMessage("Cannot move songs before or onto the currently playing song");
        return;
    }
    
    try {
        logMessage(`Moving song from position ${sourceIndex} to ${targetIndex}`);
        
        const loadingIndicator = document.createElement('div');
        loadingIndicator.className = 'loading-indicator';
        loadingIndicator.innerHTML = '<span class="material-icons" style="animation: spin 1s infinite linear;">autorenew</span>';
        loadingIndicator.style.position = 'fixed';
        loadingIndicator.style.top = '50%';
        loadingIndicator.style.left = '50%';
        loadingIndicator.style.transform = 'translate(-50%, -50%)';
        loadingIndicator.style.background = 'rgba(0, 0, 0, 0.7)';
        loadingIndicator.style.padding = '20px';
        loadingIndicator.style.borderRadius = '10px';
        loadingIndicator.style.zIndex = '10000';
        document.body.appendChild(loadingIndicator);
        
        const response = await fetch(`${API_URL}/queue/${sourceIndex}`, {
            method: 'PATCH',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ toIndex: targetIndex })
        });

        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        logMessage(`Successfully moved song to position ${targetIndex}`);
    } catch (error) {
        logMessage(`Error moving song: ${error.message}`);
    } finally {
        const loadingIndicator = document.querySelector('.loading-indicator');
        if (loadingIndicator && loadingIndicator.parentNode) {
            loadingIndicator.parentNode.removeChild(loadingIndicator);
        }
    }
    
    return false;
}
