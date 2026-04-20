import { state } from './config.js';
import { previousTrack, nextTrack, togglePlay, toggleMute, updateVolume, updateVolumeUI } from './navigation.js';
import { logMessage, formatTime } from './utils.js';

// WebSocket message handler moved from main.js
export function handleWebSocketMessage(message) {
    switch (message.type) {
        case 'queue_updated':
            console.log('[CLIENT-WS] Received queue_updated message', message.data ? `with ${message.data.items?.length || 0} items` : 'without data');
            if (message.data) {
                if (window.updateQueueFromData) {
                    window.updateQueueFromData(message.data, 'websocket', message.songAdded || false);
                }
            } else {
                console.warn('[CLIENT-WS] Queue update received without data, fetching from API...');
                if (window.updateQueue) window.updateQueue();
            }
            break;

        case 'navigation_success':
            console.log('[CLIENT-WS] Navigation success:', message.data);
            if (message.data && message.data.targetIndex !== undefined) {
                state.currentPlayingIndex = message.data.targetIndex;
            }
            break;

        case 'navigation_error':
            console.error('[CLIENT-WS] Navigation error:', message.error);
            if (logMessage) logMessage(`Navigation error: ${message.error}`);
            break;

        case 'song_updated':
            if (message.data) {
                // Update the _isCurrentlyPlaying flag in queue data
                if (state.processedQueueData && Array.isArray(state.processedQueueData) && message.data.videoId) {
                    // Clear all _isCurrentlyPlaying flags
                    state.processedQueueData.forEach(item => {
                        if (item) item._isCurrentlyPlaying = false;
                    });
                    
                    // Set the flag on the currently playing song
                    // Use currentPlayingIndex if we have it and it matches
                    if (Number.isInteger(state.currentPlayingIndex) && 
                        state.currentPlayingIndex >= 0 && 
                        state.currentPlayingIndex < state.processedQueueData.length &&
                        state.processedQueueData[state.currentPlayingIndex]?.videoId === message.data.videoId) {
                        state.processedQueueData[state.currentPlayingIndex]._isCurrentlyPlaying = true;
                    } else {
                        // Find first match by videoId
                        const matchIndex = state.processedQueueData.findIndex(item => item?.videoId === message.data.videoId);
                        if (matchIndex !== -1) {
                            state.processedQueueData[matchIndex]._isCurrentlyPlaying = true;
                            state.currentPlayingIndex = matchIndex;
                        }
                    }
                }
                
                if (window.updateNowPlayingFromData) {
                    window.updateNowPlayingFromData(message.data, {
                        isMainApp: true,
                        onSongChange: (data) => {
                            if (state.processedQueueData && Array.isArray(state.processedQueueData)) {
                                updateNowPlayingHighlight();
                                if (window.scrollToCurrentSong) window.scrollToCurrentSong(true);
                            }
                        },
                        onLyricsDisplay: (d, v) => { if (window.displayLyricsOnMainPage) window.displayLyricsOnMainPage(d, v); },
                        onLyricsHide: () => { if (window.hideLyricsOnMainPage) window.hideLyricsOnMainPage(); }
                    });
                }
                // Always update highlight when song changes
                updateNowPlayingHighlight();
            }
            break;

        case 'lyrics_updated':
            if (message.data && message.data.videoId === state.currentVideoId) {
                console.log(`[LYRICS] ✓ Received shared lyrics for: ${message.data.title} by ${message.data.artist}`);
                if (window.displayLyricsOnMainPage) window.displayLyricsOnMainPage(message.data.lyrics, message.data.videoId);
            }
            break;

        case 'song_progress':
            if (message.data && message.data.elapsedSeconds !== undefined) {
                const serverElapsed = Number(message.data.elapsedSeconds) || 0;
                const serverDuration = message.data.songDuration;
                const nowMs = Date.now();
                const sampledAtMs = Number(message.data.sampledAtMs) || nowMs;
                state.lastServerProgressAt = nowMs;
                state.lastProgressUpdate = serverElapsed;
                state.serverProgressBaseAt = sampledAtMs;
                state.serverProgressBaseElapsed = serverElapsed;
                state.playbackAnchorAt = sampledAtMs;
                state.playbackAnchorElapsed = serverElapsed;

                const progressBar = document.getElementById('nowplaying-progress');
                if (progressBar && serverDuration && serverDuration > 0) {
                    progressBar.value = (serverElapsed / serverDuration) * 100;
                }

                const timeDisplay = document.getElementById('nowplaying-time');
                if (timeDisplay && serverDuration) {
                    timeDisplay.textContent = `${formatTime(serverElapsed)} / ${formatTime(serverDuration)}`;
                }

                const rightProgressBar = document.getElementById('right-nowplaying-progress');
                if (rightProgressBar && serverDuration && serverDuration > 0) {
                    rightProgressBar.value = (serverElapsed / serverDuration) * 100;
                }

                if (window.updateLyricsDisplay) {
                    window.updateLyricsDisplay(serverElapsed, { trustedTiming: true });
                }

                if (state.currentSongData) {
                    state.currentSongData.elapsedSeconds = serverElapsed;
                    state.currentSongData.sampledAtMs = sampledAtMs;
                    if (serverDuration) {
                        state.currentSongData.songDuration = serverDuration;
                    }
                    if (message.data.isPaused !== undefined) {
                        state.currentSongData.isPaused = !!message.data.isPaused;
                    }
                }
            }
            break;

        case 'playback_updated':
            if (message.data) {
                if (window.updateNowPlayingFromData) {
                    window.updateNowPlayingFromData(message.data, {
                        isMainApp: true,
                        onSongChange: (data) => {
                            if (state.processedQueueData && Array.isArray(state.processedQueueData)) {
                                updateNowPlayingHighlight();
                                if (window.scrollToCurrentSong) window.scrollToCurrentSong(true);
                            }
                        },
                        onLyricsDisplay: (d, v) => { if (window.displayLyricsOnMainPage) window.displayLyricsOnMainPage(d, v); },
                        onLyricsHide: () => { if (window.hideLyricsOnMainPage) window.hideLyricsOnMainPage(); }
                    });
                }
            }
            break;

        case 'volume_updated':
            if (message.data && message.data.volume !== undefined) {
                if (updateVolumeUI) updateVolumeUI(message.data.volume, { optimistic: !!message.optimistic, source: 'ws' });
            }
            break;

        case 'volume_success':
            if (message.data && message.data.volume !== undefined) {
                if (updateVolumeUI) updateVolumeUI(message.data.volume, { source: 'ws-success' });
            }
            break;

        case 'volume_error':
            console.error('[CLIENT-WS] Volume error:', message.error);
            if (logMessage) logMessage(`Volume error: ${message.error}`);
            break;
    }
}

