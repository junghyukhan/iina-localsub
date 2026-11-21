const test = require("node:test");
const assert = require("node:assert/strict");
const { ToolInstaller } = require("../installer.js");
const { MANIFEST_URL } = require("../releases.js");

const digest = "a".repeat(64);
const managedPath = "/private/data/bin/localsub";
function manifest(version = "0.1.0", extra = {}) {
    return {
        version,
        platform: "macos",
        arch: "arm64",
        minimumMacOS: "26.0",
        url: `https://downloads.junghyuk.com/localsub/releases/${version}/localsub-macos-arm64.tar.gz`,
        sha256: digest,
        ...extra,
    };
}

function fixture(options = {}) {
    const preferences = new Map([
        ["executablePath", options.path || ""],
        ["installedVersion", options.version || ""],
    ]);
    const files = new Set(options.path ? [options.path] : []);
    const calls = [];
    const downloads = [];
    const checks = [];
    let current = options.manifest || manifest();
    const api = {
        preferences: {
            get: key => preferences.get(key),
            set: (key, value) => preferences.set(key, value),
            sync() {},
        },
        console: { error() {} },
        http: {
            get: async (url, settings) => {
                checks.push([url, settings]);
                if (options.offline) throw new Error("Network unavailable");
                return { statusCode: 200, data: current };
            },
            download: async (url, dest) => {
                if (options.downloadFailure)
                    throw { statusCode: 503, reason: "Service unavailable" };
                downloads.push([url, dest]);
                files.add(dest);
            },
        },
        utils: {
            resolvePath: value => value.replace("@data/", "/private/data/"),
            fileInPath: value => files.has(value),
            chooseFile: () => options.choose || null,
            exec: async (binary, args) => {
                calls.push([binary, args]);
                let stdout = "";
                if (binary === "/usr/bin/uname") stdout = options.architecture || "arm64";
                else if (binary === "/usr/bin/sw_vers") stdout = options.os || "26.0";
                else if (binary === "/usr/bin/mktemp") {
                    stdout = "/private/data/bin/.localsub-test";
                    files.add(stdout);
                } else if (binary === "/usr/bin/tar") {
                    if (options.extractionFailure) return { status: 1, stderr: "Invalid archive" };
                    files.add("/private/data/bin/.localsub-test/localsub");
                    files.add("/private/data/bin/.localsub-test/LICENSE");
                } else if (binary === "/bin/test" && options.invalidMember)
                    return { status: 1, stderr: "Not a regular file" };
                else if (binary === "/usr/bin/shasum")
                    stdout = (options.digest || digest) + "  " + args.at(-1);
                else if (binary === "/usr/bin/lockf") {
                    files.delete(args[6]);
                    files.add(args[7]);
                    files.delete(args[8]);
                    files.add(args[9]);
                } else if (binary === "/bin/rm") {
                    const target = args.at(-1);
                    for (const path of files)
                        if (path === target || path.startsWith(target + "/")) files.delete(path);
                } else if (args[0] === "--capabilities") {
                    if (options.capabilityFailure)
                        return { status: 2, stdout: "", stderr: "Unknown option" };
                    stdout =
                        options.capabilityOutput === undefined
                            ? JSON.stringify({
                                  schemaVersion: 1,
                                  localTranscriptionSupported: true,
                              })
                            : options.capabilityOutput;
                } else if (args[0] === "--help") {
                    if (options.executionFailure)
                        return { status: 126, stderr: "Execution blocked by macOS" };
                    stdout = "Usage: localsub [options] FILE";
                }
                return { status: 0, stdout, stderr: "" };
            },
        },
    };
    return {
        api,
        preferences,
        files,
        calls,
        downloads,
        checks,
        setManifest: value => {
            current = value;
        },
        installer: new ToolInstaller(api),
    };
}

test("startup inspects the local CLI without making network requests", async () => {
    const f = fixture();
    await f.installer.handle("status");
    assert.equal(f.checks.length, 0);
    assert.equal(f.installer.status.canInstall, false);
});

