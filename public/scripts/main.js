import { state } from './modules/config.js';
import { API_URL } from './modules/config.js';
import { initWebSocket } from './modules/connection.js';
import { updateNowPlayingFromData } from './modules/now-playing.js';
import { updateVolumeUI, initVolumeControls, previousTrack, nextTrack, togglePlay, toggleMute, updateVolume } from './modules/navigation.js';
import { displayLyricsUI, hideLyricsUI, toggleLyricsCollapse, updateLyricsDisplay } from './modules/lyric.js';
import { deleteSongFromQueue, moveSongInQueue, moveSongNext, clearQueue, shuffleQueue, addToQueue, updateQueueFromData, updateQueue, scrollToCurrentSong } from './modules/queue.js';
import { 
    showToast, toggleSearchResults, switchTab, initKeyboardShortcuts, 
    initMobileSwipe, initCursorTracking, initResizeHandler, 
    handlePopoutMode, updatePopoutToggleBtn, initMobileHint, toggleMobileSection,
    updateNowPlayingHighlight, handleWebSocketMessage, openPopoutWindow
} from './modules/ui.js';
import { 
    handleUnifiedInput, initUnifiedInputListener, toggleStream, 
    initAudioStreamErrorHandler, initVolumeControl
} from './modules/app.js';
import { initFloatingLyricsToggleButton, initFloatingLyricsDownloadButton } from './modules/floating-lyrics.js';

// Keep "hide lines after active blank-note" disabled on main index page.
window.__lyricsBlankCutoffEnabled = false;
window.__lyricsLeadingGhostLinesCount = 0;
window.__lyricsLeadingSpacingGhostLinesCount = 0;

const MAIN_LYRICS_FONT_SETTINGS_KEY = 'mainLyricsFontSizePx';
const MAIN_MIN_LYRICS_FONT_SIZE = 24;
const MAIN_MAX_LYRICS_FONT_SIZE = 96;
const MAIN_LYRICS_FONT_STEP = 4;
const MAIN_LINE_HEIGHT_RATIO = 0.9;
let mainLyricsFontSizePx = null;

function applyMainLyricsFontSize(fontSizePx) {
    const parsed = Number(fontSizePx);
    if (!Number.isFinite(parsed)) return;
    const clamped = Math.max(MAIN_MIN_LYRICS_FONT_SIZE, Math.min(MAIN_MAX_LYRICS_FONT_SIZE, Math.round(parsed)));
    mainLyricsFontSizePx = clamped;

    document.documentElement.style.setProperty('--lyric-font-size', `${clamped}px`);
    document.documentElement.style.setProperty('--lyric-line-height', `${Math.round(clamped * MAIN_LINE_HEIGHT_RATIO)}px`);
}

function loadMainLyricsFontSize() {
    try {
        const raw = localStorage.getItem(MAIN_LYRICS_FONT_SETTINGS_KEY);
        const parsed = Number(raw);
        if (Number.isFinite(parsed)) {
            applyMainLyricsFontSize(parsed);
        }
    } catch (_) {
        // Ignore localStorage read errors.
    }
}

function saveMainLyricsFontSize() {
    try {
        if (Number.isFinite(mainLyricsFontSizePx)) {
            localStorage.setItem(MAIN_LYRICS_FONT_SETTINGS_KEY, String(mainLyricsFontSizePx));
        }
    } catch (_) {
        // Ignore localStorage write errors.
    }
}

function adjustMainLyricsFontSize(delta) {
    const current = Number.isFinite(mainLyricsFontSizePx)
        ? mainLyricsFontSizePx
        : (parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--lyric-font-size')) || 32);
    applyMainLyricsFontSize(current + delta);
    saveMainLyricsFontSize();

    const elapsed = Number(state?.currentSongData?.elapsedSeconds);
    requestAnimationFrame(() => {
        if (Number.isFinite(elapsed) && elapsed >= 0) {
            updateLyricsDisplay(elapsed);
        }
    });
}

function initMainLyricsFontControls() {
    loadMainLyricsFontSize();

    const downBtn = document.getElementById('lyrics-font-down-btn');
    const upBtn = document.getElementById('lyrics-font-up-btn');

    if (downBtn) {
        downBtn.addEventListener('click', () => adjustMainLyricsFontSize(-MAIN_LYRICS_FONT_STEP));
    }
    if (upBtn) {
        upBtn.addEventListener('click', () => adjustMainLyricsFontSize(MAIN_LYRICS_FONT_STEP));
    }
}

if (typeof document !== 'undefined') {
    loadMainLyricsFontSize();
}





// Make functions global for onclick handlers
window.deleteSongFromQueue = deleteSongFromQueue;
window.moveSongInQueue = moveSongInQueue;
window.moveSongNext = moveSongNext;
window.clearQueue = clearQueue;
window.shuffleQueue = shuffleQueue;
window.addToQueueById = (videoId) => {
    addToQueue(videoId).then(success => {
        if (success) showToast('Song added to queue');
    });
};
window.toggleSearchResults = toggleSearchResults;
window.switchTab = switchTab;
window.handleUnifiedInput = handleUnifiedInput;
window.toggleStream = toggleStream;
window.toggleLyricsCollapse = toggleLyricsCollapse;
window.toggleMobileSection = toggleMobileSection;
window.openPopoutWindow = openPopoutWindow;
window.scrollToCurrentSong = scrollToCurrentSong;
window.updateQueue = updateQueue;
window.updateQueueFromData = updateQueueFromData;
window.updateNowPlayingFromData = updateNowPlayingFromData;
window.updateLyricsDisplay = updateLyricsDisplay;
window.replayCurrentLyricStagger = replayCurrentLyricStagger;
// Navigation controls
window.previousTrack = previousTrack;
window.nextTrack = nextTrack;
window.togglePlay = togglePlay;
window.toggleMute = toggleMute;
window.updateVolume = updateVolume;
// Lyrics display wrappers (kept here to preserve callback signatures)
function displayLyricsOnMainPage(data, videoId) {
    const result = displayLyricsUI(data, {
        fetchVideoId: videoId || null,
        validateFetch: () => true,
        logTag: 'MAIN'
    });
    if (Number.isFinite(mainLyricsFontSizePx)) {
        requestAnimationFrame(() => applyMainLyricsFontSize(mainLyricsFontSizePx));
    }
    return result;
}

function hideLyricsOnMainPage() {
    const result = hideLyricsUI({
        clearVideoId: false,
        logTag: 'MAIN'
    });
    if (Number.isFinite(mainLyricsFontSizePx)) {
        requestAnimationFrame(() => applyMainLyricsFontSize(mainLyricsFontSizePx));
    }
    return result;
}

window.displayLyricsOnMainPage = displayLyricsOnMainPage;
window.hideLyricsOnMainPage = hideLyricsOnMainPage;

let initPromise = null;
let isInitialized = false;

function markPageReady() {
    document.body.classList.add('page-ready');
    document.body.classList.remove('page-enter');
}

function initPageLoadAnimation() {
    requestAnimationFrame(markPageReady);
}

function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('/sw.js').catch((error) => {
            console.warn('[PWA] Service worker registration failed:', error);
        });
    }, { once: true });
}

