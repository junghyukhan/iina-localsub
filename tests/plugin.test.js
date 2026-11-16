const test = require("node:test");
const assert = require("node:assert/strict");
const { LocalSubPlugin } = require("../plugin.js");

function deferred() {
    let resolve;
    const promise = new Promise(yes => {
        resolve = yes;
    });
    return { promise, resolve };
}

function fixture() {
    const events = new Map();
    const files = new Map();
    const calls = [];
    const commands = [];
    const messages = [];
    const menuItems = [];
    const settings = new Map([
        ["executablePath", "/tools/localsub"],
        ["language", ""],
    ]);
    const process = deferred();
    let next = 0;
    let initializing = true;
    let menuUpdates = 0;
    const api = {
        core: {
            status: { idle: false, isNetworkResource: false, url: "file:///video.mp4" },
            osd: message => messages.push(message),
        },
        mpv: {
            path: "/video.mp4",
            getString() {
                return this.path;
            },
            getNative: () => [],
            command: (name, args) => commands.push([name, args]),
        },
        file: {
            exists: path => files.has(path),
            read: path => files.get(path),
            write: (path, text) => files.set(path, text),
        },
        console: { log() {}, error() {} },
        preferences: {
            get: key => settings.get(key),
            set: (key, value) => settings.set(key, value),
            sync() {},
        },
        menu: {
            item: (title, action) => ({ title, action, enabled: true }),
            addItem: item => menuItems.push(item),
            forceUpdate() {
                assert.equal(
                    initializing,
                    false,
                    "native menu rebuilding during plugin initialization crashes IINA",
                );
                menuUpdates += 1;
            },
        },
        event: { on: (event, action) => events.set(event, action) },
        utils: {
            resolvePath: path =>
                path.replace("@tmp/", "/private/tmp/plugin/").replace("@data/", "/private/data/"),
            fileInPath: () => true,
            exec: async (file, args) => {
                calls.push([file, args]);
                if (file === "/usr/bin/mktemp") {
                    const path = `/private/tmp/plugin/localsub.${++next}`;
                    files.set(path, "");
                    return { status: 0, stdout: path + "\n", stderr: "" };
                }
                if (file === "/bin/mkdir") {
                    return { status: 0, stdout: "", stderr: "" };
                }
                if (file === "/bin/sh") return process.promise;
                if (file === "/bin/rm") {
                    for (const path of files.keys()) {
                        if (path === args[2] || path.startsWith(args[2] + "/")) files.delete(path);
                    }
                    return { status: 0, stdout: "", stderr: "" };
                }
                throw new Error("Unexpected executable: " + file);
            },
        },
    };
    let scheduled = [];
    const plugin = new LocalSubPlugin(api, {
        cache: { prepare: async () => null },
        schedule: fn => {
            scheduled.push(fn);
            return fn;
        },
        unschedule: fn => {
            scheduled = scheduled.filter(item => item !== fn);
        },
    });
    plugin.install();
    initializing = false;
    const tick = () => new Promise(resolve => setImmediate(resolve));
    function complete(status = 0, stderr = "") {
        files.set(
            plugin.job.directory + "/subtitles.srt",
            "1\n00:00:00,000 --> 00:00:01,000\nHello.\n",
        );
        process.resolve({ status, stdout: "", stderr });
    }
    return {
        api,
        plugin,
        events,
        files,
        calls,
        commands,
        messages,
        settings,
        process,
        tick,
        complete,
        menuItems,
        menuUpdates: () => menuUpdates,
        flushAuto: async () => {
            const tasks = scheduled;
            scheduled = [];
            tasks.forEach(fn => {
                fn();
            });
            await tick();
        },
    };
}

function enableCache(f, hit = false) {
    const path = "/private/data/subtitles/0/cached.srt";
    const calls = [];
    const entry = { path };
    if (hit) f.files.set(path, "saved subtitles");
    f.plugin.cache = {
        prepare: async (...args) => {
            calls.push(args);
            return entry;
        },
        lookup: () => (f.files.has(path) ? path : null),
        unchanged: async () => true,
        store: async (_entry, source, valid) => {
            if (!valid()) return null;
            f.files.set(path, f.files.get(source));
            return path;
        },
    };
    return { path, calls };
}

