const DEFAULT_CACHE_MB = 100;
const MAX_CACHE_MB = 10240;
const MB = 1024 * 1024;

function cacheLimitMB(value) {
    return Number.isInteger(value) && value >= 0 && value <= MAX_CACHE_MB
        ? value
        : DEFAULT_CACHE_MB;
}

class CachePolicy {
    constructor(api) {
        this.api = api;
    }
    limit() {
        return cacheLimitMB(this.api.preferences.get("cacheSizeMB")) * MB;
    }
    changed() {
        this.api.preferences.set(
            "cacheRevision",
            Date.now().toString(36) + Math.random().toString(36).slice(2),
        );
    }

    async prune(limit = this.limit()) {
        const root = this.api.utils.resolvePath("@data/subtitles");
        let bytes = 0;
        try {
            if (this.api.file.exists(root)) {
                // find does not follow symlinks. Only generated epoch/hash paths are eligible.
                const result = await this.api.utils.exec("/usr/bin/find", [
                    root,
                    "-mindepth",
                    "2",
                    "-maxdepth",
                    "2",
                    "-type",
                    "f",
                    "-name",
                    "*.srt",
                    "-exec",
                    "/usr/bin/stat",
                    "-f",
                    "%Fm:%z:%N",
                    "{}",
                    "+",
                ]);
                if (result.status !== 0)
                    throw new Error(result.stderr || "Cannot measure subtitle cache.");
                const entries = result.stdout.split("\n").flatMap(line => {
                    const match = line.match(/^(\d+(?:\.\d+)?):(\d+):(.+)$/);
                    if (!match || !match[3].startsWith(root + "/")) return [];
                    const relative = match[3].slice(root.length + 1);
                    if (!/^[a-zA-Z0-9-]+\/[a-f0-9]{64}\.srt$/.test(relative)) return [];
                    return [{ path: match[3], size: Number(match[2]), used: Number(match[1]) }];
                });
                bytes = entries.reduce((sum, entry) => sum + entry.size, 0);
                entries.sort((a, b) => a.used - b.used || a.path.localeCompare(b.path));
                for (const entry of entries) {
                    if (bytes <= limit) break;
                    const removed = await this.api.utils.exec("/bin/rm", ["-f", "--", entry.path]);
                    if (removed.status !== 0)
                        throw new Error(removed.stderr || "Cannot trim subtitle cache.");
                    bytes -= entry.size;
                }
            }
            this.api.preferences.set("cacheStatus", { bytes, message: "" });
            return true;
        } catch (error) {
            this.api.preferences.set("cacheStatus", {
                bytes,
                message: "Cannot manage subtitle cache.",
            });
            this.api.console.error("Subtitle cache maintenance: " + String(error));
            return false;
        }
    }
}

// Serialize scans; changes during a scan stay dirty for the next poll.
function createCacheMaintenance(api) {
    const policy = new CachePolicy(api);
    let completed = "";
    let failed = "";
    let retryAt = 0;
    let busy = false;
    return async () => {
        const limit = policy.limit();
        const signature = JSON.stringify([limit, api.preferences.get("cacheRevision")]);
        if (busy || signature === completed || (signature === failed && Date.now() < retryAt))
            return;
        busy = true;
        try {
            if (await policy.prune(limit)) {
                completed = signature;
                failed = "";
            } else {
                failed = signature;
                retryAt = Date.now() + 5000;
            }
        } finally {
            busy = false;
        }
    };
}

module.exports = {
    CachePolicy,
    createCacheMaintenance,
    cacheLimitMB,
};
