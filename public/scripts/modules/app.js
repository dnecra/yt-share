import { API_URL } from './config.js';
import { getThumbnailUrl } from './connection.js';
import { logMessage } from './utils.js';
import { addToQueue } from './queue.js';
import { showToast } from './ui.js';

const SEARCH_TAB_CONFIG = {
    music: {
        type: 'song',
        resultContainerId: 'music-results',
        emptyText: 'No music found.',
        errorLabel: 'Music',
        loadingText: 'Searching music...'
    },
    videos: {
        type: 'videos',
        resultContainerId: 'videos-results',
        emptyText: 'No videos found.',
        errorLabel: 'Video',
        loadingText: 'Searching videos...'
    },
    albums: {
        type: 'albums',
        resultContainerId: 'albums-results',
        emptyText: 'No albums found.',
        errorLabel: 'Album',
        loadingText: 'Searching albums...'
    },
    'community-playlists': {
        type: 'community_playlists',
        resultContainerId: 'community-playlists-results',
        emptyText: 'No playlists found.',
        errorLabel: 'Playlist',
        loadingText: 'Searching playlists...'
    }
};

let activeSearchQuery = '';
let lastSearchRequestToken = 0;
const loadedSearchTabsByQuery = new Map();
const inFlightSearchTabs = new Map();

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function escapeJsString(value) {
    return String(value ?? '')
        .replace(/\\/g, '\\\\')
        .replace(/'/g, "\\'");
}

function extractPlaylistIdentity(item) {
    const playlistIdCandidates = [
        item?.playlistId,
        item?.id?.playlistId,
        item?.playlist_id,
        item?.browseId,
        item?.id?.browseId,
        item?.navigationEndpoint?.browseEndpoint?.browseId,
        item?.shareUrl ? (() => {
            try {
                const url = new URL(String(item.shareUrl));
                return url.searchParams.get('list') || '';
            } catch (_) {
                return '';
            }
        })() : ''
    ].map((value) => String(value || '').trim()).filter(Boolean);

    return playlistIdCandidates[0] || '';
}

function extractAlbumIdentity(item) {
    const albumIdCandidates = [
        item?.browseId,
        item?.id?.browseId,
        item?.albumId,
        item?.id?.albumId,
        item?.navigationEndpoint?.browseEndpoint?.browseId
    ].map((value) => String(value || '').trim()).filter(Boolean);

    return albumIdCandidates[0] || '';
}

async function fetchCollectionVideoIds(id, kind) {
    const normalizedId = String(id || '').trim();
    const normalizedKind = String(kind || '').trim().toLowerCase();
    if (!normalizedId) {
        throw new Error(`${normalizedKind || 'Collection'} ID is missing`);
    }
    if (normalizedKind !== 'album' && normalizedKind !== 'playlist') {
        throw new Error('Collection kind is invalid');
    }

    const response = await fetch(`${API_URL}/collection-items?id=${encodeURIComponent(normalizedId)}&kind=${encodeURIComponent(normalizedKind)}`);
    const data = await fetchJsonSafe(response);
    if (!response.ok || !data?.success) {
        throw new Error(data?.error || response.statusText || 'Collection request failed');
    }

    const items = Array.isArray(data?.items) ? data.items : [];
    const videoIds = items
        .map((item) => String(item?.videoId || '').trim())
        .filter(Boolean);

    return Array.from(new Set(videoIds));
}

export async function addCollectionToQueue(id, kind = 'playlist', collectionTitle = 'Playlist') {
    const normalizedId = String(id || '').trim();
    const normalizedKind = String(kind || 'playlist').trim().toLowerCase();
    const defaultTitle = normalizedKind === 'album' ? 'Album' : 'Playlist';
    const safeCollectionTitle = String(collectionTitle || defaultTitle).trim() || defaultTitle;

    if (!normalizedId) {
        showToast(`${defaultTitle} ID not found`);
        return false;
    }

    try {
        showToast(`Loading ${safeCollectionTitle}...`);
        const videoIds = await fetchCollectionVideoIds(normalizedId, normalizedKind);
        if (!videoIds.length) {
            throw new Error(`No videos found in ${normalizedKind}`);
        }

        let successCount = 0;
        for (let index = 0; index < videoIds.length; index += 1) {
            const success = await addToQueue(videoIds[index]);
            if (success) successCount += 1;
            if (index < videoIds.length - 1) {
                await delay(250);
            }
        }

        if (successCount <= 0) {
            throw new Error('Failed to add playlist tracks');
        }

        showToast(`${successCount} songs added from ${safeCollectionTitle}`);
        return true;
    } catch (error) {
        const message = String(error?.message || error || `${defaultTitle} import failed`);
        showToast(`${defaultTitle} add failed: ${message}`);
        if (logMessage) logMessage(`${defaultTitle} add failed: ${message}`);
        return false;
    }
}

function renderSearchResults(resultsDiv, items, options = {}) {
    if (!resultsDiv) return;
    const { emptyText = 'No results found.' } = options;

    const safeText = (v) => (v === null || v === undefined) ? '' : String(v);
    resultsDiv.innerHTML = '';

    if (!Array.isArray(items) || items.length === 0) {
        resultsDiv.innerHTML = `<div style="padding: 20px; text-align: center;">${escapeHtml(emptyText)}</div>`;
        return;
    }

    items.forEach((item) => {
        const videoId =
            item?.id?.videoId ||
            item?.videoId ||
            item?.video_id ||
            (typeof item?.id === 'string' ? item.id : '');

        const title =
            item?.snippet?.title ||
            item?.title ||
            item?.name ||
            'Untitled';
        const playlistId = extractPlaylistIdentity(item);
        const albumId = extractAlbumIdentity(item);

        const subtitleParts = [
            item?.snippet?.channelTitle,
            item?.author,
            Array.isArray(item?.artists) ? item.artists.join(', ') : '',
            item?.channelName,
            item?.channel,
            item?.artist,
            item?.type
        ].map((part) => safeText(part).trim()).filter(Boolean);

        const subtitle = subtitleParts[0] || 'Unknown artist';

        const originalThumbnailUrl =
            item?.snippet?.thumbnails?.high?.url ||
            item?.snippet?.thumbnails?.medium?.url ||
            item?.thumbnail ||
            item?.thumbnails?.[0]?.url ||
            item?.thumbnails?.[0] ||
            '';

        const thumbnailUrl = getThumbnailUrl(originalThumbnailUrl) || originalThumbnailUrl || '/icons/album-cover-placeholder.png';
        let addButtonHtml = '';
        if (videoId) {
            addButtonHtml = `
                <button class="search-results-button" onclick="window.addToQueueById('${escapeHtml(safeText(videoId))}')" title="Add to queue">
                    <span class="material-icons">add</span>
                </button>
            `;
        } else if (albumId) {
            addButtonHtml = `
                <button class="search-results-button" onclick="window.addCollectionToQueue('${escapeJsString(albumId)}', 'album', '${escapeJsString(safeText(title))}')" title="Add all songs from album">
                    <span class="material-icons">album</span>
                </button>
            `;
        } else if (playlistId) {
            addButtonHtml = `
                <button class="search-results-button" onclick="window.addCollectionToQueue('${escapeJsString(playlistId)}', 'playlist', '${escapeJsString(safeText(title))}')" title="Add all songs from playlist">
                    <span class="material-icons">playlist_add</span>
                </button>
            `;
        } else {
            addButtonHtml = `
                <button class="search-results-button" disabled title="No direct video or playlist to add">
                    <span class="material-icons">remove</span>
                </button>
            `;
        }

        const div = document.createElement('div');
        div.className = 'song';
        div.innerHTML = `
            <img class="thumbnail" src="${escapeHtml(thumbnailUrl)}" alt="${escapeHtml(safeText(title))}">
            <div class="details">
                <div class="title">${escapeHtml(safeText(title))}</div>
                <div class="artist-album">${escapeHtml(subtitle)}</div>
            </div>
            ${addButtonHtml}
        `;
        resultsDiv.appendChild(div);
    });
}

async function fetchJsonSafe(res) {
    const contentType = res.headers?.get?.('content-type') || '';
    if (contentType.includes('application/json')) {
        try { return await res.json(); } catch (_) { return null; }
    }
    try { return await res.text(); } catch (_) { return null; }
}

function setSearchLoadingState(tabName, loadingText) {
    const config = SEARCH_TAB_CONFIG[tabName];
    const resultsDiv = document.getElementById(config?.resultContainerId || '');
    if (!resultsDiv) return;
    resultsDiv.innerHTML = `<div style="padding: 20px; text-align: center;">${escapeHtml(loadingText || 'Loading...')}</div>`;
}

function setSearchIdleState(tabName) {
    const config = SEARCH_TAB_CONFIG[tabName];
    const resultsDiv = document.getElementById(config?.resultContainerId || '');
    if (!resultsDiv) return;
    resultsDiv.innerHTML = `<div style="padding: 20px; text-align: center; color: var(--text-secondary);">Click this tab to load results.</div>`;
}

function resetSearchTabCacheForQuery(query) {
    const normalizedQuery = String(query || '').trim();
    if (!normalizedQuery) return;
    loadedSearchTabsByQuery.delete(normalizedQuery);
    for (const key of Array.from(inFlightSearchTabs.keys())) {
        if (key.startsWith(`${normalizedQuery}::`)) {
            inFlightSearchTabs.delete(key);
        }
    }
}

function markSearchTabLoaded(query, tabName) {
    const normalizedQuery = String(query || '').trim();
    if (!normalizedQuery) return;
    const loadedTabs = loadedSearchTabsByQuery.get(normalizedQuery) || new Set();
    loadedTabs.add(tabName);
    loadedSearchTabsByQuery.set(normalizedQuery, loadedTabs);
}

function isSearchTabLoaded(query, tabName) {
    const normalizedQuery = String(query || '').trim();
    if (!normalizedQuery) return false;
    return loadedSearchTabsByQuery.get(normalizedQuery)?.has(tabName) === true;
}

async function searchRapidApiByType(query, type, resultContainerId, emptyText, errorLabel, requestToken = 0) {
    const resultsDiv = document.getElementById(resultContainerId);
    if (!resultsDiv) return;
    const safeText = (v) => (v === null || v === undefined) ? '' : String(v);

    try {
        const rapidResponse = await fetch(`${API_URL}/search?q=${encodeURIComponent(query)}&type=${encodeURIComponent(type)}`);

        const rapidData = await fetchJsonSafe(rapidResponse);
        if (!rapidResponse.ok || !rapidData?.success) {
            const apiMsg =
                rapidData?.error ||
                rapidData?.message ||
                rapidResponse.statusText ||
                `HTTP ${rapidResponse.status}`;
            throw new Error(apiMsg);
        }

        if (requestToken && requestToken !== lastSearchRequestToken) {
            return;
        }
        renderSearchResults(resultsDiv, rapidData?.result || rapidData?.items || [], { emptyText });
    } catch (error) {
        if (requestToken && requestToken !== lastSearchRequestToken) {
            return;
        }
        const msg = safeText(error?.message || error);
        resultsDiv.innerHTML = `<div style="padding: 20px; text-align: center; color: rgba(253,2,52,1);">Error: ${msg}</div>`;
        if (logMessage) logMessage(`${errorLabel} search failed: ${msg}`);
    }
}

export async function loadSearchTab(tabName, query = activeSearchQuery, options = {}) {
    const normalizedTab = String(tabName || '').trim();
    const normalizedQuery = String(query || '').trim();
    const config = SEARCH_TAB_CONFIG[normalizedTab];
    const requestToken = Number(options.requestToken) || lastSearchRequestToken;

    if (!config || !normalizedQuery) return;
    if (requestToken !== lastSearchRequestToken) return;
    if (isSearchTabLoaded(normalizedQuery, normalizedTab)) return;

    const inFlightKey = `${normalizedQuery}::${normalizedTab}`;
    if (inFlightSearchTabs.has(inFlightKey)) {
        return inFlightSearchTabs.get(inFlightKey);
    }

    setSearchLoadingState(normalizedTab, config.loadingText);

    const task = searchRapidApiByType(
        normalizedQuery,
        config.type,
        config.resultContainerId,
        config.emptyText,
        config.errorLabel,
        requestToken
    ).then(() => {
        if (requestToken === lastSearchRequestToken) {
            markSearchTabLoaded(normalizedQuery, normalizedTab);
        }
    }).finally(() => {
        inFlightSearchTabs.delete(inFlightKey);
    });

    inFlightSearchTabs.set(inFlightKey, task);
    return task;
}

// YouTube Music search
export async function searchYouTubeMusic(query) {
    return loadSearchTab('music', query);
}

// YouTube Videos search
export async function searchYouTubeVideos(query) {
    return loadSearchTab('videos', query);
}

export async function searchYouTubeAlbums(query) {
    return loadSearchTab('albums', query);
}

export async function searchYouTubeCommunityPlaylists(query) {
    return loadSearchTab('community-playlists', query);
}

// Unified search handler
export async function handleUnifiedSearch(query) {
    const normalizedQuery = String(query || '').trim();
    if (!normalizedQuery) {
        if (logMessage) logMessage('Please enter a search term.');
        return;
    }

    const searchResults = document.getElementById('search-results');
    const hideButton = document.getElementById('hide-button');
    
    if (searchResults) {
        searchResults.classList.add('active');
    }
    if (hideButton) {
        hideButton.textContent = 'hide search';
    }

    const isNewQuery = normalizedQuery !== activeSearchQuery;
    activeSearchQuery = normalizedQuery;
    lastSearchRequestToken += 1;
    const requestToken = lastSearchRequestToken;

    if (isNewQuery) {
        resetSearchTabCacheForQuery(normalizedQuery);
        Object.keys(SEARCH_TAB_CONFIG).forEach((tabName) => {
            if (tabName === 'music') {
                setSearchLoadingState(tabName, SEARCH_TAB_CONFIG[tabName].loadingText);
                return;
            }
            setSearchIdleState(tabName);
        });
    }

    const musicTabButton = document.getElementById('music-tab');
    if (musicTabButton && !musicTabButton.classList.contains('active')) {
        musicTabButton.click();
    }

    await loadSearchTab('music', normalizedQuery, { requestToken });
}

function extractYouTubeVideoId(rawValue) {
    const value = String(rawValue || '').trim();
    if (!value) return null;

    const plainIdMatch = value.match(/^[A-Za-z0-9_-]{11}$/);
    if (plainIdMatch) return plainIdMatch[0];

    const watchMatch = value.match(/[?&]v=([A-Za-z0-9_-]{11})/);
    if (watchMatch) return watchMatch[1];

    const shortMatch = value.match(/youtu\.be\/([A-Za-z0-9_-]{11})/i);
    if (shortMatch) return shortMatch[1];

    const musicPathMatch = value.match(/music\.youtube\.com\/watch\?v=([A-Za-z0-9_-]{11})/i);
    if (musicPathMatch) return musicPathMatch[1];

    return null;
}

function parseQueueVideoIds(inputValue) {
    const value = String(inputValue || '').trim();
    if (!value) return [];

    const parts = value.split(',').map((part) => part.trim()).filter(Boolean);
    if (parts.length === 0) return [];

    const ids = [];
    for (const part of parts) {
        const id = extractYouTubeVideoId(part);
        if (!id) return [];
        ids.push(id);
    }

    return ids;
}

// Unified input handler (URL or search)
export async function handleUnifiedInput() {
    const input = document.getElementById('unified-input');
    if (!input) return;

    const value = input.value.trim();
    if (!value) {
        if (logMessage) logMessage('Please enter a search term or URL.');
        return;
    }

    const videoIds = parseQueueVideoIds(value);
    if (videoIds.length > 0) {
        let successCount = 0;
        for (let i = 0; i < videoIds.length; i += 1) {
            const videoId = videoIds[i];
            // Accept plain video ID as equivalent to:
            // https://music.youtube.com/watch?v=<videoId>
            const success = await addToQueue(videoId);
            if (success) successCount += 1;
            if (i < videoIds.length - 1) {
                await delay(500);
            }
        }

        if (successCount > 0) {
            input.value = '';
            if (successCount === 1) {
                showToast('Song added to queue');
            } else {
                showToast(`${successCount} songs added to queue`);
            }
        }
    } else {
        await handleUnifiedSearch(value);
    }
}

// Update button icon based on input
export function initUnifiedInputListener() {
    const input = document.getElementById('unified-input');
    const button = document.getElementById('unified-button');
    
    if (!input || !button) return;

    input.addEventListener('input', function(e) {
        const value = e.target.value.trim();
        const icon = button.querySelector('.material-icons');
        const queueIds = parseQueueVideoIds(value);
        const isQueueInput = queueIds.length > 0;

        if (isQueueInput) {
            icon.textContent = 'add';
            button.title = 'Add to queue';
            button.classList.add('add-mode');
        } else {
            icon.textContent = 'search';
            button.title = 'Search';
            button.classList.remove('add-mode');
        }
    });

    input.addEventListener('keypress', function(e) {
        if (e.key === 'Enter') {
            handleUnifiedInput();
        }
    });
}

// ============================================================================
// SHARED AUDIO CONTEXT - Used by both visualizer and volume control
// ============================================================================
let audioContext = null;
let gainNode = null;
let audioSource = null;
let analyser = null;
let isAudioContextInitialized = false;
let isVolumeControlInitialized = false;
let isAudioErrorHandlerInitialized = false;

// Initialize audio context ONCE - shared by both visualizer and volume control
function initAudioContext() {
    const audioPlayer = document.getElementById('audioPlayer');
    
    if (isAudioContextInitialized || !audioPlayer) {
        return; // Already initialized or no player
    }
    
    try {
        audioContext = new (window.AudioContext || window.webkitAudioContext)();
        
        // Create source from audio element (can only be done ONCE)
        audioSource = audioContext.createMediaElementSource(audioPlayer);
        
        // Create gain node for volume control
        gainNode = audioContext.createGain();
        gainNode.gain.value = 1.0;
        
        // Create analyser for visualizer
        analyser = audioContext.createAnalyser();
        analyser.fftSize = 256;
        analyser.smoothingTimeConstant = 0.8;
        
        // Connect the chain: source -> gain -> analyser -> destination
        audioSource.connect(gainNode);
        gainNode.connect(analyser);
        analyser.connect(audioContext.destination);
        
        isAudioContextInitialized = true;
        
        console.log('[AUDIO] Audio context initialized');
    } catch (error) {
        console.error('[AUDIO] Failed to initialize audio context:', error);
    }
}

// ============================================================================
// VOLUME CONTROL
// ============================================================================

// Initialize volume control with boost capability (up to 200%)
export function initVolumeControl() {
    if (isVolumeControlInitialized) return;

    const volumeSlider = document.getElementById('swyh-volume');
    const volumeValue = document.getElementById('volume-value');
    
    if (!volumeSlider || !volumeValue) {
        console.warn('[VOLUME] Volume slider or value display not found');
        return;
    }
    
    // Handle volume changes
    volumeSlider.addEventListener('input', (e) => {
        const volume = e.target.value / 100;
        
        // Initialize audio context on first interaction if not already done
        if (!isAudioContextInitialized) {
            initAudioContext();
        }
        
        if (gainNode) {
            gainNode.gain.value = volume;
        }
        
        volumeValue.textContent = `${e.target.value}%`;
        localStorage.setItem('swyhVolume', volume);
    });
    
    // Restore saved volume on load
    const savedVolume = localStorage.getItem('swyhVolume');
    if (savedVolume !== null) {
        const volumePercent = Math.round(savedVolume * 100);
        volumeSlider.value = volumePercent;
        volumeValue.textContent = `${volumePercent}%`;
    }

    isVolumeControlInitialized = true;
    
    console.log('[VOLUME] Volume control initialized');
}

// ============================================================================
// AUDIO VISUALIZER
// ============================================================================

let dataArray = null;
let bufferLength = null;
let animationId = null;
let isVisualizerActive = false;

function getCurrentTopButtonGlowColor() {
    const rootStyles = getComputedStyle(document.documentElement);
    return rootStyles.getPropertyValue('--lyrics-active-color').trim()
        || rootStyles.getPropertyValue('--text-primary').trim()
        || '#ffffff';
}

function showVisualizer() {
    const visualizerContainer = document.getElementById('audio-visualizer');
    if (visualizerContainer) {
        visualizerContainer.style.display = 'block';
    }
}

function hideVisualizer() {
    const visualizerContainer = document.getElementById('audio-visualizer');
    if (visualizerContainer) {
        visualizerContainer.style.display = 'none';
    }
}

function updateStatus(message, isError = false) {
    const statusDiv = document.getElementById('visualizer-status');
    if (statusDiv) {
        statusDiv.textContent = message;
        statusDiv.style.color = getCurrentTopButtonGlowColor();
    }
    console.log(`[STREAM] ${message}`);
}

function initVisualizer() {
    const canvas = document.getElementById('visualizer-canvas');
    
    if (!canvas) {
        console.warn('[VISUALIZER] Canvas not found');
        return;
    }

    // Initialize shared audio context if not already done
    if (!isAudioContextInitialized) {
        initAudioContext();
    }
    
    if (!analyser) {
        updateStatus('Failed to initialize audio context', true);
        console.error('[VISUALIZER] Analyser not initialized');
        return;
    }

    // Set up data array for frequency data
    if (!dataArray) {
        bufferLength = analyser.frequencyBinCount;
        dataArray = new Uint8Array(bufferLength);
    }

    isVisualizerActive = true;
    
    // Set canvas size
    const container = canvas.parentElement;
    canvas.width = container.clientWidth;
    canvas.height = 64;
    
    updateStatus('Streaming (Live)');
    drawVisualizer();
    
    console.log('[VISUALIZER] Visualizer initialized');
}

function drawVisualizer() {
    if (!isVisualizerActive) return;

    animationId = requestAnimationFrame(drawVisualizer);

    const canvas = document.getElementById('visualizer-canvas');
    if (!canvas) return;
    
    const ctx = canvas.getContext('2d');
    const accentColor = getCurrentTopButtonGlowColor();
    const statusDiv = document.getElementById('visualizer-status');
    if (statusDiv) {
        statusDiv.style.color = accentColor;
    }
    
    analyser.getByteFrequencyData(dataArray);

    // Clear canvas
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Draw bars
    const numBars = 32;
    const barWidth = canvas.width / numBars;
    
    for (let i = 0; i < numBars; i++) {
        const dataIndex = Math.floor((i / numBars) * bufferLength);
        const value = dataArray[dataIndex];
        const barHeight = (value / 255) * canvas.height * 0.7;
        
        const x = i * barWidth;
        const y = canvas.height - barHeight;
        
        ctx.fillStyle = accentColor;
        ctx.fillRect(x, y, barWidth - 1, barHeight);
    }
}

function stopVisualizer() {
    isVisualizerActive = false;
    if (animationId) {
        cancelAnimationFrame(animationId);
        animationId = null;
    }
    console.log('[VISUALIZER] Visualizer stopped');
}

// ============================================================================
// AUDIO STREAMING
// ============================================================================

let isStreamPlaying = false;
let reconnectTimer = null;
let reconnectAttempts = 0;
let isReconnecting = false;

export function toggleStream() {
    if (isStreamPlaying) {
        stopStream();
    } else {
        startStream();
    }
}

export function startStream() {
    const audioPlayer = document.getElementById('audioPlayer');
    const toggleBtn = document.getElementById('stream-btn');
    
    if (!audioPlayer || !toggleBtn) {
        console.error('[STREAM] Audio player or toggle button not found');
        return;
    }

    // CRITICAL: Initialize audio context BEFORE starting stream
    if (!isAudioContextInitialized) {
        initAudioContext();
    }

    showVisualizer();
    updateStatus('Connecting to stream...');
    
    // Reset reconnect state
    reconnectAttempts = 0;
    isReconnecting = false;
    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }

    const streamUrl = `/audio-proxy?url=${encodeURIComponent('http://192.168.99.47:5901/stream/swyh.wav')}`;
    
    // Complete reset
    audioPlayer.pause();
    audioPlayer.src = '';
    audioPlayer.load();
    
    // Critical settings for live streaming
    audioPlayer.preload = 'none';
    audioPlayer.autoplay = false;
    
    // Set source with cache-busting
    audioPlayer.src = streamUrl + '&t=' + Date.now();
    audioPlayer.load();
    
    // Apply saved volume immediately
    const savedVolume = localStorage.getItem('swyhVolume');
    if (savedVolume !== null && gainNode) {
        gainNode.gain.value = parseFloat(savedVolume);
    }
    
    // Single play event handler
    const onPlaying = () => {
        updateStatus('Streaming (Live)');
        isStreamPlaying = true;
        isReconnecting = false;
        reconnectAttempts = 0;
        
        const label = toggleBtn.querySelector('.stream-label');
        if (label) label.textContent = 'STOP STREAM';
        toggleBtn.classList.add('streaming');
        
        initVisualizer();
        maintainLiveSync(audioPlayer);
        
        audioPlayer.removeEventListener('playing', onPlaying);
    };
    
    audioPlayer.addEventListener('playing', onPlaying, { once: true });
    
    // Start playback
    audioPlayer.play().catch(err => {
        if (err.message.includes('no supported source was found')) {
            updateStatus('Launching swyh-rs on server... Coba pencet Audio Stream lagi', true);
            launchSwyhOnServer().then(() => {
                updateStatus('SWYH launched, connecting...');
                setTimeout(() => {
                    startStream();
                }, 3000);
            }).catch(launchErr => {
                updateStatus('Failed to launch SWYH: ' + launchErr.message, true);
                startAutoReconnect(audioPlayer, toggleBtn);
            });
        } else {
            updateStatus('Failed to start: ' + err.message, true);
            startAutoReconnect(audioPlayer, toggleBtn);
        }
    });
    
    console.log('[STREAM] Stream started');
}

