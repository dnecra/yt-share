import { state } from './modules/config.js';
import { API_URL } from './modules/config.js';
import { initWebSocket } from './modules/connection.js';
import { updateNowPlayingFromData } from './modules/now-playing.js';
import { updateVolumeUI, initVolumeControls, previousTrack, nextTrack, togglePlay, toggleMute, updateVolume } from './modules/navigation.js';
import { displayLyricsUI, hideLyricsUI, toggleLyricsCollapse, updateLyricsDisplay, centerActiveLyricLineStrict } from './modules/lyric.js';
import { refreshLyricDynamicTheme, setLyricDynamicThemeEnabled, getLyricDynamicThemeEnabled } from './modules/lyric-dynamic-theme.js';
import { deleteSongFromQueue, moveSongInQueue, moveSongNext, clearQueue, shuffleQueue, addToQueue, updateQueueFromData, updateQueue, scrollToCurrentSong } from './modules/queue.js';
import { 
    showToast, toggleSearchResults, switchTab, initKeyboardShortcuts, 
    initMobileSwipe, initCursorTracking, initResizeHandler, 
    handlePopoutMode, updatePopoutToggleBtn, initMobileHint, toggleMobileSection,
    updateNowPlayingHighlight, handleWebSocketMessage, openPopoutWindow
} from './modules/ui.js';
import { 
    handleUnifiedInput, initUnifiedInputListener, toggleStream, 
    initAudioStreamErrorHandler, initVolumeControl, addCollectionToQueue, loadSearchTab
} from './modules/app.js';
import { initFloatingLyricsToggleButton, initFloatingLyricsDownloadButton } from './modules/floating-lyrics.js';

// Keep "hide lines after active blank-note" disabled on main index page.
window.__lyricsBlankCutoffEnabled = false;
window.__lyricsLeadingGhostLinesCount = 0;
window.__lyricsLeadingSpacingGhostLinesCount = 0;

const MAIN_LYRICS_FONT_SETTINGS_KEY = 'mainLyricsFontSizePx';
const MAIN_LYRICS_FONT_SETTINGS_VERSION_KEY = 'mainLyricsFontSizeVersion';
const MAIN_LYRICS_APPEARANCE_SETTINGS_KEY = 'mainLyricsAppearance';
const MAIN_LYRICS_FONT_SETTINGS_VERSION = 2;
const MAIN_DEFAULT_LYRICS_FONT_SIZE = 48;
const MAIN_MIN_LYRICS_FONT_SIZE = 40;
const MAIN_MAX_LYRICS_FONT_SIZE = 72;
const MAIN_LYRICS_FONT_STEP = 4;
const MAIN_LINE_HEIGHT_RATIO = 0.9;
const MAIN_LYRIC_WEIGHT_ORDER = ['thin', 'regular', 'bold'];
const MAIN_LYRIC_WEIGHT_PRESETS = {
    thin: { label: 'Thin', main: 400, translation: 400 },
    regular: { label: 'Regular', main: 600, translation: 500 },
    bold: { label: 'Bold', main: 800, translation: 600 }
};
const MAIN_LYRIC_BACKGROUND_ORDER = ['none', 'solid', 'dynamic'];
const MAIN_LYRIC_BACKGROUND_PRESETS = {
    none: { label: 'None', value: 'transparent' },
    solid: { label: 'Black', value: 'rgba(18, 18, 18, 1)' },
    dynamic: { label: 'Dynamic', value: 'rgba(18, 18, 18, 0.96)' }
};
const MAIN_LYRIC_COLOR_PRESETS = [
    { name: 'White', hex: '#ccccc1' },
    { name: 'Red', hex: '#ef4144' },
    { name: 'Red V2', hex: '#990f04' },
    { name: 'Light Pink', hex: '#ffbaba' },
    { name: 'Green', hex: '#8fc04f' },
    { name: 'Blue', hex: '#30bdd5' },
    { name: 'Yellow', hex: '#f5f07c' },
    { name: 'Orange', hex: '#fbbf1f' }
];
let mainLyricsFontSizePx = null;
let mainLyricsRecenterRaf = null;
let mainLyricFontWeightPreset = 'bold';
let mainLyricBackgroundPreset = 'dynamic';
let mainLyricColorIndex = 0;
let mainLyricColorMode = 'dynamic';
const mainLyricMiniControlLabelTouched = {
    weight: false,
    background: false,
    color: false
};

function applyMainLyricsFontSize(fontSizePx) {
    const parsed = Number(fontSizePx);
    if (!Number.isFinite(parsed)) return;
    const clamped = Math.max(MAIN_MIN_LYRICS_FONT_SIZE, Math.min(MAIN_MAX_LYRICS_FONT_SIZE, Math.round(parsed)));
    mainLyricsFontSizePx = clamped;

    document.documentElement.style.setProperty('--lyric-font-size', `${clamped}px`);
    document.documentElement.style.setProperty('--lyric-line-height', `${Math.round(clamped * MAIN_LINE_HEIGHT_RATIO)}px`);
}