// Toast notification
let toastTimeout = null;

export function showToast(message) {
    const toast = document.getElementById('toast');
    if (!toast) return;

    toast.textContent = message;
    toast.classList.add('show');

    if (toastTimeout) clearTimeout(toastTimeout);
    toastTimeout = setTimeout(() => {
        toast.classList.remove('show');
    }, 1800);
}

// Popout window
export function openPopoutWindow() {
    const w = 480;
    const h = window.screen.availHeight;
    window.open(
        window.location.pathname + '?popout=1',
        'yt-share-popout',
        `width=${w},height=${h},left=0,top=0,resizable=yes,scrollbars=yes`
    );
}

export function isPopoutMode() {
    return window.location.search.includes('popout=1');
}

// Mobile section toggle
export function toggleMobileSection() {
    if (window.innerWidth > 768) return;

    if (state.mobileSection === 'right') {
        document.body.classList.add('show-left-section');
        state.mobileSection = 'left';
    } else {
        document.body.classList.remove('show-left-section');
        state.mobileSection = 'right';
    }

    updatePopoutToggleBtn();
}

export function updatePopoutToggleBtn() {
    const btn = document.getElementById('popout-toggle-btn');
    if (!btn) return;

    if (window.innerWidth <= 768 || isPopoutMode()) {
        btn.style.display = 'flex';
        btn.querySelector('.material-icons').textContent = (state.mobileSection === 'right') ? 'queue_music' : 'list';
    } else {
        btn.style.display = 'none';
    }
}

// Search UI
export function toggleSearchResults() {
    const searchResults = document.getElementById('search-results');
    const hideButton = document.getElementById('hide-button');
    if (!searchResults || !hideButton) return;

    if (searchResults.classList.contains('active')) {
        searchResults.classList.remove('active');
        hideButton.textContent = 'show search';
    } else {
        searchResults.classList.add('active');
        hideButton.textContent = 'hide search';
    }
}

export function switchTab(tabName) {
    document.querySelectorAll('.search-tab').forEach(tab => {
        tab.classList.remove('active');
    });
    
    const targetTab = document.getElementById(`${tabName}-tab`);
    if (targetTab) targetTab.classList.add('active');

    document.querySelectorAll('.tab-content').forEach(content => {
        content.classList.remove('active');
    });
    
    const targetContent = document.getElementById(`${tabName}-results`);
    if (targetContent) targetContent.classList.add('active');

    if (typeof window.loadSearchTab === 'function') {
        window.loadSearchTab(tabName);
    }
}

