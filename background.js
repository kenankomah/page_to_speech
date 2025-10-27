// Background service worker (MV3)

const OFFSCREEN_DOC_URL = chrome.runtime.getURL("offscreen.html");

async function ensureOffscreenDocument() {
    const hasDocument = await chrome.offscreen.hasDocument?.();
    if (!hasDocument) {
        await chrome.offscreen.createDocument({
            url: OFFSCREEN_DOC_URL,
            reasons: [chrome.offscreen.Reason.AUDIO_PLAYBACK],
            justification:
                "Play synthesized speech audio in background while popup closes",
        });
    }
    // Wait until offscreen is responding
    const start = Date.now();
    while (Date.now() - start < 4000) {
        try {
            const res = await chrome.runtime.sendMessage({
                target: "offscreen",
                type: "ping",
            });
            if (res?.ok) return;
        } catch {}
        await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error("Offscreen document did not become ready");
}

function chunkTextBySentences(text, maxLen = 2800) {
    const sentences = text
        .replace(/\s+/g, " ")
        .split(/(?<=[.!?])\s+(?=[A-Z0-9"'\(\[])|\n+/);
    const chunks = [];
    let current = "";
    for (const s of sentences) {
        if ((current + " " + s).trim().length > maxLen && current) {
            chunks.push(current.trim());
            current = s;
        } else {
            current = (current + " " + s).trim();
        }
    }
    if (current) chunks.push(current.trim());
    return chunks.filter(Boolean);
}

async function extractPageText(tabId) {
    const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
            function getVisibleText() {
                const preferSelectors = ["main", "article", '[role="main"]'];
                for (const sel of preferSelectors) {
                    const el = document.querySelector(sel);
                    if (
                        el &&
                        el.innerText &&
                        el.innerText.trim().length > 500
                    ) {
                        return el.innerText;
                    }
                }
                // Fallback: collect from paragraphs
                const paras = Array.from(document.querySelectorAll("p"))
                    .map((p) => p.innerText.trim())
                    .filter(Boolean)
                    .join("\n\n");
                if (paras.length > 500) return paras;
                // Last resort: the whole body
                return document.body?.innerText || "";
            }
            return getVisibleText();
        },
        world: "MAIN",
    });
    return (result || "").trim();
}

async function fetchOpenAISpeech(apiKey, model, voice, text) {
    const res = await fetch("https://api.openai.com/v1/audio/speech", {
        method: "POST",
        headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify({
            model: model || "gpt-4o-mini-tts",
            voice: voice || "alloy",
            input: text,
            format: "mp3",
        }),
    });
    if (!res.ok) {
        const textErr = await res.text().catch(() => "");
        throw new Error(`OpenAI TTS error ${res.status}: ${textErr}`);
    }
    const blob = await res.blob();
    const arrayBuffer = await blob.arrayBuffer();
    return arrayBuffer; // Return raw audio data (mp3)
}

async function startReadingCurrentPage(providerOverride) {
    const [activeTab] = await chrome.tabs.query({
        active: true,
        currentWindow: true,
    });
    if (!activeTab?.id) throw new Error("No active tab");
    const text = await extractPageText(activeTab.id);
    if (!text) throw new Error("Could not extract text from page");

    const {
        provider = "openai",
        openaiApiKey = "",
        openaiModel = "gpt-4o-mini-tts",
        openaiVoice = "alloy",
    } = await chrome.storage.local.get({
        provider: "openai",
        openaiApiKey: "",
        openaiModel: "gpt-4o-mini-tts",
        openaiVoice: "alloy",
    });
    const effectiveProvider = providerOverride || provider;

    await ensureOffscreenDocument();

    if (effectiveProvider === "webspeech") {
        await chrome.runtime.sendMessage({
            target: "offscreen",
            type: "webspeech_start",
            payload: { text },
        });
        return { provider: "webspeech", chunks: 1 };
    }

    if (!openaiApiKey) {
        throw new Error(
            "OpenAI API key is not set. Add it in the extension options."
        );
    }

    const chunks = chunkTextBySentences(text);
    // Notify offscreen to prepare queue
    await chrome.runtime.sendMessage({
        target: "offscreen",
        type: "queue_reset",
    });

    for (let i = 0; i < chunks.length; i++) {
        const c = chunks[i];
        const audioBuffer = await fetchOpenAISpeech(
            openaiApiKey,
            openaiModel,
            openaiVoice,
            c
        );
        const buf = Array.from(new Uint8Array(audioBuffer));
        await chrome.runtime.sendMessage({
            target: "offscreen",
            type: "queue_append_audio",
            payload: { buffer: buf, mime: "audio/mpeg" },
        });
    }
    await chrome.runtime.sendMessage({
        target: "offscreen",
        type: "queue_play",
    });
    return { provider: "openai", chunks: chunks.length };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    (async () => {
        try {
            if (message?.type === "offscreen_ready") {
                // no-op acknowledgment from offscreen
                sendResponse?.({ ok: true });
                return;
            }
            if (message?.type === "read_current_page") {
                const res = await startReadingCurrentPage(message?.provider);
                sendResponse({ ok: true, ...res });
                return;
            }
            if (message?.type === "pause") {
                await ensureOffscreenDocument();
                await chrome.runtime.sendMessage({
                    target: "offscreen",
                    type: "pause",
                });
                sendResponse({ ok: true });
                return;
            }
            if (message?.type === "resume") {
                await ensureOffscreenDocument();
                await chrome.runtime.sendMessage({
                    target: "offscreen",
                    type: "resume",
                });
                sendResponse({ ok: true });
                return;
            }
            if (message?.type === "stop") {
                await ensureOffscreenDocument();
                await chrome.runtime.sendMessage({
                    target: "offscreen",
                    type: "stop",
                });
                sendResponse({ ok: true });
                return;
            }
        } catch (e) {
            sendResponse({ ok: false, error: e?.message || String(e) });
        }
    })();
    return true; // keep port open for async
});