test("cached subtitles load without starting transcription or creating temporary files", async () => {
    const f = fixture();
    const cache = enableCache(f, true);
    await f.plugin.generate();
    assert.deepEqual(f.commands, [["sub-add", [cache.path, "select", "LocalSub"]]]);
    assert.equal(f.calls.length, 0);
    assert.equal(f.settings.get("jobStatus").message, "Cached subtitles loaded.");
});

test("generated subtitles persist and are reused after reopening the video", async () => {
    const f = fixture();
    const cache = enableCache(f);
    const pending = f.plugin.generate();
    await f.tick();
    f.complete();
    await pending;
    assert.equal(f.commands[0][1][0], cache.path);
    assert.equal(f.files.has("/private/tmp/plugin/localsub.1/subtitles.srt"), false);
    f.events.get("mpv.start-file")();
    await f.tick();
    assert.equal(f.files.has(cache.path), true);
    await f.plugin.generate();
    assert.equal(f.calls.filter(([file]) => file === "/bin/sh").length, 1);
    assert.equal(f.commands.length, 2);
});

test("eviction before attachment falls back to temporary output until the media changes", async () => {
    const f = fixture();
    const cache = enableCache(f);
    f.plugin.cache.store = async () => cache.path;
    const pending = f.plugin.generate();
    await f.tick();
    f.complete();
    await pending;
    const subtitle = "/private/tmp/plugin/localsub.1/subtitles.srt";
    assert.equal(f.files.has(cache.path), false);
    assert.equal(f.commands[0][1][0], subtitle);
    assert.equal(f.files.has(subtitle), true);
    f.events.get("mpv.start-file")();
    await f.tick();
    assert.equal(f.files.has(subtitle), false);
});

test("repeating generate does not duplicate a cached track that is already loaded", async () => {
    const f = fixture();
    const cache = enableCache(f, true);
    f.api.mpv.getNative = name =>
        name === "track-list"
            ? [{ type: "sub", "external-filename": cache.path, selected: false }]
            : [];
    await f.plugin.generate();
    assert.equal(f.commands.length, 0);
    assert.match(f.messages.at(-1), /already loaded/);
});

test("source changes during transcription discard the result rather than cache or attach it", async () => {
    const f = fixture();
    const cache = enableCache(f);
    f.plugin.cache.unchanged = async () => false;
    const pending = f.plugin.generate();
    await f.tick();
    f.complete();
    await pending;
    assert.equal(f.files.has(cache.path), false);
    assert.equal(f.commands.length, 0);
    assert.match(f.messages.at(-1), /media file changed/);
});

test("opt-in auto-generation starts once after a local video loads", async () => {
    const f = fixture();
    f.settings.set("autoGenerate", true);
    f.events.get("iina.file-loaded")();
    assert.equal(f.plugin.job, null);
    await f.flushAuto();
    assert.equal(f.plugin.job.automatic, true);
    f.complete();
    await f.tick();
    assert.equal(f.commands.length, 1);
    f.events.get("iina.file-loaded")();
    await f.flushAuto();
    assert.equal(f.calls.filter(([file]) => file === "/bin/sh").length, 1);
});

test("failed automatic attempts do not loop or retry on duplicate file-loaded events", async () => {
    const f = fixture();
    f.settings.set("autoGenerate", true);
    f.events.get("iina.file-loaded")();
    await f.flushAuto();
    f.complete(1, "Transcription failed");
    await f.tick();
    f.events.get("iina.file-loaded")();
    await f.flushAuto();
    assert.equal(f.calls.filter(([file]) => file === "/bin/sh").length, 1);
    assert.equal(f.settings.get("jobStatus").busy, false);
    assert.equal(f.settings.get("jobStatus").message, "Transcription failed");
});

