function qs(id) {
    return document.getElementById(id);
}

async function load() {
    const defaults = {
        provider: "openai",
        openaiApiKey: "",
        openaiModel: "gpt-4o-mini-tts",
        openaiVoice: "alloy",
    };
    const data = await chrome.storage.local.get(defaults);
    qs("provider").value = data.provider;
    qs("openaiApiKey").value = data.openaiApiKey || "";
    qs("openaiModel").value = data.openaiModel || "gpt-4o-mini-tts";
    qs("openaiVoice").value = data.openaiVoice || "alloy";
}

async function save() {
    const payload = {
        provider: qs("provider").value,
        openaiApiKey: qs("openaiApiKey").value.trim(),
        openaiModel: qs("openaiModel").value.trim() || "gpt-4o-mini-tts",
        openaiVoice: qs("openaiVoice").value.trim() || "alloy",
    };
    await chrome.storage.local.set(payload);
    setStatus("Saved");
}

function setStatus(text, isError = false) {
    const el = qs("status");
    el.textContent = text;
    el.style.color = isError ? "#b00020" : "#555";
}

async function test() {
    await save();
    setStatus("Testing...");
    try {
        const res = await chrome.runtime.sendMessage({
            type: "read_current_page",
        });
        if (!res?.ok) throw new Error(res?.error || "Failed");
        setStatus("Playback started");
    } catch (e) {
        setStatus(e?.message || String(e), true);
    }
}

document.addEventListener("DOMContentLoaded", () => {
    load();
    qs("save").addEventListener("click", save);
    qs("test").addEventListener("click", test);
});