async function fetchInitialState({ onSongUpdate, onVolumeUpdate } = {}) {
    const tasks = [];

    tasks.push((async () => {
        try {
            const response = await fetch(`${API_URL}/song`);
            if (!response.ok) return;

            const data = await response.json();
            if (data && typeof onSongUpdate === 'function') {
                onSongUpdate(data);
            }
        } catch (error) {
            console.error('Failed to fetch initial song state:', error);
        }
    })());

    tasks.push((async () => {
        try {
            const response = await fetch(`${API_URL}/volume`);
            if (!response.ok) return;

            const data = await response.json();
            const volume = data?.volume ?? data?.state ?? data?.value;
            if (typeof volume === 'number' && typeof onVolumeUpdate === 'function') {
                onVolumeUpdate(volume);
            }
        } catch (error) {
            console.error('Failed to fetch initial volume state:', error);
        }
    })());

    await Promise.all(tasks);
}

function replayCurrentLyricStagger() {
    const currentLine = document.querySelector('#synced-lyrics .lyric-line.current, #plain-lyrics .lyric-line.current');
    if (!currentLine) return;

    const words = currentLine.querySelectorAll('.lyric-word');
    if (!words.length) return;

    const safeWordCount = Math.max(1, words.length);
    const staggerMs = Math.max(70, Math.min(180, 520 / safeWordCount));

    words.forEach((word, index) => {
        const delay = `${((index * staggerMs) / 1000).toFixed(3)}s`;
        word.style.willChange = 'opacity, transform';
        word.style.transitionDelay = delay;
        word.style.animationDelay = delay;
    });

    currentLine.classList.remove('activating-current');
    void currentLine.offsetWidth;
    currentLine.classList.add('activating-current');

    requestAnimationFrame(() => {
        requestAnimationFrame(() => {
            setTimeout(() => {
                currentLine.classList.remove('activating-current');
            }, 50);
        });
    });
}

// Initialize app
async function init() {
    if (isInitialized) return initPromise;
    if (initPromise) return initPromise;

    initPromise = (async () => {
    console.log('[MAIN] Initializing...');
    initPageLoadAnimation();
    
    // Initialize UI handlers
    handlePopoutMode();
    initCursorTracking();
    initKeyboardShortcuts();
    initMobileSwipe();
    initResizeHandler();
    updatePopoutToggleBtn();
    initMobileHint();
    
    // Initialize app features
    initUnifiedInputListener();
    initVolumeControl();
    initAudioStreamErrorHandler();
    console.log('[INIT] Audio system initialized');
    initFloatingLyricsToggleButton();
    initFloatingLyricsDownloadButton();
    initMainLyricsFontControls();
    registerServiceWorker();
    
    // Initialize volume controls
    initVolumeControls();
    
    // Fetch initial data
    await updateQueue();
    
    // Initialize WebSocket
    if (typeof WebSocket !== 'undefined' && !state.ws) {
        initWebSocket(handleWebSocketMessage);
    }
    
    // Fetch initial state
    await fetchInitialState({
        onSongUpdate: (data) => {
            updateNowPlayingFromData(data, {
                isMainApp: true,
                onSongChange: (data) => {
                    if (state.processedQueueData && Array.isArray(state.processedQueueData)) {
                        updateNowPlayingHighlight();
                        scrollToCurrentSong(true);
                    }
                },
                onLyricsDisplay: displayLyricsOnMainPage,
                onLyricsHide: hideLyricsOnMainPage
            });
        },
        onVolumeUpdate: updateVolumeUI
    });
    
    console.log('[MAIN] Initialization complete');
    isInitialized = true;
    })();

    try {
        await initPromise;
    } catch (error) {
        markPageReady();
        initPromise = null;
        throw error;
    }
}

// Start app on load
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
} else {
    init();
}