async function launchSwyhOnServer() {
    try {
        const response = await fetch('/launch-swyh', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                executablePath: 'C:\\Program Files\\swyh-rs\\swyh-rs.exe'
            })
        });
        
        if (!response.ok) {
            throw new Error('Server returned error: ' + response.status);
        }
        
        const result = await response.json();
        if (!result.success) {
            throw new Error(result.message || 'Unknown error');
        }
        
        return result;
    } catch (error) {
        console.error('[STREAM] Failed to launch SWYH:', error);
        throw error;
    }
}

function maintainLiveSync(audioPlayer) {
    const syncInterval = setInterval(() => {
        if (!isStreamPlaying) {
            clearInterval(syncInterval);
            return;
        }
        
        // Check if we have buffered data
        if (audioPlayer.buffered.length > 0) {
            const bufferEnd = audioPlayer.buffered.end(audioPlayer.buffered.length - 1);
            const currentTime = audioPlayer.currentTime;
            const lag = bufferEnd - currentTime;
            
            // If lagging more than 0.5 seconds, jump to live edge
            if (lag > 0.5) {
                audioPlayer.currentTime = bufferEnd - 0.1;
            }
        }
        
        // If playback stalls, start reconnect
        if (audioPlayer.paused && isStreamPlaying && !isReconnecting) {
            const toggleBtn = document.getElementById('stream-btn');
            startAutoReconnect(audioPlayer, toggleBtn);
        }
    }, 500);
    
    audioPlayer._syncInterval = syncInterval;
}

