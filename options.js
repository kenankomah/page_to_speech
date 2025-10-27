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
    const voice = data.openaiVoice || "alloy";
    const select = qs("openaiVoiceSelect");
    const input = qs("openaiVoice");
    if ([...select.options].some((o) => o.value === voice)) {
        select.value = voice;
        input.style.display = "none";
        input.value = "";
    } else {
        select.value = "custom";
        input.style.display = "";
        input.value = voice;
    }
}

async function save() {
    const select = qs("openaiVoiceSelect");
    const input = qs("openaiVoice");
    const chosenVoice =
        select.value === "custom"
            ? input.value.trim() || "alloy"
            : select.value;
    const payload = {
        provider: qs("provider").value,
        openaiApiKey: qs("openaiApiKey").value.trim(),
        openaiModel: qs("openaiModel").value.trim() || "gpt-4o-mini-tts",
        openaiVoice: chosenVoice,
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
    const select = qs("openaiVoiceSelect");
    const input = qs("openaiVoice");
    if (select) {
        select.addEventListener("change", () => {
            if (select.value === "custom") {
                input.style.display = "";
                input.focus();
            } else {
                input.style.display = "none";
            }
        });
    }
});
