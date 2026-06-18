const WebSocket = require('ws');

const CHAT_ENABLED = process.env.CHAT_ENABLED !== 'false';
const MAX_CHAT_HISTORY = 80;
const MAX_CHAT_MESSAGE_LENGTH = 500;

let nextMessageId = 1;
const chatHistory = [];
let nextNoticeId = 1;
let latestNotice = null;

function appendChatHistory(entry) {
    if (!CHAT_ENABLED || !entry || typeof entry !== 'object') return null;

    const historyEntry = {
        ...entry,
        id: entry.id || nextMessageId++,
        createdAt: entry.createdAt || new Date().toISOString()
    };

    chatHistory.push(historyEntry);
    if (chatHistory.length > MAX_CHAT_HISTORY) {
        chatHistory.splice(0, chatHistory.length - MAX_CHAT_HISTORY);
    }

    return historyEntry;
}

function sanitizeChatText(value) {
    return String(value || '')
        .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
        .replace(/\s+\n/g, '\n')
        .replace(/\n{4,}/g, '\n\n\n')
        .trim()
        .slice(0, MAX_CHAT_MESSAGE_LENGTH);
}

function buildChatMessage(rawText, clientInfo = {}) {
    const text = sanitizeChatText(rawText);
    if (!text) {
        throw new Error('Message cannot be empty');
    }

    return {
        id: nextMessageId++,
        type: 'chat_message',
        text,
        senderName: String(clientInfo.displayName || clientInfo.ip || 'Guest').slice(0, 80),
        senderIp: String(clientInfo.ip || ''),
        createdAt: new Date().toISOString()
    };
}

function buildChatNotice(rawText, clientInfo = {}) {
    const text = sanitizeChatText(String(rawText || '').replace(/^<notice>/i, ''));
    if (!text) {
        throw new Error('Notice cannot be empty');
    }

    return {
        id: nextNoticeId++,
        type: 'chat_notice',
        text,
        senderName: String(clientInfo.displayName || clientInfo.ip || 'Guest').slice(0, 80),
        senderIp: String(clientInfo.ip || ''),
        createdAt: new Date().toISOString()
    };
}

function sendChatHistory(ws) {
    if (!CHAT_ENABLED || !ws || ws.readyState !== WebSocket.OPEN) return;

    ws.send(JSON.stringify({
        type: 'chat_history',
        enabled: true,
        messages: chatHistory
    }));
}

function sendLatestNotice(ws) {
    if (!CHAT_ENABLED || !latestNotice || !ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify(latestNotice));
}

function sendChatDisabled(ws) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;

    ws.send(JSON.stringify({
        type: 'chat_disabled',
        enabled: false
    }));
}

function handleChatClientMessage(ws, message, clientInfo, broadcast) {
    if (!message || typeof message !== 'object') {
        return false;
    }

    if (message.type === 'chat_get_history') {
        if (CHAT_ENABLED) {
            sendChatHistory(ws);
        } else {
            sendChatDisabled(ws);
        }
        return true;
    }

    if (message.type !== 'chat_send') {
        return false;
    }

    if (!CHAT_ENABLED) {
        sendChatDisabled(ws);
        return true;
    }

    try {
        const rawText = String(message.text || '').trim();
        if (/^<notice>/i.test(rawText)) {
            latestNotice = buildChatNotice(rawText, clientInfo);
            broadcast(latestNotice);
            return true;
        }

        const chatMessage = appendChatHistory(buildChatMessage(message.text, clientInfo));
        broadcast(chatMessage);
    } catch (error) {
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
                type: 'chat_error',
                error: error.message || 'Failed to send message'
            }));
        }
    }

    return true;
}

module.exports = {
    CHAT_ENABLED,
    appendChatHistory,
    sendChatHistory,
    sendLatestNotice,
    handleChatClientMessage
};
