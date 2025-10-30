// Background service worker (MV3)

const OFFSCREEN_DOC_URL = chrome.runtime.getURL("offscreen.html");

// Manage cancellation of an active reading session
let activeSessionId = null;
const controllersBySession = new Map(); // sessionId -> Set<AbortController>
let currentSession = { voice: null, model: null, provider: null };

function cancelActiveSession() {
    const sessionId = activeSessionId;
    if (!sessionId) return;
    const set = controllersBySession.get(sessionId);
    if (set) {
        for (const c of set) {
            try {
                c.abort();
            } catch {}
        }
        controllersBySession.delete(sessionId);
    }
    activeSessionId = null;
    currentSession = { voice: null, model: null, provider: null };
}

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

function chunkTextBySentences(text, maxLen = 600) {
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

async function fetchOpenAISpeech(
    apiKey,
    model,
    voice,
    text,
    format = "mp3",
    signal
) {
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
            format,
        }),
        signal,
    });
    if (!res.ok) {
        const textErr = await res.text().catch(() => "");
        throw new Error(`OpenAI TTS error ${res.status}: ${textErr}`);
    }
    const blob = await res.blob();
    const arrayBuffer = await blob.arrayBuffer();
    return arrayBuffer; // Return raw audio data (mp3)
}

async function sendToOffscreen(message) {
    await ensureOffscreenDocument();
    try {
        return await chrome.runtime.sendMessage({
            target: "offscreen",
            ...message,
        });
    } catch (e) {
        // Retry once after a brief delay in case the offscreen doc was just recreated
        await new Promise((r) => setTimeout(r, 150));
        await ensureOffscreenDocument();
        return await chrome.runtime.sendMessage({
            target: "offscreen",
            ...message,
        });
    }
}

function isOffscreenSupported() {
    try {
        return Boolean(chrome.offscreen?.createDocument);
    } catch {
        return false;
    }
}

