import { API_URL, state } from './config.js';
import { logMessage } from './utils.js';
import { updateLyricsDisplay } from './lyric.js';

const VOLUME_SEND_THROTTLE_MS = 120;
const VOLUME_SEND_DEBOUNCE_MS = 180;
const VOLUME_REMOTE_SYNC_GRACE_MS = 900;
const VOLUME_REMOTE_EPSILON = 1;
let volumeControlsInitialized = false;
let volumeSliderElement = null;
let volumeSendTimer = null;
let pendingVolumePercent = null;
let lastVolumeSendStartedAt = 0;
let volumePointerReleaseTimer = null;

// Progress tracking
export function startProgressTracking(songData) {
    if (state.progressTimer) {
        clearInterval(state.progressTimer);
        state.progressTimer = null;
    }

    if (!songData || !songData.videoId) {
        return;
    }

    state.currentSongData = songData;

    if (songData.elapsedSeconds !== undefined) {
        updateLyricsDisplay(songData.elapsedSeconds);
    }

    state.progressTimer = setInterval(async () => {
        if (state.ws && state.ws.readyState === WebSocket.OPEN) {
            return;
        }

        try {
            const response = await fetch(`${API_URL}/song`);
            if (!response.ok) {
                return;
            }

            const data = await response.json();
            if (data && data.videoId === state.currentSongData?.videoId) {
                if (data.elapsedSeconds !== undefined) {
                    updateLyricsDisplay(data.elapsedSeconds);
                }

                state.currentSongData = data;

                if (data.isPaused) {
                    stopProgressTracking();
                }
            } else {
                stopProgressTracking();
            }
        } catch (error) {
            // Silent fail
        }
    }, 1000);
}

export function stopProgressTracking() {
    if (state.progressTimer) {
        clearInterval(state.progressTimer);
        state.progressTimer = null;
    }
    state.currentSongData = null;
}

// Playback controls
export async function previousTrack() {
    try {
        const url = `${API_URL}/previous`;
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({})
        });

        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        const result = await response.json().catch(() => ({}));
        if (result.message) {
            console.log(result.message);
        }
    } catch (error) {
        console.error('Error in previousTrack:', error.message);
    }
}

export async function nextTrack() {
    try {
        const url = `${API_URL}/next`;
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({})
        });

        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        const result = await response.json().catch(() => ({}));
        if (result.message) {
            console.log(result.message);
        }
    } catch (error) {
        console.error('Error in nextTrack:', error.message);
    }
}

export async function togglePlay() {
    try {
        const url = `${API_URL}/toggle-play`;
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
    } catch (error) {
        console.error('Error in togglePlay:', error.message);
    }
}

export async function toggleMute() {
    if (state.ws && state.ws.readyState === WebSocket.OPEN) {
        try {
            state.ws.send(JSON.stringify({
                type: 'toggle_mute'
            }));
            if (logMessage) logMessage('Toggling mute...');
            return;
        } catch (error) {
            console.error('[MUTE] WebSocket error, falling back to HTTP:', error);
        }
    }

    try {
        const response = await fetch(`${API_URL}/toggle-mute`, {
            method: 'POST',
            headers: {
                'accept': '*/*',
                'Content-Length': '0'
            }
        });

        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        if (logMessage) logMessage('Toggled mute');
    } catch (error) {
        if (logMessage) logMessage(`Error toggling mute: ${error.message}`);
    }
}

// Volume control
export function detectServerVolumeScale(value) {
    if (typeof value !== 'number') return;
    if (value > 0 && value < 1) {
        state.serverVolumeScale = '0-1';
    } else if (value > 100 && value <= 255) {
        state.serverVolumeScale = '0-255';
    } else {
        state.serverVolumeScale = 'percent';
    }
}

export function convertServerValueToPercent(value) {
    if (state.serverVolumeScale === '0-1') return Math.round(value * 100);
    if (state.serverVolumeScale === '0-255') return Math.round((value / 255) * 100);
    return Math.round(value);
}

export function convertPercentToServerValue(percent) {
    const p = Math.max(0, Math.min(100, Math.round(percent)));
    if (state.serverVolumeScale === '0-1') return +(p / 100).toFixed(3);
    if (state.serverVolumeScale === '0-255') return Math.round((p / 100) * 255);
    return p;
}

function getVolumeSlider() {
    if (volumeSliderElement && document.contains(volumeSliderElement)) {
        return volumeSliderElement;
    }
    volumeSliderElement = document.querySelector('.volume-slider');
    return volumeSliderElement;
}

function normalizePercentValue(value) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return 1;
    return Math.max(1, Math.min(100, Math.round(parsed)));
}

function setVolumeSliderPercent(percent, { force = false } = {}) {
    const slider = getVolumeSlider();
    const normalized = normalizePercentValue(percent);
    state.volumePercent = normalized;

    if (slider) {
        const currentValue = normalizePercentValue(slider.value);
        if (force || currentValue !== normalized) {
            slider.value = String(normalized);
        }
    }

    updateVolumeIcon(normalized);
}

function shouldIgnoreRemoteVolumePercent(percent, { optimistic = false } = {}) {
    const now = Date.now();
    const remotePercent = normalizePercentValue(percent);
    const localPercent = normalizePercentValue(state.volumePercent);

    if (!state.isUserAdjustingVolume && now >= (state.volumeRemoteSyncLockUntil || 0)) {
        return false;
    }

    const delta = Math.abs(remotePercent - localPercent);
    if (delta <= VOLUME_REMOTE_EPSILON) {
        return true;
    }

    return optimistic;
}

