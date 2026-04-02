const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

/**
 * Resolve a downloadable file from the local ./download directory.
 *
 * Rules:
 * - If only one file exists, serve it.
 * - If multiple files exist, serve the most recently modified.
 */
async function resolveDownloadFilePath(downloadDirAbsolute) {
    const dir = downloadDirAbsolute;
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    const files = entries.filter(e => e.isFile()).map(e => e.name);
    if (files.length === 0) return null;
    if (files.length === 1) return path.join(dir, files[0]);

    let best = null;
    let bestMtime = 0;
    for (const name of files) {
        const full = path.join(dir, name);
        try {
            const st = await fsp.stat(full);
            const m = st.mtimeMs || 0;
            if (m > bestMtime) {
                bestMtime = m;
                best = full;
            }
        } catch (e) {}
    }
    return best || path.join(dir, files[0]);
}

module.exports = { resolveDownloadFilePath };
