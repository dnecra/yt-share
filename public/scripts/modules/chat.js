import { state } from './config.js';
import { escapeHtml } from './utils.js';
import { showToast } from './ui.js';

const CHAT_PANEL_STORAGE_KEY = 'yt-share-chat-open';
const MAX_CHAT_MESSAGE_LENGTH = 500;
const CHAT_NAME_HUES = [
    0, 205, 52, 286, 154, 24, 226, 325,
    96, 184, 268, 342, 132, 34, 244, 304,
    72, 170, 214, 12, 112, 196, 258, 318,
    44, 144, 232, 292, 88, 166, 276, 336
];
const senderColorCache = new Map();
const usedSenderHues = [];

let initialized = false;
let messageList = null;
let messageForm = null;
let messageInput = null;
let emptyState = null;
let noticeModal = null;
let noticeMessage = null;
let noticeClose = null;
let noticeTicker = null;
let noticeMarquee = null;
let noticeTickerClose = null;
let onlineList = null;
let edgeBubble = null;
let edgeBubbleSender = null;
let edgeBubbleText = null;
const activeStreamClients = new Map();

function isChatOpen() {
    return document.body.classList.contains('chat-open');
}

function updateChatEdgeTab(open = isChatOpen()) {
    const tab = document.getElementById('chat-edge-tab');
    if (!tab) return;
    tab.setAttribute('aria-expanded', open ? 'true' : 'false');
    tab.title = open ? 'Close chat' : 'Open chat';
    if (open) {
        hideChatEdgeBubble();
    }
}

function persistChatOpen(open) {
    try {
        localStorage.setItem(CHAT_PANEL_STORAGE_KEY, open ? '1' : '0');
    } catch (_) {
        // Ignore storage failures.
    }
}

function scrollChatToBottom() {
    if (!messageList) return;
    messageList.scrollTop = messageList.scrollHeight;
}

function updateEmptyState() {
    if (!emptyState || !messageList) return;
    const hasMessages = messageList.querySelector('.chat-message');
    emptyState.hidden = !!hasMessages;
}

function getSenderColor(message) {
    const key = String(message?.senderIp || message?.senderName || 'guest');
    const cached = senderColorCache.get(key);
    if (cached) return cached.color;

    let hash = 0;
    for (let i = 0; i < key.length; i += 1) {
        hash = ((hash << 5) - hash) + key.charCodeAt(i);
        hash |= 0;
    }

    const start = Math.abs(hash) % CHAT_NAME_HUES.length;
    let selectedHue = CHAT_NAME_HUES[start];
    let selectedDistance = -1;

    for (let i = 0; i < CHAT_NAME_HUES.length; i += 1) {
        const hue = CHAT_NAME_HUES[(start + i) % CHAT_NAME_HUES.length];
        const minDistance = usedSenderHues.length === 0
            ? 180
            : Math.min(...usedSenderHues.map((usedHue) => {
                const diff = Math.abs(hue - usedHue) % 360;
                return Math.min(diff, 360 - diff);
            }));

        if (minDistance > selectedDistance) {
            selectedHue = hue;
            selectedDistance = minDistance;
        }
    }

    usedSenderHues.push(selectedHue);
    const color = `oklch(78% 0.19 ${selectedHue})`;
    senderColorCache.set(key, { color, hue: selectedHue });
    return color;
}

function cleanDisplayIp(value) {
    const ip = String(value || '').trim();
    if (ip.startsWith('::ffff:')) return ip.slice(7);
    if (ip === '::1' || ip === '::') return '127.0.0.1';
    return ip;
}

function getDisplayActor(message) {
    const name = String(message?.senderName || '').trim();
    if (name && name !== 'unknown') return name;
    return cleanDisplayIp(message?.senderIp) || 'unknown';
}

