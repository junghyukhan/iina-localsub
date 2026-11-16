const { ToolInstaller } = require("./installer.js");
const { createSettingsSync } = require("./settings.js");
const { createCacheMaintenance } = require("./cache-policy.js");
const installer = new ToolInstaller(iina);
// NSNull prevents IINA from writing its entire preference property list.
iina.preferences.set("jobStatus", { id: "", message: "", busy: false });
const syncSettings = createSettingsSync(iina);
const maintainCache = createCacheMaintenance(iina);
maintainCache();
// Ignore requests persisted from a previous application session.
let lastRequest = iina.preferences.get("toolRequest");
installer.handle("status");

// IINA's Settings webview exposes preferences, not the normal plugin message API.
setInterval(() => {
    syncSettings();
    maintainCache();
    if (installer.busy) return;
    const request = iina.preferences.get("toolRequest");
    if (!request || request.id === (lastRequest && lastRequest.id)) return;
    lastRequest = request;
    if (["install", "choose", "refresh", "clear-cache"].includes(request.action))
        installer.handle(request.action, request.id);
}, 500);
