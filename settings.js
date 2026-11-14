const keys = ["autoGenerate", "language", "executablePath", "cacheSizeMB"];

// Settings webviews change shared preferences, but IINA only flushes them on panel dismissal.
function createSettingsSync(api) {
    const snapshot = () => JSON.stringify(keys.map(key => api.preferences.get(key)));
    let saved = snapshot();
    return () => {
        const current = snapshot();
        if (current === saved) return;
        api.preferences.sync();
        saved = current;
    };
}

module.exports = { createSettingsSync };
