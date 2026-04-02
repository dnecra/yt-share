/**
 * Volume Manager
 * Handles volume changes with debouncing to prevent glitchy UI behavior
 */

let pendingVolumeUpdate = null;
let lastSetVolume = null;
let volumeUpdateTimeout = null;
let lastUserSetTime = 0;
const VOLUME_DEBOUNCE_MS = 150; // Debounce volume updates by 150ms
const USER_INTERACTION_SUPPRESS_MS = 300; // Suppress external updates for 300ms after user interaction

/**
 * Check if we should suppress external volume updates (user is interacting)
 */
function shouldSuppressExternalUpdate() {
    const now = Date.now();
    return (now - lastUserSetTime) < USER_INTERACTION_SUPPRESS_MS;
}

/**
 * Set volume with debouncing to prevent rapid updates
 */
async function setVolume(volume, proxyRequest, broadcast, setLastVolume, isUserInitiated = true) {
    // Round to nearest integer to avoid float issues
    const roundedVolume = Math.round(volume);
    
    // Track user-initiated changes
    if (isUserInitiated) {
        lastUserSetTime = Date.now();
    }
    
    // Clear any pending timeout
    if (volumeUpdateTimeout) {
        clearTimeout(volumeUpdateTimeout);
        volumeUpdateTimeout = null;
    }
    
    // Store the pending update
    pendingVolumeUpdate = roundedVolume;
    
    // Update UI immediately for responsiveness (optimistic update)
    setLastVolume(roundedVolume);
    broadcast({ type: 'volume_updated', data: { volume: roundedVolume }, optimistic: true });
    
    // Debounce the actual API call
    return new Promise((resolve, reject) => {
        volumeUpdateTimeout = setTimeout(async () => {
            try {
                const volumeToSet = pendingVolumeUpdate;
                pendingVolumeUpdate = null;
                volumeUpdateTimeout = null;
                
                // Only send if different from last successfully set volume
                if (volumeToSet === lastSetVolume) {
                    resolve({ success: true, data: { volume: volumeToSet }, cached: true });
                    return;
                }
                
                const result = await proxyRequest('POST', '/volume', { volume: volumeToSet });
                
                if (result.success) {
                    const actualVolume = result.data?.volume ?? result.data?.state ?? result.data?.value ?? volumeToSet;
                    lastSetVolume = actualVolume;
                    setLastVolume(actualVolume);
                    // Don't broadcast again - we already did optimistically
                    resolve(result);
                } else {
                    // Revert optimistic update on failure
                    const currentVolumeResult = await proxyRequest('GET', '/volume');
                    if (currentVolumeResult.success) {
                        const currentVolume = currentVolumeResult.data?.volume ?? currentVolumeResult.data?.state ?? currentVolumeResult.data?.value;
                        if (typeof currentVolume === 'number') {
                            setLastVolume(currentVolume);
                            broadcast({ type: 'volume_updated', data: { volume: currentVolume } });
                        }
                    }
                    reject(result);
                }
            } catch (error) {
                reject(error);
            }
        }, VOLUME_DEBOUNCE_MS);
    });
}

/**
 * Handle external volume update (from WebSocket or polling)
 * Returns true if update was applied, false if suppressed
 */
function handleExternalVolumeUpdate(volume, setLastVolume, broadcast) {
    // Suppress updates during user interaction
    if (shouldSuppressExternalUpdate()) {
        return false;
    }
    
    const roundedVolume = Math.round(volume);
    
    // Only update if different from current
    if (roundedVolume !== lastSetVolume) {
        lastSetVolume = roundedVolume;
        setLastVolume(roundedVolume);
        broadcast({ type: 'volume_updated', data: { volume: roundedVolume } });
        return true;
    }
    
    return false;
}

/**
 * Toggle mute with proper state management
 */
async function toggleMute(proxyRequest, broadcast, setLastVolume) {
    lastUserSetTime = Date.now();
    
    try {
        const result = await proxyRequest('POST', '/toggle-mute');
        if (result.success) {
            const volumeResult = await proxyRequest('GET', '/volume');
            if (volumeResult.success) {
                const actualVolume = volumeResult.data?.volume ?? volumeResult.data?.state ?? volumeResult.data?.value ?? 0;
                lastSetVolume = actualVolume;
                setLastVolume(actualVolume);
                broadcast({ type: 'volume_updated', data: { volume: actualVolume } });
            } else {
                broadcast({ type: 'volume_updated' });
            }
            return result;
        }
        return result;
    } catch (error) {
        throw error;
    }
}

/**
 * Get current volume from cache or API
 */
function getLastSetVolume() {
    return lastSetVolume;
}

/**
 * Clear pending volume updates (useful on disconnect)
 */
function clearPendingVolumeUpdates() {
    if (volumeUpdateTimeout) {
        clearTimeout(volumeUpdateTimeout);
        volumeUpdateTimeout = null;
    }
    pendingVolumeUpdate = null;
}

module.exports = {
    setVolume,
    handleExternalVolumeUpdate,
    toggleMute,
    getLastSetVolume,
    clearPendingVolumeUpdates,
    shouldSuppressExternalUpdate
};
