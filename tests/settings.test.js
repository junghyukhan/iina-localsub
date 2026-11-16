const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createSettingsSync } = require("../settings.js");
const defaults = require("../Info.json").preferenceDefaults;

function assertPropertyList(value) {
    assert.notEqual(value, null, "Property lists cannot contain NSNull");
    if (Array.isArray(value)) value.forEach(assertPropertyList);
    else if (typeof value === "object") Object.values(value).forEach(assertPropertyList);
    else assert.ok(["string", "number", "boolean"].includes(typeof value));
}

function fixture() {
    const current = structuredClone(defaults);
    let disk = {};
    let flushes = 0;
    const api = {
        preferences: {
            get: key => current[key],
            set: (key, value) => {
                current[key] = value;
            },
            sync: () => {
                assertPropertyList(current);
                disk = structuredClone(current);
                flushes++;
            },
        },
    };
    return { api, current, disk: () => disk, flushes: () => flushes };
}

test("all preference defaults can be serialized as an IINA property list", () => {
    assertPropertyList(defaults);
});

test("settings persist without closing the preferences panel and survive a restart", () => {
    const f = fixture();
    const tick = createSettingsSync(f.api);
    tick();
    assert.equal(f.flushes(), 0);
    f.current.autoGenerate = true;
    tick();
    assert.equal(f.disk().autoGenerate, true);
    tick();
    assert.equal(f.flushes(), 1);
    const restarted = { ...defaults, ...f.disk() };
    assert.equal(restarted.autoGenerate, true);
    f.current.cacheSizeMB = 50;
    tick();
    assert.equal(f.disk().cacheSizeMB, 50);
    f.current.language = "ja";
    f.current.executablePath = "/custom/localsub";
    tick();
    assert.equal(f.disk().language, "ja");
    assert.equal(f.disk().executablePath, "/custom/localsub");
});

test("transient job status changes do not cause repeated disk writes", () => {
    const f = fixture();
    const tick = createSettingsSync(f.api);
    f.current.jobStatus = { id: "job", message: "Generating subtitles…", busy: true };
    tick();
    assert.equal(f.flushes(), 0);
});

test("the global service keeps preferences serializable and saves while the installer is busy", () => {
    const f = fixture();
    let timer;
    class BusyInstaller {
        constructor() {
            this.busy = true;
        }
        handle() {}
    }
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../global.js"), "utf8"), {
        iina: f.api,
        require: name =>
            name === "./installer.js"
                ? { ToolInstaller: BusyInstaller }
                : name === "./settings.js"
                  ? { createSettingsSync }
                  : { createCacheMaintenance: () => () => {} },
        setInterval: callback => {
            timer = callback;
        },
    });
    f.current.autoGenerate = true;
    timer();
    assert.equal(f.disk().autoGenerate, true);
    assert.equal(f.disk().jobStatus.message, "");
});
