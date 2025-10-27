function qs(id) {
    return document.getElementById(id);
}

async function loadSettings() {
    const { provider = "openai" } = await chrome.storage.local.get({
        provider: "openai",
    });
    qs("provider").value = provider;
}

function setStatus(text, isError = false) {
    const el = qs("status");
    el.textContent = text;
    el.style.color = isError ? "#b00020" : "#555";
}

async function send(type, extra = {}) {
    return await chrome.runtime.sendMessage({ type, ...extra });
}

async function onRead() {
    setStatus("Extracting and generating audio...");
    const provider = qs("provider").value;
    const res = await send("read_current_page", { provider }).catch((e) => ({
        ok: false,
        error: e?.message || String(e),
    }));
    if (!res?.ok) {
        setStatus(res?.error || "Failed to start reading", true);
        return;
    }
    setStatus(
        `Reading with ${res.provider} (${res.chunks || 1} chunk${
            (res.chunks || 1) > 1 ? "s" : ""
        })`
    );
}

async function onPause() {
    await send("pause").catch(() => {});
}
async function onResume() {
    await send("resume").catch(() => {});
}
async function onStop() {
    await send("stop").catch(() => {});
    setStatus("Stopped");
}

document.addEventListener("DOMContentLoaded", () => {
    loadSettings();
    qs("read").addEventListener("click", onRead);
    qs("pause").addEventListener("click", onPause);
    qs("resume").addEventListener("click", onResume);
    qs("stop").addEventListener("click", onStop);
    qs("optionsLink").addEventListener("click", (e) => {
        e.preventDefault();
        if (chrome.runtime.openOptionsPage) chrome.runtime.openOptionsPage();
    });
});
