(() => {
    const status = document.getElementById("tool-status");
    const path = document.getElementById("tool-path");
    const install = document.getElementById("install-tool");
    const choose = document.getElementById("choose-tool");
    const check = document.getElementById("check-tool");
    const clear = document.getElementById("clear-cache");
    const generation = document.getElementById("generation-status");
    const cacheSize = document.getElementById("cache-size");
    const cacheUsage = document.getElementById("cache-usage");
    const executable = document.getElementById("executable-path");
    const preferences = window.iina && window.iina.preferences;
    if (!preferences) {
        status.textContent = "Open this page in IINA’s plugin settings.";
        return;
    }

    preferences.get("cacheSizeMB", value => {
        cacheSize.value = Number.isInteger(value) && value >= 0 && value <= 10240 ? value : 100;
    });
    cacheSize.addEventListener("change", () => {
        if (!cacheSize.reportValidity()) return;
        preferences.set("cacheSizeMB", cacheSize.valueAsNumber);
    });

    let awaiting = null;
    let requestedAt = 0;
    function request(action) {
        install.disabled = true;
        choose.disabled = true;
        check.disabled = true;
        clear.disabled = true;
        requestedAt = Date.now();
        awaiting = requestedAt.toString(36) + Math.random().toString(36).slice(2);
        preferences.set("toolRequest", { id: awaiting, action });
    }

    let pending = false;
    function update() {
        if (pending) return;
        pending = true;
        preferences.get("cacheStatus", state => {
            const bytes = state && Number.isFinite(state.bytes) ? state.bytes : 0;
            const amount =
                bytes === 0
                    ? "0 MB"
                    : bytes < 1024 * 1024
                      ? `${Math.ceil(bytes / 1024)} KB`
                      : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
            const text = (state && state.message) || `${amount} used`;
            if (cacheUsage.textContent !== text) cacheUsage.textContent = text;
        });
        preferences.get("jobStatus", job => {
            const message = (job && job.message) || "";
            generation.hidden = !message;
            if (generation.textContent !== message) generation.textContent = message;
        });
        preferences.get("toolStatus", state => {
            pending = false;
            if (!state || (awaiting && state.requestId !== awaiting)) {
                if (Date.now() - requestedAt > 5000) {
                    status.textContent = "Enable LocalSub and restart IINA.";
                }
                return;
            }
            awaiting = null;
            if (status.textContent !== state.message) status.textContent = state.message;
            path.textContent = state.path || "";
            install.disabled = !!state.busy || !state.canInstall;
            choose.disabled = !!state.busy;
            check.disabled = !!state.busy;
            clear.disabled = !!state.busy;
            install.textContent = state.installLabel || "Install";
        });
    }

    install.addEventListener("click", () => request("install"));
    choose.addEventListener("click", () => request("choose"));
    check.addEventListener("click", () => request("refresh"));
    clear.addEventListener("click", () => request("clear-cache"));
    executable.addEventListener("change", () => {
        // Let IINA's built-in preference binding store the changed path first.
        setTimeout(() => request("refresh"), 0);
    });
    request("refresh");
    update();
    setInterval(update, 750);
})();
