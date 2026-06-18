const LOG_COLORS = {
    reset: '\x1b[0m',
    dim: '\x1b[2m',
    info: '\x1b[36m',
    success: '\x1b[32m',
    warn: '\x1b[33m',
    error: '\x1b[31m',
    action: '\x1b[35m'
};

/**
 * Log an event with colored output.
 */
function logEvent(level, tag, message, meta = null) {
    const color = LOG_COLORS[level] || LOG_COLORS.info;
    console.log(`${color}[${tag}]${LOG_COLORS.reset} ${message}`);
}

const recentLogs = new Map();
const DEFAULT_REPEAT_TTL = parseInt(process.env.LOG_REPEAT_TTL || '60000', 10);
const MAX_RECENT_LOG_KEYS = parseInt(process.env.MAX_RECENT_LOG_KEYS || '5000', 10);

/**
 * Log a message only once within a TTL to reduce repeated messages.
 */
function logOnce(tag, message, ttl = DEFAULT_REPEAT_TTL) {
    try {
        const key = `${tag}|${message}`;
        const now = Date.now();
        const last = recentLogs.get(key) || 0;
        if (now - last < ttl) return;
        recentLogs.set(key, now);
        if (recentLogs.size > MAX_RECENT_LOG_KEYS) {
            for (const [k, ts] of recentLogs.entries()) {
                if (now - ts > ttl) {
                    recentLogs.delete(k);
                }
            }
            if (recentLogs.size > MAX_RECENT_LOG_KEYS) {
                const overflow = recentLogs.size - MAX_RECENT_LOG_KEYS;
                let dropped = 0;
                for (const k of recentLogs.keys()) {
                    recentLogs.delete(k);
                    dropped++;
                    if (dropped >= overflow) break;
                }
            }
        }
        logEvent('info', tag, message);
    } catch (e) {
        console.log(`[${tag}] ${message}`);
    }
}

/**
 * Log an action with optional IP/display metadata for auditing.
 */
function logAction(tag, message, meta, getRandomNameForIp, normalizeIpAddress) {
    let msg = message;
    try {
        if (meta && meta.ip) {
            const normalizedIp = (typeof normalizeIpAddress === 'function') ? normalizeIpAddress(meta.ip) : meta.ip;
            const display = (typeof getRandomNameForIp === 'function') ? getRandomNameForIp(normalizedIp) : normalizedIp;
            const displayColored = `${LOG_COLORS.success}${display}${LOG_COLORS.reset}`;
            const ipColored = `${LOG_COLORS.info}${meta.ip}${LOG_COLORS.reset}`;
            msg = `${message} — from ${displayColored} (${ipColored})`;
        }
    } catch (e) {
    }
    logEvent('action', tag, msg, meta);
}

function formatActor(meta, getRandomNameForIp, normalizeIpAddress) {
    const ip = meta?.ip || meta?.senderIp || 'unknown';
    const normalizedIp = (typeof normalizeIpAddress === 'function') ? normalizeIpAddress(ip) : ip;
    const display = meta?.displayName || ((typeof getRandomNameForIp === 'function') ? getRandomNameForIp(normalizedIp) : normalizedIp) || normalizedIp;
    const displayColored = `${LOG_COLORS.success}${display}${LOG_COLORS.reset}`;
    const ipColored = `${LOG_COLORS.info}${ip}${LOG_COLORS.reset}`;
    return `${displayColored} (${ipColored})`;
}

function compactSongLabel(item) {
    if (!item || typeof item !== 'object') return '';
    const title = String(item.title || item.name || item.videoTitle || '').trim();
    const artist = String(item.artist || item.author || item.channelName || item.channel || '').trim();
    if (title && artist) return `${title} - ${artist}`;
    return title || artist || String(item.videoId || item.id || '').trim();
}

function formatNavigationResult(result = {}) {
    const from = Number.isInteger(result.currentIndex) ? result.currentIndex : '?';
    const to = Number.isInteger(result.targetIndex) ? result.targetIndex : '?';
    const method = result.method ? ` via ${result.method}` : '';
    const targetLabel = compactSongLabel(result.targetItem);
    const target = targetLabel ? ` -> "${targetLabel}"` : '';
    return `${from} -> ${to}${method}${target}`;
}

function logPlaybackAction(stage, message, meta, getRandomNameForIp, normalizeIpAddress) {
    const actor = meta?.ip ? ` by ${formatActor(meta, getRandomNameForIp, normalizeIpAddress)}` : '';
    const suffix = meta?.result ? ` (${formatNavigationResult(meta.result)})` : '';
    const level = stage === 'failed' ? 'error' : stage === 'done' ? 'success' : 'action';
    logEvent(level, 'PLAYBACK', `${message}${actor}${suffix}`, meta);
}

const recentLyricsCacheHits = new Map();
const LYRICS_CACHE_HIT_TTL = parseInt(process.env.LYRICS_CACHE_HIT_TTL || '60000', 10);
const MAX_RECENT_LYRICS_CACHE_HITS = parseInt(process.env.MAX_RECENT_LYRICS_CACHE_HITS || '5000', 10);

/**
 * Throttled log for lyrics cache hits for a specific video id.
 */
function logLyricsCacheHit(videoId) {
    try {
        const now = Date.now();
        const last = recentLyricsCacheHits.get(videoId) || 0;
        if (now - last < LYRICS_CACHE_HIT_TTL) return;
        recentLyricsCacheHits.set(videoId, now);
        if (recentLyricsCacheHits.size > MAX_RECENT_LYRICS_CACHE_HITS) {
            for (const [k, ts] of recentLyricsCacheHits.entries()) {
                if (now - ts > LYRICS_CACHE_HIT_TTL) {
                    recentLyricsCacheHits.delete(k);
                }
            }
            if (recentLyricsCacheHits.size > MAX_RECENT_LYRICS_CACHE_HITS) {
                const overflow = recentLyricsCacheHits.size - MAX_RECENT_LYRICS_CACHE_HITS;
                let dropped = 0;
                for (const k of recentLyricsCacheHits.keys()) {
                    recentLyricsCacheHits.delete(k);
                    dropped++;
                    if (dropped >= overflow) break;
                }
            }
        }
        logEvent('info', 'LYRICS', `Cache hit for videoId: ${videoId}`);
    } catch (e) {
        logEvent('info', 'LYRICS', `Cache hit for videoId: ${videoId}`);
    }
}

module.exports = {
    LOG_COLORS,
    logEvent,
    logOnce,
    logAction,
    logPlaybackAction,
    formatNavigationResult,
    logLyricsCacheHit
};