function clampMainLyricPreset(value, allowed, fallback) {
    return allowed.includes(value) ? value : fallback;
}

function normalizeHexColor(hex) {
    const raw = String(hex || '').trim().replace(/^#/, '');
    if (raw.length === 3) {
        return `#${raw.split('').map((c) => c + c).join('')}`;
    }
    if (raw.length !== 6) return null;
    return `#${raw}`;
}

function parseCssColorToRgbStruct(value) {
    const raw = String(value || '').trim();
    if (!raw) return null;

    const hex = normalizeHexColor(raw);
    if (hex) return hexToRgb(hex);

    const rgbMatch = raw.match(/^rgba?\(\s*([0-9.]+)\s*,\s*([0-9.]+)\s*,\s*([0-9.]+)(?:\s*,\s*[0-9.]+\s*)?\)$/i);
    if (!rgbMatch) return null;

    return {
        r: Number(rgbMatch[1]),
        g: Number(rgbMatch[2]),
        b: Number(rgbMatch[3])
    };
}

function hexToRgb(hex) {
    const normalized = normalizeHexColor(hex);
    if (!normalized) return null;
    const h = normalized.slice(1);
    return {
        r: parseInt(h.slice(0, 2), 16),
        g: parseInt(h.slice(2, 4), 16),
        b: parseInt(h.slice(4, 6), 16)
    };
}

function rgbToHex(r, g, b) {
    const to = (x) => Math.round(Math.min(255, Math.max(0, x))).toString(16).padStart(2, '0');
    return `#${to(r)}${to(g)}${to(b)}`;
}

function rgbToHsl(r, g, b) {
    r /= 255;
    g /= 255;
    b /= 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    let h = 0;
    let s = 0;
    const l = (max + min) / 2;

    if (max !== min) {
        const d = max - min;
        s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
        switch (max) {
            case r: h = ((g - b) / d + (g < b ? 6 : 0)) / 6; break;
            case g: h = ((b - r) / d + 2) / 6; break;
            default: h = ((r - g) / d + 4) / 6; break;
        }
    }

    return [h * 360, s, l];
}

function hslToRgb(h, s, l) {
    h /= 360;
    if (s === 0) {
        const v = Math.round(l * 255);
        return [v, v, v];
    }

    const hue2rgb = (p, q, t) => {
        if (t < 0) t += 1;
        if (t > 1) t -= 1;
        if (t < 1 / 6) return p + (q - p) * 6 * t;
        if (t < 1 / 2) return q;
        if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
        return p;
    };

    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;

    return [
        Math.round(hue2rgb(p, q, h + 1 / 3) * 255),
        Math.round(hue2rgb(p, q, h) * 255),
        Math.round(hue2rgb(p, q, h - 1 / 3) * 255)
    ];
}

function buildMainLyricPaletteFromHex(primaryHex) {
    const primaryRgb = hexToRgb(primaryHex);
    const primary = normalizeHexColor(primaryHex);
    if (!primaryRgb || !primary) return null;

    const [h, s, l] = rgbToHsl(primaryRgb.r, primaryRgb.g, primaryRgb.b);
    const secondary = rgbToHex(...hslToRgb(h, Math.min(1, s * 0.75), l * 0.5));
    const secVar1 = rgbToHex(...hslToRgb(h, Math.min(1, s * 0.25), Math.min(0.93, l * 0.75)));
    const secVar2 = rgbToHex(...hslToRgb(h, Math.min(1, s * 0.125), l * 0.5));
    const bgTint = rgbToHex(...hslToRgb(h, Math.min(1, s * 0.125), Math.max(0.05, l * 0.05)));

    return { primary, secondary, secVar1, secVar2, bgTint };
}

function getMainCurrentAppliedThemePrimaryHex() {
    const rootStyles = getComputedStyle(document.documentElement);
    const fromTextPrimary = parseCssColorToRgbStruct(rootStyles.getPropertyValue('--text-primary'));
    if (fromTextPrimary) return rgbToHex(fromTextPrimary.r, fromTextPrimary.g, fromTextPrimary.b);
    const fromDtPrimary = parseCssColorToRgbStruct(rootStyles.getPropertyValue('--dt-primary'));
    if (fromDtPrimary) return rgbToHex(fromDtPrimary.r, fromDtPrimary.g, fromDtPrimary.b);
    const fallback = MAIN_LYRIC_COLOR_PRESETS[mainLyricColorIndex]?.hex;
    return normalizeHexColor(fallback) || '#2a2a2a';
}

function buildMainDynamicLyricBackgroundFromPrimaryHex(primaryHex) {
    const rgb = hexToRgb(primaryHex);
    if (!rgb) return 'rgba(12, 12, 12, 0.96)';
    const [h, s, l] = rgbToHsl(rgb.r, rgb.g, rgb.b);
    const darkL = Math.max(0.02, Math.min(0.12, l * 0.24));
    const darkS = Math.max(0.06, Math.min(0.62, s * 0.55));
    const [r, g, b] = hslToRgb(h, darkS, darkL);
    return `rgba(${r}, ${g}, ${b}, 0.96)`;
}

function applyMainDynamicLyricBackground() {
    const primaryHex = getMainCurrentAppliedThemePrimaryHex();
    const dynamicBg = buildMainDynamicLyricBackgroundFromPrimaryHex(primaryHex);
    document.documentElement.style.setProperty('--text-bg', dynamicBg, 'important');
}

function refreshMainDynamicLyricBackgroundIfNeeded() {
    if (mainLyricBackgroundPreset !== 'dynamic') return;
    applyMainDynamicLyricBackground();
}

function getMainFontWeightIconSvg(preset) {
    const weight = preset === 'thin' ? 400 : preset === 'bold' ? 800 : 600;
    const minorOpacity = preset === 'thin' ? 0.45 : preset === 'bold' ? 0.7 : 0.55;
    return `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><text x="1" y="17" font-size="13" font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif" font-weight="400" fill="currentColor" opacity="${minorOpacity}">A</text><text x="10" y="18" font-size="16" font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif" font-weight="${weight}" fill="currentColor">A</text></svg>`;
}

function getMainBackgroundIconSvg(preset) {
    if (preset === 'none') {
        return `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><text x="12" y="15.5" text-anchor="middle" font-size="12.5" font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif" font-weight="700" fill="currentColor" stroke="none">A</text></svg>`;
    }
    if (preset === 'dynamic') {
        return `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect x="4.2" y="4.6" width="15.6" height="14.8" rx="3.2" fill="currentColor" opacity="0.3"/><circle cx="16.8" cy="7.2" r="1.25" fill="currentColor" opacity="0.9"/><text x="12" y="15.8" text-anchor="middle" font-size="12" font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif" font-weight="700" fill="currentColor">A</text></svg>`;
    }
    return `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><rect x="4.2" y="4.6" width="15.6" height="14.8" rx="3.2" fill="#101010" opacity="0.92" stroke="none"/><text x="12" y="15.8" text-anchor="middle" font-size="12" font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif" font-weight="700" fill="#ffffff" stroke="none">A</text></svg>`;
}

function getMainThemeColorIconSvg(isDynamic) {
    if (isDynamic) {
        return `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="none" aria-hidden="true"><defs><linearGradient id="lyrics-color-dynamic-grad-main" x1="12" y1="4" x2="12" y2="20" gradientUnits="userSpaceOnUse"><stop offset="0%" stop-color="#ff3b30"/><stop offset="22%" stop-color="#ff9500"/><stop offset="42%" stop-color="#ffd60a"/><stop offset="60%" stop-color="#34c759"/><stop offset="78%" stop-color="#0a84ff"/><stop offset="100%" stop-color="#bf5af2"/></linearGradient></defs><circle cx="12" cy="12" r="6.8" fill="url(#lyrics-color-dynamic-grad-main)"/><circle cx="12" cy="12" r="7.8" fill="none" stroke="rgba(255,255,255,0.72)" stroke-width="1.2"/></svg>`;
    }
    return `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="none" aria-hidden="true"><circle cx="12" cy="12" r="6.8" fill="currentColor"/><circle cx="12" cy="12" r="7.8" fill="none" stroke="rgba(255,255,255,0.72)" stroke-width="1.2"/></svg>`;
}

function applyMainLyricPalette(palette) {
    if (!palette) return;
    const root = document.documentElement;
    const vars = {
        '--text-primary': palette.primary,
        '--text-secondary': palette.secondary,
        '--text-secondary-var1': palette.secVar1,
        '--text-secondary-var2': palette.secVar2,
        '--dt-primary': palette.primary,
        '--dt-secondary': palette.secondary,
        '--dt-secondary-var1': palette.secVar1,
        '--dt-secondary-var2': palette.secVar2,
        '--dt-bg-tint': palette.bgTint
    };

    for (const [key, value] of Object.entries(vars)) {
        root.style.setProperty(key, value);
    }
}

function applyMainLyricFontWeightPreset(preset) {
    const normalized = clampMainLyricPreset(preset, MAIN_LYRIC_WEIGHT_ORDER, 'bold');
    const config = MAIN_LYRIC_WEIGHT_PRESETS[normalized] || MAIN_LYRIC_WEIGHT_PRESETS.bold;
    mainLyricFontWeightPreset = normalized;
    document.documentElement.style.setProperty('--lyrics-inactive-font-weight', String(config.main));
    document.documentElement.style.setProperty('--lyrics-active-font-weight', String(config.main));
    document.documentElement.style.setProperty('--lyrics-translation-font-weight', String(config.translation));
}

function applyMainLyricBackgroundPreset(preset) {
    const normalized = clampMainLyricPreset(preset, MAIN_LYRIC_BACKGROUND_ORDER, 'dynamic');
    const config = MAIN_LYRIC_BACKGROUND_PRESETS[normalized] || MAIN_LYRIC_BACKGROUND_PRESETS.dynamic;
    mainLyricBackgroundPreset = normalized;
    if (normalized === 'dynamic') {
        applyMainDynamicLyricBackground();
        return;
    }
    document.documentElement.style.setProperty('--text-bg', config.value, 'important');
}

function applyMainLyricColorState() {
    if (mainLyricColorMode === 'dynamic') {
        setLyricDynamicThemeEnabled(true, { refresh: true });
        refreshLyricDynamicTheme();
        refreshMainDynamicLyricBackgroundIfNeeded();
        return;
    }

    const paletteConfig = MAIN_LYRIC_COLOR_PRESETS[mainLyricColorIndex] || MAIN_LYRIC_COLOR_PRESETS[0];
    const palette = buildMainLyricPaletteFromHex(paletteConfig.hex);
    setLyricDynamicThemeEnabled(false, { refresh: false });
    applyMainLyricPalette(palette);
    refreshMainDynamicLyricBackgroundIfNeeded();
}

function applyMainLyricAppearance() {
    applyMainLyricFontWeightPreset(mainLyricFontWeightPreset);
    applyMainLyricColorState();
    applyMainLyricBackgroundPreset(mainLyricBackgroundPreset);
    updateMainLyricMiniControls();
}

function saveMainLyricAppearanceSettings() {
    try {
        localStorage.setItem(MAIN_LYRICS_APPEARANCE_SETTINGS_KEY, JSON.stringify({
            fontWeightPreset: mainLyricFontWeightPreset,
            backgroundPreset: mainLyricBackgroundPreset,
            colorIndex: mainLyricColorIndex,
            colorMode: mainLyricColorMode
        }));
    } catch (_) {
        // Ignore localStorage write errors.
    }
}

function loadMainLyricAppearanceSettings() {
    try {
        const raw = localStorage.getItem(MAIN_LYRICS_APPEARANCE_SETTINGS_KEY);
        const parsed = raw ? JSON.parse(raw) : null;
        if (!parsed || typeof parsed !== 'object') return;
        mainLyricFontWeightPreset = clampMainLyricPreset(parsed.fontWeightPreset, MAIN_LYRIC_WEIGHT_ORDER, mainLyricFontWeightPreset);
        mainLyricBackgroundPreset = clampMainLyricPreset(parsed.backgroundPreset, MAIN_LYRIC_BACKGROUND_ORDER, mainLyricBackgroundPreset);
        mainLyricColorMode = parsed.colorMode === 'fixed' ? 'fixed' : 'dynamic';
        const candidateColorIndex = Number(parsed.colorIndex);
        if (Number.isInteger(candidateColorIndex) && candidateColorIndex >= 0 && candidateColorIndex < MAIN_LYRIC_COLOR_PRESETS.length) {
            mainLyricColorIndex = candidateColorIndex;
        }
    } catch (_) {
        // Ignore localStorage parse errors.
    }
}

function updateMainLyricMiniControls() {
    const weightBtn = document.getElementById('main-lyrics-weight-btn');
    const bgBtn = document.getElementById('main-lyrics-bg-btn');
    const colorBtn = document.getElementById('main-lyrics-color-btn');
    const weightIcon = weightBtn?.querySelector('.main-lyrics-mini-icon');
    const bgIcon = bgBtn?.querySelector('.main-lyrics-mini-icon');
    const colorIcon = colorBtn?.querySelector('.main-lyrics-mini-icon');
    const weightLabel = weightBtn?.querySelector('.lyrics-btn-label');
    const bgLabel = bgBtn?.querySelector('.lyrics-btn-label');
    const colorLabel = colorBtn?.querySelector('.lyrics-btn-label');
    const weightPreset = MAIN_LYRIC_WEIGHT_PRESETS[mainLyricFontWeightPreset] || MAIN_LYRIC_WEIGHT_PRESETS.bold;
    const bgPreset = MAIN_LYRIC_BACKGROUND_PRESETS[mainLyricBackgroundPreset] || MAIN_LYRIC_BACKGROUND_PRESETS.dynamic;
    const colorPreset = mainLyricColorMode === 'dynamic'
        ? { name: 'Dynamic' }
        : (MAIN_LYRIC_COLOR_PRESETS[mainLyricColorIndex] || MAIN_LYRIC_COLOR_PRESETS[0]);
    const currentThemeHex = getMainCurrentAppliedThemePrimaryHex();
    const fixedColorHex = normalizeHexColor(colorPreset.hex) || '#e5e5e5';

    if (weightBtn) {
        weightBtn.title = `Font weight: ${weightPreset.label}`;
        weightBtn.setAttribute('aria-label', `Cycle lyric font weight (current: ${weightPreset.label})`);
    }
    if (weightLabel) {
        weightLabel.textContent = mainLyricMiniControlLabelTouched.weight ? weightPreset.label : 'Font Weight';
    }
    if (weightIcon) {
        weightIcon.innerHTML = getMainFontWeightIconSvg(mainLyricFontWeightPreset);
    }
    if (bgBtn) {
        bgBtn.title = `Font background: ${bgPreset.label}`;
        bgBtn.setAttribute('aria-label', `Cycle lyric background (current: ${bgPreset.label})`);
    }
    if (bgLabel) {
        bgLabel.textContent = mainLyricMiniControlLabelTouched.background ? bgPreset.label : 'Font BG';
    }
    if (bgIcon) {
        bgIcon.innerHTML = getMainBackgroundIconSvg(mainLyricBackgroundPreset);
    }
    if (bgBtn) {
        if (mainLyricBackgroundPreset === 'dynamic') {
            bgBtn.style.setProperty('--lyrics-bg-icon-color', currentThemeHex);
        } else {
            bgBtn.style.removeProperty('--lyrics-bg-icon-color');
        }
    }
    if (colorBtn) {
        colorBtn.title = `Font color: ${colorPreset.name}`;
        colorBtn.setAttribute('aria-label', `Cycle lyric color (current: ${colorPreset.name})`);
    }
    if (colorLabel) {
        colorLabel.textContent = mainLyricMiniControlLabelTouched.color ? colorPreset.name : 'Color';
    }
    if (colorIcon) {
        colorIcon.innerHTML = getMainThemeColorIconSvg(mainLyricColorMode === 'dynamic');
    }
    if (colorBtn) {
        colorBtn.style.setProperty('--lyrics-theme-cycle-color', fixedColorHex);
        if (mainLyricColorMode === 'dynamic') {
            colorBtn.style.borderColor = currentThemeHex;
            colorBtn.style.borderWidth = '2.4px';
        } else {
            colorBtn.style.removeProperty('border-color');
            colorBtn.style.removeProperty('border-width');
        }
    }
}

function resetMainLyricMiniControlLabels() {
    mainLyricMiniControlLabelTouched.weight = false;
    mainLyricMiniControlLabelTouched.background = false;
    mainLyricMiniControlLabelTouched.color = false;
    updateMainLyricMiniControls();
}

function syncMainLyricsViewportHeight() {
    const root = document.documentElement;
    if (!root) return;

    const displayMode = document.getElementById('lyrics-container')?.classList.contains('scroll-line-mode')
        ? 'scroll'
        : 'fixed';
    const visibleLines = displayMode === 'scroll' ? 3 : 3;

    const allLines = Array.from(document.querySelectorAll('#synced-lyrics .lyric-line, #plain-lyrics .lyric-line'))
        .filter((line) => !!line?.offsetParent || line?.classList?.contains('current'));

    const rootStyles = getComputedStyle(root);
    const measuredRowHeights = allLines
        .slice(0, 12)
        .map((line) => {
            const styles = getComputedStyle(line);
            const marginTop = parseFloat(styles.marginTop) || 0;
            const marginBottom = parseFloat(styles.marginBottom) || 0;
            const rectHeight = line.getBoundingClientRect().height || 0;
            return rectHeight + Math.max(0, marginTop) + Math.max(0, marginBottom);
        })
        .filter((value) => Number.isFinite(value) && value > 0);

    const fallbackLineHeight = parseFloat(rootStyles.getPropertyValue('--lyric-line-height')) || 40;
    const fallbackGap =
        parseFloat(rootStyles.getPropertyValue('--lyrics-line-gap'))
        || parseFloat(rootStyles.getPropertyValue('--lyrics-line-outer-gap'))
        || 16;
    const singleRowHeight = measuredRowHeights.length > 0
        ? Math.max(...measuredRowHeights)
        : (fallbackLineHeight + fallbackGap);
    const viewportHeight = Math.max(1, Math.round(singleRowHeight * visibleLines));

    root.style.setProperty('--lyrics-viewport-height', `${viewportHeight}px`);

    const edgeFadeSize = Math.max(24, Math.min(128, Math.round(viewportHeight * 0.22)));
    const edgeFadeSizeTop = Math.max(edgeFadeSize, Math.round(edgeFadeSize * 1.5));
    root.style.setProperty('--lyrics-edge-fade-size', `${edgeFadeSize}px`);
    root.style.setProperty('--lyrics-edge-fade-size-top', `${edgeFadeSizeTop}px`);
}

function captureMainActiveLyricIndex() {
    const activeLine = document.querySelector('#synced-lyrics .lyric-line.current, #plain-lyrics .lyric-line.current');
    if (!activeLine) return -1;
    const index = Number.parseInt(activeLine.dataset.index || '-1', 10);
    return Number.isFinite(index) ? index : -1;
}

function getMainLyricsScrollContainer() {
    const lyricsContainer = document.getElementById('lyrics-container');
    if (!lyricsContainer) return null;
    return lyricsContainer.querySelector('#lyrics-content') || lyricsContainer;
}

function captureMainActiveLyricAnchor() {
    const lyricsContainer = document.getElementById('lyrics-container');
    const scrollContainer = getMainLyricsScrollContainer();
    if (!lyricsContainer || !scrollContainer) return null;

    const activeLine = lyricsContainer.querySelector('#synced-lyrics .lyric-line.current, #plain-lyrics .lyric-line.current');
    if (!activeLine) return null;

    const lineRect = activeLine.getBoundingClientRect();
    const scrollRect = scrollContainer.getBoundingClientRect();
    const computedStyle = getComputedStyle(activeLine);
    const singleRowHeight = Math.min(
        parseFloat(computedStyle.lineHeight) || lineRect.height,
        lineRect.height
    );
    const centerOffset = (lineRect.top - scrollRect.top) + (singleRowHeight / 2);
    const index = Number.parseInt(activeLine.dataset.index || '-1', 10);
    if (!Number.isFinite(index) || index < 0) return null;

    return { index, centerOffset };
}

function restoreMainActiveLyricAnchor(anchor) {
    if (!anchor) return;

    const lyricsContainer = document.getElementById('lyrics-container');
    const scrollContainer = getMainLyricsScrollContainer();
    if (!lyricsContainer || !scrollContainer) return;

    const lineElement = lyricsContainer.querySelector(`.lyric-line[data-index="${anchor.index}"]`);
    if (!lineElement) return;

    const lineRect = lineElement.getBoundingClientRect();
    const scrollRect = scrollContainer.getBoundingClientRect();
    const computedStyle = getComputedStyle(lineElement);
    const singleRowHeight = Math.min(
        parseFloat(computedStyle.lineHeight) || lineRect.height,
        lineRect.height
    );
    const currentCenterOffset = (lineRect.top - scrollRect.top) + (singleRowHeight / 2);
    const delta = currentCenterOffset - anchor.centerOffset;
    if (Math.abs(delta) <= 0.5) return;

    scrollContainer.scrollTop += delta;
}

function scheduleMainViewportSyncAndRecenter() {
    const activeAnchor = captureMainActiveLyricAnchor();
    const activeIndex = captureMainActiveLyricIndex();
    syncMainLyricsViewportHeight();

    if (mainLyricsRecenterRaf) cancelAnimationFrame(mainLyricsRecenterRaf);
    mainLyricsRecenterRaf = requestAnimationFrame(() => {
        syncMainLyricsViewportHeight();
        mainLyricsRecenterRaf = requestAnimationFrame(() => {
            mainLyricsRecenterRaf = null;
            if (activeIndex < 0) return;
            const lyricsContainer = document.getElementById('lyrics-container');
            if (!lyricsContainer) return;
            if (activeAnchor) {
                restoreMainActiveLyricAnchor(activeAnchor);
                return;
            }
            centerActiveLyricLineStrict(activeIndex, lyricsContainer, { behavior: 'instant' });
        });
    });
}

function loadMainLyricsFontSize() {
    try {
        const savedVersion = Number(localStorage.getItem(MAIN_LYRICS_FONT_SETTINGS_VERSION_KEY));
        if (!Number.isFinite(savedVersion) || savedVersion < MAIN_LYRICS_FONT_SETTINGS_VERSION) {
            applyMainLyricsFontSize(MAIN_DEFAULT_LYRICS_FONT_SIZE);
            localStorage.setItem(MAIN_LYRICS_FONT_SETTINGS_KEY, String(mainLyricsFontSizePx));
            localStorage.setItem(MAIN_LYRICS_FONT_SETTINGS_VERSION_KEY, String(MAIN_LYRICS_FONT_SETTINGS_VERSION));
            return;
        }

        const raw = localStorage.getItem(MAIN_LYRICS_FONT_SETTINGS_KEY);
        const parsed = Number(raw);
        if (Number.isFinite(parsed)) {
            applyMainLyricsFontSize(parsed);
            return;
        }
    } catch (_) {
        // Ignore localStorage read errors.
    }
    applyMainLyricsFontSize(MAIN_DEFAULT_LYRICS_FONT_SIZE);
}

function saveMainLyricsFontSize() {
    try {
        if (Number.isFinite(mainLyricsFontSizePx)) {
            localStorage.setItem(MAIN_LYRICS_FONT_SETTINGS_KEY, String(mainLyricsFontSizePx));
            localStorage.setItem(MAIN_LYRICS_FONT_SETTINGS_VERSION_KEY, String(MAIN_LYRICS_FONT_SETTINGS_VERSION));
        }
    } catch (_) {
        // Ignore localStorage write errors.
    }
}

function adjustMainLyricsFontSize(delta) {
    const current = Number.isFinite(mainLyricsFontSizePx)
        ? mainLyricsFontSizePx
        : (parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--lyric-font-size')) || MAIN_DEFAULT_LYRICS_FONT_SIZE);
    applyMainLyricsFontSize(current + delta);
    saveMainLyricsFontSize();
    scheduleMainViewportSyncAndRecenter();
}

function initMainLyricsFontControls() {
    loadMainLyricsFontSize();
    loadMainLyricAppearanceSettings();

    const downBtn = document.getElementById('lyrics-font-down-btn');
    const upBtn = document.getElementById('lyrics-font-up-btn');
    const weightBtn = document.getElementById('main-lyrics-weight-btn');
    const bgBtn = document.getElementById('main-lyrics-bg-btn');
    const colorBtn = document.getElementById('main-lyrics-color-btn');
    const controls = document.getElementById('lyrics-font-controls');

    if (downBtn) {
        downBtn.title = 'Decrease lyrics font size';
        downBtn.addEventListener('click', () => adjustMainLyricsFontSize(-MAIN_LYRICS_FONT_STEP));
    }
    if (upBtn) {
        upBtn.title = 'Increase lyrics font size';
        upBtn.addEventListener('click', () => adjustMainLyricsFontSize(MAIN_LYRICS_FONT_STEP));
    }
    if (weightBtn) {
        weightBtn.addEventListener('click', (event) => {
            mainLyricMiniControlLabelTouched.weight = true;
            const currentIndex = MAIN_LYRIC_WEIGHT_ORDER.indexOf(mainLyricFontWeightPreset);
            mainLyricFontWeightPreset = MAIN_LYRIC_WEIGHT_ORDER[(currentIndex + 1) % MAIN_LYRIC_WEIGHT_ORDER.length];
            applyMainLyricAppearance();
            saveMainLyricAppearanceSettings();
            event.currentTarget?.blur?.();
        });
    }
    if (bgBtn) {
        bgBtn.addEventListener('click', (event) => {
            mainLyricMiniControlLabelTouched.background = true;
            const currentIndex = MAIN_LYRIC_BACKGROUND_ORDER.indexOf(mainLyricBackgroundPreset);
            mainLyricBackgroundPreset = MAIN_LYRIC_BACKGROUND_ORDER[(currentIndex + 1) % MAIN_LYRIC_BACKGROUND_ORDER.length];
            applyMainLyricAppearance();
            saveMainLyricAppearanceSettings();
            event.currentTarget?.blur?.();
        });
    }
    if (colorBtn) {
        colorBtn.addEventListener('click', (event) => {
            mainLyricMiniControlLabelTouched.color = true;
            if (mainLyricColorMode === 'dynamic') {
                mainLyricColorMode = 'fixed';
                mainLyricColorIndex = 0;
            } else if (mainLyricColorIndex >= MAIN_LYRIC_COLOR_PRESETS.length - 1) {
                mainLyricColorMode = 'dynamic';
            } else {
                mainLyricColorIndex += 1;
            }
            applyMainLyricAppearance();
            saveMainLyricAppearanceSettings();
            event.currentTarget?.blur?.();
        });
    }
    if (controls) {
        const reset = () => resetMainLyricMiniControlLabels();
        controls.addEventListener('pointerenter', reset);
        controls.addEventListener('pointerleave', reset);
    }

    applyMainLyricAppearance();
}

if (typeof document !== 'undefined') {
    loadMainLyricsFontSize();
    loadMainLyricAppearanceSettings();
}





// Make functions global for onclick handlers
window.deleteSongFromQueue = deleteSongFromQueue;
window.moveSongInQueue = moveSongInQueue;
window.moveSongNext = moveSongNext;
window.clearQueue = clearQueue;
window.shuffleQueue = shuffleQueue;
window.addToQueueById = (videoId) => {
    addToQueue(videoId).then(success => {
        if (success) showToast('Song added to queue');
    });
};
window.addCollectionToQueue = addCollectionToQueue;
window.loadSearchTab = loadSearchTab;
window.toggleSearchResults = toggleSearchResults;
window.switchTab = switchTab;
window.handleUnifiedInput = handleUnifiedInput;
window.toggleStream = toggleStream;
window.toggleLyricsCollapse = toggleLyricsCollapse;
window.toggleMobileSection = toggleMobileSection;
window.openPopoutWindow = openPopoutWindow;
window.scrollToCurrentSong = scrollToCurrentSong;
window.updateQueue = updateQueue;
window.updateQueueFromData = updateQueueFromData;
window.updateNowPlayingFromData = updateNowPlayingFromData;
window.updateLyricsDisplay = updateLyricsDisplay;
window.replayCurrentLyricStagger = replayCurrentLyricStagger;
// Navigation controls
window.previousTrack = previousTrack;
window.nextTrack = nextTrack;
window.togglePlay = togglePlay;
window.toggleMute = toggleMute;
window.updateVolume = updateVolume;
// Lyrics display wrappers (kept here to preserve callback signatures)
function displayLyricsOnMainPage(data, videoId) {
    const result = displayLyricsUI(data, {
        fetchVideoId: videoId || null,
        validateFetch: () => true,
        logTag: 'MAIN'
    });
    if (Number.isFinite(mainLyricsFontSizePx)) {
        requestAnimationFrame(() => {
            applyMainLyricsFontSize(mainLyricsFontSizePx);
            applyMainLyricAppearance();
            scheduleMainViewportSyncAndRecenter();
        });
    }
    return result;
}

function hideLyricsOnMainPage() {
    const result = hideLyricsUI({
        clearVideoId: false,
        logTag: 'MAIN'
    });
    if (Number.isFinite(mainLyricsFontSizePx)) {
        requestAnimationFrame(() => {
            applyMainLyricsFontSize(mainLyricsFontSizePx);
            applyMainLyricAppearance();
            syncMainLyricsViewportHeight();
        });
    }
    return result;
}

window.displayLyricsOnMainPage = displayLyricsOnMainPage;
window.hideLyricsOnMainPage = hideLyricsOnMainPage;

let initPromise = null;
let isInitialized = false;

function markPageReady() {
    document.body.classList.add('page-ready');
    document.body.classList.remove('page-enter');
}

function initPageLoadAnimation() {
    requestAnimationFrame(markPageReady);
}

function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('/sw.js').catch((error) => {
            console.warn('[PWA] Service worker registration failed:', error);
        });
    }, { once: true });
}

