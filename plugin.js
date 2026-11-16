const runner = require("./runner.js");
const { findExecutable, queryCapabilities, lockedRunner } = require("./tool.js");
const { resolveLanguage } = require("./language.js");
const { SubtitleCache } = require("./cache.js");

class LocalSubPlugin {
    constructor(api, options = {}) {
        this.api = api;
        this.cache = options.cache || new SubtitleCache(api);
        this.schedule = options.schedule || setTimeout;
        this.unschedule = options.unschedule || clearTimeout;
        this.autoTimer = null;
        this.autoAttemptedSession = -1;
        this.session = 0;
        this.selectionRevision = 0;
        this.job = null;
        this.directories = new Set();
        this.closed = false;
    }

    install() {
        const { menu, event } = this.api;
        this.generateItem = menu.item("Generate subtitles", () => {
            this.generate().catch(error => this.fail(error));
        });
        this.cancelItem = menu.item("Cancel generation", () => this.cancel(true));
        [this.generateItem, this.cancelItem].forEach(item => menu.addItem(item));

        event.on("mpv.start-file", () => {
            this.closed = false;
            this.invalidate();
        });
        event.on("mpv.end-file", () => this.invalidate());
        event.on("iina.file-loaded", () => { this.refresh(); this.scheduleAuto(); });
        event.on("mpv.track-list.changed", () => {
            if (this.job && this.job.automatic && !this.job.attaching && this.hasSubtitles()) this.cancel(false);
        });
        event.on("mpv.aid.changed", () => this.cancel(false));
        event.on("iina.window-will-close", () => {
            this.closed = true;
            this.invalidate();
        });
        ["sid", "secondary-sid", "sub-visibility"].forEach(property => {
            event.on(`mpv.${property}.changed`, () => { this.selectionRevision += 1; });
        });
        // Rebuilding the native menu here recursively initializes IINA's first player.
        this.refresh(false);
    }

    currentPath() {
        const { core, mpv } = this.api;
        if (this.closed || core.status.idle || core.status.isNetworkResource
            || typeof core.status.url !== "string") return null;
        const path = mpv.getString("path");
        if (path && path.startsWith("/")) return path;
        // IINA's status URL is already percent-decoded.
        const url = core.status.url;
        return url.startsWith("file:///") ? url.slice(7) : null;
    }

    refresh(updateMenu = true) {
        if (!this.generateItem) return;
        this.generateItem.enabled = !!this.currentPath() && !this.job;
        this.cancelItem.enabled = !!this.job && !this.job.cancelled;
        if (updateMenu) this.api.menu.forceUpdate();
    }

    hasSubtitles() {
        return (this.api.mpv.getNative("track-list") || []).some(track => track.type === "sub");
    }

    scheduleAuto() {
        if (this.autoTimer !== null) this.unschedule(this.autoTimer);
        this.autoTimer = null;
        if (this.api.preferences.get("autoGenerate") !== true || !this.currentPath()
            || this.autoAttemptedSession === this.session || this.hasSubtitles()) return;
        const session = this.session;
        this.autoTimer = this.schedule(() => {
            this.autoTimer = null;
            if (session !== this.session || this.job || !this.currentPath()
                || this.api.preferences.get("autoGenerate") !== true || this.hasSubtitles()) return;
            this.generate({ automatic: true }).catch(error => this.fail(error));
        }, 750);
    }

    usable(job) {
        return this.isCurrent(job) && !job.cancelled && (!job.automatic || !this.hasSubtitles());
    }

    status(job, message, busy) {
        const current = this.api.preferences.get("jobStatus");
        if (!busy && current && current.id !== job.id) return;
        this.api.preferences.set("jobStatus", { id: job.id, message, busy });
    }

    attach(job, subtitle, cached = false) {
        if (!this.usable(job)) return;
        const exists = (this.api.mpv.getNative("track-list") || []).some(track =>
            track.type === "sub" && track["external-filename"] === subtitle);
        const select = this.selectionRevision === job.revision;
        if (!exists) {
            job.attaching = true;
            this.api.mpv.command("sub-add", [subtitle, select ? "select" : "auto", "LocalSub"]);
        }
        const message = exists ? "Subtitles already loaded."
            : !select ? "Subtitles ready in IINA’s subtitle tracks."
            : cached ? "Cached subtitles loaded." : "Subtitles loaded.";
        this.status(job, message, false);
        this.notify(message);
    }

