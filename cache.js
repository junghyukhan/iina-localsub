const { CachePolicy } = require("./cache-policy.js");

function validSubtitle(text) {
    return typeof text === "string" && /^\d+\r?\n\d{2,}:\d{2}:\d{2},\d{3} --> \d{2,}:\d{2}:\d{2},\d{3}\r?\n\S/.test(text.trim());
}

class SubtitleCache {
    constructor(api) { this.api = api; this.policy = new CachePolicy(api); }

    epoch() {
        const value = String(this.api.preferences.get("cacheEpoch") || "0");
        return /^[a-zA-Z0-9-]+$/.test(value) ? value : "0";
    }

    root(epoch = this.epoch()) { return this.api.utils.resolvePath("@data/subtitles") + "/" + epoch; }

    async exec(binary, args) {
        const result = await this.api.utils.exec(binary, args);
        if (result.status !== 0) throw new Error(result.stderr || `${binary} failed.`);
        return result.stdout.trim();
    }

    fingerprint(path, executable = false) {
        // Finder's last-used metadata can change media ctime without changing its contents.
        const format = executable ? "%d:%i:%z:%Fm:%Fc" : "%d:%i:%z:%Fm";
        return this.exec("/usr/bin/stat", ["-L", "-f", format, path]);
    }

    async prepare(input, binary, language) {
        if (this.policy.limit() === 0) return null;
        try {
            const epoch = this.epoch();
            const media = await this.fingerprint(input);
            const executable = await this.fingerprint(binary, true);
            const os = await this.exec("/usr/bin/sw_vers", ["-buildVersion"]);
            const locale = language ? "" : await this.exec("/usr/bin/defaults", ["read", "-g", "AppleLocale"]);
            const identity = JSON.stringify([1, input, media, binary, executable, os, language, locale]);
            const digest = (await this.exec("/bin/sh", ["-c", 'printf "%s" "$1" | /usr/bin/shasum -a 256',
                "localsub-cache-key", identity])).split(/\s+/)[0];
            if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error("Cannot identify the subtitle cache entry.");
            return { input, media, epoch, root: this.root(epoch), path: this.root(epoch) + "/" + digest + ".srt" };
        } catch (error) {
            this.api.console.error("Subtitle cache unavailable: " + String(error));
            return null;
        }
    }

    lookup(entry) {
        if (!entry || entry.epoch !== this.epoch() || this.policy.limit() === 0) return null;
        try {
            if (!this.api.file.exists(entry.path) || !validSubtitle(this.api.file.read(entry.path, {}))) return null;
            this.api.utils.exec("/usr/bin/touch", ["-c", "-m", entry.path]).catch(() => {});
            return entry.path;
        } catch (_) { return null; }
    }

    async unchanged(entry) {
        try { return await this.fingerprint(entry.input) === entry.media; }
        catch (_) { return false; }
    }

    async store(entry, subtitle, canPublish) {
        if (!entry || entry.epoch !== this.epoch() || !canPublish() || this.policy.limit() === 0) return null;
        let staging = null;
        let snapshot = null;
        let published = false;
        try {
            if (this.lookup(entry)) return entry.path;
            const size = Number(await this.exec("/usr/bin/stat", ["-L", "-f", "%z", subtitle]));
            if (!Number.isSafeInteger(size) || size < 0) throw new Error("Cannot measure generated subtitles.");
            if (size > this.policy.limit()) return null;
            await this.exec("/bin/mkdir", ["-p", entry.root]);
            await this.exec("/bin/chmod", ["700", entry.root]);
            staging = await this.exec("/usr/bin/mktemp", [entry.root + "/.pending.XXXXXX"]);
            const prefix = entry.root + "/.pending.";
            if (!staging.startsWith(prefix) || !/^[a-zA-Z0-9]+$/.test(staging.slice(prefix.length))) {
                staging = null;
                throw new Error("Cannot create a subtitle cache staging file.");
            }
            await this.exec("/bin/cp", [subtitle, staging]);
            await this.exec("/bin/chmod", ["600", staging]);
            if (!validSubtitle(this.api.file.read(staging, {}))) throw new Error("Cannot cache invalid subtitles.");
            if (!canPublish() || entry.epoch !== this.epoch() || size > this.policy.limit()) return null;
            // Stage on the cache filesystem for atomic publication.
            const result = await this.api.utils.exec("/bin/ln", [staging, entry.path]);
            published = result.status === 0;
            if (!published && !this.lookup(entry) && canPublish() && entry.epoch === this.epoch()) {
                // Repair only the rejected bytes, not a result another job has replaced.
                snapshot = staging + ".invalid";
                await this.exec("/bin/cp", [entry.path, snapshot]);
                if (!validSubtitle(this.api.file.read(snapshot, {})) && canPublish() && entry.epoch === this.epoch()) {
                    const output = await this.exec("/usr/bin/lockf", [
                        "-k", this.api.utils.resolvePath("@data/subtitles/.repair.lock"), "/bin/sh", "-c",
                        'if /usr/bin/cmp -s "$1" "$2"; then /bin/mv -f "$3" "$1" && printf published; fi',
                        "localsub-cache-repair", entry.path, snapshot, staging,
                    ]);
                    published = output === "published";
                }
            }
            if (!canPublish() || entry.epoch !== this.epoch() || size > this.policy.limit()) {
                if (published) await this.api.utils.exec("/bin/rm", ["-f", "--", entry.path]);
                return null;
            }
            return this.lookup(entry);
        } catch (error) {
            this.api.console.error("Cannot cache subtitles: " + String(error));
            return null;
        } finally {
            if (published) this.policy.changed();
            if (staging) await this.api.utils.exec("/bin/rm", ["-f", "--", staging, ...(snapshot ? [snapshot] : [])]);
        }
    }

    async clear() {
        const old = this.root();
        const epoch = Date.now().toString(36) + "-" + Math.random().toString(36).slice(2);
        // Rotate first so clearing cannot delete or repopulate the new cache generation.
        this.api.preferences.set("cacheEpoch", epoch);
        this.api.preferences.sync();
        await this.exec("/bin/rm", ["-rf", "--", old]);
        this.policy.changed();
    }
}

module.exports = { SubtitleCache, validSubtitle };