test("startup status never stores a null request ID that would break IINA preference saving", async () => {
    const f = fixture();
    await f.installer.handle("status", null);
    assert.equal(f.installer.status.requestId, "");
    assert.equal(JSON.stringify(f.installer.status).includes(":null"), false);
});

test("Settings checks stable.json without downloading or installing", async () => {
    const f = fixture();
    await f.installer.handle("refresh");
    assert.equal(f.checks[0][0], MANIFEST_URL);
    assert.equal(f.checks[0][1].headers["Cache-Control"], "no-cache");
    assert.equal(f.downloads.length, 0);
    assert.equal(f.installer.status.releaseVersion, "0.1.0");
    assert.equal(f.installer.status.canInstall, true);
});

test("verified archives install privately, retain the license and clean staging", async () => {
    const f = fixture();
    await f.installer.handle("install");
    assert.equal(f.downloads.length, 1);
    assert.equal(f.preferences.get("executablePath"), managedPath);
    assert.equal(f.preferences.get("installedVersion"), "0.1.0");
    assert.equal(f.installer.status.installed, true);
    assert.equal(f.installer.status.canInstall, false);
    assert.ok(f.files.has(managedPath + ".LICENSE"));
    const publication = f.calls.find(([binary]) => binary === "/usr/bin/lockf");
    assert.deepEqual(publication[1].slice(0, 3), [
        "-k",
        "/private/data/bin/.localsub.lock",
        "/bin/sh",
    ]);
    assert.equal(publication[1].includes("-t"), false);
    const binaries = f.calls.map(([binary]) => binary);
    assert.ok(binaries.indexOf("/usr/bin/shasum") < binaries.indexOf("/usr/bin/tar"));
    assert.ok(binaries.indexOf("/usr/bin/tar") < binaries.indexOf("/bin/chmod"));
    assert.deepEqual(f.calls.find(([binary]) => binary === "/usr/bin/tar")[1].slice(-3), [
        "--",
        "localsub",
        "LICENSE",
    ]);
    assert.equal(
        binaries.some(value => /sudo|xattr/.test(value)),
        false,
    );
    assert.equal(
        [...f.files].some(value => value.includes("/.localsub-")),
        false,
    );
});

