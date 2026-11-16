const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function fixture() {
    const nodes = new Map();
    for (const id of [
        "tool-status",
        "tool-path",
        "install-tool",
        "choose-tool",
        "check-tool",
        "clear-cache",
        "generation-status",
        "executable-path",
        "cache-size",
        "cache-usage",
    ]) {
        nodes.set(id, {
            textContent: "",
            disabled: true,
            handlers: {},
            addEventListener(event, fn) {
                this.handlers[event] = fn;
            },
        });
    }
    const size = nodes.get("cache-size");
    Object.defineProperty(size, "valueAsNumber", {
        get: () => (size.value === "" ? NaN : Number(size.value)),
    });
    size.reportValidity = () =>
        Number.isInteger(size.valueAsNumber) &&
        size.valueAsNumber >= 0 &&
        size.valueAsNumber <= 10240;
    const saved = new Map();
    let cache = { bytes: 0, message: "" };
    const requests = [];
    let state = { busy: false, canInstall: true, message: "Ready" };
    let update;
    let job = null;
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../preferences.js"), "utf8"), {
        document: { getElementById: id => nodes.get(id) },
        window: {
            iina: {
                preferences: {
                    set: (key, value) => {
                        saved.set(key, value);
                        if (key === "toolRequest") requests.push(value);
                    },
                    get: (key, callback) =>
                        callback(
                            key === "jobStatus"
                                ? job
                                : key === "cacheSizeMB"
                                  ? 100
                                  : key === "cacheStatus"
                                    ? cache
                                    : state,
                        ),
                },
            },
        },
        setInterval: callback => {
            update = callback;
        },
        setTimeout: callback => callback(),
    });
    return {
        nodes,
        requests,
        saved,
        setCache: value => {
            cache = value;
        },
        update: () => update(),
        setState: value => {
            state = value;
        },
        setJob: value => {
            job = value;
        },
    };
}

test("cache budget saves only valid values and usage is displayed", () => {
    const f = fixture();
    const size = f.nodes.get("cache-size");
    assert.equal(size.value, 100);
    for (const value of ["", "-1", "0.5", "10241", "abc"]) {
        size.value = value;
        size.handlers.change();
        assert.equal(f.saved.has("cacheSizeMB"), false);
    }
    size.value = "0";
    size.handlers.change();
    assert.equal(f.saved.get("cacheSizeMB"), 0);
    f.setCache({ bytes: 1024 * 1024 * 2.5, message: "" });
    f.update();
    assert.equal(f.nodes.get("cache-usage").textContent, "2.5 MB used");
    f.setCache({ bytes: 12 * 1024, message: "" });
    f.update();
    assert.equal(f.nodes.get("cache-usage").textContent, "12 KB used");
});

test("settings wait for the global installer to acknowledge requests", () => {
    const f = fixture();
    assert.equal(f.requests[0].action, "refresh");
    assert.equal(f.nodes.get("install-tool").disabled, true);
    f.setState({ requestId: f.requests[0].id, busy: false, canInstall: true, message: "Ready" });
    f.update();
    assert.equal(f.nodes.get("install-tool").disabled, false);
    f.nodes.get("install-tool").handlers.click();
    assert.equal(f.requests.at(-1).action, "install");
    f.update();
    assert.equal(f.nodes.get("install-tool").disabled, true);
});

test("failed update checks leave retry and executable selection available", () => {
    const f = fixture();
    f.setState({
        requestId: f.requests[0].id,
        busy: false,
        canInstall: false,
        message: "Not configured",
    });
    f.update();
    assert.equal(f.nodes.get("install-tool").disabled, true);
    assert.equal(f.nodes.get("choose-tool").disabled, false);
    assert.equal(f.nodes.get("check-tool").disabled, false);
    f.nodes.get("choose-tool").handlers.click();
    assert.equal(f.requests.at(-1).action, "choose");
});

test("generation status is shown only when there is activity and cache clearing uses the bridge", () => {
    const f = fixture();
    assert.equal(f.nodes.get("generation-status").hidden, true);
    f.setState({
        requestId: f.requests[0].id,
        busy: false,
        canInstall: false,
        message: "LocalSub 0.1.0",
    });
    f.setJob({ message: "Generating subtitles…", busy: true });
    f.update();
    assert.equal(f.nodes.get("generation-status").hidden, false);
    assert.equal(f.nodes.get("generation-status").textContent, "Generating subtitles…");
    f.nodes.get("clear-cache").handlers.click();
    assert.equal(f.requests.at(-1).action, "clear-cache");
});

test("update button clearly distinguishes managed updates from external installation", () => {
    const f = fixture();
    f.setState({
        requestId: f.requests[0].id,
        busy: false,
        canInstall: true,
        message: "LocalSub 0.1.0 · 0.2.0 available",
        installLabel: "Update",
    });
    f.update();
    assert.equal(f.nodes.get("install-tool").textContent, "Update");
    f.nodes.get("check-tool").handlers.click();
    assert.equal(f.requests.at(-1).action, "refresh");
    assert.equal(f.nodes.get("check-tool").disabled, true);
});
