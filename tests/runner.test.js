const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const runner = require("../runner.js");

function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "localsub-test-"));
    const directory = path.join(root, "job with ' quotes");
    fs.mkdirSync(directory);
    const binary = path.join(root, "fake ' localsub");
    fs.writeFileSync(binary, `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const output = args[args.indexOf("--output") + 1];
const directory = path.dirname(output);
fs.writeFileSync(path.join(directory, "arguments.json"), JSON.stringify(args));
fs.writeFileSync(path.join(directory, "worker.pid"), String(process.pid));
if (args.at(-1) === "hang") {
    process.on("SIGTERM", () => process.exit(143));
    setInterval(() => {}, 1000);
} else if (args.at(-1) === "fail") {
    fs.writeFileSync(path.join(directory, ".localsub-partial.tmp"), "partial");
    process.stderr.write("transcription failed");
    process.exit(1);
} else {
    fs.writeFileSync(output, "1\\n00:00:00,000 --> 00:00:01,000\\nHello.\\n");
    process.stdout.write("subtitle stdout should be discarded");
}
`, { mode: 0o700 });
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    return { root, directory, binary };
}

function run(t, f, input, language = "") {
    const child = spawn("/bin/sh", ["-c", runner, "localsub-runner", f.directory, f.binary, input, language]);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    t.after(() => { if (child.exitCode === null) child.kill("SIGTERM"); });
    const finished = new Promise((resolve, reject) => {
        child.on("error", reject);
        child.on("close", status => resolve({ status, stdout, stderr }));
    });
    return { child, finished };
}

async function until(predicate, timeout = 5000) {
    const start = Date.now();
    while (!predicate()) {
        if (Date.now() - start > timeout) throw new Error("Timed out waiting for worker");
        await new Promise(resolve => setTimeout(resolve, 20));
    }
}

test("supervisor preserves arguments and discards subtitle stdout", { timeout: 10000 }, async t => {
    const f = fixture(t);
    const input = "/videos/it's 100% real; $(touch SHOULD_NOT_EXIST).mp4";
    const result = await run(t, f, input, "ja").finished;
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "");
    const args = JSON.parse(fs.readFileSync(path.join(f.directory, "arguments.json")));
    assert.deepEqual(args, ["--format", "srt", "--output", path.join(f.directory, "subtitles.srt"), "--language", "ja", "--", input]);
    assert.equal(fs.existsSync(path.join(f.directory, "subtitles.srt")), true);
});

test("system language leaves the CLI language option unset", { timeout: 10000 }, async t => {
    const f = fixture(t);
    const result = await run(t, f, "/video.mp4").finished;
    assert.equal(result.status, 0, result.stderr);
    const args = JSON.parse(fs.readFileSync(path.join(f.directory, "arguments.json")));
    assert.deepEqual(args, ["--format", "srt", "--output", path.join(f.directory, "subtitles.srt"), "--", "/video.mp4"]);
});

test("worker failure propagates status and cleans partial output", { timeout: 10000 }, async t => {
    const f = fixture(t);
    const result = await run(t, f, "fail").finished;
    assert.equal(result.status, 1);
    assert.match(result.stderr, /transcription failed/);
    assert.equal(fs.existsSync(f.directory), false);
});

test("cancel marker terminates the worker and removes temporary files", { timeout: 15000 }, async t => {
    const f = fixture(t);
    const running = run(t, f, "hang");
    const pidFile = path.join(f.directory, "worker.pid");
    await until(() => fs.existsSync(pidFile));
    const pid = Number(fs.readFileSync(pidFile, "utf8"));
    fs.writeFileSync(path.join(f.directory, "cancel"), "");
    const result = await running.finished;
    assert.equal(result.status, 143);
    assert.equal(fs.existsSync(f.directory), false);
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
});

test("cancellation before launch does not start a worker", { timeout: 10000 }, async t => {
    const f = fixture(t);
    fs.writeFileSync(path.join(f.directory, "cancel"), "");
    const result = await run(t, f, "hang").finished;
    assert.equal(result.status, 143);
    assert.equal(fs.existsSync(f.directory), false);
});
