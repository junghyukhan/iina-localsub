const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { createHash } = require("node:crypto");
const { promisify } = require("node:util");
const exec = promisify(require("node:child_process").execFile);
const { CachePolicy, createCacheMaintenance, cacheLimitMB } = require("../cache-policy.js");

async function fixture(run) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "localsub-budget '100%-"));
    const directory = path.join(root, "subtitles");
    const prefs = new Map([["cacheSizeMB", 1], ["cacheRevision", "0"]]);
    const api = {
        preferences: { get: key => prefs.get(key), set: (key, value) => prefs.set(key, value) },
        file: { exists: file => fs.existsSync(file) },
        console: { error() {} },
        utils: { resolvePath: () => directory, exec: async (file, args) => {
            try { return { status: 0, ...await exec(file, args) }; }
            catch (e) { return { status: e.code, stdout: e.stdout || "", stderr: e.stderr || String(e) }; }
        } },
    };
    const put = (name, size, time, epoch = "0") => {
        const parent = path.join(directory, epoch);
        fs.mkdirSync(parent, { recursive: true });
        const file = path.join(parent, createHash("sha256").update(name).digest("hex") + ".srt");
        fs.writeFileSync(file, Buffer.alloc(size));
        fs.utimesSync(file, time, time);
        return file;
    };
    try { await run({ api, prefs, put, directory, root, policy: new CachePolicy(api) }); }
    finally { fs.rmSync(root, { recursive: true, force: true }); }
}

test("cache budgets accept only whole MB values within bounds", () => {
    for (const value of [null, undefined, "5", -1, 0.5, NaN, Infinity, 10241]) assert.equal(cacheLimitMB(value), 100);
    for (const value of [0, 1, 100, 10240]) assert.equal(cacheLimitMB(value), value);
});

test("native maintenance honors sub-second recency across epochs and keeps files within budget", () => fixture(async f => {
    const old = f.put("old", 600000, 10, "old-epoch");
    const middle = f.put("middle", 600000, 20.1);
    const recent = f.put("recent", 600000, 20.9);
    await f.policy.prune();
    assert.equal(fs.existsSync(old), false);
    assert.equal(fs.existsSync(middle), false);
    assert.equal(fs.existsSync(recent), true);
    assert.equal(f.prefs.get("cacheStatus").bytes, 600000);
    await f.policy.prune();
    assert.equal(fs.existsSync(recent), true);
}));

test("zero budget removes subtitles but never follows symlinks or deletes other files", () => fixture(async f => {
    const entry = f.put("entry", 50, 1);
    const outside = path.join(f.root, "outside");
    fs.mkdirSync(outside);
    const privateFile = path.join(outside, "a".repeat(64) + ".srt");
    fs.writeFileSync(privateFile, "keep");
    fs.symlinkSync(outside, path.join(f.directory, "linked-epoch"));
    const staging = path.join(f.directory, "0", ".pending.123");
    fs.writeFileSync(staging, "pending");
    f.prefs.set("cacheSizeMB", 0);
    await f.policy.prune();
    assert.equal(fs.existsSync(entry), false);
    assert.equal(fs.readFileSync(privateFile, "utf8"), "keep");
    assert.equal(fs.readFileSync(staging, "utf8"), "pending");
    assert.equal(f.prefs.get("cacheStatus").bytes, 0);
}));

test("maintenance handles an empty cache without creating files", () => fixture(async f => {
    await f.policy.prune();
    assert.equal(f.prefs.get("cacheStatus").bytes, 0);
    assert.equal(fs.existsSync(f.directory), false);
}));

test("global maintenance serializes scans and notices changes during an in-flight scan", () => fixture(async f => {
    f.put("one", 50, 1);
    const real = f.api.utils.exec;
    let release;
    let scans = 0;
    f.api.utils.exec = async (file, args) => {
        if (file === "/usr/bin/find") { scans++; await new Promise(resolve => { release = resolve; }); }
        return real(file, args);
    };
    const tick = createCacheMaintenance(f.api);
    const first = tick();
    await tick();
    assert.equal(scans, 1);
    f.prefs.set("cacheSizeMB", 0);
    release(); await first;
    const second = tick();
    assert.equal(scans, 2);
    release(); await second;
    await tick();
    assert.equal(scans, 2);
    assert.equal(f.prefs.get("cacheStatus").bytes, 0);
}));

test("transient maintenance failures are throttled and a changed setting retries immediately", () => fixture(async f => {
    f.put("one", 50, 1);
    const real = f.api.utils.exec;
    let calls = 0;
    f.api.utils.exec = async () => { calls++; return { status: 1, stderr: "transient error" }; };
    const tick = createCacheMaintenance(f.api);
    await tick(); await tick();
    assert.equal(calls, 1);
    f.api.utils.exec = real;
    f.prefs.set("cacheSizeMB", 0);
    await tick();
    assert.equal(f.prefs.get("cacheStatus").message, "");
    assert.equal(f.prefs.get("cacheStatus").bytes, 0);
}));

test("maintenance errors are reported without failing generation or leaking null preferences", () => fixture(async f => {
    f.put("one", 50, 1);
    f.api.utils.exec = async () => ({ status: 1, stderr: "permission denied" });
    await assert.doesNotReject(f.policy.prune());
    assert.equal(f.prefs.get("cacheStatus").message, "Cannot manage subtitle cache.");
}));
