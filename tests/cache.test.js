const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const exec = promisify(execFile);
const { SubtitleCache, validSubtitle } = require("../cache.js");
const srt = "1\n00:00:00,000 --> 00:00:01,000\nHello.\n";

function fixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "localsub-cache-test-"));
    const input = path.join(root, "100% 'video'.mp4");
    const binary = path.join(root, "localsub");
    const source = path.join(root, "source.srt");
    fs.writeFileSync(input, "video"); fs.writeFileSync(binary, "binary"); fs.writeFileSync(source, srt);
    const preferences = new Map();
    const calls = [];
    let count = 0;
    let locale = "en-US";
    let build = "26A1";
    const api = {
        console: { error() {} },
        preferences: { get: key => preferences.get(key), set: (key, value) => preferences.set(key, value), sync() {} },
        file: { exists: file => fs.existsSync(file), read: file => fs.readFileSync(file, "utf8") },
        utils: {
            resolvePath: file => path.join(root, file.replace("@data/", "")),
            exec: async (file, args) => {
                calls.push([file, args]);
                try {
                    let stdout = "";
                    if (file === "/usr/bin/stat") {
                        const stat = fs.statSync(args.at(-1), { bigint: true });
                        stdout = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}`;
                        if (args.includes("%d:%i:%z:%Fm:%Fc")) stdout += `:${stat.ctimeNs}`;
                        if (args.includes("%z")) stdout = String(stat.size);
                    } else if (file === "/usr/bin/sw_vers") stdout = build;
                    else if (file === "/usr/bin/defaults") stdout = locale;
                    else if (file === "/bin/sh") stdout = createHash("sha256").update(args[3]).digest("hex");
                    else if (file === "/bin/mkdir") fs.mkdirSync(args.at(-1), { recursive: true });
                    else if (file === "/bin/chmod") fs.chmodSync(args[1], parseInt(args[0], 8));
                    else if (file === "/usr/bin/mktemp") {
                        stdout = args[0].replace("XXXXXX", String(++count));
                        fs.closeSync(fs.openSync(stdout, "wx", 0o600));
                    } else if (file === "/bin/cp") fs.copyFileSync(args[0], args[1]);
                    else if (file === "/bin/ln") fs.linkSync(args[0], args[1]);
                    else if (file === "/usr/bin/lockf") stdout = (await exec(file, args)).stdout;
                    else if (file === "/usr/bin/touch") { const now = new Date(); fs.utimesSync(args.at(-1), now, now); }
                    else if (file === "/bin/rm") {
                        for (const target of args.slice(args.indexOf("--") + 1)) {
                            fs.rmSync(target, { recursive: args.includes("-rf"), force: true });
                        }
                    }
                    else throw Error("Unexpected executable: " + file);
                    return { status: 0, stdout, stderr: "" };
                } catch (error) { return { status: 1, stdout: "", stderr: String(error) }; }
            },
        },
    };
    return { api, input, binary, source, root, calls, preferences, cache: new SubtitleCache(api),
        setLocale: value => { locale = value; }, setBuild: value => { build = value; },
        cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

async function withCache(fn) {
    const f = fixture();
    try { await fn(f); } finally { f.cleanup(); }
}

test("zero cache budget bypasses reuse and publication", async () => withCache(async f => {
    const entry = await f.cache.prepare(f.input, f.binary, "en-US");
    assert.equal(await f.cache.store(entry, f.source, () => true), entry.path);
    f.preferences.set("cacheSizeMB", 0);
    assert.equal(await f.cache.prepare(f.input, f.binary, "en-US"), null);
    assert.equal(f.cache.lookup(entry), null);
    assert.equal(await f.cache.store(entry, f.source, () => true), null);
}));

test("oversized subtitles remain temporary instead of consuming the cache budget", async () => withCache(async f => {
    f.preferences.set("cacheSizeMB", 1);
    fs.appendFileSync(f.source, "x".repeat(1024 * 1024));
    const entry = await f.cache.prepare(f.input, f.binary, "en-US");
    assert.equal(await f.cache.store(entry, f.source, () => true), null);
    assert.equal(fs.existsSync(entry.path), false);
    assert.equal(fs.existsSync(f.source), true);
}));

test("disabling caching during publication removes the result and preserves temporary playback output", async () => withCache(async f => {
    const entry = await f.cache.prepare(f.input, f.binary, "en-US");
    const real = f.api.utils.exec;
    f.api.utils.exec = async (file, args) => {
        const result = await real(file, args);
        if (file === "/bin/ln") f.preferences.set("cacheSizeMB", 0);
        return result;
    };
    assert.equal(await f.cache.store(entry, f.source, () => true), null);
    assert.equal(fs.existsSync(entry.path), false);
    assert.equal(fs.existsSync(f.source), true);
    assert.equal(typeof f.preferences.get("cacheRevision"), "string");
}));

test("cache reuse refreshes recency without changing the identity", async () => withCache(async f => {
    const entry = await f.cache.prepare(f.input, f.binary, "en-US");
    await f.cache.store(entry, f.source, () => true);
    fs.utimesSync(entry.path, 1, 1);
    assert.equal(f.cache.lookup(entry), entry.path);
    assert.ok(fs.statSync(entry.path).mtimeMs > 1000);
    assert.equal((await f.cache.prepare(f.input, f.binary, "en-US")).path, entry.path);
}));

test("empty and malformed cache files are not treated as subtitles", () => {
    assert.equal(validSubtitle(srt), true);
    assert.equal(validSubtitle("\r\n" + srt.replaceAll("\n", "\r\n")), true);
    for (const value of ["", "text", "1\n00:00:00,000 --> 00:00:01,000\n", null]) assert.equal(validSubtitle(value), false);
});

test("unchanged media, executable and language resolve to the same persistent entry", async () => withCache(async f => {
    const first = await f.cache.prepare(f.input, f.binary, "en-US");
    const second = await new SubtitleCache(f.api).prepare(f.input, f.binary, "en-US");
    assert.equal(first.path, second.path);
    assert.equal(f.cache.lookup(first), null);
    assert.equal(await f.cache.store(first, f.source, () => true), first.path);
    assert.equal(new SubtitleCache(f.api).lookup(second), first.path);
    assert.equal(fs.statSync(first.path).mode & 0o777, 0o600);
    assert.equal(fs.statSync(first.root).mode & 0o777, 0o700);
    assert.deepEqual(fs.readdirSync(first.root), [path.basename(first.path)]);
}));

test("language, source changes, executable changes and OS updates invalidate entries", async () => withCache(async f => {
    const first = await f.cache.prepare(f.input, f.binary, "en-US");
    assert.notEqual((await f.cache.prepare(f.input, f.binary, "ja-JP")).path, first.path);
    fs.appendFileSync(f.input, "changed");
    assert.equal(await f.cache.unchanged(first), false);
    const changedMedia = await f.cache.prepare(f.input, f.binary, "en-US");
    assert.notEqual(changedMedia.path, first.path);
    fs.appendFileSync(f.binary, "updated");
    const changedBinary = await f.cache.prepare(f.input, f.binary, "en-US");
    assert.notEqual(changedBinary.path, changedMedia.path);
    f.setBuild("26B1");
    assert.notEqual((await f.cache.prepare(f.input, f.binary, "en-US")).path, changedBinary.path);
}));

test("media permission and access metadata changes do not invalidate content identity", async () => withCache(async f => {
    const first = await f.cache.prepare(f.input, f.binary, "en-US");
    fs.chmodSync(f.input, 0o600);
    assert.equal((await f.cache.prepare(f.input, f.binary, "en-US")).path, first.path);
    assert.equal(await f.cache.unchanged(first), true);
}));

test("system locale changes invalidate automatic-language entries", async () => withCache(async f => {
    const first = await f.cache.prepare(f.input, f.binary, "");
    f.setLocale("ko-KR");
    assert.notEqual((await f.cache.prepare(f.input, f.binary, "")).path, first.path);
}));

test("concurrent publication never overwrites the first valid result", async () => withCache(async f => {
    const entry = await f.cache.prepare(f.input, f.binary, "en-US");
    const other = path.join(f.root, "other.srt");
    fs.writeFileSync(other, srt.replace("Hello.", "Different."));
    await Promise.all([f.cache.store(entry, f.source, () => true), f.cache.store(entry, other, () => true)]);
    const winner = fs.readFileSync(entry.path, "utf8");
    assert.ok([srt, srt.replace("Hello.", "Different.")].includes(winner));
    await f.cache.store(entry, other, () => true);
    assert.equal(fs.readFileSync(entry.path, "utf8"), winner);
    assert.equal(fs.readdirSync(entry.root).length, 1);
}));

test("corrupt cache entries are repaired and reused without leaving staging files", { skip: process.platform !== "darwin" }, async () => withCache(async f => {
    const entry = await f.cache.prepare(f.input, f.binary, "en-US");
    fs.mkdirSync(entry.root, { recursive: true });
    for (const corrupt of ["", "not SRT"]) {
        fs.writeFileSync(entry.path, corrupt);
        assert.equal(f.cache.lookup(entry), null);
        assert.equal(await f.cache.store(entry, f.source, () => true), entry.path);
        assert.equal(fs.readFileSync(entry.path, "utf8"), srt);
        assert.equal(await f.cache.store(entry, f.source, () => true), entry.path);
        assert.deepEqual(fs.readdirSync(entry.root), [path.basename(entry.path)]);
    }
}));

test("concurrent repairs preserve the first valid result", { skip: process.platform !== "darwin" }, async () => withCache(async f => {
    const entry = await f.cache.prepare(f.input, f.binary, "en-US");
    fs.mkdirSync(entry.root, { recursive: true });
    fs.writeFileSync(entry.path, "broken");
    const other = path.join(f.root, "other.srt");
    const different = srt.replace("Hello.", "Different.");
    fs.writeFileSync(other, different);
    const results = await Promise.all([
        f.cache.store(entry, f.source, () => true),
        f.cache.store(entry, other, () => true),
    ]);
    assert.deepEqual(results, [entry.path, entry.path]);
    assert.ok([srt, different].includes(fs.readFileSync(entry.path, "utf8")));
    assert.deepEqual(fs.readdirSync(entry.root), [path.basename(entry.path)]);
}));

test("repair does not overwrite a valid result published after the corrupt snapshot", { skip: process.platform !== "darwin" }, async () => withCache(async f => {
    const entry = await f.cache.prepare(f.input, f.binary, "en-US");
    fs.mkdirSync(entry.root, { recursive: true });
    fs.writeFileSync(entry.path, "broken");
    const winner = srt.replace("Hello.", "Another job won.");
    const original = f.api.utils.exec;
    f.api.utils.exec = async (binary, args) => {
        if (binary === "/usr/bin/lockf") fs.writeFileSync(entry.path, winner);
        return original(binary, args);
    };
    assert.equal(await f.cache.store(entry, f.source, () => true), entry.path);
    assert.equal(fs.readFileSync(entry.path, "utf8"), winner);
    assert.deepEqual(fs.readdirSync(entry.root), [path.basename(entry.path)]);
}));

test("cancellation after repair removes only the newly published result", { skip: process.platform !== "darwin" }, async () => withCache(async f => {
    const entry = await f.cache.prepare(f.input, f.binary, "en-US");
    fs.mkdirSync(entry.root, { recursive: true });
    fs.writeFileSync(entry.path, "broken");
    let active = true;
    const original = f.api.utils.exec;
    f.api.utils.exec = async (binary, args) => {
        const result = await original(binary, args);
        if (binary === "/usr/bin/lockf") active = false;
        return result;
    };
    assert.equal(await f.cache.store(entry, f.source, () => active), null);
    assert.deepEqual(fs.readdirSync(entry.root), []);
}));

test("clearing during repair leaves the new namespace untouched", { skip: process.platform !== "darwin" }, async () => withCache(async f => {
    const old = await f.cache.prepare(f.input, f.binary, "en-US");
    fs.mkdirSync(old.root, { recursive: true });
    fs.writeFileSync(old.path, "broken");
    const original = f.api.utils.exec;
    let fresh;
    f.api.utils.exec = async (binary, args) => {
        const result = await original(binary, args);
        if (binary === "/usr/bin/lockf") {
            await f.cache.clear();
            fresh = await f.cache.prepare(f.input, f.binary, "en-US");
            await f.cache.store(fresh, f.source, () => true);
        }
        return result;
    };
    assert.equal(await f.cache.store(old, f.source, () => true), null);
    assert.equal(fs.existsSync(old.path), false);
    assert.equal(f.cache.lookup(fresh), fresh.path);
    assert.equal(fs.readFileSync(fresh.path, "utf8"), srt);
}));

test("cancellation and malformed results are never published", async () => withCache(async f => {
    const entry = await f.cache.prepare(f.input, f.binary, "en-US");
    assert.equal(await f.cache.store(entry, f.source, () => false), null);
    fs.writeFileSync(f.source, "not SRT");
    assert.equal(await f.cache.store(entry, f.source, () => true), null);
    assert.equal(f.cache.lookup(entry), null);
    assert.equal(fs.readdirSync(entry.root).length, 0);
}));

test("clearing rotates the namespace so in-flight jobs cannot refill it", async () => withCache(async f => {
    const old = await f.cache.prepare(f.input, f.binary, "en-US");
    await f.cache.store(old, f.source, () => true);
    await f.cache.clear();
    assert.equal(fs.existsSync(old.path), false);
    assert.equal(f.cache.lookup(old), null);
    assert.equal(await f.cache.store(old, f.source, () => true), null);
    const fresh = await f.cache.prepare(f.input, f.binary, "en-US");
    assert.notEqual(fresh.path, old.path);
    assert.equal(await f.cache.store(fresh, f.source, () => true), fresh.path);
}));

test("clear during publication removes stale results without touching the new namespace", async () => withCache(async f => {
    const old = await f.cache.prepare(f.input, f.binary, "en-US");
    const original = f.api.utils.exec;
    let rotated = false;
    f.api.utils.exec = async (binary, args) => {
        const result = await original(binary, args);
        if (binary === "/bin/ln" && !rotated) { rotated = true; await f.cache.clear(); }
        return result;
    };
    assert.equal(await f.cache.store(old, f.source, () => true), null);
    assert.equal(fs.existsSync(old.path), false);
}));

test("unreadable files disable caching without preventing transcription", async () => withCache(async f => {
    fs.unlinkSync(f.input);
    assert.equal(await f.cache.prepare(f.input, f.binary, "en-US"), null);
}));