test("a missing CLI warns once per automatic session while manual retries remain available", async () => {
    const f = fixture();
    f.settings.set("autoGenerate", true);
    f.api.utils.fileInPath = () => false;
    f.events.get("iina.file-loaded")();
    await f.flushAuto();
    assert.equal(f.messages.length, 1);
    assert.match(f.messages[0], /Install or choose LocalSub in plugin settings/);
    f.events.get("iina.file-loaded")();
    await f.flushAuto();
    assert.equal(f.messages.length, 1);
    await assert.rejects(f.plugin.generate(), /Install or choose LocalSub in plugin settings/);
    f.api.utils.fileInPath = () => true;
    const pending = f.plugin.generate();
    await f.tick();
    f.complete();
    await pending;
    assert.equal(f.commands.length, 1);
    f.events.get("mpv.start-file")();
    f.api.utils.fileInPath = () => false;
    f.events.get("iina.file-loaded")();
    await f.flushAuto();
    assert.match(f.messages.at(-1), /Install or choose LocalSub in plugin settings/);
});

test("auto-generation skips disabled subtitle tracks and network media", async () => {
    for (const subtitles of [true, false]) {
        const f = fixture();
        f.settings.set("autoGenerate", true);
        if (subtitles) f.api.mpv.getNative = () => [{ type: "sub", selected: false }];
        else f.api.core.status.isNetworkResource = true;
        f.events.get("iina.file-loaded")();
        await f.flushAuto();
        assert.equal(f.calls.length, 0);
    }
});

test("auto-generation uses cache and never creates a worker when a subtitle appears during the delay", async () => {
    const f = fixture();
    const cache = enableCache(f, true);
    f.settings.set("autoGenerate", true);
    f.events.get("iina.file-loaded")();
    await f.flushAuto();
    assert.equal(f.commands[0][1][0], cache.path);
    assert.equal(f.calls.length, 0);
    const second = fixture();
    second.settings.set("autoGenerate", true);
    second.events.get("iina.file-loaded")();
    second.api.mpv.getNative = () => [{ type: "sub", selected: false }];
    await second.flushAuto();
    assert.equal(second.calls.length, 0);
});

test("a reused player window can automatically load cached subtitles after being closed", async () => {
    const f = fixture();
    const cache = enableCache(f, true);
    f.settings.set("autoGenerate", true);
    f.events.get("iina.window-will-close")();
    assert.equal(f.plugin.currentPath(), null);
    f.events.get("mpv.start-file")();
    f.events.get("iina.file-loaded")();
    await f.flushAuto();
    assert.equal(f.plugin.closed, false);
    assert.equal(f.commands[0][1][0], cache.path);
    assert.equal(f.calls.length, 0);
});

test("file changes invalidate delayed automatic requests", async () => {
    const f = fixture();
    f.settings.set("autoGenerate", true);
    f.events.get("iina.file-loaded")();
    f.events.get("mpv.start-file")();
    await f.flushAuto();
    assert.equal(f.calls.length, 0);
});

test("subtitles added during automatic transcription cancel it without attaching output", async () => {
    const f = fixture();
    const cache = enableCache(f);
    f.settings.set("autoGenerate", true);
    f.events.get("iina.file-loaded")();
    await f.flushAuto();
    f.api.mpv.getNative = () => [{ type: "sub", selected: false }];
    f.events.get("mpv.track-list.changed")();
    assert.equal(f.plugin.job.cancelled, true);
    f.complete();
    await f.tick();
    assert.equal(f.commands.length, 0);
    assert.equal(f.files.has(cache.path), false);
});

test("startup sets menu state without rebuilding IINA's native player menu", () => {
    const f = fixture();
    assert.equal(f.menuUpdates(), 0);
    assert.equal(f.plugin.generateItem.enabled, true);
    assert.equal(f.plugin.cancelItem.enabled, false);
    f.events.get("iina.file-loaded")();
    assert.equal(f.menuUpdates(), 1);
});

test("only generate and cancel appear in the Plugin menu", () => {
    const f = fixture();
    assert.deepEqual(
        f.menuItems.map(item => item.title),
        ["Generate subtitles", "Cancel generation"],
    );
});

