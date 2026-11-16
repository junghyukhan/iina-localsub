const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const dist = path.join(root, "dist");
const info = require(path.join(root, "Info.json"));
const archive = path.join(dist, `iina-localsub-${info.version}.iinaplgz`);
fs.mkdirSync(dist, { recursive: true });
fs.rmSync(archive, { force: true });
const files = [
    "LICENSE",
    "Info.json",
    info.entry,
    info.globalEntry,
    "plugin.js",
    "runner.js",
    "tool.js",
    "language.js",
    "cache.js",
    "cache-policy.js",
    "settings.js",
    "installer.js",
    "releases.js",
    info.preferencesPage,
    "preferences.css",
    "preferences.js",
];
execFileSync("/usr/bin/zip", ["-q", archive, ...files], { cwd: root });
console.log(archive);
