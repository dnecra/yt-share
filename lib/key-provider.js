const path = require('path');

function loadLocalProvider() {
    const localPath = path.join(__dirname, 'key-provider.local.js');
    try {
        // Intentionally load from an ignored local file so secrets never need to live in /public.
        return require(localPath);
    } catch (error) {
        if (error && error.code === 'MODULE_NOT_FOUND') {
            return {};
        }
        throw error;
    }
}

function normalizeKey(value) {
    return String(value || '').trim();
}

function getApiKeys() {
    const local = loadLocalProvider();

    return {
        rapidApiHost: normalizeKey(
            local.rapidApiHost
            || process.env.RAPIDAPI_HOST
            || 'youtube-music-api3.p.rapidapi.com'
        ),
        rapidApiKey: normalizeKey(
            local.rapidApiKey
            || process.env.RAPIDAPI_KEY
        )
    };
}

function hasUsableSecret(value) {
    return Boolean(normalizeKey(value)) && !/YOUR_|REPLACE|CHANGEME/i.test(String(value));
}

module.exports = {
    getApiKeys,
    hasUsableSecret
};
