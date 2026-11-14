const MANIFEST_URL = "https://downloads.junghyuk.com/localsub/stable.json";

function versionParts(value) {
    if (typeof value !== "string" || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\.(0|[1-9]\d*))?$/.test(value)) return null;
    const parts = value.split(".").map(Number);
    return parts.every(Number.isSafeInteger) ? [...parts, ...Array(3 - parts.length).fill(0)] : null;
}

function compareVersions(left, right) {
    const a = versionParts(left);
    const b = versionParts(right);
    if (!a || !b) throw new Error("Cannot compare invalid versions.");
    for (let index = 0; index < 3; index++) {
        if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1;
    }
    return 0;
}

function validateManifest(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)
        || !versionParts(value.version) || value.version.split(".").length !== 3
        || value.platform !== "macos" || !["arm64", "x86_64"].includes(value.arch)
        || !versionParts(value.minimumMacOS)
        || typeof value.sha256 !== "string" || !/^[a-f0-9]{64}$/i.test(value.sha256)) {
        throw new Error("The CLI update manifest is invalid.");
    }
    // Trust this HTTPS origin, but never accept executable URLs on arbitrary hosts.
    const match = typeof value.url === "string" && value.url.match(
        /^https:\/\/downloads\.junghyuk\.com\/localsub\/releases\/(\d+\.\d+\.\d+)\/[a-zA-Z0-9_-][a-zA-Z0-9._-]*\.tar\.gz$/);
    if (!match || match[1] !== value.version) throw new Error("The CLI update download URL is invalid.");
    return { version: value.version, platform: value.platform, arch: value.arch,
        minimumMacOS: value.minimumMacOS, url: value.url, sha256: value.sha256, format: "tar.gz" };
}

async function fetchRelease(api) {
    const response = await api.http.get(MANIFEST_URL, { headers: { "Cache-Control": "no-cache" } });
    if (!response || response.statusCode !== 200) throw new Error("Could not retrieve the CLI update manifest.");
    let value = response.data;
    if (value == null) {
        try { value = JSON.parse(response.text); }
        catch (_) { throw new Error("The CLI update manifest is not valid JSON."); }
    }
    return validateManifest(value);
}

module.exports = { MANIFEST_URL, versionParts, compareVersions, validateManifest, fetchRelease };
