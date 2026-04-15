import { YT_API_KEY, RAPIDAPI_HOST, RAPIDAPI_KEY, hasUsableYouTubeApiKey, hasUsableRapidApiKey } from './config.js';
import { getThumbnailUrl } from './connection.js';
import { logMessage } from './utils.js';
import { addToQueue } from './queue.js';
import { showToast } from './ui.js';

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// YouTube Music search
export async function searchYouTubeMusic(query) {
    const resultsDiv = document.getElementById('music-results');
    if (!resultsDiv) return;

    try {
        const response = await fetch(`https://youtube-music-api3.p.rapidapi.com/search?q=${encodeURIComponent(query)}&type=song`, {
            method: 'GET',
            headers: {
                'x-rapidapi-host': RAPIDAPI_HOST,
                'x-rapidapi-key': RAPIDAPI_KEY
            }
        });

        if (!response.ok) {
            throw new Error(`API Error: ${response.status}`);
        }

        const data = await response.json();
        resultsDiv.innerHTML = '';

        if (!data?.result?.length) {
            resultsDiv.innerHTML = '<div style="padding: 20px; text-align: center;">No music found.</div>';
            return;
        }

        data.result.forEach(song => {
            const div = document.createElement('div');
            div.className = 'song';
            div.innerHTML = `
                <img class="thumbnail" src="${song.thumbnail}" alt="${song.title}">
                <div class="details">
                    <div class="title">${song.title}</div>
                    <div class="artist-album">${song.author || (song.artists?.join(', ')) || 'Unknown artist'}</div>
                </div>
                <button class="search-results-button" onclick="window.addToQueueById('${song.videoId}')">
                    <span class="material-icons">add</span>
                </button>
            `;
            resultsDiv.appendChild(div);
        });
    } catch (error) {
        resultsDiv.innerHTML = `<div style="padding: 20px; text-align: center; color: rgba(253,2,52,1);">Error: ${error.message}</div>`;
        if (logMessage) logMessage(`Music search failed: ${error.message}`);
    }
}