    async generate({ automatic = false } = {}) {
        if (this.job || (automatic && this.hasSubtitles())) return;
        const input = this.currentPath();
        if (!input) { this.notify("Open a local media file first."); return; }
        this.autoAttemptedSession = this.session;
        const binary = findExecutable(this.api);
        if (!binary || !binary.startsWith("/") || !this.api.utils.fileInPath(binary)) {
            throw new Error("Install or choose LocalSub in plugin settings.");
        }
        const job = {
            id: Date.now().toString(36) + Math.random().toString(36).slice(2),
            session: this.session, revision: this.selectionRevision, input, automatic,
            directory: null, cancelled: false,
        };
        this.job = job;
        this.refresh();
        this.status(job, "Checking saved subtitles…", true);
        const managed = binary === this.api.utils.resolvePath("@data/bin/localsub");
        try {
            if (managed) {
                const setup = await this.api.utils.exec("/bin/mkdir", ["-p", this.api.utils.resolvePath("@data/bin")]);
                if (setup.status !== 0) throw new Error(setup.stderr || "Cannot prepare the LocalSub installation folder.");
            }
            if (!this.isCurrent(job) || job.cancelled) return;
            const resolved = await resolveLanguage(this.api, binary);
            if (!this.isCurrent(job) || job.cancelled) return;
            this.api.console.log(`Speech language: ${resolved.language || "automatic"} (${resolved.source})`);
            const entry = await this.cache.prepare(input, binary, resolved.language);
            if (!this.usable(job)) return;
            const cached = entry && this.cache.lookup(entry);
            if (cached && await this.cache.unchanged(entry) && this.cache.lookup(entry)) {
                if (this.usable(job)) this.attach(job, cached, true);
                return;
            }
            const capability = await queryCapabilities(this.api, binary);
            if (!this.usable(job)) return;
            if (capability.state === "unsupported") {
                throw new Error("On-device subtitle generation isn’t supported on this Mac.");
            }
            this.status(job, "Generating subtitles…", true);
            this.notify("Generating subtitles…");
            const temporary = await this.api.utils.exec("/usr/bin/mktemp", [
                "-d", this.api.utils.resolvePath("@tmp/localsub.XXXXXX"),
            ]);
            if (temporary.status !== 0) throw new Error(temporary.stderr || "Cannot create a temporary directory.");
            job.directory = temporary.stdout.trim();
            if (!job.directory.startsWith("/") || !this.api.file.exists(job.directory)) {
                throw new Error("Cannot locate the temporary subtitle directory.");
            }
            if (!this.isCurrent(job) || job.cancelled) return;
            const invocation = managed
                ? ["-c", lockedRunner, "localsub-locked-runner", this.api.utils.resolvePath("@data/bin/.localsub.lock"),
                    runner, job.directory, binary, input, resolved.language]
                : ["-c", runner, "localsub-runner", job.directory, binary, input, resolved.language];
            const result = await this.api.utils.exec(
                "/bin/sh", invocation,
                undefined, undefined,
                message => { this.api.console.log(String(message).trim()); });
            if (!this.isCurrent(job) || job.cancelled) return;
            if (result.status !== 0) {
                throw new Error(managed && result.status === 75
                    ? "LocalSub is busy. Try again when generation or installation finishes."
                    : (result.stderr || `localsub exited with status ${result.status}.`).trim());
            }
            const subtitle = job.directory + "/subtitles.srt";
            if (!this.api.file.exists(subtitle) || !this.api.file.read(subtitle, {}).trim()) {
                throw new Error("No speech subtitles were generated.");
            }
            if (!this.usable(job)) return;
            if (entry && !await this.cache.unchanged(entry)) throw new Error("The media file changed during generation. Try again.");
            const saved = entry && await this.cache.store(entry, subtitle, () => this.usable(job));
            if (!this.usable(job)) return;
            const available = saved && this.api.file.exists(saved) ? saved : null;
            if (!available) this.directories.add(job.directory);
            this.attach(job, available || subtitle);
        } catch (error) {
            if (!job.cancelled && this.isCurrent(job)) {
                this.status(job, error.message || String(error), false);
                this.fail(error);
            }
        } finally {
            if (job.directory && !this.directories.has(job.directory)) {
                await this.removeDirectory(job.directory);
            }
            if (this.job === job) {
                const current = this.api.preferences.get("jobStatus");
                if (current && current.id === job.id && current.busy) this.status(job, "", false);
                this.job = null;
            }
            this.refresh();
            this.scheduleAuto();
        }
    }

    isCurrent(job) {
        return !this.closed && job.session === this.session && this.currentPath() === job.input;
    }

    cancel(showMessage) {
        const job = this.job;
        if (!job || job.cancelled) return;
        job.cancelled = true;
        if (job.directory && this.api.file.exists(job.directory)) {
            this.api.file.write(job.directory + "/cancel", "");
        }
        this.status(job, showMessage ? "Cancelling…" : "", false);
        if (showMessage) this.notify("Cancelling subtitle generation…");
        this.refresh();
    }

    invalidate() {
        if (this.autoTimer !== null) this.unschedule(this.autoTimer);
        this.autoTimer = null;
        this.session += 1;
        this.cancel(false);
        for (const directory of this.directories) this.removeDirectory(directory);
        this.directories.clear();
        this.refresh();
    }

    async removeDirectory(directory) {
        try {
            await this.api.utils.exec("/bin/rm", ["-rf", "--", directory]);
        } catch (error) {
            this.api.console.error("Cannot remove temporary subtitles: " + String(error));
        }
    }

    notify(message) {
        if (!this.closed) this.api.core.osd("LocalSub: " + message);
    }

    fail(error) {
        const message = error && error.message ? error.message : String(error);
        this.api.console.error(message);
        this.notify(message.slice(-300));
    }
}

module.exports = { LocalSubPlugin };
