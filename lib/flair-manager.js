const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const FLAIRS_FILE_NAME = 'queue-flairs.json';
const MAX_FLAIR_EMOJI_LENGTH = 32;
const emojiSegmenter = typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function'
    ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
    : null;

function normalizeFlairEmoji(emoji) {
    return typeof emoji === 'string' ? emoji.trim() : '';
}

function splitGraphemes(value) {
    if (!value) return [];
    if (emojiSegmenter) {
        return Array.from(emojiSegmenter.segment(value), part => part.segment);
    }
    return Array.from(value);
}

function isValidFlairEmoji(emoji) {
    const normalized = normalizeFlairEmoji(emoji);
    if (!normalized || normalized.length > MAX_FLAIR_EMOJI_LENGTH) return false;

    const graphemes = splitGraphemes(normalized);
    if (graphemes.length !== 1 || graphemes[0] !== normalized) return false;

    return /\p{Extended_Pictographic}|\p{Emoji_Presentation}|\p{Regional_Indicator}|[#*0-9]\ufe0f?\u20e3/u.test(normalized);
}

function resolveRootConfigFile(fileName) {
    const candidates = [
        path.resolve(__dirname, '..', fileName),
        path.resolve(__dirname, fileName),
        path.resolve(process.cwd(), fileName)
    ];

    if (process.pkg) {
        candidates.unshift(path.resolve(path.dirname(process.execPath), fileName));
    }

    for (const filePath of candidates) {
        try {
            if (fs.existsSync(filePath)) return filePath;
        } catch (_) {
            // ignore and continue
        }
    }

    return candidates[0];
}

const FLAIRS_FILE = resolveRootConfigFile(FLAIRS_FILE_NAME);
const flairsByVideoId = new Map();

function normalizeFlairIp(ip, normalizeIpAddress) {
    const normalized = typeof normalizeIpAddress === 'function' ? normalizeIpAddress(ip) : ip;
    return normalized || ip || 'unknown';
}

function loadQueueFlairsFromDisk() {
    try {
        if (!fs.existsSync(FLAIRS_FILE)) return;
        const raw = fs.readFileSync(FLAIRS_FILE, 'utf8');
        const data = JSON.parse(raw);
        if (!data || typeof data !== 'object') return;

        flairsByVideoId.clear();
        for (const [videoId, entries] of Object.entries(data)) {
            if (!videoId || !entries || typeof entries !== 'object') continue;
            const flairMap = new Map();
            for (const [ipKey, flair] of Object.entries(entries)) {
                if (!ipKey || !flair || typeof flair !== 'object') continue;
                const emoji = normalizeFlairEmoji(flair.emoji);
                if (!isValidFlairEmoji(emoji)) continue;
                flairMap.set(ipKey, {
                    emoji,
                    ip: flair.ip || ipKey,
                    displayName: flair.displayName || flair.ip || ipKey,
                    updatedAt: Number(flair.updatedAt) || Date.now()
                });
            }
            if (flairMap.size > 0) {
                flairsByVideoId.set(videoId, flairMap);
            }
        }
    } catch (error) {
        console.warn('Could not load queue-flairs.json:', error?.message || error);
    }
}

async function saveQueueFlairsToDisk() {
    const data = {};
    for (const [videoId, flairMap] of flairsByVideoId.entries()) {
        data[videoId] = {};
        for (const [ipKey, flair] of flairMap.entries()) {
            data[videoId][ipKey] = flair;
        }
    }

    const tempPath = `${FLAIRS_FILE}.tmp`;
    await fsp.writeFile(tempPath, JSON.stringify(data, null, 2), 'utf8');
    await fsp.rename(tempPath, FLAIRS_FILE);
}

function getFlairsForVideo(videoId) {
    const flairMap = flairsByVideoId.get(videoId);
    if (!flairMap) return [];
    return Array.from(flairMap.values()).sort((a, b) => (a.updatedAt || 0) - (b.updatedAt || 0));
}

async function setFlairForVideo(videoId, clientIp, displayName, emoji, normalizeIpAddress) {
    if (!videoId || typeof videoId !== 'string') {
        throw new Error('videoId is required');
    }
    const normalizedEmoji = normalizeFlairEmoji(emoji);
    if (!isValidFlairEmoji(normalizedEmoji)) {
        throw new Error('Unsupported flair emoji');
    }

    const ipKey = normalizeFlairIp(clientIp, normalizeIpAddress);
    let flairMap = flairsByVideoId.get(videoId);
    if (!flairMap) {
        flairMap = new Map();
        flairsByVideoId.set(videoId, flairMap);
    }

    const existingFlair = flairMap.get(ipKey);
    if (existingFlair?.emoji === normalizedEmoji) {
        flairMap.delete(ipKey);
        if (flairMap.size === 0) {
            flairsByVideoId.delete(videoId);
        }
        await saveQueueFlairsToDisk();
        return {
            videoId,
            removed: true,
            flair: existingFlair,
            flairs: getFlairsForVideo(videoId)
        };
    }

    const flair = {
        emoji: normalizedEmoji,
        ip: clientIp || ipKey,
        displayName: displayName || ipKey,
        updatedAt: Date.now()
    };
    flairMap.set(ipKey, flair);
    await saveQueueFlairsToDisk();
    return {
        videoId,
        flair,
        flairs: getFlairsForVideo(videoId)
    };
}

function enrichQueueItemsWithFlairs(queueItems, extractVideoIdFromItem) {
    if (!Array.isArray(queueItems)) return queueItems;

    return queueItems.map(item => {
        const videoId = extractVideoIdFromItem(item);
        if (!videoId) return item;

        const flairs = getFlairsForVideo(videoId);
        if (flairs.length === 0) {
            delete item._flairs;
            if (item.playlistPanelVideoRenderer && typeof item.playlistPanelVideoRenderer === 'object') {
                delete item.playlistPanelVideoRenderer._flairs;
            }
            return item;
        }

        item._flairs = flairs;
        if (item.playlistPanelVideoRenderer && typeof item.playlistPanelVideoRenderer === 'object') {
            item.playlistPanelVideoRenderer._flairs = flairs;
        }
        return item;
    });
}

loadQueueFlairsFromDisk();

module.exports = {
    isValidFlairEmoji,
    getFlairsForVideo,
    setFlairForVideo,
    enrichQueueItemsWithFlairs,
    loadQueueFlairsFromDisk
};
