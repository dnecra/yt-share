/**
 * Canonical volume state manager.
 *
 * The browser-facing contract is always an integer percentage from 0 to 100.
 * Writes are coalesced while an upstream request is running, so rapid slider
 * input is last-write-wins without leaving any caller's promise unresolved.
 */

let lastSetVolume = null;
let desiredVolume = null;
let desiredVersion = 0;
let appliedVersion = 0;
let writeWorker = null;
let waiters = [];

function normalizeVolume(value) {
    const numeric = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
    if (!Number.isFinite(numeric) || numeric < 0 || numeric > 100) {
        return null;
    }
    return Math.round(numeric);
}

function extractVolume(data, fallback = null) {
    const raw = data && typeof data === 'object'
        ? data.volume ?? data.state ?? data.value
        : data;
    const normalized = normalizeVolume(raw);
    return normalized === null ? normalizeVolume(fallback) : normalized;
}

function publishVolume(volume, setLastVolume, broadcast, extra = {}) {
    lastSetVolume = volume;
    setLastVolume(volume);
    broadcast({ type: 'volume_updated', data: { volume }, ...extra });
}

function settleWaiters(version, result, error = null) {
    const settled = waiters.filter((waiter) => waiter.version <= version);
    waiters = waiters.filter((waiter) => waiter.version > version);
    for (const waiter of settled) {
        if (error) waiter.reject(error);
        else waiter.resolve(result);
    }
}

async function runWriteWorker(proxyRequest, broadcast, setLastVolume) {
    while (appliedVersion < desiredVersion) {
        const version = desiredVersion;
        const volume = desiredVolume;
        const result = await proxyRequest('POST', '/volume', { volume });

        if (!result.success) {
            // A newer target can still be attempted. Only fail requests that
            // were covered by this failed upstream write.
            appliedVersion = version;
            if (version === desiredVersion) {
                await reconcileAfterFailure(proxyRequest, broadcast, setLastVolume, version);
            }
            settleWaiters(version, result);
            continue;
        }

        const actualVolume = extractVolume(result.data, volume);
        appliedVersion = version;

        // Do not publish an intermediate response if newer slider input was
        // received while this request was in flight.
        if (version === desiredVersion) {
            publishVolume(actualVolume, setLastVolume, broadcast);
        }

        settleWaiters(version, {
            ...result,
            data: { ...(result.data && typeof result.data === 'object' ? result.data : {}), volume: actualVolume }
        });
    }
}

async function reconcileAfterFailure(proxyRequest, broadcast, setLastVolume, expectedVersion) {
    const current = await proxyRequest('GET', '/volume');
    if (!current.success) return;
    const volume = extractVolume(current.data);
    if (volume !== null && expectedVersion === desiredVersion) {
        publishVolume(volume, setLastVolume, broadcast);
    }
}

function ensureWriteWorker(proxyRequest, broadcast, setLastVolume) {
    if (writeWorker) return;

    writeWorker = runWriteWorker(proxyRequest, broadcast, setLastVolume)
        .catch(async (error) => {
            const failedThroughVersion = desiredVersion;
            appliedVersion = failedThroughVersion;
            settleWaiters(failedThroughVersion, null, error);
            try {
                await reconcileAfterFailure(proxyRequest, broadcast, setLastVolume, failedThroughVersion);
            } catch (_) {
                // The original write error is the useful error for callers.
            }
        })
        .finally(() => {
            writeWorker = null;
            if (appliedVersion < desiredVersion) {
                ensureWriteWorker(proxyRequest, broadcast, setLastVolume);
            }
        });
}

function setVolume(volume, proxyRequest, broadcast, setLastVolume) {
    const normalized = normalizeVolume(volume);
    if (normalized === null) {
        return Promise.resolve({
            success: false,
            status: 400,
            error: 'Volume must be a number between 0 and 100'
        });
    }

    desiredVolume = normalized;
    const version = ++desiredVersion;

    // This is responsive for every connected client. The worker later emits
    // the authoritative upstream result for the newest target only.
    publishVolume(normalized, setLastVolume, broadcast, { optimistic: true });

    const promise = new Promise((resolve, reject) => {
        waiters.push({ version, resolve, reject });
    });
    ensureWriteWorker(proxyRequest, broadcast, setLastVolume);
    return promise;
}

function handleExternalVolumeUpdate(volume, setLastVolume, broadcast) {
    const normalized = normalizeVolume(volume);
    if (normalized === null) return false;

    // Polling and upstream WebSocket messages may describe an older value
    // while a local write is queued or in flight.
    if (writeWorker || appliedVersion < desiredVersion) return false;
    if (normalized === lastSetVolume) return false;

    publishVolume(normalized, setLastVolume, broadcast);
    return true;
}

async function toggleMute(proxyRequest, broadcast, setLastVolume) {
    // Finish queued volume writes before toggling, otherwise a late write can
    // immediately undo the mute operation.
    if (writeWorker) await writeWorker;

    const result = await proxyRequest('POST', '/toggle-mute');
    if (!result.success) return result;

    const current = await proxyRequest('GET', '/volume');
    const volume = current.success ? extractVolume(current.data) : null;
    if (volume !== null) publishVolume(volume, setLastVolume, broadcast);
    return result;
}

function getLastSetVolume() {
    return lastSetVolume;
}

function clearPendingVolumeUpdates() {
    // In-flight network requests cannot be cancelled safely. Rejecting or
    // dropping their callers would recreate the hanging-request bug.
}

function shouldSuppressExternalUpdate() {
    return !!writeWorker || appliedVersion < desiredVersion;
}

module.exports = {
    setVolume,
    handleExternalVolumeUpdate,
    toggleMute,
    getLastSetVolume,
    clearPendingVolumeUpdates,
    shouldSuppressExternalUpdate,
    normalizeVolume,
    extractVolume
};
