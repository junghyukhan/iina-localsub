const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { lockedRunner } = require("../tool.js");
const runner = require("../runner.js");
const exec = promisify(execFile);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

test("kernel locks defer installation until generation exits without leaving stale locks", { skip: process.platform !== "darwin", timeout: 15000 }, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "localsub-lock-test-"));
    let holder;
    let waiter;
    try {
        const lock = path.join(root, "lock");
        const ready = path.join(root, "ready");
        const published = path.join(root, "published");
        // Keep holding the lock until the test explicitly releases stdin.
        holder = exec("/usr/bin/lockf", ["-k", lock, "/bin/sh", "-c",
            'touch "$1"; read -r release', "holder", ready], { timeout: 10000 });
        for (let attempts = 0; !fs.existsSync(ready) && attempts < 100; attempts++) await delay(10);
        assert.ok(fs.existsSync(ready));
        await assert.rejects(exec("/usr/bin/lockf", ["-k", "-t", "0", lock, "/usr/bin/true"]), { code: 75 });
        waiter = exec("/usr/bin/lockf", ["-k", lock, "/usr/bin/touch", published], { timeout: 10000 });
        assert.equal(fs.existsSync(published), false);
        holder.child.stdin.end("\n");
        await Promise.all([holder, waiter]);
        assert.ok(fs.existsSync(published));
        assert.ok(fs.existsSync(lock));
        await exec("/usr/bin/lockf", ["-k", "-t", "0", lock, "/usr/bin/true"]);
    } finally {
        if (holder && !holder.child.stdin.writableEnded) holder.child.stdin.end("\n");
        await Promise.allSettled([holder, waiter].filter(Boolean));
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test("locked supervisor retains the original application PID across lockf", { skip: process.platform !== "darwin" }, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "localsub-locked-runner-"));
    try {
        const job = path.join(root, "job");
        const binary = path.join(root, "cli");
        fs.mkdirSync(job);
        fs.writeFileSync(binary, '#!/bin/sh\nwhile [ "$#" -gt 0 ]; do\n if [ "$1" = --output ]; then output=$2; shift 2; else shift; fi\ndone\nprintf "%s" "$LOCALSUB_OWNER_PID" > "$output"\n', { mode: 0o700 });
        await exec("/bin/sh", ["-c", lockedRunner, "localsub-locked-runner", path.join(root, "lock"), runner, job, binary, "/video.mp4", ""]);
        assert.equal(fs.readFileSync(path.join(job, "subtitles.srt"), "utf8"), String(process.pid));
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
