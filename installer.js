const { findExecutable } = require("./tool.js");
const { SubtitleCache } = require("./cache.js");
const { fetchRelease, compareVersions, versionParts } = require("./releases.js");

function errorMessage(error) {
    if (error && error.message) return error.message;
    if (error && error.statusCode) return `HTTP ${error.statusCode}: ${error.reason || "Download failed"}`;
    return String(error);
}

class ToolInstaller {
    constructor(api) {
        this.api = api;
        this.release = null;
        this.updateError = "";
        this.busy = false;
        this.platform = null;
        this.status = {};
    }

    publish(message, extra = {}) {
        this.status = { ...this.status, ...extra, busy: this.busy, message };
        this.api.preferences.set("toolStatus", this.status);
    }

    async exec(binary, args) {
        const result = await this.api.utils.exec(binary, args);
        if (result.status !== 0) throw new Error(result.stderr || `${binary} exited with status ${result.status}.`);
        return result.stdout;
    }

    async inspect(checkUpdates = false) {
        if (!this.platform) {
            const architecture = (await this.exec("/usr/bin/uname", ["-m"])).trim();
            const version = (await this.exec("/usr/bin/sw_vers", ["-productVersion"])).trim();
            this.platform = { architecture, version };
        }
        if (checkUpdates) {
            // An unsuccessful check must not leave a stale release installable.
            this.release = null;
            this.updateError = "";
            try { this.release = await fetchRelease(this.api); }
            catch (error) { this.updateError = errorMessage(error); }
        }
        const path = findExecutable(this.api);
        let installed = false;
        if (path && this.api.utils.fileInPath(path)) {
            try { installed = /Usage: localsub/i.test(await this.exec(path, ["--help"])); }
            catch (_) {}
        }
        const managedPath = this.api.utils.resolvePath("@data/bin/localsub");
        const managed = path === managedPath;
        const storedVersion = this.api.preferences.get("installedVersion") || "";
        const managedVersion = this.api.utils.fileInPath(managedPath) && versionParts(storedVersion) ? storedVersion : "";
        const version = managed ? managedVersion : "";
        const release = this.release;
        let compatible = false;
        let canInstall = false;
        let installLabel = "Install";
        let message = installed ? (version ? `LocalSub ${version}` : "External LocalSub") : "LocalSub not installed";
        if (compareVersions(this.platform.version, "26.0") < 0) {
            message += " · Requires macOS 26+";
        } else if (this.updateError) {
            message += ` · Update check failed: ${this.updateError}`;
        } else if (release) {
            if (release.arch !== this.platform.architecture) {
                message += " · No download for this architecture";
            } else if (compareVersions(this.platform.version, release.minimumMacOS) < 0) {
                message += ` · Release requires macOS ${release.minimumMacOS}+`;
            } else {
                compatible = true;
                const comparison = managedVersion ? compareVersions(release.version, managedVersion) : 1;
                canInstall = comparison >= 0 && (!installed || !managed || comparison > 0);
                if (comparison < 0) message += " · Installed version is newer";
                else if (installed && managed && comparison === 0) message += " · Up to date";
                else if (installed) message += ` · ${release.version} available`;
                else message = `LocalSub ${release.version} available`;
                if (installed && !managed) installLabel = "Install managed copy";
                else if (installed && managed && comparison > 0) installLabel = "Update";
            }
        }
        this.publish(message, { installed, managed, path: path || "", version, managedVersion,
            canInstall, installLabel, releaseVersion: release ? release.version : "",
            downloadConfigured: compatible });
    }

    async handle(action, requestId = "") {
        if (this.busy) return;
        this.busy = true;
        this.status = { ...this.status, requestId: typeof requestId === "string" ? requestId : "" };
        this.publish(action === "install" ? "Preparing install…" : "Checking LocalSub…");
        let committed = false;
        try {
            if (action === "clear-cache") {
                await new SubtitleCache(this.api).clear();
                await this.inspect();
                this.publish("Subtitle cache cleared.");
            } else if (action === "choose") {
                const path = this.api.utils.chooseFile("Choose the localsub executable", {});
                if (path) {
                    const help = await this.exec(path, ["--help"]);
                    if (!/Usage: localsub/i.test(help)) throw new Error("That executable is not localsub.");
                    this.api.preferences.set("executablePath", path);
                    this.api.preferences.sync();
                }
                await this.inspect();
            } else if (action === "install") {
                // Keep installation pinned to the release shown in Settings.
                await this.inspect(!this.release);
                if (!this.status.downloadConfigured) throw new Error(this.updateError || "No compatible LocalSub download is available.");
                if (!this.status.canInstall) return;
                const release = this.release;
                await this.install(release, () => { committed = true; });
                await this.inspect();
            } else if (action === "refresh" || action === "status") {
                await this.inspect(action === "refresh");
            }
        } catch (error) {
            const detail = errorMessage(error);
            this.publish(detail + (committed
                ? " The executable was installed, but a post-install step failed."
                : " Your existing executable has not been changed."));
            this.api.console.error(detail);
        } finally {
            this.busy = false;
            this.publish(this.status.message);
        }
    }

    async install(release, onCommit = () => {}) {
        const directory = this.api.utils.resolvePath("@data/bin");
        const destination = directory + "/localsub";
        await this.exec("/bin/mkdir", ["-p", directory]);
        const staging = (await this.exec("/usr/bin/mktemp", ["-d", directory + "/.localsub-XXXXXX"])).trim();
        const prefix = directory + "/.localsub-";
        if (!staging.startsWith(prefix) || !/^[a-zA-Z0-9]+$/.test(staging.slice(prefix.length))) {
            throw new Error("Could not create a private installation directory.");
        }
        const temporary = staging + "/download";
        try {
            this.publish(`Downloading LocalSub ${release.version}…`);
            await this.api.http.download(release.url, temporary, {});
            const digest = (await this.exec("/usr/bin/shasum", ["-a", "256", temporary])).trim().split(/\s+/)[0];
            if (digest.toLowerCase() !== release.sha256.toLowerCase()) throw new Error("Download checksum did not match. Nothing was installed.");
            this.publish("Installing LocalSub…");
            await this.exec("/usr/bin/tar", ["-xzf", temporary, "-C", staging, "--", "localsub", "LICENSE"]);
            const executable = staging + "/localsub";
            for (const path of [executable, staging + "/LICENSE"]) {
                await this.exec("/bin/test", ["-f", path]);
                await this.exec("/bin/test", ["!", "-L", path]);
            }
            await this.exec("/bin/chmod", ["700", executable]);
            const help = await this.exec(executable, ["--help"]);
            if (!/Usage: localsub/i.test(help)) throw new Error("The downloaded executable failed verification.");
            this.publish("Waiting for subtitle generation…");
            // Kernel locks release on process exit. Keep the lock inode stable across jobs.
            await this.exec("/usr/bin/lockf", ["-k", directory + "/.localsub.lock", "/bin/sh", "-c",
                'set -e; /bin/mv -f "$1" "$2"; /bin/mv -f "$3" "$4"', "localsub-install",
                staging + "/LICENSE", directory + "/localsub.LICENSE", executable, destination]);
            onCommit();
            this.api.preferences.set("executablePath", destination);
            this.api.preferences.set("installedVersion", release.version);
            this.api.preferences.sync();
        } finally {
            await this.exec("/bin/rm", ["-rf", staging]);
        }
    }
}

module.exports = { ToolInstaller };