test("manual generation runs the CLI and attaches subtitles without reopening media", async () => {
    const f = fixture();
    const pending = f.plugin.generate();
    await f.tick();
    assert.equal(f.plugin.generateItem.enabled, false);
    assert.equal(f.plugin.cancelItem.enabled, true);
    const invocation = f.calls.find(([file]) => file === "/bin/sh")[1];
    assert.deepEqual(invocation.slice(4), ["/tools/localsub", "/video.mp4", ""]);
    f.complete();
    await pending;
    assert.deepEqual(f.commands, [
        ["sub-add", ["/private/tmp/plugin/localsub.1/subtitles.srt", "select", "LocalSub"]],
    ]);
    assert.equal(f.plugin.job, null);
    assert.equal(f.plugin.generateItem.enabled, true);
});

test("unsupported recognition stops before creating a worker but cached subtitles still load", async () => {
    const f = fixture();
    const exec = f.api.utils.exec;
    f.api.utils.exec = async (binary, args) =>
        args[0] === "--capabilities"
            ? {
                  status: 0,
                  stdout: JSON.stringify({ schemaVersion: 1, localTranscriptionSupported: false }),
              }
            : exec(binary, args);
    await f.plugin.generate();
    assert.equal(
        f.calls.some(([binary]) => binary === "/usr/bin/mktemp" || binary === "/bin/sh"),
        false,
    );
    assert.match(f.messages.at(-1), /On-device subtitle generation isn’t supported on this Mac\./);
    assert.equal(f.settings.get("jobStatus").busy, false);
    enableCache(f, true);
    await f.plugin.generate();
    assert.equal(f.commands[0][0], "sub-add");
});

test("cancellation during capability inspection prevents launching generation", async () => {
    const f = fixture();
    const inspection = deferred();
    const exec = f.api.utils.exec;
    f.api.utils.exec = async (binary, args) =>
        args[0] === "--capabilities" ? inspection.promise : exec(binary, args);
    const pending = f.plugin.generate();
    await f.tick();
    f.plugin.cancel(false);
    inspection.resolve({
        status: 0,
        stdout: JSON.stringify({ schemaVersion: 1, localTranscriptionSupported: true }),
    });
    await pending;
    assert.equal(f.calls.length, 0);
});

test("managed CLI generation runs its supervisor under the update lock", async () => {
    const f = fixture();
    f.settings.set("executablePath", "/private/data/bin/localsub");
    const pending = f.plugin.generate();
    await f.tick();
    const invocation = f.calls.find(([file]) => file === "/bin/sh")[1];
    assert.equal(invocation[2], "localsub-locked-runner");
    assert.equal(invocation[3], "/private/data/bin/.localsub.lock");
    f.complete();
    await pending;
    assert.equal(f.plugin.job, null);
});

test("video opening alone never starts generation", () => {
    const f = fixture();
    f.events.get("mpv.start-file")();
    f.events.get("iina.file-loaded")();
    assert.equal(f.calls.length, 0);
});

test("installation before player initialization does not query mpv", () => {
    const f = fixture();
    f.api.core.status.url = null;
    f.api.mpv.getString = () => {
        throw new Error("mpv is not initialized");
    };
    f.plugin.refresh();
    assert.equal(f.plugin.generateItem.enabled, false);
});

test("network media is rejected", async () => {
    const f = fixture();
    f.api.core.status.isNetworkResource = true;
    await f.plugin.generate();
    assert.equal(f.calls.length, 0);
    assert.match(f.messages.at(-1), /local media/);
});

test("absolute media paths containing percent signs are passed unchanged", async () => {
    const f = fixture();
    f.api.mpv.path = "/videos/100% real 'video'.mp4";
    const pending = f.plugin.generate();
    await f.tick();
    const invocation = f.calls.find(([file]) => file === "/bin/sh")[1];
    assert.equal(invocation[5], f.api.mpv.path);
    f.complete();
    await pending;
});

test("a second request does not start another concurrent process", async () => {
    const f = fixture();
    const pending = f.plugin.generate();
    await f.plugin.generate();
    await f.tick();
    assert.equal(f.calls.filter(([file]) => file === "/bin/sh").length, 1);
    f.complete();
    await pending;
});