// YouTube Videos search
export async function searchYouTubeVideos(query) {
    const resultsDiv = document.getElementById('videos-results');
    if (!resultsDiv) return;

    // Helpers (kept local to avoid touching other modules)
    const safeText = (v) => (v === null || v === undefined) ? '' : String(v);
    const fetchJsonSafe = async (res) => {
        const contentType = res.headers?.get?.('content-type') || '';
        if (contentType.includes('application/json')) {
            try { return await res.json(); } catch (_) { return null; }
        }
        try { return await res.text(); } catch (_) { return null; }
    };

    const render = (items) => {
        resultsDiv.innerHTML = '';
        if (!Array.isArray(items) || items.length === 0) {
            resultsDiv.innerHTML = '<div style="padding: 20px; text-align: center;">No videos found.</div>';
            return;
        }

        items.forEach(item => {
            // Normalize a few possible shapes (Google API vs RapidAPI wrappers)
            const videoId =
                item?.id?.videoId ||
                item?.videoId ||
                item?.video_id ||
                item?.id;

            const title =
                item?.snippet?.title ||
                item?.title ||
                item?.name ||
                'Untitled';

            const channelTitle =
                item?.snippet?.channelTitle ||
                item?.author ||
                item?.channelName ||
                item?.channel ||
                '';

            const originalThumbnailUrl =
                item?.snippet?.thumbnails?.high?.url ||
                item?.snippet?.thumbnails?.medium?.url ||
                item?.thumbnail ||
                item?.thumbnails?.[0]?.url ||
                item?.thumbnails?.[0] ||
                '';

            const thumbnailUrl = getThumbnailUrl(originalThumbnailUrl);

            if (!videoId) return;

            const div = document.createElement('div');
            div.className = 'song';
            div.innerHTML = `
                <img class="thumbnail" src="${thumbnailUrl}" alt="${safeText(title)}">
                <div class="details">
                    <div class="title">${safeText(title)}</div>
                    <div class="artist-album">${safeText(channelTitle)}</div>
                </div>
                <button class="search-results-button" onclick="window.addToQueueById('${safeText(videoId)}')">
                    <span class="material-icons">add</span>
                </button>
            `;
            resultsDiv.appendChild(div);
        });
    };

    // Strategy:
    // 1) Try official YouTube Data API (if key is usable).
    // 2) If forbidden/quota/key-restricted (common cause of 403 in browser), fall back to RapidAPI search
    //    so the "Video" tab still works without requiring Google key changes on the client.
    try {
        // ------------------------
        // 1) YouTube Data API v3
        // ------------------------
        const hasKey = hasUsableYouTubeApiKey();
        if (hasKey) {
            const url = new URL('https://www.googleapis.com/youtube/v3/search');
            url.searchParams.set('part', 'snippet');
            url.searchParams.set('type', 'video');
            url.searchParams.set('maxResults', '10');
            url.searchParams.set('q', query);
            url.searchParams.set('videoCategoryId', '10'); // Music
            url.searchParams.set('regionCode', 'US');
            url.searchParams.set('key', YT_API_KEY);

            const response = await fetch(url.toString());
            if (response.ok) {
                const data = await response.json();
                render(data?.items || []);
                return;
            }

            // If YouTube returns an error body, surface it (and decide whether to fall back).
            const errBody = await fetchJsonSafe(response);
            const apiMsg =
                errBody?.error?.message ||
                (typeof errBody === 'string' ? errBody : '') ||
                response.statusText ||
                `HTTP ${response.status}`;

            // Only fall back on common "browser key" failures
            if (![400, 401, 403, 429].includes(response.status)) {
                throw new Error(apiMsg);
            }

            console.warn('[VIDEO] YouTube Data API failed, falling back:', response.status, apiMsg);
        } else if (!hasUsableRapidApiKey()) {
            console.warn('[VIDEO] Missing/placeholder YT_API_KEY and RAPIDAPI_KEY.');
        }

        // ------------------------
        // 2) Fallback: RapidAPI (same provider you already use for Music tab)
        // ------------------------
        const rapidResponse = await fetch(`https://youtube-music-api3.p.rapidapi.com/search?q=${encodeURIComponent(query)}&type=video`, {
            method: 'GET',
            headers: {
                'x-rapidapi-host': RAPIDAPI_HOST,
                'x-rapidapi-key': RAPIDAPI_KEY
            }
        });

        if (!rapidResponse.ok) {
            const errBody = await fetchJsonSafe(rapidResponse);
            const apiMsg =
                errBody?.message ||
                errBody?.error?.message ||
                (typeof errBody === 'string' ? errBody : '') ||
                rapidResponse.statusText ||
                `HTTP ${rapidResponse.status}`;
            throw new Error(apiMsg);
        }

        const rapidData = await rapidResponse.json();

        // Most responses are { result: [...] } but we keep it defensive.
        render(rapidData?.result || rapidData?.items || []);
    } catch (error) {
        const msg = safeText(error?.message || error);
        resultsDiv.innerHTML = `<div style="padding: 20px; text-align: center; color: rgba(253,2,52,1);">Error: ${msg}</div>`;
        if (logMessage) logMessage(`Video search failed: ${msg}`);
    }
}

// Unified search handler
export async function handleUnifiedSearch(query) {
    if (!query) {
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

    const musicResults = document.getElementById('music-results');
    const videosResults = document.getElementById('videos-results');
    
    if (musicResults) {
        musicResults.innerHTML = '<div style="padding: 20px; text-align: center;">Searching music...</div>';
    }
    if (videosResults) {
        videosResults.innerHTML = '<div style="padding: 20px; text-align: center;">Searching videos...</div>';
    }

    await Promise.all([
        searchYouTubeMusic(query),
        searchYouTubeVideos(query)
    ]);
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
        statusDiv.style.color = isError ? 'rgba(253,2,52,1)' : 'rgba(253,2,52,1)';
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
        
        ctx.fillStyle = 'rgba(253,2,52,1)';
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
    
    const streamUrl = `/audio-proxy?url=${encodeURIComponent('http://192.168.0.101:5901/stream/swyh.wav')}`;
    
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