// Keyboard shortcuts
export function initKeyboardShortcuts() {
    document.addEventListener('keydown', function(e) {
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

        switch(e.key) {
            case ' ':
                e.preventDefault();
                togglePlay();
                break;
            case 'ArrowRight':
            case 'n':
                e.preventDefault();
                nextTrack();
                break;
            case 'ArrowLeft':
            case 'p':
                e.preventDefault();
                previousTrack();
                break;
            case 'ArrowUp':
                e.preventDefault();
                const volSlider = document.querySelector('.volume-slider');
                if (volSlider) {
                    volSlider.value = Math.min(100, parseInt(volSlider.value) + 5);
                    updateVolume(volSlider.value);
                }
                break;
            case 'ArrowDown':
                e.preventDefault();
                const volSliderDown = document.querySelector('.volume-slider');
                if (volSliderDown) {
                    volSliderDown.value = Math.max(1, parseInt(volSliderDown.value) - 5);
                    updateVolume(volSliderDown.value);
                }
                break;
            case 'j':
                e.preventDefault();
                // Scroll to current song - requires queue module
                if (window.scrollToCurrentSong) {
                    window.scrollToCurrentSong(true);
                }
                break;
        }
    });
}

// Mobile swipe detection
export function initMobileSwipe() {
    let touchStartX = 0;
    let touchStartY = 0;
    let touchEndX = 0;
    let touchEndY = 0;
    const minSwipeDistance = 80;
    let isSwiping = false;

    function handleTouchStart(e) {
        if (e.touches.length !== 1 || window.innerWidth > 768) return;
        touchStartX = e.touches[0].clientX;
        touchStartY = e.touches[0].clientY;
        touchEndX = touchStartX;
        touchEndY = touchStartY;
        isSwiping = false;
    }

    function handleTouchMove(e) {
        if (e.touches.length !== 1 || window.innerWidth > 768) return;
        touchEndX = e.touches[0].clientX;
        touchEndY = e.touches[0].clientY;
        
        const dx = Math.abs(touchEndX - touchStartX);
        const dy = Math.abs(touchEndY - touchStartY);
        
        if (dx > dy && dx > 20) {
            isSwiping = true;
            e.preventDefault();
        }
    }

    function handleTouchEnd(e) {
        if (!isSwiping || window.innerWidth > 768) {
            isSwiping = false;
            return;
        }
        
        const dx = touchEndX - touchStartX;
        const dy = touchEndY - touchStartY;

        if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > minSwipeDistance) {
            toggleMobileSection();
        }
        
        isSwiping = false;
    }

    document.addEventListener('touchstart', handleTouchStart, {passive: true});
    document.addEventListener('touchmove', handleTouchMove, {passive: false});
    document.addEventListener('touchend', handleTouchEnd, {passive: true});
}

// Cursor tracking (for auto-scroll)
export function initCursorTracking() {
    document.addEventListener('mouseenter', () => {
        state.isCursorOnPage = true;
    });

    document.addEventListener('mouseleave', () => {
        state.isCursorOnPage = false;
    });
}

