const fs = require('fs');
const path = require('path');

const IP_NAMES_FILE = path.join(__dirname, '..', 'ip-names.json');
const ipNamesMap = new Map();
const ipAssignedName = new Map();
const IP_NAME_ROTATE_MS = parseInt(process.env.IP_NAME_ROTATE_MS || '60000', 10);
const IP_ASSIGNED_NAME_TTL_MS = parseInt(process.env.IP_ASSIGNED_NAME_TTL_MS || String(24 * 60 * 60 * 1000), 10);
const IP_ASSIGNED_NAME_MAX_SIZE = parseInt(process.env.IP_ASSIGNED_NAME_MAX_SIZE || '2048', 10);

/**
 * Load IP-to-display-name mappings from disk into memory.
 */
function loadIpNames() {
    try {
        if (!fs.existsSync(IP_NAMES_FILE)) return;
        const raw = fs.readFileSync(IP_NAMES_FILE, 'utf8');
        const obj = JSON.parse(raw);
        for (const [key, names] of Object.entries(obj)) {
            if (!names) continue;
            ipNamesMap.set(key, names);
            if (typeof key === 'string' && key.startsWith('::ffff:')) {
                ipNamesMap.set(key.substring(7), names);
            }
            if (key === '::1') ipNamesMap.set('127.0.0.1', names);
            if (key === '127.0.0.1') ipNamesMap.set('::1', names);
        }
    } catch (err) {
        console.warn('Could not load ip-names.json:', err?.message || err);
    }
}

/**
 * Choose and assign a display name for a normalized IP from configured lists.
 */
function assignNameForIp(normalizedIp) {
    if (!normalizedIp) return null;
    const existing = ipAssignedName.get(normalizedIp);
    if (existing && existing.name) return existing.name;
    const candidates = [];
    const keysToCheck = [normalizedIp, `::ffff:${normalizedIp}`, `::ffff:${normalizedIp}`.replace('::ffff::', '::ffff:')];
    if (normalizedIp === '127.0.0.1') keysToCheck.push('::1');
    for (const k of keysToCheck) {
        const list = ipNamesMap.get(k);
        if (Array.isArray(list) && list.length > 0) {
            candidates.push(...list);
        }
    }
    if (candidates.length === 0) return null;
    const used = new Set(Array.from(ipAssignedName.values()).map(v => v.name));
    const available = candidates.filter(n => !used.has(n));
    const pickList = available.length > 0 ? available : candidates;
    const chosen = pickList[Math.floor(Math.random() * pickList.length)];
    ipAssignedName.set(normalizedIp, { name: chosen, timestamp: Date.now() });
    return chosen;
}

/**
 * Return an already assigned name or assign a new random name for an IP.
 */
function getRandomNameForIp(normalizedIp) {
    if (!normalizedIp) return null;
    const assigned = ipAssignedName.get(normalizedIp);
    if (assigned && assigned.name) return assigned.name;
    return assignNameForIp(normalizedIp);
}

/**
 * Force-assign a (possibly different) name for a normalized IP address.
 */
function forceAssignNameForIp(normalizedIp) {
    if (!normalizedIp) return null;
    const candidates = [];
    const keysToCheck = [normalizedIp, `::ffff:${normalizedIp}`];
    if (normalizedIp === '127.0.0.1') keysToCheck.push('::1');
    for (const k of keysToCheck) {
        const list = ipNamesMap.get(k);
        if (Array.isArray(list) && list.length > 0) candidates.push(...list);
    }
    if (candidates.length === 0) return null;
    const current = ipAssignedName.get(normalizedIp)?.name;
    const used = new Set(Array.from(ipAssignedName.entries()).map(([k, v]) => v?.name).filter(Boolean));
    if (current) used.delete(current);
    const available = candidates.filter(n => n !== current && !used.has(n));
    const pickList = available.length > 0 ? available : candidates.filter(n => n !== current);
    const chosen = (pickList.length > 0 ? pickList : candidates)[Math.floor(Math.random() * (pickList.length > 0 ? pickList.length : candidates.length))];
    ipAssignedName.set(normalizedIp, { name: chosen, timestamp: Date.now() });
    return chosen;
}

/**
 * Rotate the assigned names across known IPs to avoid name stagnation.
 */
function rotateAssignedNames() {
    if (ipNamesMap.size === 0) return;
    const used = new Set(Array.from(ipAssignedName.values()).map(v => v.name));
    for (const key of ipNamesMap.keys()) {
        let normalized = key;
        if (typeof key === 'string' && key.startsWith('::ffff:')) normalized = key.substring(7);
        if (normalized === '::1') normalized = '127.0.0.1';
        const list = ipNamesMap.get(key);
        if (!Array.isArray(list) || list.length === 0) continue;
        const current = ipAssignedName.get(normalized)?.name;
        const candidates = list.filter(n => n !== current && !used.has(n));
        let chosen = null;
        if (candidates.length > 0) {
            chosen = candidates[Math.floor(Math.random() * candidates.length)];
        } else {
            const fallback = list.filter(n => n !== current);
            chosen = fallback.length > 0 ? fallback[Math.floor(Math.random() * fallback.length)] : list[Math.floor(Math.random() * list.length)];
        }
        if (chosen) {
            ipAssignedName.set(normalized, { name: chosen, timestamp: Date.now() });
            used.add(chosen);
        }
    }
}

function pruneAssignedNames() {
    const now = Date.now();

    for (const [ip, entry] of ipAssignedName.entries()) {
        if (!entry || typeof entry.timestamp !== 'number') {
            ipAssignedName.delete(ip);
            continue;
        }
        if (now - entry.timestamp > IP_ASSIGNED_NAME_TTL_MS) {
            ipAssignedName.delete(ip);
        }
    }

    if (ipAssignedName.size <= IP_ASSIGNED_NAME_MAX_SIZE) {
        return;
    }

    const entries = Array.from(ipAssignedName.entries());
    entries.sort((a, b) => (a[1]?.timestamp || 0) - (b[1]?.timestamp || 0));
    const overflow = ipAssignedName.size - IP_ASSIGNED_NAME_MAX_SIZE;
    for (let i = 0; i < overflow; i++) {
        ipAssignedName.delete(entries[i][0]);
    }
}

function normalizeIpAddress(ip) {
    if (!ip || ip === 'unknown') {
        return null;
    }
    if (ip.startsWith('::ffff:')) {
        return ip.substring(7);
    }
    if (ip === '::1' || ip === '::') {
        return '127.0.0.1';
    }
    return ip;
}

/**
 * Extract client IP from the Hono request context (x-forwarded-for/x-real-ip).
 */
function getClientIpFromContext(c) {
    const forwardedFor = c.req.header('x-forwarded-for');
    if (forwardedFor) {
        const ips = forwardedFor.split(',').map(ip => ip.trim());
        const normalized = normalizeIpAddress(ips[0]);
        if (normalized) {
            return normalized;
        }
    }
    const realIp = c.req.header('x-real-ip');
    if (realIp) {
        const normalized = normalizeIpAddress(realIp);
        if (normalized) {
            return normalized;
        }
    }
    return null;
}

function startRotation() {
    loadIpNames();
    setInterval(() => {
        try {
            pruneAssignedNames();
            rotateAssignedNames();
        } catch (e) { /* ignore */ }
    }, IP_NAME_ROTATE_MS);
}

module.exports = {
    loadIpNames,
    assignNameForIp,
    getRandomNameForIp,
    forceAssignNameForIp,
    rotateAssignedNames,
    normalizeIpAddress,
    getClientIpFromContext,
    startRotation
};