function renderChatMessage(message) {
    if (!messageList || !message) return;

    const item = document.createElement('div');
    item.className = 'chat-message';
    item.dataset.messageId = String(message.id || '');

    const time = message.createdAt
        ? new Date(message.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        : '';
    const senderColor = getSenderColor(message);
    const senderName = getDisplayActor(message);

    item.innerHTML = `
        <span class="chat-line-main">
            <span class="chat-sender" style="color: ${senderColor}">[${escapeHtml(senderName || 'Guest')}]</span><span class="chat-colon">:</span>
            <span class="chat-message-text">${escapeHtml(message.text || '')}</span>
        </span>
        <span class="chat-time">${escapeHtml(time)}</span>
    `;

    messageList.appendChild(item);
    updateEmptyState();
    scrollChatToBottom();
}

function hideChatEdgeBubble() {
    if (edgeBubble) {
        edgeBubble.hidden = true;
        edgeBubble.classList.remove('visible');
    }
}

function showChatEdgeBubble(message) {
    if (isChatOpen() || !edgeBubble || !edgeBubbleSender || !edgeBubbleText) return;

    edgeBubbleSender.textContent = getDisplayActor(message) || 'Guest';
    edgeBubbleSender.style.color = getSenderColor(message);
    edgeBubbleText.textContent = message?.text || '';
    edgeBubble.hidden = false;
    void edgeBubble.offsetWidth;
    edgeBubble.classList.add('visible');
}

function renderChatLog(message) {
    if (!messageList || !message) return;

    const item = document.createElement('div');
    item.className = 'chat-message chat-log-message';

    const actor = getDisplayActor(message);
    const time = message.createdAt
        ? new Date(message.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        : '';

    item.innerHTML = `
        <span class="chat-line-main">
            <span class="chat-log-actor">[${escapeHtml(actor)}]</span>
            <span class="chat-log-action">${escapeHtml(message.action || 'changed playback')}</span>
        </span>
        <span class="chat-time">${escapeHtml(time)}</span>
    `;

    messageList.appendChild(item);
    updateEmptyState();
    scrollChatToBottom();
}

function closeNotice() {
    if (noticeModal) noticeModal.hidden = true;
    document.body.classList.remove('chat-notice-active');
}

function closeNoticeTicker() {
    if (noticeTicker) noticeTicker.hidden = true;
}

function updateNoticeMarquee() {
    if (!noticeMarquee || !noticeTicker || noticeTicker.hidden) return;

    noticeTicker.classList.remove('is-overflowing');
    noticeMarquee.style.removeProperty('--chat-notice-marquee-start');
    noticeMarquee.style.removeProperty('--chat-notice-marquee-distance');
    noticeMarquee.style.removeProperty('--chat-notice-marquee-duration');
    noticeMarquee.style.animation = 'none';

    requestAnimationFrame(() => {
        if (!noticeMarquee || !noticeTicker || noticeTicker.hidden) return;

        const closeButtonSpace = 44;
        const leftInset = 12;
        const viewportWidth = Math.max(0, noticeTicker.clientWidth - closeButtonSpace - leftInset);
        const textWidth = noticeMarquee.scrollWidth;
        const shouldScroll = textWidth > viewportWidth;
        noticeTicker.classList.toggle('is-overflowing', shouldScroll);

        if (!shouldScroll) {
            noticeMarquee.style.animation = '';
            return;
        }

        const gap = 48;
        const distance = textWidth + viewportWidth + gap;
        const start = viewportWidth + gap;
        const duration = Math.max(10, distance / 42);

        noticeMarquee.style.setProperty('--chat-notice-marquee-start', `${start}px`);
        noticeMarquee.style.setProperty('--chat-notice-marquee-distance', `${distance}px`);
        noticeMarquee.style.setProperty('--chat-notice-marquee-duration', `${duration}s`);
        requestAnimationFrame(() => {
            if (noticeMarquee) noticeMarquee.style.animation = '';
        });
    });
}

function showNotice(message) {
    const text = String(message?.text || '').trim();
    if (!text) return;

    if (noticeMessage) {
        noticeMessage.textContent = text;
    }
    if (noticeModal) {
        noticeModal.hidden = false;
    }
    document.body.classList.add('chat-notice-active');

    if (noticeMarquee) {
        const sender = message?.senderName ? `${message.senderName}: ` : '';
        noticeMarquee.textContent = `${sender}${text}`;
    }
    if (noticeTicker) {
        noticeTicker.hidden = false;
    }
    updateNoticeMarquee();
}

function renderChatHistory(messages) {
    if (!messageList) return;
    messageList.innerHTML = '';
    if (emptyState) {
        messageList.appendChild(emptyState);
    }
    (Array.isArray(messages) ? messages : []).forEach((message) => {
        if (message?.type === 'chat_log') {
            renderChatLog(message);
        } else if (message?.type === 'chat_message') {
            renderChatMessage(message);
        }
    });
    updateEmptyState();
    scrollChatToBottom();
}

function renderOnlineClients(clients) {
    if (!onlineList) return;

    const list = Array.isArray(clients) ? clients : [];
    onlineList.innerHTML = '';

    if (list.length === 0) {
        const empty = document.createElement('span');
        empty.className = 'chat-online-empty';
        empty.textContent = 'No clients';
        onlineList.appendChild(empty);
        return;
    }

    list.forEach((client) => {
        const item = document.createElement('span');
        item.className = 'chat-online-client';
        const name = document.createElement('span');
        name.className = 'chat-online-name';
        name.textContent = getDisplayActor(client) || 'Client';
        name.style.color = getSenderColor(client);
        item.appendChild(name);

        const count = Number(client?.count || 0);
        if (count > 1) {
            const badge = document.createElement('span');
            badge.className = 'chat-online-count';
            badge.textContent = String(count);
            item.appendChild(badge);
        }

        onlineList.appendChild(item);
    });
}

function sendChatMessage(text) {
    const trimmed = String(text || '').trim();
    if (!trimmed) return;

    if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
        showToast('Chat is disconnected');
        return;
    }

    state.ws.send(JSON.stringify({
        type: 'chat_send',
        text: trimmed.slice(0, MAX_CHAT_MESSAGE_LENGTH)
    }));
}

function requestChatHistory() {
    if (!state.ws || state.ws.readyState !== WebSocket.OPEN) return;
    state.ws.send(JSON.stringify({ type: 'chat_get_history' }));
}

function updateStreamStatusIndicator() {
    const status = document.getElementById('client-stream-status');
    const text = document.getElementById('client-stream-status-text');
    if (!status) return;

    const names = Array.from(activeStreamClients.values()).filter(Boolean);
    status.hidden = names.length === 0;
    status.title = names.length > 0
        ? `Streaming: ${names.join(', ')}`
        : '';
    if (text) {
        const label = names.length === 1 ? names[0] : `${names.length} clients`;
        text.innerHTML = `<span class="client-stream-status-name">${escapeHtml(label)}</span> <span class="client-stream-status-suffix">streaming</span>`;
    }
}

function handleClientStreamStatus(message) {
    const key = String(message?.senderIp || message?.senderName || 'unknown');
    if (message?.active) {
        activeStreamClients.set(key, message.senderName || 'Client');
    } else {
        activeStreamClients.delete(key);
    }
    updateStreamStatusIndicator();
}

export function handleChatWebSocketMessage(message) {
    switch (message?.type) {
        case 'chat_history':
            renderChatHistory(message.messages);
            break;
        case 'chat_message':
            renderChatMessage(message);
            showChatEdgeBubble(message);
            break;
        case 'chat_log':
            renderChatLog(message);
            break;
        case 'chat_clients':
            renderOnlineClients(message.clients);
            break;
        case 'chat_notice':
            showNotice(message);
            break;
        case 'client_stream_status':
            handleClientStreamStatus(message);
            break;
        case 'chat_error':
            showToast(message.error || 'Chat message failed');
            break;
        case 'chat_disabled':
            showToast('Chat is disabled on this server');
            document.body.classList.remove('chat-open');
            updateChatEdgeTab(false);
            persistChatOpen(false);
            break;
    }
}

export function toggleChatPanel(force) {
    const nextOpen = typeof force === 'boolean' ? force : !isChatOpen();
    document.body.classList.toggle('chat-open', nextOpen);
    updateChatEdgeTab(nextOpen);
    persistChatOpen(nextOpen);
    if (nextOpen) {
        void document.body.offsetWidth;
    }
    window.dispatchEvent(new CustomEvent('yt-share-chat-toggle', {
        detail: { open: nextOpen }
    }));
    if (nextOpen) {
        requestChatHistory();
        requestAnimationFrame(scrollChatToBottom);
        messageInput?.focus?.({ preventScroll: true });
    }
}

export function initChat() {
    if (initialized) return;
    if (window.location.search.includes('popout=1')) return;

    messageList = document.getElementById('chat-messages');
    messageForm = document.getElementById('chat-form');
    messageInput = document.getElementById('chat-input');
    emptyState = document.getElementById('chat-empty');
    noticeModal = document.getElementById('chat-notice-modal');
    noticeMessage = document.getElementById('chat-notice-message');
    noticeClose = document.getElementById('chat-notice-close');
    noticeTicker = document.getElementById('chat-notice-ticker');
    noticeMarquee = document.getElementById('chat-notice-marquee');
    noticeTickerClose = document.getElementById('chat-notice-ticker-close');
    onlineList = document.getElementById('chat-online-list');
    edgeBubble = document.getElementById('chat-edge-bubble');
    edgeBubbleSender = document.getElementById('chat-edge-bubble-sender');
    edgeBubbleText = document.getElementById('chat-edge-bubble-text');

    if (!messageList || !messageForm || !messageInput) return;

    messageForm.addEventListener('submit', (event) => {
        event.preventDefault();
        const value = messageInput.value;
        sendChatMessage(value);
        messageInput.value = '';
        messageInput.focus();
    });

    messageInput.addEventListener('input', () => {
        if (messageInput.value.length > MAX_CHAT_MESSAGE_LENGTH) {
            messageInput.value = messageInput.value.slice(0, MAX_CHAT_MESSAGE_LENGTH);
        }
    });

    noticeClose?.addEventListener('click', closeNotice);
    noticeTickerClose?.addEventListener('click', closeNoticeTicker);
    edgeBubble?.addEventListener('click', () => {
        toggleChatPanel(true);
    });
    window.addEventListener('resize', updateNoticeMarquee);

    window.addEventListener('lyrics-ws-open', requestChatHistory);

    let savedOpen = false;
    try {
        savedOpen = localStorage.getItem(CHAT_PANEL_STORAGE_KEY) === '1';
    } catch (_) {
        savedOpen = false;
    }

    document.body.classList.toggle('chat-open', savedOpen);
    updateChatEdgeTab(savedOpen);
    window.dispatchEvent(new CustomEvent('yt-share-chat-toggle', {
        detail: { open: savedOpen }
    }));
    updateEmptyState();
    initialized = true;
}