test("user subtitle selection changes add the track without selecting it", async () => {
    const f = fixture();
    const pending = f.plugin.generate();
    await f.tick();
    f.events.get("mpv.sid.changed")();
    f.complete();
    await pending;
    assert.deepEqual(f.commands, [
        ["sub-add", ["/private/tmp/plugin/localsub.1/subtitles.srt", "auto", "LocalSub"]],
    ]);
});

test("cancellation signals the supervisor and never attaches output", async () => {
    const f = fixture();
    const pending = f.plugin.generate();
    await f.tick();
    const directory = f.plugin.job.directory;
    f.plugin.cancel(true);
    assert.equal(f.files.has(directory + "/cancel"), true);
    f.complete();
    await pending;
    assert.equal(f.commands.length, 0);
    assert.equal(f.files.has(directory), false);
    assert.equal(f.plugin.job, null);
});

test("switching away and reopening the same video cannot attach a stale job", async () => {
    const f = fixture();
    const pending = f.plugin.generate();
    await f.tick();
    f.events.get("mpv.start-file")();
    f.complete();
    await pending;
    assert.equal(f.commands.length, 0);
    assert.equal(f.plugin.job, null);
});

test("cancellation during language resolution does not create temporary files or launch the runner", async () => {
    const f = fixture();
    const pending = f.plugin.generate();
    f.plugin.cancel(false);
    await pending;
    assert.equal(
        f.calls.some(([file]) => file === "/bin/sh"),
        false,
    );
    assert.equal(f.files.size, 0);
    assert.equal(f.calls.length, 0);
});

test("cancellation during temporary directory creation removes the directory without launching the runner", {
    timeout: 5000,
}, async () => {
    const f = fixture();
    const temporary = deferred();
    const resume = deferred();
    const exec = f.api.utils.exec;
    f.api.utils.exec = async (binary, args) => {
        const result = await exec(binary, args);
        if (binary === "/usr/bin/mktemp") {
            temporary.resolve();
            await resume.promise;
        }
        return result;
    };
    const pending = f.plugin.generate();
    await temporary.promise;
    f.plugin.cancel(false);
    resume.resolve();
    await pending;
    assert.equal(
        f.calls.some(([file]) => file === "/bin/sh"),
        false,
    );
    assert.equal(f.files.size, 0);
    assert.equal(f.plugin.job, null);
});

test("window closure cancels a job and avoids later OSDs", async () => {
    const f = fixture();
    const pending = f.plugin.generate();
    await f.tick();
    f.events.get("iina.window-will-close")();
    const messages = f.messages.length;
    f.complete();
    await pending;
    assert.equal(f.commands.length, 0);
    assert.equal(f.messages.length, messages);
});

test("CLI failures are reported and incomplete directories are removed", async () => {
    const f = fixture();
    const pending = f.plugin.generate();
    await f.tick();
    f.complete(1, "Unsupported media");
    await pending;
    assert.match(f.messages.at(-1), /Unsupported media/);
    assert.equal(f.files.size, 0);
    assert.equal(f.commands.length, 0);
});

test("empty transcripts are not attached", async () => {
    const f = fixture();
    const pending = f.plugin.generate();
    await f.tick();
    f.files.set(f.plugin.job.directory + "/subtitles.srt", "");
    f.process.resolve({ status: 0, stdout: "", stderr: "" });
    await pending;
    assert.match(f.messages.at(-1), /No speech/);
    assert.equal(f.commands.length, 0);
});

test("completed temporary subtitles are removed when the file changes", async () => {
    const f = fixture();
    const pending = f.plugin.generate();
    await f.tick();
    f.complete();
    await pending;
    assert.equal(f.files.size, 2);
    f.events.get("mpv.end-file")();
    await f.tick();
    assert.equal(f.files.size, 0);
});

test("language preference is passed as an argument", async () => {
    const f = fixture();
    f.settings.set("language", "ja");
    const pending = f.plugin.generate();
    await f.tick();
    assert.equal(f.calls.find(([file]) => file === "/bin/sh")[1].at(-1), "ja");
    f.complete();
    await pending;
});
