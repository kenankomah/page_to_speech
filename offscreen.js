// Offscreen document to handle audio playback and Web Speech fallback

const audioEl = document.getElementById("audio");

/** @type {Array<{ url?: string, buffer?: Uint8Array, mime?: string }>} */
const queue = [];
let isPlaying = false;
let useWebSpeech = false;
let speechUtterances = [];

function resetQueue() {
    stopAll();
    queue.length = 0;
    isPlaying = false;
    useWebSpeech = false;
    speechUtterances = [];
}

function urlFromBuffer(buffer, mime) {
    const blob = new Blob([buffer], { type: mime || "audio/mpeg" });
    return URL.createObjectURL(blob);
}

async function playNext() {
    if (useWebSpeech) return; // handled separately
    if (isPlaying) return;
    const item = queue.shift();
    if (!item) return;
    isPlaying = true;
    try {
        const src =
            item.url ||
            (item.buffer ? urlFromBuffer(item.buffer, item.mime) : null);
        if (!src) return;
        audioEl.src = src;
        await audioEl.play();
    } catch (e) {
        console.error("Audio play error", e);
        isPlaying = false;
        // Try next
        playNext();
    }
}

audioEl.addEventListener("ended", () => {
    isPlaying = false;
    playNext();
});

function stopAll() {
    try {
        audioEl.pause();
    } catch {}
    audioEl.currentTime = 0;
    isPlaying = false;
    if ("speechSynthesis" in window) {
        window.speechSynthesis.cancel();
    }
}

function pausePlayback() {
    if (useWebSpeech) {
        if (window.speechSynthesis.speaking && !window.speechSynthesis.paused) {
            window.speechSynthesis.pause();
        }
        return;
    }
    try {
        audioEl.pause();
    } catch {}
    isPlaying = false;
}

async function resumePlayback() {
    if (useWebSpeech) {
        if (window.speechSynthesis.paused) {
            window.speechSynthesis.resume();
        }
        return;
    }
    try {
        await audioEl.play();
        isPlaying = true;
    } catch (e) {
        console.error("Resume error", e);
    }
}

function webspeechStart(text) {
    resetQueue();
    useWebSpeech = true;
    if (!("speechSynthesis" in window)) {
        console.warn("Web Speech API not available");
        return;
    }
    const sentences = text
        .replace(/\s+/g, " ")
        .split(/(?<=[.!?])\s+(?=[A-Z0-9"'\(\[])|\n+/)
        .filter(Boolean);
    speechUtterances = sentences.map((s) => new SpeechSynthesisUtterance(s));
    // Chain them
    for (let i = 0; i < speechUtterances.length - 1; i++) {
        speechUtterances[i].addEventListener("end", () => {
            window.speechSynthesis.speak(speechUtterances[i + 1]);
        });
    }
    if (speechUtterances[0]) {
        window.speechSynthesis.speak(speechUtterances[0]);
    }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    try {
        if (message?.target !== "offscreen") return;
        if (message.type === "ping") {
            sendResponse?.({ ok: true });
            return;
        }
        if (message.type === "queue_reset") {
            resetQueue();
            sendResponse?.({ ok: true });
            return;
        }
        if (message.type === "queue_append_audio") {
            const b = new Uint8Array(message.payload.buffer);
            queue.push({ buffer: b, mime: message.payload.mime });
            // Autoplay next if idle
            if (!isPlaying) playNext();
            sendResponse?.({ ok: true });
            return;
        }
        if (message.type === "queue_play") {
            playNext();
            sendResponse?.({ ok: true });
            return;
        }
        if (message.type === "pause") {
            pausePlayback();
            sendResponse?.({ ok: true });
            return;
        }
        if (message.type === "resume") {
            resumePlayback();
            sendResponse?.({ ok: true });
            return;
        }
        if (message.type === "stop") {
            resetQueue();
            sendResponse?.({ ok: true });
            return;
        }
        if (message.type === "webspeech_start") {
            webspeechStart(message.payload.text || "");
            sendResponse?.({ ok: true });
            return;
        }
    } catch (e) {
        console.error(e);
        sendResponse?.({ ok: false, error: e?.message || String(e) });
    }
});

// Notify background that the offscreen document is ready to receive messages
window.addEventListener("DOMContentLoaded", () => {
    try {
        chrome.runtime.sendMessage({ type: "offscreen_ready" }).catch(() => {});
    } catch {}
});
