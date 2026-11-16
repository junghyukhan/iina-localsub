const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const info = require("../Info.json");

test("manifest declares the author and an existing preferences page", () => {
    assert.equal(info.author.name, "Junghyuk Han");
    assert.equal(info.preferencesPage, "preferences.html");
    assert.equal(fs.existsSync(path.join(__dirname, "..", info.preferencesPage)), true);
});

test("publication metadata enables IINA GitHub updates and keeps package versions aligned", () => {
    assert.equal(info.ghRepo, "junghyukhan/iina-localsub");
    assert.ok(Number.isSafeInteger(info.ghVersion) && info.ghVersion > 0);
    assert.equal(info.version, require("../package.json").version);
});

test("preferences use IINA bindings with labels and persistent help text", () => {
    const html = fs.readFileSync(path.join(__dirname, "..", info.preferencesPage), "utf8");
    assert.match(html, /<html lang="en">/);
    assert.match(html, /<link rel="stylesheet" href="preferences\.css">/);
    assert.ok(fs.existsSync(path.join(__dirname, "..", "preferences.css")));
    for (const [key, id, description] of [
        ["executablePath", "executable-path", "executable-help"],
        ["language", "speech-language", "language-help"],
        ["autoGenerate", "auto-generate", "auto-help"],
    ]) {
        assert.ok(Object.hasOwn(info.preferenceDefaults, key));
        assert.match(html, new RegExp(`<label for="${id}">`));
        assert.match(
            html,
            new RegExp(
                `<input id="${id}"[^>]*data-pref-key="${key}"[^>]*aria-describedby="${description}"`,
            ),
        );
        assert.match(html, new RegExp(`id="${description}"`));
    }
    assert.match(html, /<script src="preferences\.js" defer><\/script>/);
    assert.match(html, /id="install-tool" type="button"/);
    assert.match(html, /id="choose-tool" type="button"/);
    assert.match(html, /id="tool-status" role="status"/);
    assert.equal(info.globalEntry, "global.js");
});

test("cache size uses native numeric constraints with validated saving rather than a blind preference binding", () => {
    const html = fs.readFileSync(path.join(__dirname, "..", info.preferencesPage), "utf8");
    const input = html.match(/<input id="cache-size"[^>]+>/)[0];
    assert.match(html, /<label for="cache-size">Maximum cache size \(MB\)<\/label>/);
    assert.match(input, /type="number"/);
    assert.match(input, /min="0" max="10240" step="1" required/);
    assert.match(input, /aria-describedby="cache-help"/);
    assert.doesNotMatch(input, /data-pref-key/);
    assert.equal(info.preferenceDefaults.cacheSizeMB, 100);
});

test("settings keep technical controls collapsed", () => {
    const html = fs.readFileSync(path.join(__dirname, "..", info.preferencesPage), "utf8");
    const primary = html.split(/<main\b[^>]*>/)[1].split("<details>")[0];
    assert.match(html, /<details>\s*<summary>Advanced<\/summary>/);
    const advanced = html.split("<details>")[1].split("</details>")[0];
    assert.match(advanced, /id="executable-path"/);
    assert.match(advanced, /id="choose-tool"/);
    assert.match(primary, /id="cache-size"/);
    assert.match(primary, /id="cache-usage"/);
    assert.match(primary, /id="clear-cache"/);
    assert.match(primary, /Transcription stays on your Mac\./);
    assert.doesNotMatch(advanced, /id="cache-size"|id="cache-usage"|id="clear-cache"/);
    assert.doesNotMatch(primary, /id="choose-tool"|id="tool-path"/);
    assert.doesNotMatch(
        html,
        /Homebrew|\/opt\/homebrew|Automatic language:|checksum|notarized|models may download/i,
    );
});
