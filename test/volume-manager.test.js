const test = require('node:test');
const assert = require('node:assert/strict');

function freshManager() {
    const path = require.resolve('../lib/volume-manager');
    delete require.cache[path];
    return require(path);
}

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

test('normalizes the public volume contract to integer 0-100', () => {
    const { normalizeVolume, extractVolume } = freshManager();

    assert.equal(normalizeVolume(0), 0);
    assert.equal(normalizeVolume('49.6'), 50);
    assert.equal(normalizeVolume(100), 100);
    assert.equal(normalizeVolume('50nope'), null);
    assert.equal(normalizeVolume(-1), null);
    assert.equal(normalizeVolume(101), null);
    assert.equal(extractVolume({ state: 35 }), 35);
    assert.equal(extractVolume(35), 35);
    assert.equal(extractVolume({}, 42), 42);
});

test('coalesces rapid writes without hanging callers or publishing stale confirmations', async () => {
    const manager = freshManager();
    const firstRequest = deferred();
    const calls = [];
    const messages = [];
    let lastVolume = null;

    const proxyRequest = async (method, endpoint, body) => {
        calls.push({ method, endpoint, body });
        if (calls.length === 1) return firstRequest.promise;
        return { success: true, status: 200, data: { volume: body.volume } };
    };
    const broadcast = (message) => messages.push(message);
    const setLastVolume = (volume) => { lastVolume = volume; };

    const first = manager.setVolume(10, proxyRequest, broadcast, setLastVolume);
    const second = manager.setVolume(20, proxyRequest, broadcast, setLastVolume);
    const third = manager.setVolume(30, proxyRequest, broadcast, setLastVolume);

    assert.equal(manager.handleExternalVolumeUpdate(5, setLastVolume, broadcast), false);
    firstRequest.resolve({ success: true, status: 200, data: { volume: 10 } });

    const results = await Promise.all([first, second, third]);
    assert.deepEqual(calls.map((call) => call.body.volume), [10, 30]);
    assert.deepEqual(results.map((result) => result.data.volume), [10, 30, 30]);
    assert.equal(lastVolume, 30);

    const confirmed = messages
        .filter((message) => !message.optimistic)
        .map((message) => message.data.volume);
    assert.deepEqual(confirmed, [30]);
});

test('reconciles the authoritative value after a failed write', async () => {
    const manager = freshManager();
    const messages = [];
    let lastVolume = null;

    const proxyRequest = async (method) => method === 'POST'
        ? { success: false, status: 503, error: 'offline' }
        : { success: true, status: 200, data: { volume: 64 } };

    const result = await manager.setVolume(
        25,
        proxyRequest,
        (message) => messages.push(message),
        (volume) => { lastVolume = volume; }
    );

    assert.equal(result.success, false);
    assert.equal(lastVolume, 64);
    assert.deepEqual(messages.map((message) => message.data.volume), [25, 64]);
});

test('does not publish failure reconciliation over a newer target', async () => {
    const manager = freshManager();
    const reconciliation = deferred();
    const messages = [];
    let postCount = 0;

    const proxyRequest = async (method, endpoint, body) => {
        if (method === 'GET') return reconciliation.promise;
        postCount += 1;
        if (postCount === 1) return { success: false, status: 503, error: 'offline' };
        return { success: true, status: 200, data: { volume: body.volume } };
    };

    const first = manager.setVolume(15, proxyRequest, (message) => messages.push(message), () => {});
    await new Promise((resolve) => setImmediate(resolve));
    const second = manager.setVolume(75, proxyRequest, (message) => messages.push(message), () => {});
    reconciliation.resolve({ success: true, status: 200, data: { volume: 64 } });

    await Promise.all([first, second]);
    assert.equal(messages.some((message) => message.data.volume === 64), false);
    assert.equal(messages.at(-1).data.volume, 75);
    assert.equal(messages.at(-1).optimistic, undefined);
});
