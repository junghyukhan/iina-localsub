function canonical(tag) {
    if (typeof tag !== "string") return null;
    try {
        const result = Intl.getCanonicalLocales(tag.trim().replace(/_/g, "-"))[0];
        return result && result !== "und" ? result : null;
    } catch (_) {
        return null;
    }
}

function equivalent(requested, supported) {
    const tag = canonical(requested);
    if (!tag) return null;
    const exact = supported.find(value => canonical(value) === tag);
    if (exact) return exact;
    const language = tag.split("-")[0];
    const matches = supported.filter(value => (canonical(value) || "").split("-")[0] === language);
    if (!matches.length) return null;
    const expanded = new Intl.Locale(tag).maximize();
    return (
        matches.find(value => {
            const locale = new Intl.Locale(canonical(value)).maximize();
            return locale.script === expanded.script && locale.region === expanded.region;
        }) ||
        matches.find(
            value => new Intl.Locale(canonical(value)).maximize().script === expanded.script,
        ) ||
        null
    );
}

async function resolveLanguage(api, binary) {
    const tracks = api.mpv.getNative("track-list") || [];
    const audio = tracks.filter(track => track.type === "audio");
    const selected = audio.find(track => track.selected);
    // AVAudioFile cannot be instructed to read IINA's selected alternate audio track.
    if (selected && (selected.external || (audio.length > 1 && selected.id !== audio[0].id))) {
        throw new Error(
            "Selected alternate audio is not supported. Select the primary audio track.",
        );
    }
    const override = String(api.preferences.get("language") || "").trim();
    if (override) {
        const tag = canonical(override);
        if (!tag) throw new Error("Enter a language tag such as en-US, ja, or ko.");
        return { language: tag, source: "language override" };
    }
    const preferred = api.mpv.getNative("alang") || api.mpv.getString("alang") || [];
    const preferences = Array.isArray(preferred) ? preferred : String(preferred).split(",");
    const candidates = [
        ...(selected && selected.lang
            ? [{ tag: selected.lang, source: "audio-track language" }]
            : []),
        ...preferences.map(tag => ({ tag, source: "IINA audio preferences" })),
    ].filter(candidate => canonical(candidate.tag));

    if (candidates.length) {
        const result = await api.utils.exec(binary, ["--languages"]);
        if (result.status !== 0)
            throw new Error(result.stderr || "Cannot list supported speech languages.");
        const supported = result.stdout
            .split(/\r?\n/)
            .map(line => line.trim().split(/\s+/)[0])
            .filter(tag => canonical(tag));
        if (!supported.length) throw new Error("LocalSub returned no supported speech languages.");
        for (const candidate of candidates) {
            const language = equivalent(candidate.tag, supported);
            if (language) return { language, source: candidate.source };
        }
    }
    return { language: "", source: "system locale, then English" };
}

module.exports = { canonical, equivalent, resolveLanguage };