function markLocalVolumeInteraction() {
    state.isUserAdjustingVolume = true;
    state.lastLocalVolumeUpdateMs = Date.now();
    state.volumeRemoteSyncLockUntil = Date.now() + VOLUME_REMOTE_SYNC_GRACE_MS;
}

function finishLocalVolumeInteractionSoon(delayMs = 160) {
    if (volumePointerReleaseTimer) {
        clearTimeout(volumePointerReleaseTimer);
    }
    volumePointerReleaseTimer = setTimeout(() => {
        state.isUserAdjustingVolume = false;
        volumePointerReleaseTimer = null;
    }, delayMs);
}

async function sendVolumePercentNow(percent) {
    const volumePercent = normalizePercentValue(percent);
    pendingVolumePercent = null;
    lastVolumeSendStartedAt = Date.now();
    state.lastVolumeSentAt = lastVolumeSendStartedAt;
    state.lastVolumeSentValue = volumePercent;

    const sendVolume = convertPercentToServerValue(volumePercent);

    if (state.ws && state.ws.readyState === WebSocket.OPEN) {
        try {
            state.ws.send(JSON.stringify({
                type: 'set_volume',
                volume: sendVolume
            }));
            return;
        } catch (error) {
            console.error('[VOLUME] WebSocket error, falling back to HTTP:', error);
        }
    }

    try {
        const response = await fetch(`${API_URL}/volume`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ volume: sendVolume })
        });

        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        const result = await response.json().catch(() => ({}));
        const actualVolume = result?.volume ?? result?.state ?? result?.value;
        if (typeof actualVolume === 'number') {
            updateVolumeUI(actualVolume, { source: 'http-response' });
        }
    } catch (error) {
        if (logMessage) logMessage(`Error updating volume: ${error.message}`);
    }
}

function scheduleVolumeSend(percent) {
    pendingVolumePercent = normalizePercentValue(percent);

    const now = Date.now();
    const elapsed = now - lastVolumeSendStartedAt;
    const delay = elapsed >= VOLUME_SEND_THROTTLE_MS
        ? 0
        : Math.min(VOLUME_SEND_DEBOUNCE_MS, VOLUME_SEND_THROTTLE_MS - elapsed);

    if (volumeSendTimer) {
        clearTimeout(volumeSendTimer);
    }

    volumeSendTimer = setTimeout(() => {
        const nextPercent = pendingVolumePercent;
        volumeSendTimer = null;
        sendVolumePercentNow(nextPercent);
    }, delay);
}

export function updateVolumeIcon(value) {
    const volumeIcon = document.querySelector('.volume-control .material-icons');
    if (!volumeIcon) return;
    
    if (value == 0) {
        volumeIcon.textContent = 'volume_off';
    } else if (value < 50) {
        volumeIcon.textContent = 'volume_down';
    } else {
        volumeIcon.textContent = 'volume_up';
    }
}

export function updateVolumeUI(volume, options = {}) {
    if (typeof volume !== 'number') {
        return;
    }

    const optimistic = !!options.optimistic;
    if (!optimistic) {
        detectServerVolumeScale(volume);
    }

    const percent = convertServerValueToPercent(volume);
    if (shouldIgnoreRemoteVolumePercent(percent, { optimistic })) {
        return;
    }

    state.volumeLastServerValue = volume;
    state.volumeLastServerPercent = percent;
    setVolumeSliderPercent(percent);
}

export async function updateVolume(value) {
    const volumePercent = normalizePercentValue(value);
    markLocalVolumeInteraction();
    setVolumeSliderPercent(volumePercent, { force: true });
    scheduleVolumeSend(volumePercent);
}

// Initialize volume controls
export function initVolumeControls() {
    if (volumeControlsInitialized) return;

    const volumeSlider = getVolumeSlider();
    if (!volumeSlider) return;

    const startAdjust = () => {
        markLocalVolumeInteraction();
    };
    const endAdjust = () => {
        finishLocalVolumeInteractionSoon();
    };

    volumeSlider.addEventListener('mousedown', startAdjust);
    volumeSlider.addEventListener('touchstart', startAdjust);
    volumeSlider.addEventListener('pointerdown', startAdjust);
    document.addEventListener('mouseup', endAdjust);
    document.addEventListener('touchend', endAdjust);
    document.addEventListener('pointerup', endAdjust);
    document.addEventListener('pointercancel', endAdjust);

    volumeSlider.addEventListener('input', (e) => {
        const newValue = normalizePercentValue(e.target.value);
        markLocalVolumeInteraction();
        setVolumeSliderPercent(newValue, { force: true });
        scheduleVolumeSend(newValue);
    });

    // Wheel control for bottom controls
    const bottomControls = document.getElementById('bottom-controls');
    if (bottomControls) {
        let wheelActiveTimer = null;
        const DEBOUNCE_MS = 300;

        bottomControls.addEventListener('wheel', (e) => {
            e.preventDefault();
            if (!volumeSlider) return;

            markLocalVolumeInteraction();
            if (wheelActiveTimer) clearTimeout(wheelActiveTimer);
            wheelActiveTimer = setTimeout(() => {
                finishLocalVolumeInteractionSoon(120);
                wheelActiveTimer = null;
            }, DEBOUNCE_MS + 50);

            const step = e.shiftKey ? 10 : 2;
            const dir = e.deltaY > 0 ? -1 : 1;
            let newVal = normalizePercentValue(volumeSlider.value) + dir * step;
            newVal = normalizePercentValue(newVal);

            if (newVal === normalizePercentValue(volumeSlider.value)) return;

            setVolumeSliderPercent(newVal, { force: true });
            scheduleVolumeSend(newVal);
        }, { passive: false });
    }

    setVolumeSliderPercent(normalizePercentValue(volumeSlider.value), { force: true });
    volumeControlsInitialized = true;
}