async function startReadingCurrentPage(providerOverride, voiceOverride) {
    const [activeTab] = await chrome.tabs.query({
        active: true,
        currentWindow: true,
    });
    if (!activeTab?.id) throw new Error("No active tab");
    // Prefer selected text if available
    let text = "";
    try {
        const [{ result: selected }] = await chrome.scripting.executeScript({
            target: { tabId: activeTab.id },
            func: () => window.getSelection()?.toString() || "",
            world: "MAIN",
        });
        text = (selected || "").trim();
    } catch {}
    if (!text) {
        text = await extractPageText(activeTab.id);
    }
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
    let effectiveProvider = providerOverride || provider;

    // If offscreen isn't available (older Chrome), auto-fallback to Web Speech
    if (effectiveProvider !== "webspeech" && !isOffscreenSupported()) {
        effectiveProvider = "webspeech";
    }

    if (effectiveProvider === "webspeech") {
        // Best-effort ensure offscreen exists if it's used to host speech
        await ensureOffscreenDocument().catch(() => {});
        await sendToOffscreen({
            type: "webspeech_start",
            payload: { text },
        }).catch(() => {});
        currentSession = { voice: null, model: null, provider: "webspeech" };
        return { provider: "webspeech", chunks: 1 };
    }

    await ensureOffscreenDocument();

    if (!openaiApiKey) {
        throw new Error(
            "OpenAI API key is not set. Add it in the extension options."
        );
    }

    const chunks = chunkTextBySentences(text);
    // Quick duration estimate from word count (approx 160 wpm)
    const wordCount = (text.trim().match(/\b\w+\b/g) || []).length;
    const totalEstimateSec = wordCount ? (wordCount / 160) * 60 : 0;

    // Record current session details
    currentSession = {
        voice: voiceOverride || openaiVoice,
        model: openaiModel,
        provider: "openai",
    };

    // Start a new session and prepare abort tracking
    const mySessionId = crypto?.randomUUID
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random()}`;
    activeSessionId = mySessionId;
    controllersBySession.set(mySessionId, new Set());

    try {
        // Notify offscreen to prepare queue
        await sendToOffscreen({ type: "queue_reset" });
        // Send expected chunk count and total estimate so total can be displayed immediately
        await sendToOffscreen({
            type: "queue_set_expected",
            payload: { expectedCount: chunks.length, totalEstimateSec },
        });

        // Fetch and enqueue first chunk, start playback ASAP
        // Use WAV for the first chunk to reduce synthesis latency, then MP3 for the rest
        const firstController = new AbortController();
        controllersBySession.get(mySessionId)?.add(firstController);
        const firstBufAB = await fetchOpenAISpeech(
            openaiApiKey,
            openaiModel,
            voiceOverride || openaiVoice,
            chunks[0] || "",
            "wav",
            firstController.signal
        );
        controllersBySession.get(mySessionId)?.delete(firstController);
        if (activeSessionId !== mySessionId) {
            // Session was cancelled; do not enqueue
            return { provider: "openai", chunks: chunks.length };
        }
        const firstBuf = Array.from(new Uint8Array(firstBufAB));
        await sendToOffscreen({
            type: "queue_append_audio",
            payload: { buffer: firstBuf, mime: "audio/wav" },
        });
        await sendToOffscreen({ type: "queue_play" });

        // Pipeline remaining chunks with limited concurrency
        const CONCURRENCY = 3;
        let inFlight = 0;
        let nextIndex = 1;
        const total = chunks.length;

        const launch = () => {
            while (inFlight < CONCURRENCY && nextIndex < total) {
                const idx = nextIndex++;
                inFlight++;
                const controller = new AbortController();
                controllersBySession.get(mySessionId)?.add(controller);
                fetchOpenAISpeech(
                    openaiApiKey,
                    openaiModel,
                    voiceOverride || openaiVoice,
                    chunks[idx],
                    "mp3",
                    controller.signal
                )
                    .then((ab) => {
                        controllersBySession
                            .get(mySessionId)
                            ?.delete(controller);
                        if (activeSessionId !== mySessionId) return;
                        const b = Array.from(new Uint8Array(ab));
                        return sendToOffscreen({
                            type: "queue_append_audio",
                            payload: { buffer: b, mime: "audio/mpeg" },
                        });
                    })
                    .catch(() => {})
                    .finally(() => {
                        inFlight--;
                        launch();
                    });
            }
        };
        launch(); // fire-and-forget

        // Return immediately after starting playback
        return { provider: "openai", chunks: chunks.length };
    } catch (e) {
        // Fallback to Web Speech if offscreen messaging/audio queue fails
        await sendToOffscreen({ type: "stop" }).catch(() => {});
        await sendToOffscreen({
            type: "webspeech_start",
            payload: { text },
        }).catch(() => {});
        currentSession = { voice: null, model: null, provider: "webspeech" };
        return { provider: "webspeech", chunks: 1 };
    }
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
                const res = await startReadingCurrentPage(
                    message?.provider,
                    message?.openaiVoice
                );
                sendResponse({ ok: true, ...res });
                return;
            }
            if (message?.type === "pause") {
                await ensureOffscreenDocument();
                await sendToOffscreen({ type: "pause" });
                sendResponse({ ok: true });
                return;
            }
            if (message?.type === "resume") {
                await ensureOffscreenDocument();
                await sendToOffscreen({ type: "resume" });
                sendResponse({ ok: true });
                return;
            }
            if (message?.type === "stop") {
                // Cancel all in-flight TTS requests and prevent further queueing
                cancelActiveSession();
                await ensureOffscreenDocument();
                await sendToOffscreen({ type: "stop" });
                sendResponse({ ok: true });
                return;
            }
            if (message?.type === "get_status") {
                await ensureOffscreenDocument();
                const res = await sendToOffscreen({ type: "get_status" });
                if (res?.ok) {
                    sendResponse({
                        ...res,
                        voice: currentSession.voice,
                        model: currentSession.model,
                        providerUsed: currentSession.provider,
                    });
                } else {
                    sendResponse(res);
                }
                return;
            }
        } catch (e) {
            sendResponse({ ok: false, error: e?.message || String(e) });
        }
    })();
    return true; // keep port open for async
});
