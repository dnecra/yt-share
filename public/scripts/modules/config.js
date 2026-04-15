// Configuration and shared state
export const API_URL = '/api/v1';
export const MAX_RECONNECT_ATTEMPTS = 10;
export const YT_API_KEY = globalThis.YT_API_KEY || '';
export const RAPIDAPI_HOST = 'youtube-music-api3.p.rapidapi.com';
export const RAPIDAPI_KEY = globalThis.RAPIDAPI_KEY || '6e9c0a131fmshb2c000221e56a88p1505d8jsn8afc28ef47a5';

export function hasUsableYouTubeApiKey() {
    return Boolean(YT_API_KEY) && !/YOUR_|REPLACE|CHANGEME/i.test(String(YT_API_KEY));
}

export function hasUsableRapidApiKey() {
    return Boolean(RAPIDAPI_KEY) && !/YOUR_|REPLACE|CHANGEME/i.test(String(RAPIDAPI_KEY));
}

// Shared state
export const state = {
    currentVideoId: null,
    currentLyrics: [],
    lyricsOffset: 0,
    isSyncedLyrics: false,
    lastFetchedVideoId: null,
    currentFetchVideoId: null,
    lastLyricsRequestKey: null,
    lyricsCandidateOffset: 0,
    lyricsCandidateTotal: 0,
    isPaused: false,
    currentSongData: null,
    currentPlayingIndex: null,
    
    // WebSocket
    ws: null,
    reconnectAttempts: 0,
    
    // Timers
    lyricsTimer: null,
    progressTimer: null,
    // Queue (main app only)
    rawQueueData: null,
    processedQueueData: null,
    previousQueueLength: 0,
    shouldScrollToBottom: false,
    newlyAddedIndex: null,
    highlightTimeout: null,
    scrollTimeout: null,
    queueAutoScrollResumeAt: 0,
    queueAutoScrollPendingReason: '',
    queueLastInteractionAt: 0,
    queueUserInteracting: false,
    queueInteractionReleaseTimer: null,
    failedItems: [],
    draggedItem: null,
    draggedIndex: null,
    
    // UI state (main app only)
    isCursorOnPage: false,
    lyricsManuallyCollapsed: false,
    lyricsAutoCollapsed: false,
    suppressLyricsAutoExpand: false,
    lastUpdateTime: 0,
    lastProgressUpdate: 0,
    lastServerProgressAt: 0,
    serverProgressBaseAt: 0,
    serverProgressBaseElapsed: 0,
    playbackAnchorAt: 0,
    playbackAnchorElapsed: 0,
    
    // Volume
    isUserAdjustingVolume: false,
    lastLocalVolumeUpdateMs: 0,
    serverVolumeScale: 'percent',
    volumePercent: 0,
    volumeLastServerValue: null,
    volumeLastServerPercent: null,
    volumeRemoteSyncLockUntil: 0,
    lastVolumeSentAt: 0,
    lastVolumeSentValue: null,
    volumeDebounceTimer: null,
    
    // Mobile
    mobileSection: 'right'
};

// Reset state for new song
export function resetSongState() {
    state.currentLyrics = [];
    state.isSyncedLyrics = false;
    state.lyricsOffset = 0;
    state.lastFetchedVideoId = null;
    state.currentFetchVideoId = null;
    state.lastLyricsRequestKey = null;
    state.lyricsCandidateOffset = 0;
    state.lyricsCandidateTotal = 0;
    state.lastProgressUpdate = 0;
    state.lastServerProgressAt = 0;
    state.serverProgressBaseAt = 0;
    state.serverProgressBaseElapsed = 0;
    state.playbackAnchorAt = 0;
    state.playbackAnchorElapsed = 0;
}
