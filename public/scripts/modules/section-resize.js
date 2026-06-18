const SECTION_SIZE_STORAGE_KEY = 'yt-share-section-widths-v3';

const LIMITS = {
    left: { min: 768, max: 1600 },
    right: { min: 360, max: 1100 },
    chat: { min: 240, max: 360 }
};

let initialized = false;
let activeResize = null;

function getLayout() {
    return document.getElementById('layout-container');
}

function getLayoutWidth() {
    return getLayout()?.getBoundingClientRect().width || window.innerWidth;
}

function isChatOpen() {
    return document.body.classList.contains('chat-open');
}

function getChatTabWidth() {
    const raw = getComputedStyle(getLayout() || document.documentElement).getPropertyValue('--chat-tab-width');
    const parsed = parseFloat(raw);
    return Number.isFinite(parsed) ? parsed : 38;
}

function readSaved() {
    try {
        const parsed = JSON.parse(localStorage.getItem(SECTION_SIZE_STORAGE_KEY) || '{}');
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (_) {
        return {};
    }
}

function writeSaved(next) {
    try {
        localStorage.setItem(SECTION_SIZE_STORAGE_KEY, JSON.stringify({
            ...readSaved(),
            ...next
        }));
    } catch (_) {
        // Ignore storage failures.
    }
}

function clamp(section, value) {
    const limits = LIMITS[section];
    return Math.max(limits.min, Math.min(limits.max, Math.round(value)));
}

function getSectionWidth(id) {
    return document.getElementById(id)?.getBoundingClientRect().width || 0;
}

function getLayoutCssPx(name, fallback = 0) {
    const layout = getLayout();
    if (!layout) return fallback;
    const parsed = parseFloat(getComputedStyle(layout).getPropertyValue(name));
    return Number.isFinite(parsed) ? parsed : fallback;
}

function setMainWidths(leftWidth, { persist = false, chatWidth = null } = {}) {
    const layout = getLayout();
    if (!layout) return;

    const reservedChatWidth = isChatOpen()
        ? (Number.isFinite(chatWidth) ? chatWidth : getLayoutCssPx('--chat-section-width', getSectionWidth('chat-section')))
        : 0;
    const total = getLayoutWidth() - reservedChatWidth;
    const minLeft = LIMITS.left.min;
    const minRight = LIMITS.right.min;
    const maxLeft = Math.min(LIMITS.left.max, total - minRight);
    const nextLeft = Math.max(minLeft, Math.min(maxLeft, Math.round(leftWidth)));
    const nextRight = Math.max(minRight, Math.round(total - nextLeft));

    layout.style.setProperty('--left-section-width', `${nextLeft}px`);
    layout.style.setProperty('--right-section-width', `${nextRight}px`);

    if (persist) {
        writeSaved({ left: nextLeft, right: nextRight });
    }
}

function setMainWidthsFromRight(rightWidth, { persist = false, chatWidth = null } = {}) {
    const layout = getLayout();
    if (!layout) return;

    const reservedChatWidth = isChatOpen()
        ? (Number.isFinite(chatWidth) ? chatWidth : getLayoutCssPx('--chat-section-width', getSectionWidth('chat-section')))
        : 0;
    const total = getLayoutWidth() - reservedChatWidth;
    const maxRight = Math.min(LIMITS.right.max, total - LIMITS.left.min);
    const nextRight = Math.max(LIMITS.right.min, Math.min(maxRight, Math.round(rightWidth)));
    const nextLeft = Math.max(LIMITS.left.min, Math.round(total - nextRight));

    layout.style.setProperty('--left-section-width', `${nextLeft}px`);
    layout.style.setProperty('--right-section-width', `${nextRight}px`);

    if (persist) {
        writeSaved({ left: nextLeft, right: nextRight });
    }
}

function setChatWidth(chatWidth, { persist = false } = {}) {
    const layout = getLayout();
    if (!layout) return 0;

    const maxByLayout = Math.max(LIMITS.chat.min, getLayoutWidth() - LIMITS.left.min - LIMITS.right.min);
    const nextChat = Math.max(LIMITS.chat.min, Math.min(Math.min(LIMITS.chat.max, maxByLayout), Math.round(chatWidth)));
    layout.style.setProperty('--chat-section-width', `${nextChat}px`);

    if (persist && isChatOpen()) {
        writeSaved({ chat: nextChat });
    }

    return nextChat;
}

function applyInitialWidths() {
    const total = getLayoutWidth();
    const saved = readSaved();
    const savedRight = Number(saved.right);
    const savedChat = Number(saved.chat);
    const chatWidth = Number.isFinite(savedChat) ? savedChat : Math.max(LIMITS.chat.min, total * 0.15);

    const nextChat = setChatWidth(chatWidth);
    const currentRight = getLayoutCssPx('--right-section-width', LIMITS.right.min);
    setMainWidthsFromRight(Number.isFinite(savedRight) ? savedRight : currentRight, { chatWidth: nextChat });
}

function startResize(event, sectionKey) {
    if (window.innerWidth <= 1366) return;
    if (sectionKey === 'chat' && !isChatOpen()) return;
    event.preventDefault();

    activeResize = {
        sectionKey,
        startX: event.clientX,
        leftWidth: getSectionWidth('left-section'),
        rightWidth: getSectionWidth('right-section'),
        chatWidth: getSectionWidth('chat-section')
    };
    document.body.classList.add('section-resizing');
    document.body.classList.add(`section-resizing-${sectionKey}`);
    event.currentTarget.setPointerCapture?.(event.pointerId);
}

function updateResize(event) {
    if (!activeResize) return;

    const delta = event.clientX - activeResize.startX;
    if (activeResize.sectionKey === 'chat') {
        const nextChat = setChatWidth(activeResize.chatWidth - delta, { persist: true });
        setMainWidthsFromRight(activeResize.rightWidth, { chatWidth: nextChat });
        return;
    }

    setMainWidths(activeResize.leftWidth + delta, { persist: true });
}

function endResize() {
    if (!activeResize) return;
    const sectionKey = activeResize.sectionKey;
    activeResize = null;
    document.body.classList.remove('section-resizing');
    document.body.classList.remove(`section-resizing-${sectionKey}`);
}

export function syncSectionWidths() {
    if (window.innerWidth <= 1366) return;
    applyInitialWidths();
}

export function initSectionResize() {
    if (initialized || window.location.search.includes('popout=1')) return;
    syncSectionWidths();

    document.querySelectorAll('[data-resize-section]').forEach((handle) => {
        const sectionKey = handle.getAttribute('data-resize-section');
        handle.addEventListener('pointerdown', (event) => startResize(event, sectionKey));
    });

    window.addEventListener('yt-share-chat-toggle', syncSectionWidths);
    window.addEventListener('resize', syncSectionWidths);
    window.addEventListener('pointermove', updateResize);
    window.addEventListener('pointerup', endResize);
    window.addEventListener('pointercancel', endResize);
    initialized = true;
}