async function fetchInitialState({ onSongUpdate, onVolumeUpdate } = {}) {
    const tasks = [];

    tasks.push((async () => {
        try {
            const response = await fetch(`${API_URL}/song`);
            if (!response.ok) return;

            const data = await response.json();
            if (data && typeof onSongUpdate === 'function') {
                onSongUpdate(data);
            }
        } catch (error) {
            console.error('Failed to fetch initial song state:', error);
        }
    })());

    tasks.push((async () => {
        try {
            const response = await fetch(`${API_URL}/volume`);
            if (!response.ok) return;

            const data = await response.json();
            const volume = data?.volume ?? data?.state ?? data?.value;
            if (typeof volume === 'number' && typeof onVolumeUpdate === 'function') {
                onVolumeUpdate(volume);
            }
        } catch (error) {
            console.error('Failed to fetch initial volume state:', error);
        }
    })());

    await Promise.all(tasks);
}

function replayCurrentLyricStagger() {
    const currentLine = document.querySelector('#synced-lyrics .lyric-line.current, #plain-lyrics .lyric-line.current');
    if (!currentLine) return;

    const words = currentLine.querySelectorAll('.lyric-word');
    if (!words.length) return;

    const safeWordCount = Math.max(1, words.length);
    const staggerMs = Math.max(70, Math.min(180, 520 / safeWordCount));

    words.forEach((word, index) => {
        const delay = `${((index * staggerMs) / 1000).toFixed(3)}s`;
        word.style.willChange = 'opacity, transform';
        word.style.transitionDelay = delay;
        word.style.animationDelay = delay;
    });

    currentLine.classList.remove('activating-current');
    void currentLine.offsetWidth;
    currentLine.classList.add('activating-current');

    requestAnimationFrame(() => {
        requestAnimationFrame(() => {
            setTimeout(() => {
                currentLine.classList.remove('activating-current');
            }, 50);
        });
    });
}

