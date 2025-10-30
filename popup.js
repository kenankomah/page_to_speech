function qs(id) {
    return document.getElementById(id);
}

async function loadSettings() {
    const defaults = {
        provider: "openai",
        openaiVoice: "alloy",
    };
    const { provider, openaiVoice } = await chrome.storage.local.get(defaults);
    qs("provider").value = provider;
    const select = qs("voiceSelect");
    const input = qs("voiceCustom");
    if ([...select.options].some((o) => o.value === openaiVoice)) {
        select.value = openaiVoice;
        input.style.display = "none";
        input.value = "";
    } else {
        select.value = "custom";
        input.style.display = "";
        input.value = openaiVoice;
    }
}

function setStatus(text, isError = false) {
    const el = qs("status");
    el.textContent = text;
    el.style.color = isError ? "#b00020" : "#555";
}

async function send(type, extra = {}) {
    return await chrome.runtime.sendMessage({ type, ...extra });
}

let playing = false;
let paused = false;

function formatTime(totalSec) {
    const s = Math.max(0, Math.floor(totalSec || 0));
    const mm = String(Math.floor(s / 60)).padStart(2, "0");
    const ss = String(s % 60).padStart(2, "0");
    return `${mm}:${ss}`;
}

function updateToggleLabel() {
    const btn = qs("toggle");
    if (!btn) return;
    if (!playing) btn.textContent = "Read";
    else if (paused) btn.textContent = "Resume";
    else btn.textContent = "Pause";
}

async function onRead() {
    setStatus("Extracting and generating audio...");
    const provider = qs("provider").value;
    const voiceSel = qs("voiceSelect");
    const voiceInp = qs("voiceCustom");
    const openaiVoice =
        voiceSel.value === "custom"
            ? voiceInp.value.trim() || "alloy"
            : voiceSel.value;
    const res = await send("read_current_page", {
        provider,
        openaiVoice,
    }).catch((e) => ({
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
    playing = true;
    paused = false;
    updateToggleLabel();
    const elapsedEl = qs("elapsed");
    const totalEl = qs("total");
    if (elapsedEl) elapsedEl.textContent = "00:00";
    if (totalEl) totalEl.textContent = "--:--";
}

async function onStop() {
    await send("stop").catch(() => {});
    setStatus("Stopped");
    playing = false;
    paused = false;
    updateToggleLabel();
    const elapsedEl = qs("elapsed");
    const totalEl = qs("total");
    if (elapsedEl) elapsedEl.textContent = "00:00";
    if (totalEl) totalEl.textContent = "--:--";
}

document.addEventListener("DOMContentLoaded", () => {
    loadSettings();
    // Initialize toggle label from current playback status
    chrome.runtime
        .sendMessage({ type: "get_status" })
        .then((res) => {
            if (!res?.ok) return;
            const isActive = Boolean(
                res.playing ||
                    res.queueLength > 0 ||
                    (res.provider === "webspeech" && res.paused)
            );
            playing = isActive;
            paused = Boolean(res.paused && isActive);
            // Set voice dropdown to match current session if available
            if (res.providerUsed === "openai" && res.voice) {
                const select = qs("voiceSelect");
                const input = qs("voiceCustom");
                if ([...select.options].some((o) => o.value === res.voice)) {
                    select.value = res.voice;
                    input.style.display = "none";
                    input.value = "";
                } else {
                    select.value = "custom";
                    input.style.display = "";
                    input.value = res.voice;
                }
            }
            updateToggleLabel();
        })
        .catch(() => {});
    const toggleBtn = qs("toggle");
    if (toggleBtn) {
        toggleBtn.addEventListener("click", async () => {
            if (!playing) {
                await onRead();
            } else if (!paused) {
                await send("pause").catch(() => {});
                paused = true;
                updateToggleLabel();
            } else {
                await send("resume").catch(() => {});
                paused = false;
                updateToggleLabel();
            }
        });
    }
    qs("stop").addEventListener("click", onStop);
    qs("optionsLink").addEventListener("click", (e) => {
        e.preventDefault();
        if (chrome.runtime.openOptionsPage) chrome.runtime.openOptionsPage();
    });
    const voiceSel = qs("voiceSelect");
    const voiceInp = qs("voiceCustom");
    voiceSel.addEventListener("change", () => {
        if (voiceSel.value === "custom") {
            voiceInp.style.display = "";
            voiceInp.focus();
        } else {
            voiceInp.style.display = "none";
        }
    });

    // Poll playback status and timers
    setInterval(() => {
        chrome.runtime
            .sendMessage({ type: "get_status" })
            .then((res) => {
                if (!res?.ok) return;
                const isActive = Boolean(
                    res.playing ||
                        res.queueLength > 0 ||
                        (res.provider === "webspeech" && res.paused)
                );
                playing = isActive;
                paused = Boolean(res.paused && isActive);
                updateToggleLabel();
                const elapsedEl = qs("elapsed");
                const totalEl = qs("total");
                if (elapsedEl && typeof res.elapsedSec === "number") {
                    elapsedEl.textContent = formatTime(res.elapsedSec);
                }
                if (totalEl) {
                    if (typeof res.totalSec === "number" && res.totalSec > 0) {
                        totalEl.textContent = formatTime(res.totalSec);
                    } else {
                        totalEl.textContent = "--:--";
                    }
                }
            })
            .catch(() => {});
    }, 1000);
});