function startAutoReconnect(audioPlayer, toggleBtn) {
    if (isReconnecting) return;
    
    isReconnecting = true;
    
    // Clear existing intervals
    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }
    
    if (audioPlayer._syncInterval) {
        clearInterval(audioPlayer._syncInterval);
        audioPlayer._syncInterval = null;
    }
    
    const streamUrl = `/audio-proxy?url=${encodeURIComponent('http://192.168.99.47:5901/stream/swyh.wav')}`;
    
    function attemptReconnect() {
        if (!isStreamPlaying) {
            if (reconnectTimer) {
                clearTimeout(reconnectTimer);
                reconnectTimer = null;
            }
            isReconnecting = false;
            return;
        }
        
        reconnectAttempts++;
        const backoffTime = Math.min(reconnectAttempts * 1000, 5000);
        
        updateStatus(`Server unreachable - Reconnecting (attempt ${reconnectAttempts})`, true);
        
        audioPlayer.src = streamUrl + '&t=' + Date.now();
        audioPlayer.load();
        
        audioPlayer.play()
            .then(() => {
                if (reconnectTimer) {
                    clearTimeout(reconnectTimer);
                    reconnectTimer = null;
                }
                isReconnecting = false;
                reconnectAttempts = 0;
                updateStatus('Reconnected - Streaming (Live)');
                maintainLiveSync(audioPlayer);
            })
            .catch(err => {
                if (reconnectTimer) {
                    clearTimeout(reconnectTimer);
                }
                reconnectTimer = setTimeout(attemptReconnect, backoffTime);
            });
    }
    
    attemptReconnect();
}

