const test = require("node:test");
const assert = require("node:assert/strict");
const { canonical, equivalent, resolveLanguage } = require("../language.js");

function api({
    override = "",
    tracks = [],
    preferred = [],
    supported = "en-US  (installed)\nja-JP\nko-KR\nfr-FR\n",
} = {}) {
    const calls = [];
    return {
        calls,
        preferences: { get: () => override },
        mpv: {
            getNative: name => (name === "track-list" ? tracks : preferred),
            getString: () => "",
        },
        utils: {
            exec: async (binary, args) => {
                calls.push([binary, args]);
                return { status: 0, stdout: supported };
            },
        },
    };
}

test("ISO 639 metadata and regional language equivalents are normalized", () => {
    assert.equal(canonical("eng"), "en");
    assert.equal(canonical("jpn"), "ja");
    assert.equal(canonical("ko_KR"), "ko-KR");
    assert.equal(canonical("und"), null);
    assert.equal(equivalent("eng", ["en-AU", "en-US"]), "en-US");
    assert.equal(equivalent("ja", ["ja-JP"]), "ja-JP");
    assert.equal(equivalent("zh-TW", ["zh-CN"]), null);
});

test("explicit override wins without consulting supported languages", async () => {
    const mock = api({ override: "ko", tracks: [{ type: "audio", selected: true, lang: "ja" }] });
    assert.deepEqual(await resolveLanguage(mock, "/cli"), {
        language: "ko",
        source: "language override",
    });
    assert.equal(mock.calls.length, 0);
});

test("invalid explicit override fails rather than silently falling back", async () => {
    await assert.rejects(resolveLanguage(api({ override: "--anything" }), "/cli"), /language tag/);
});

test("selected audio language wins over IINA preferences", async () => {
    const mock = api({
        tracks: [{ type: "audio", selected: true, lang: "jpn" }],
        preferred: ["eng"],
    });
    assert.deepEqual(await resolveLanguage(mock, "/cli"), {
        language: "ja-JP",
        source: "audio-track language",
    });
    assert.equal(mock.calls.length, 1);
});

test("unsupported metadata and preferences are skipped in order", async () => {
    const mock = api({
        tracks: [{ type: "audio", selected: true, lang: "xx" }],
        preferred: ["zz", "kor", "eng"],
    });
    assert.deepEqual(await resolveLanguage(mock, "/cli"), {
        language: "ko-KR",
        source: "IINA audio preferences",
    });
});

test("unknown metadata delegates system locale and English fallback to CLI", async () => {
    assert.deepEqual(await resolveLanguage(api({ preferred: ["xx"] }), "/cli"), {
        language: "",
        source: "system locale, then English",
    });
});

test("unselected audio and subtitle language preferences do not affect recognition", async () => {
    const mock = api({ tracks: [{ type: "audio", selected: false, lang: "ja" }] });
    assert.equal((await resolveLanguage(mock, "/cli")).language, "");
    assert.equal(mock.calls.length, 0);
});

test("unsupported alternate selected audio is rejected rather than transcribing the wrong track", async () => {
    const mock = api({
        tracks: [
            { type: "audio", id: 1, selected: false, lang: "en" },
            { type: "audio", id: 2, selected: true, lang: "ja" },
        ],
    });
    await assert.rejects(resolveLanguage(mock, "/cli"), /alternate audio/);
});
