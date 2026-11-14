function findExecutable(api) {
    const configured = String(api.preferences.get("executablePath") || "").trim();
    if (configured) return api.utils.resolvePath(configured);
    const managed = api.utils.resolvePath("@data/bin/localsub");
    return [managed, "/opt/homebrew/bin/localsub", "/usr/local/bin/localsub"]
        .find(path => path && api.utils.fileInPath(path)) || null;
}

// Preserve IINA's PID across lockf so the supervisor still detects app termination.
const lockedRunner = `export LOCALSUB_OWNER_PID="$PPID"
exec /usr/bin/lockf -k -t 0 "$1" /bin/sh -c "$2" localsub-runner "$3" "$4" "$5" "$6"`;

module.exports = { findExecutable, lockedRunner };