// Initialize app
async function init() {
    if (isInitialized) return initPromise;
    if (initPromise) return initPromise;

    initPromise = (async () => {
    console.log('[MAIN] Initializing...');
    initPageLoadAnimation();
    
    // Initialize UI handlers
    handlePopoutMode();
    initCursorTracking();
    initKeyboardShortcuts();
    initMobileSwipe();
    initResizeHandler();
    updatePopoutToggleBtn();
    initMobileHint();
    
    // Initialize app features
    initUnifiedInputListener();
    initVolumeControl();
    initAudioStreamErrorHandler();
    console.log('[INIT] Audio system initialized');
    initFloatingLyricsToggleButton();
    initFloatingLyricsDownloadButton();
    initMainLyricsFontControls();
    registerServiceWorker();
    
    // Initialize volume controls
    initVolumeControls();
    
    // Fetch initial data
    await updateQueue();
    
    // Initialize WebSocket
    if (typeof WebSocket !== 'undefined' && !state.ws) {
        initWebSocket(handleWebSocketMessage);
    }
    
    // Fetch initial state
    await fetchInitialState({
        onSongUpdate: (data) => {
            updateNowPlayingFromData(data, {
                isMainApp: true,
                onSongChange: (data) => {
                    if (state.processedQueueData && Array.isArray(state.processedQueueData)) {
                        updateNowPlayingHighlight();
                        scrollToCurrentSong(true);
                    }
                },
                onLyricsDisplay: displayLyricsOnMainPage,
                onLyricsHide: hideLyricsOnMainPage
            });
        },
        onVolumeUpdate: updateVolumeUI
    });
    
    console.log('[MAIN] Initialization complete');
    isInitialized = true;
    })();

    try {
        await initPromise;
    } catch (error) {
        markPageReady();
        initPromise = null;
        throw error;
    }
}

// Start app on load
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
} else {
    init();
}
