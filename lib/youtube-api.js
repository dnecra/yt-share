const axios = require('axios');

const YT_MUSIC_API_URLS = process.env.YT_MUSIC_API_URL 
    ? [process.env.YT_MUSIC_API_URL]
    : ['http://127.0.0.1:26538/api/v1'];

let currentApiUrlIndex = 0;
let lastSuccessfulApiUrl = null;
let lastApiCallTime = 0;
const MIN_API_CALL_INTERVAL = 100;

function getActiveApiUrl() {
    return YT_MUSIC_API_URLS[currentApiUrlIndex];
}

/**
 * Construct a WebSocket URL (ws/wss) for a given API URL, handling path.
 */
function getWebSocketUrl(apiUrl = null) {
    const targetUrl = apiUrl || getActiveApiUrl();
    try {
        const url = new URL(targetUrl);
        const wsProtocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
        const pathname = url.pathname.endsWith('/ws') ? url.pathname : `${url.pathname}/ws`;
        return `${wsProtocol}//${url.host}${pathname}`;
    } catch (error) {
        console.error('Error constructing WebSocket URL:', error);
        const wsUrl = targetUrl.replace(/^https?:/, 'ws:').replace(/^http:/, 'ws:');
        return wsUrl.endsWith('/ws') ? wsUrl : `${wsUrl}/ws`;
    }
}

/**
 * Return the active WebSocket URL derived from the active API URL.
 */
function getActiveWebSocketUrl() {
    return getWebSocketUrl(getActiveApiUrl());
}

/**
 * Proxy an HTTP request to the configured YouTube Music API URLs with retry and failover.
 */
async function proxyRequest(method, endpoint, data = null, params = null) {
    const now = Date.now();
    const timeSinceLastCall = now - lastApiCallTime;
    if (timeSinceLastCall < MIN_API_CALL_INTERVAL) {
        await new Promise(resolve => setTimeout(resolve, MIN_API_CALL_INTERVAL - timeSinceLastCall));
    }
    const urlsToTry = [...YT_MUSIC_API_URLS];
    const startIndex = currentApiUrlIndex;
    for (let attempt = 0; attempt < urlsToTry.length; attempt++) {
        const urlIndex = (startIndex + attempt) % urlsToTry.length;
        const apiUrl = urlsToTry[urlIndex];
        try {
            const config = {
                method,
                url: `${apiUrl}${endpoint}`,
                headers: {
                    'Content-Type': 'application/json',
                },
                timeout: 5000,
            };
            if (data) {
                config.data = data;
            }
            if (params) {
                config.params = params;
            }
            lastApiCallTime = Date.now();
            const response = await axios(config);
            if (urlIndex !== currentApiUrlIndex) {
                console.log(`[API-FALLBACK] Switched to ${apiUrl} (was ${YT_MUSIC_API_URLS[currentApiUrlIndex]})`);
                currentApiUrlIndex = urlIndex;
                // Notify caller that reconnect is needed
                if (this.onApiUrlChanged) {
                    this.onApiUrlChanged();
                }
            }
            lastSuccessfulApiUrl = apiUrl;
            return { success: true, data: response.data, status: response.status };
        } catch (error) {
            const isConnectionError = error.code === 'ECONNREFUSED' || 
                                     error.code === 'ETIMEDOUT' || 
                                     error.code === 'ENOTFOUND' ||
                                     error.code === 'ECONNRESET' ||
                                     error.message.includes('timeout');
            if (isConnectionError && attempt < urlsToTry.length - 1) {
                console.log(`[API-FALLBACK] ${apiUrl} failed (${error.code || error.message}), trying next...`);
                continue;
            }
            console.error(`Error proxying ${method} ${endpoint}:`, error.message);
            return { 
                success: false, 
                error: error.message, 
                status: error.response?.status || 500,
                data: error.response?.data || null
            };
        }
    }
    return { 
        success: false, 
        error: 'All API URLs failed', 
        status: 503,
        data: null
    };
}

function setApiUrlChangeCallback(callback) {
    proxyRequest.onApiUrlChanged = callback;
}

module.exports = {
    getActiveApiUrl,
    getWebSocketUrl,
    getActiveWebSocketUrl,
    proxyRequest,
    setApiUrlChangeCallback,
    YT_MUSIC_API_URLS
};
