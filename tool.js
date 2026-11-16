function findExecutable(api) {
    const configured = String(api.preferences.get("executablePath") || "").trim();
    if (configured) return api.utils.resolvePath(configured);
    const managed = api.utils.resolvePath("@data/bin/localsub");
    return (
        [managed, "/opt/homebrew/bin/localsub", "/usr/local/bin/localsub"].find(
            path => path && api.utils.fileInPath(path),
        ) || null
    );
}

// Older external CLIs may not implement this query.
async function queryCapabilities(api, binary) {
    try {
        const result = await api.utils.exec(binary, ["--capabilities"]);
        if (result.status !== 0) return { state: "unknown" };
        const value = JSON.parse(result.stdout);
        if (
            !value ||
            value.schemaVersion !== 1 ||
            typeof value.localTranscriptionSupported !== "boolean"
        ) {
            return { state: "unknown" };
        }
        return { state: value.localTranscriptionSupported ? "supported" : "unsupported" };
    } catch (_) {
        return { state: "unknown" };
    }
}

// Preserve IINA's PID across lockf so the supervisor still detects app termination.
const lockedRunner = `export LOCALSUB_OWNER_PID="$PPID"
exec /usr/bin/lockf -k -t 0 "$1" /bin/sh -c "$2" localsub-runner "$3" "$4" "$5" "$6"`;

module.exports = { findExecutable, queryCapabilities, lockedRunner };