test("CLI updates follow stable.json without plugin configuration changes", async () => {
    const f = fixture({ path: managedPath, version: "0.1.0", manifest: manifest("0.2.0") });
    await f.installer.handle("refresh");
    assert.equal(f.installer.status.version, "0.1.0");
    assert.equal(f.installer.status.releaseVersion, "0.2.0");
    assert.equal(f.installer.status.message, "LocalSub 0.1.0 (0.2.0 available)");
    assert.equal(f.installer.status.installLabel, "Update");
    assert.equal(f.installer.status.canInstall, true);
    await f.installer.handle("install");
    assert.match(f.downloads[0][0], /\/0\.2\.0\//);
    assert.equal(f.preferences.get("installedVersion"), "0.2.0");
    assert.equal(f.installer.status.canInstall, false);
    assert.equal(f.installer.status.message, "LocalSub 0.2.0 (Up to date)");
});

test("install uses the displayed release even if stable.json changes after the check", async () => {
    const f = fixture();
    await f.installer.handle("refresh");
    f.setManifest(manifest("0.2.0"));
    await f.installer.handle("install");
    assert.equal(f.preferences.get("installedVersion"), "0.1.0");
    assert.equal(f.checks.length, 1);
});

test("equal and older releases never replace a working managed CLI", async () => {
    for (const available of ["0.2.0", "0.1.0"]) {
        const f = fixture({ path: managedPath, version: "0.2.0", manifest: manifest(available) });
        await f.installer.handle("refresh");
        assert.equal(f.installer.status.canInstall, false);
        await f.installer.handle("install");
        assert.equal(f.downloads.length, 0);
        assert.equal(f.preferences.get("installedVersion"), "0.2.0");
    }
});

test("an external CLI selection does not allow downgrading the managed copy", async () => {
    const external = "/tools/localsub";
    const f = fixture({ path: external, version: "0.2.0" });
    f.files.add(managedPath);
    await f.installer.handle("refresh");
    assert.equal(f.installer.status.canInstall, false);
    await f.installer.handle("install");
    assert.equal(f.downloads.length, 0);
    assert.equal(f.preferences.get("executablePath"), external);
    assert.equal(f.preferences.get("installedVersion"), "0.2.0");
});

test("external CLIs are never overwritten and offer a managed installation instead", async () => {
    const f = fixture({ path: "/existing/localsub" });
    await f.installer.handle("refresh");
    assert.equal(f.installer.status.installLabel, "Install managed copy");
    await f.installer.handle("install");
    assert.ok(f.files.has("/existing/localsub"));
    assert.equal(
        f.calls
            .filter(([binary]) => binary === "/usr/bin/lockf")
            .some(([, args]) => args.at(-1) === "/existing/localsub"),
        false,
    );
    assert.equal(f.preferences.get("executablePath"), managedPath);
});

test("offline update checks keep the installed CLI usable and disable stale downloads", async () => {
    const f = fixture({ path: managedPath, version: "0.1.0", offline: true });
    await f.installer.handle("refresh");
    assert.equal(f.installer.status.installed, true);
    assert.equal(f.installer.status.canInstall, false);
    assert.match(f.installer.status.message, /Network unavailable/);
    assert.equal(f.preferences.get("executablePath"), managedPath);
    assert.equal(f.installer.status.busy, false);
});

test("a failed refresh clears an earlier available release", async () => {
    const f = fixture();
    await f.installer.handle("refresh");
    f.setManifest({});
    await f.installer.handle("refresh");
    assert.equal(f.installer.status.canInstall, false);
    assert.equal(f.installer.status.releaseVersion, "");
    await f.installer.handle("install");
    assert.equal(f.downloads.length, 0);
});

test("checksum, archive, member, download and execution failures preserve the previous executable", async () => {
    for (const option of [
        { digest: "b".repeat(64) },
        { extractionFailure: true },
        { invalidMember: true },
        { downloadFailure: true },
        { executionFailure: true },
    ]) {
        const f = fixture({
            path: managedPath,
            version: "0.1.0",
            manifest: manifest("0.2.0"),
            ...option,
        });
        await f.installer.handle("install");
        assert.equal(f.preferences.get("executablePath"), managedPath);
        assert.equal(f.preferences.get("installedVersion"), "0.1.0");
        assert.equal(
            f.calls.some(([binary]) => binary === "/usr/bin/lockf"),
            false,
        );
        assert.equal(
            [...f.files].some(value => value.includes("/.localsub-")),
            false,
        );
        assert.match(f.installer.status.message, /existing executable has not been changed/);
        if (option.digest)
            assert.equal(
                f.calls.some(([binary]) => binary === "/usr/bin/tar"),
                false,
            );
    }
});

test("post-install persistence and cleanup failures acknowledge that the executable was installed", async () => {
    for (const failure of ["preferences", "cleanup rejection", "cleanup status"]) {
        const f = fixture({ path: managedPath, version: "0.1.0", manifest: manifest("0.2.0") });
        if (failure === "preferences") {
            f.api.preferences.sync = () => {
                throw new Error("Cannot save preferences");
            };
        } else {
            const exec = f.api.utils.exec;
            f.api.utils.exec = async (binary, args) => {
                if (binary === "/bin/rm") {
                    if (failure === "cleanup rejection") throw new Error("Cannot clean staging");
                    return { status: 1, stdout: "", stderr: "Cannot clean staging" };
                }
                return exec(binary, args);
            };
        }
        await f.installer.handle("install");
        assert.ok(f.calls.some(([binary]) => binary === "/usr/bin/lockf"));
        assert.equal(f.preferences.get("installedVersion"), "0.2.0");
        assert.match(f.installer.status.message, /executable was installed/);
        assert.doesNotMatch(f.installer.status.message, /has not been changed/);
        assert.equal(f.installer.status.busy, false);
    }
});

test("unsupported OS, minimum OS and architecture never start a download", async () => {
    for (const option of [
        { os: "15.5" },
        { architecture: "x86_64" },
        { manifest: manifest("0.2.0", { minimumMacOS: "26.1" }) },
    ]) {
        const f = fixture(option);
        await f.installer.handle("install");
        assert.equal(f.downloads.length, 0);
        assert.equal(f.installer.status.canInstall, false);
    }
});

test("universal releases install on both architectures, including Rosetta's x86_64 environment", async () => {
    for (const architecture of ["arm64", "x86_64"]) {
        const f = fixture({ architecture, manifest: manifest("0.2.0", { arch: "universal" }) });
        await f.installer.handle("install");
        assert.equal(f.downloads.length, 1);
        assert.equal(f.installer.status.installed, true);
        assert.equal(f.installer.status.capability, "supported");
    }
    const f = fixture({
        architecture: "unknown",
        manifest: manifest("0.2.0", { arch: "universal" }),
    });
    await f.installer.handle("install");
    assert.equal(f.downloads.length, 0);
});

test("release metadata alone determines the minimum installation OS", async () => {
    const f = fixture({ os: "15.5", manifest: manifest("0.2.0", { minimumMacOS: "15.0" }) });
    await f.installer.handle("install");
    assert.equal(f.downloads.length, 1);
    const newer = fixture({ os: "26.0", manifest: manifest("0.2.0", { minimumMacOS: "26.1" }) });
    await newer.installer.handle("refresh");
    assert.equal(newer.installer.status.message, "LocalSub 0.2.0 requires macOS 26.1 or later");
    assert.equal(newer.installer.status.canInstall, false);
});

test("incompatible updates identify the release and required macOS without replacing the installed CLI", async () => {
    const f = fixture({
        path: managedPath,
        version: "0.1.0",
        os: "15.5",
        manifest: manifest("0.2.0"),
    });
    await f.installer.handle("refresh");
    assert.equal(f.installer.status.message, "LocalSub 0.1.0 (0.2.0 requires macOS 26.0 or later)");
    assert.equal(f.installer.status.canInstall, false);
    assert.equal(f.installer.status.downloadConfigured, false);
    assert.equal(f.downloads.length, 0);
});

test("runnable but unsupported CLIs remain installed without claiming transcription support", async () => {
    const f = fixture({
        path: managedPath,
        capabilityOutput: JSON.stringify({
            schemaVersion: 1,
            localTranscriptionSupported: false,
        }),
    });
    await f.installer.handle("status");
    assert.equal(f.installer.status.installed, true);
    assert.equal(f.installer.status.capability, "unsupported");
    assert.match(
        f.installer.status.message,
        /On-device subtitle generation isn’t supported on this Mac\./,
    );
});

test("unknown capability does not clutter the user-facing status", async () => {
    // Protocol failure variants are covered by tool.test.js.
    const f = fixture({ path: managedPath, capabilityFailure: true });
    await f.installer.handle("status");
    assert.equal(f.installer.status.installed, true);
    assert.equal(f.installer.status.capability, "unknown");
    assert.equal(f.installer.status.message, "External LocalSub");
});

test("native executable chooser verifies and stores the selected path", async () => {
    const f = fixture({ choose: "/chosen/localsub" });
    f.files.add("/chosen/localsub");
    await f.installer.handle("choose");
    assert.equal(f.preferences.get("executablePath"), "/chosen/localsub");
    assert.equal(f.installer.status.installed, true);
});

test("cache clearing rotates its namespace without touching the CLI or checking updates", async () => {
    const f = fixture({ path: managedPath, version: "0.1.0" });
    await f.installer.handle("clear-cache");
    assert.notEqual(f.preferences.get("cacheEpoch"), "0");
    assert.equal(f.preferences.get("executablePath"), managedPath);
    assert.equal(f.checks.length, 0);
    assert.ok(
        f.calls.some(
            ([binary, args]) => binary === "/bin/rm" && args.at(-1) === "/private/data/subtitles/0",
        ),
    );
});

test("concurrent installation requests are ignored", async () => {
    const f = fixture();
    await Promise.all([f.installer.handle("install"), f.installer.handle("install")]);
    assert.equal(f.downloads.length, 1);
});
