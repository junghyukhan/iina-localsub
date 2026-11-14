const test = require("node:test");
const assert = require("node:assert/strict");
const { compareVersions, validateManifest, fetchRelease, MANIFEST_URL } = require("../releases.js");

const manifest = {
    version: "0.1.0", platform: "macos", arch: "arm64", minimumMacOS: "26.0",
    url: "https://downloads.junghyuk.com/localsub/releases/0.1.0/localsub-macos-arm64.tar.gz",
    sha256: "a".repeat(64),
};

test("stable versions and macOS versions are compared numerically", () => {
    assert.equal(compareVersions("0.10.0", "0.9.0"), 1);
    assert.equal(compareVersions("26.0", "26.0.0"), 0);
    assert.equal(compareVersions("26.1", "26.0.9"), 1);
    assert.equal(compareVersions("1.0.0", "2.0.0"), -1);
    assert.throws(() => compareVersions("invalid", "1.0.0"));
});

test("published manifest schema is accepted and its archive format inferred", () => {
    assert.deepEqual(validateManifest(manifest), { ...manifest, format: "tar.gz" });
});

test("invalid schema and unsafe archive locations are rejected", () => {
    for (const fields of [
        { version: "0.1" }, { version: "01.1.0" }, { version: "1.0.0-beta" },
        { version: "999999999999999999.0.0" }, { platform: "linux" }, { arch: "unknown" },
        { minimumMacOS: "invalid" }, { sha256: "bad" },
        { url: manifest.url.replace("https:", "http:") },
        { url: manifest.url.replace("downloads.junghyuk.com", "evil.example") },
        { url: manifest.url.replace("downloads.junghyuk.com", "downloads.junghyuk.com.evil.example") },
        { url: manifest.url.replace("/0.1.0/", "/0.2.0/") },
        { url: manifest.url + "?redirect=https://evil.example" },
        { url: manifest.url.replace("localsub-macos-arm64", "../localsub-macos-arm64") },
    ]) assert.throws(() => validateManifest({ ...manifest, ...fields }));
    for (const value of [null, [], "text", {}]) assert.throws(() => validateManifest(value));
});

test("HTTP data and text responses are supported without browser fetch APIs", async () => {
    for (const response of [{ statusCode: 200, data: manifest }, { statusCode: 200, text: JSON.stringify(manifest) }]) {
        const result = await fetchRelease({ http: { get: async url => {
            assert.equal(url, MANIFEST_URL);
            return response;
        } } });
        assert.equal(result.version, "0.1.0");
    }
});

test("non-success HTTP responses and malformed JSON cannot produce a release", async () => {
    for (const response of [{ statusCode: 404 }, { statusCode: 200, text: "not JSON" }]) {
        await assert.rejects(fetchRelease({ http: { get: async () => response } }));
    }
});

test("manifest host is permitted by IINA", () => {
    assert.ok(require("../Info.json").allowedDomains.includes(new URL(MANIFEST_URL).hostname));
});