// Resize handler
export function initResizeHandler() {
    let floatingSearchHomeParent = null;
    let floatingSearchHomeNextSibling = null;
    let streamBtnHomeParent = null;
    let streamBtnHomeNextSibling = null;
    let volumeControlHomeParent = null;
    let volumeControlHomeNextSibling = null;
    let volumeFabInitialized = false;

    const applyMobileSearchPlacement = () => {
        const floatingSearch = document.getElementById('floating-search');
        const leftSection = document.getElementById('left-section');
        const nowPlaying = document.getElementById('nowplaying');
        if (!floatingSearch || !leftSection) return;

        if (!floatingSearchHomeParent) {
            floatingSearchHomeParent = floatingSearch.parentElement;
            floatingSearchHomeNextSibling = floatingSearch.nextElementSibling;
        }

        const isMobile = window.innerWidth <= 768;

        if (isMobile) {
            if (nowPlaying) nowPlaying.style.display = 'none';
            if (floatingSearch.parentElement !== leftSection) {
                leftSection.insertBefore(floatingSearch, leftSection.firstChild);
            }
            document.body.classList.add('search-on-left');
            return;
        }

        if (nowPlaying) nowPlaying.style.display = '';
        if (floatingSearchHomeParent && floatingSearch.parentElement !== floatingSearchHomeParent) {
            if (floatingSearchHomeNextSibling && floatingSearchHomeNextSibling.parentElement === floatingSearchHomeParent) {
                floatingSearchHomeParent.insertBefore(floatingSearch, floatingSearchHomeNextSibling);
            } else {
                floatingSearchHomeParent.appendChild(floatingSearch);
            }
        }
        document.body.classList.remove('search-on-left');
    };

    const applyMobileStreamButtonPlacement = () => {
        const streamBtn = document.getElementById('stream-btn');
        const bottomControls = document.getElementById('bottom-controls');
        if (!streamBtn || !bottomControls) return;

        if (!streamBtnHomeParent) {
            streamBtnHomeParent = streamBtn.parentElement;
            streamBtnHomeNextSibling = streamBtn.nextElementSibling;
        }

        const isMobile = window.innerWidth <= 768;

        if (isMobile) {
            if (streamBtn.parentElement !== bottomControls) {
                bottomControls.appendChild(streamBtn);
            }
            streamBtn.classList.add('mobile-bottom-stream');
            return;
        }

        streamBtn.classList.remove('mobile-bottom-stream');
        if (streamBtnHomeParent && streamBtn.parentElement !== streamBtnHomeParent) {
            if (streamBtnHomeNextSibling && streamBtnHomeNextSibling.parentElement === streamBtnHomeParent) {
                streamBtnHomeParent.insertBefore(streamBtn, streamBtnHomeNextSibling);
            } else {
                streamBtnHomeParent.appendChild(streamBtn);
            }
        }
    };

    const applyMobileVolumePlacement = () => {
        const volumeControl = document.querySelector('.volume-control');
        const bottomControls = document.getElementById('bottom-controls');
        if (!volumeControl || !bottomControls) return;

        if (!volumeControlHomeParent) {
            volumeControlHomeParent = volumeControl.parentElement;
            volumeControlHomeNextSibling = volumeControl.nextElementSibling;
        }

        const isMobile = window.innerWidth <= 768;
        if (isMobile) {
            if (volumeControl.parentElement !== document.body) {
                document.body.appendChild(volumeControl);
            }
            volumeControl.classList.add('mobile-volume-floating');
            return;
        }

        volumeControl.classList.remove('mobile-volume-floating');
        if (volumeControlHomeParent && volumeControl.parentElement !== volumeControlHomeParent) {
            if (volumeControlHomeNextSibling && volumeControlHomeNextSibling.parentElement === volumeControlHomeParent) {
                volumeControlHomeParent.insertBefore(volumeControl, volumeControlHomeNextSibling);
            } else {
                volumeControlHomeParent.appendChild(volumeControl);
            }
        }
    };

    const initMobileVolumeFab = () => {
        if (volumeFabInitialized) return;

        const volumeControl = document.querySelector('.volume-control');
        const volumeButton = document.querySelector('.volume-control .volume-icon-button');
        const volumeSlider = document.querySelector('.volume-control .volume-slider');
        if (!volumeControl || !volumeButton || !volumeSlider) return;

        if (!volumeButton.dataset.desktopOnclick) {
            volumeButton.dataset.desktopOnclick = volumeButton.getAttribute('onclick') || 'toggleMute()';
        }
        if (volumeButton.getAttribute('onclick')) {
            volumeButton.removeAttribute('onclick');
        }

        const setAdjusting = (active) => {
            if (window.innerWidth <= 768) {
                document.body.classList.toggle('mobile-volume-adjusting', !!active);
                return;
            }
            document.body.classList.remove('mobile-volume-adjusting');
        };
        const syncMobileVolumeIconState = () => {
            const value = parseInt(volumeSlider.value, 10);
            const safe = Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 0;
            volumeControl.classList.remove('volume-muted', 'volume-half', 'volume-max');
            if (safe <= 0) {
                volumeControl.classList.add('volume-muted');
            } else if (safe <= 50) {
                volumeControl.classList.add('volume-half');
            } else {
                volumeControl.classList.add('volume-max');
            }
        };

        const beginAdjust = () => setAdjusting(true);
        const endAdjust = () => setTimeout(() => setAdjusting(false), 80);

        volumeSlider.addEventListener('pointerdown', beginAdjust);
        volumeSlider.addEventListener('mousedown', beginAdjust);
        volumeSlider.addEventListener('touchstart', beginAdjust, { passive: true });
        volumeSlider.addEventListener('focus', beginAdjust);
        volumeSlider.addEventListener('keydown', beginAdjust);

        window.addEventListener('pointerup', endAdjust, { passive: true });
        window.addEventListener('mouseup', endAdjust, { passive: true });
        window.addEventListener('touchend', endAdjust, { passive: true });
        window.addEventListener('touchcancel', endAdjust, { passive: true });
        volumeSlider.addEventListener('blur', endAdjust);
        volumeSlider.addEventListener('keyup', endAdjust);
        window.addEventListener('blur', () => setAdjusting(false));
        volumeSlider.addEventListener('input', syncMobileVolumeIconState);
        volumeSlider.addEventListener('change', syncMobileVolumeIconState);

        volumeButton.addEventListener('click', (event) => {
            if (window.innerWidth > 768) {
                toggleMute();
            }
        });

        syncMobileVolumeIconState();
        volumeFabInitialized = true;
    };

    applyMobileSearchPlacement();
    applyMobileStreamButtonPlacement();
    applyMobileVolumePlacement();
    initMobileVolumeFab();

    window.addEventListener('resize', function() {
        if (window.innerWidth > 768) {
            document.body.classList.remove('show-left-section');
            document.body.classList.remove('mobile-volume-adjusting');
            state.mobileSection = 'right';
        }
        applyMobileSearchPlacement();
        applyMobileStreamButtonPlacement();
        applyMobileVolumePlacement();
        initMobileVolumeFab();
        updatePopoutToggleBtn();
    });
}