export function stopStream() {
    const audioPlayer = document.getElementById('audioPlayer');
    const toggleBtn = document.getElementById('stream-btn');
    
    if (!audioPlayer || !toggleBtn) return;

    // Clear reconnect interval
    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }
    
    isReconnecting = false;
    
    cleanup(audioPlayer, toggleBtn);
    
    updateStatus('Stream stopped');
    stopVisualizer();
    
    setTimeout(() => {
        if (!isStreamPlaying) hideVisualizer();
    }, 2000);
    
    console.log('[STREAM] Stream stopped');
}

function cleanup(audioPlayer, toggleBtn) {
    // Clear sync interval
    if (audioPlayer._syncInterval) {
        clearInterval(audioPlayer._syncInterval);
        audioPlayer._syncInterval = null;
    }
    
    // Stop playback
    audioPlayer.pause();
    audioPlayer.src = '';
    audioPlayer.load();
    
    isStreamPlaying = false;
    
    if (toggleBtn) {
        const label = toggleBtn.querySelector('.stream-label');
        if (label) label.textContent = 'STREAM AUDIO';
        toggleBtn.classList.remove('streaming');
    }
}

// ============================================================================
// ERROR HANDLER
// ============================================================================

export function initAudioStreamErrorHandler() {
    if (isAudioErrorHandlerInitialized) return;

    const audioPlayer = document.getElementById('audioPlayer');
    
    if (!audioPlayer) return;

    let lastErrorTime = 0;
    const ERROR_THROTTLE = 2000;

    audioPlayer.addEventListener('error', (e) => {
        const now = Date.now();
        
        if (now - lastErrorTime < ERROR_THROTTLE) {
            return;
        }
        
        lastErrorTime = now;
        
        const error = audioPlayer.error;
        let errorMsg = 'Connection failed';
        
        if (error) {
            switch(error.code) {
                case 2: 
                    errorMsg = 'Server unreachable'; 
                    if (isStreamPlaying && !isReconnecting) {
                        updateStatus(errorMsg, true);
                        const toggleBtn = document.getElementById('stream-btn');
                        startAutoReconnect(audioPlayer, toggleBtn);
                        return;
                    }
                    return;
                case 3: 
                case 4: 
                    if (!isStreamPlaying) return;
                    break;
            }
        }
        
        if (!isReconnecting) {
            updateStatus('Error: ' + errorMsg, true);
            const toggleBtn = document.getElementById('stream-btn');
            cleanup(audioPlayer, toggleBtn);
        }
    });

    isAudioErrorHandlerInitialized = true;
    
    console.log('[ERROR] Error handler initialized');
}
