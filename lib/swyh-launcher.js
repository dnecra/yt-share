const { exec, spawn } = require('child_process');

function isRunning() {
    return new Promise((resolve) => {
        exec('tasklist /FI "IMAGENAME eq swyh-rs.exe"', (error, stdout) => {
            if (error) {
                return resolve(false);
            }
            resolve(stdout.toLowerCase().includes('swyh-rs.exe'));
        });
    });
}

function launchWithExec(executablePath) {
    return new Promise((resolve) => {
        const command = `"${executablePath}"`;
        const child = exec(command, {
            detached: true,
            windowsHide: false
        }, (launchError) => {
            if (launchError) {
                return resolve({ success: false, error: launchError.message });
            }
            return resolve({ success: true });
        });

        try {
            if (child && typeof child.unref === 'function') child.unref();
        } catch (e) {}
    });
}

function launchWithSpawn(executablePath) {
    return new Promise((resolve) => {
        try {
            const child = spawn(executablePath, [], {
                detached: true,
                stdio: 'ignore'
            });
            child.unref();
            resolve({ success: true, pid: child.pid });
        } catch (error) {
            resolve({ success: false, error: error.message });
        }
    });
}

module.exports = {
    isRunning,
    launchWithExec,
    launchWithSpawn
};