// Update now-playing highlight in the queue UI
export function updateNowPlayingHighlight() {
    // Clear previous highlight states
    const songEls = Array.from(document.querySelectorAll('.song'));
    songEls.forEach(el => {
        el.classList.remove('active', 'now-playing');
        // Keep draggable state for unavailable items
        if (!el.classList.contains('unavailable')) {
            el.draggable = true;
        }
    });

    let targetIndex = null;
    const processed = state.processedQueueData;

    // 1) Prefer index-based tracking (duplicate-safe)
    if (Number.isInteger(state.currentPlayingIndex) &&
        processed && Array.isArray(processed) &&
        state.currentPlayingIndex >= 0 &&
        state.currentPlayingIndex < processed.length) {
        targetIndex = state.currentPlayingIndex;
    }

    // 2) Item marked by server or by YouTube's own `selected` flag  
    if (targetIndex === null && processed && Array.isArray(processed)) {
        const flagged = processed.findIndex(s => s && s._isCurrentlyPlaying);
        if (flagged !== -1) targetIndex = flagged;
    }

    // 3) Fallback: videoId match, but only if unambiguous (single match)
    if (targetIndex === null && state.currentVideoId && processed && Array.isArray(processed)) {
        let matchIndex = -1;
        let matchCount = 0;
        for (let i = 0; i < processed.length; i++) {
            if (processed[i]?.videoId === state.currentVideoId) {
                matchIndex = i;
                matchCount++;
            }
        }
        if (matchCount === 1) targetIndex = matchIndex;
    }

    state.currentPlayingIndex = Number.isInteger(targetIndex) ? targetIndex : null;

    if (state.currentPlayingIndex !== null) {
        const el = document.querySelector(`.song[data-index="${state.currentPlayingIndex}"]`);
        if (el) {
            el.classList.add('active', 'now-playing');
            el.draggable = false;
        }
    }
}




// Popout mode handler
export function handlePopoutMode() {
    if (isPopoutMode()) {
        const left = document.getElementById('left-section');
        if (left) left.style.display = 'none';

        const right = document.getElementById('right-section');
        if (right) {
            right.style.width = '100vw';
            right.style.maxWidth = '100vw';
            right.style.border = 'none';
            right.style.position = 'static';
        }

        const popoutBtn = document.getElementById('popout-button');
        if (popoutBtn) popoutBtn.style.display = 'none';

        const layout = document.getElementById('layout-container');
        if (layout) layout.style.flexDirection = 'column';

        document.body.style.overflow = 'auto';
    }
}

// Initialize mobile hint popup
export function initMobileHint() {
    if (window.innerWidth <= 768) {
        const hasSeenHint = localStorage.getItem('yt-music-remote-hint-seen');
        
        if (!hasSeenHint) {
            const hintPopup = document.getElementById('mobile-hint-popup');
            if (hintPopup) {
                hintPopup.style.display = 'flex';
                setTimeout(() => {
                    hintPopup.style.display = 'none';
                    localStorage.setItem('yt-music-remote-hint-seen', 'true');
                }, 3000);
            }
        }
    }
}
