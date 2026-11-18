// ==UserScript==
// @name         Study Buddy
// @description  Tap the green button to have Claude watch the page. It rings the correct option of visible questions and explains why in a small bubble.
// @version      1.0.0
// @match        *://*/*
// @exclude      *://*.anthropic.com/*
// @grant        GM.xmlHttpRequest
// @grant        GM.getValue
// @grant        GM.setValue
// @inject-into  content
// @run-at       document-idle
// @noframes
// ==/UserScript==

// iPad / iPhone version of the Study Buddy extension, for the free "Userscripts"
// Safari extension (App Store). It does the same job as extension/content.js +
// src/background.js, but runs entirely in the page, so it needs no Mac or Xcode.
// Calls go through GM.xmlHttpRequest (the Userscripts extension makes the request),
// so the page's own scripts never see your API key.

(async () => {
  if (window.__studyBuddyLoaded) return;
  window.__studyBuddyLoaded = true;

  const ID_ATTR = "data-sb-id";
  const MAX_ELEMENTS = 300;
  const MAX_TEXT = 300;
  const DEBOUNCE_MS = 1500;
  const WATCH_KEY = "studyBuddyWatching"; // sessionStorage: stays on for this tab + site

  const DEFAULTS = { apiKey: "", model: "claude-opus-5-5", effort: "medium" };
  const settings = { ...DEFAULTS };
  for (const k of Object.keys(DEFAULTS)) settings[k] = await GM.getValue(k, DEFAULTS[k]);

  const OPTION_SELECTOR =
    "label,li,button,td,option,[role=radio],[role=checkbox],[role=option],[role=menuitemradio],[role=button]";

  const SYSTEM_PROMPT = `You are a study helper looking at the user's browser tab with them.

You receive a list of the page elements currently visible on screen, each written as [id] text.

Find every question that is visible right now: multiple choice, true/false, select-all-that-apply, or a short question with a clear answer. For each one:
- Work out the correct answer yourself. Do not assume any option is already selected correctly.
- Set answer_element_id to the id of the element that holds the correct option. If several options are correct (select all that apply), add one entry per correct option, repeating the question.
- Set question_element_id to the id of the element holding the question text when you can tell.
- Keep the explanation to one or two plain sentences that teach the idea, not just restate the answer.
- Use "low" confidence when the question is ambiguous, depends on course material you cannot see, or is cut off.

If no questions are visible, return an empty list. Only use ids that appear in the element list.`;

  const OUTPUT_FORMAT = {
    type: "json_schema",
    schema: {
      type: "object",
      properties: {
        questions: {
          type: "array",
          items: {
            type: "object",
            properties: {
              question: { type: "string" },
              question_element_id: { type: ["string", "null"] },
              answer_element_id: { type: ["string", "null"] },
              answer_text: { type: "string" },
              explanation: { type: "string" },
              confidence: { enum: ["high", "medium", "low"] },
            },
            additionalProperties: false,
            required: ["question", "question_element_id", "answer_element_id", "answer_text", "explanation", "confidence"],
          },
        },
      },
      additionalProperties: false,
      required: ["questions"],
    },
  };

  let watching = false;
  let inFlight = false;
  let pending = false;
  let lastFingerprint = "";
  let debounceTimer = null;
  let nextId = 1;
  let observer = null;
  let results = [];

  // ---------- Overlay (shadow DOM so page styles can't break it) ----------
  const host = document.createElement("div");
  host.setAttribute("data-study-buddy", "");
  host.style.cssText = "all: initial; position: fixed; inset: 0; pointer-events: none; z-index: 2147483647;";
  const shadow = host.attachShadow({ mode: "closed" });
  shadow.innerHTML = `
    <style>
      :host { --accent: #16a34a; --bg: #ffffff; --fg: #1f2937; --muted: #6b7280; --border: #e5e7eb; --field: #f9fafb; }
      @media (prefers-color-scheme: dark) {
        :host { --accent: #4ade80; --bg: #1f2937; --fg: #f3f4f6; --muted: #9ca3af; --border: #374151; --field: #111827; }
      }
      * { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
      .ring {
        position: fixed; border: 3px solid var(--accent); border-radius: 8px;
        background: color-mix(in srgb, var(--accent) 12%, transparent); pointer-events: none;
      }
      .ring.low { border-style: dashed; }
      .bubble {
        position: fixed; max-width: min(300px, calc(100vw - 16px)); min-width: 180px; padding: 10px 12px;
        background: var(--bg); color: var(--fg); border: 1px solid var(--border);
        border-left: 4px solid var(--accent); border-radius: 12px;
        box-shadow: 0 8px 24px rgba(0,0,0,.18); font-size: 14px; line-height: 1.4; pointer-events: auto;
      }
      .bubble .head { display: flex; align-items: baseline; gap: 6px; margin-bottom: 4px; padding-right: 22px; flex-wrap: wrap; }
      .bubble .answer { font-weight: 600; }
      .bubble .conf { font-size: 12px; color: var(--muted); }
      .bubble .close {
        position: absolute; top: 2px; right: 4px; border: 0; background: none; color: var(--muted);
        font-size: 20px; line-height: 1; padding: 6px; cursor: pointer;
      }
      .dock {
        position: fixed; right: 12px; bottom: 76px; display: flex; flex-direction: column; gap: 8px;
        max-height: 55vh; overflow-y: auto; pointer-events: auto;
      }
      .dock .bubble { position: static; }
      .bar {
        position: fixed; right: 12px; bottom: 16px; display: flex; gap: 6px; align-items: center; pointer-events: auto;
      }
      .pill, .gear {
        border: 1px solid var(--border); background: var(--bg); color: var(--fg);
        box-shadow: 0 4px 12px rgba(0,0,0,.15); font-size: 14px; border-radius: 999px; cursor: pointer;
        min-height: 44px; display: flex; align-items: center; gap: 8px;
      }
      .pill { padding: 0 16px; max-width: 70vw; }
      .pill .label { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .gear { width: 44px; justify-content: center; font-size: 18px; }
      .dot { width: 10px; height: 10px; border-radius: 50%; background: var(--muted); flex: none; }
      .pill.on .dot { background: var(--accent); }
      .pill.busy .dot { background: var(--accent); animation: pulse 1s infinite; }
      .pill.error .dot { background: #dc2626; }
      @keyframes pulse { 50% { opacity: .3; } }
      .panel {
        position: fixed; right: 12px; bottom: 72px; width: min(320px, calc(100vw - 24px)); padding: 14px;
        background: var(--bg); color: var(--fg); border: 1px solid var(--border); border-radius: 14px;
        box-shadow: 0 8px 24px rgba(0,0,0,.2); font-size: 14px; pointer-events: auto; display: none;
      }
      .panel.open { display: block; }
      .panel h2 { font-size: 16px; margin: 0 0 10px; }
      .panel label { display: block; margin-bottom: 10px; }
      .panel input, .panel select {
        display: block; width: 100%; margin-top: 4px; padding: 8px; border-radius: 8px; font-size: 16px;
        border: 1px solid var(--border); background: var(--field); color: var(--fg);
      }
      .panel button {
        width: 100%; min-height: 40px; border: 0; border-radius: 8px; background: var(--accent);
        color: #fff; font-size: 15px; font-weight: 600; cursor: pointer;
      }
      .panel .hint { color: var(--muted); font-size: 12px; margin: 8px 0 0; }
    </style>
    <div class="layer"></div>
    <div class="dock"></div>
    <div class="panel">
      <h2>Study Buddy settings</h2>
      <label>Anthropic API key <input type="password" class="key" placeholder="sk-ant-…" autocomplete="off" autocapitalize="off" spellcheck="false"></label>
      <label>Model
        <select class="model">
          <option value="claude-opus-5-5">Claude Opus 5.5 (most accurate)</option>
          <option value="claude-sonnet-5-5">Claude Sonnet 5.5 (faster, cheaper)</option>
          <option value="claude-haiku-5-5">Claude Haiku 5.5 (fastest, cheapest)</option>
        </select>
      </label>
      <label>Effort
        <select class="effort">
          <option value="low">Low (quickest)</option>
          <option value="medium">Medium</option>
          <option value="high">High (most careful)</option>
        </select>
      </label>
      <button class="save">Save</button>
      <p class="hint">Your key is stored only in the Userscripts extension on this device.</p>
    </div>
    <div class="bar">
      <button class="gear" title="Settings">⚙︎</button>
      <button class="pill"><span class="dot"></span><span class="label">Study Buddy</span></button>
    </div>
  `;
  const $ = (sel) => shadow.querySelector(sel);
  const layer = $(".layer");
  const dock = $(".dock");
  const pill = $(".pill");
  const pillLabel = $(".pill .label");
  const panel = $(".panel");

  $(".gear").addEventListener("click", () => {
    $(".key").value = settings.apiKey;
    $(".model").value = settings.model;
    $(".effort").value = settings.effort;
    panel.classList.toggle("open");
  });
  $(".save").addEventListener("click", async () => {
    settings.apiKey = $(".key").value.trim();
    settings.model = $(".model").value;
    settings.effort = $(".effort").value;
    for (const k of Object.keys(DEFAULTS)) await GM.setValue(k, settings[k]);
    panel.classList.remove("open");
    setStatus(watching ? "Watching" : "Study Buddy", watching ? "on" : "");
    if (watching) analyzeNow({ force: true });
  });
  pill.addEventListener("click", () => setWatching(!watching));

  document.documentElement.appendChild(host);

  function setStatus(text, kind = "") {
    pill.className = `pill ${kind}`;
    pillLabel.textContent = text;
  }

  // ---------- Collect what's on screen ----------
  function isVisible(el) {
    const rect = el.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return false;
    if (rect.bottom < 0 || rect.top > innerHeight || rect.right < 0 || rect.left > innerWidth) return false;
    const style = getComputedStyle(el);
    return style.visibility !== "hidden" && style.display !== "none" && Number(style.opacity) > 0.05;
  }

  function idFor(el) {
    let id = el.getAttribute(ID_ATTR);
    if (!id) {
      id = `e${nextId++}`;
      el.setAttribute(ID_ATTR, id);
    }
    return id;
  }

  function textOf(el) {
    let text = (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
    if (!text && el.labels?.length) text = el.labels[0].innerText.trim();
    if (!text) text = (el.getAttribute("aria-label") || "").trim();
    return text.slice(0, MAX_TEXT);
  }

  function collectElements() {
    const seen = new Set();
    const out = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
        const parent = node.parentElement;
        if (!parent || parent.closest("script,style,noscript,[data-study-buddy]")) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    let node;
    while ((node = walker.nextNode()) && out.length < MAX_ELEMENTS) {
      const parent = node.parentElement;
      let el = parent.closest(OPTION_SELECTOR) || parent;
      if (el === document.body || el === document.documentElement) el = parent;
      if (seen.has(el)) continue;
      seen.add(el);
      if (!isVisible(el)) continue;
      const text = textOf(el);
      if (text) out.push({ id: idFor(el), text });
    }
    return out;
  }

  // ---------- Claude API ----------
  function post(url, headers, body) {
    return new Promise((resolve, reject) => {
      GM.xmlHttpRequest({
        method: "POST",
        url,
        headers,
        data: JSON.stringify(body),
        onload: (res) => resolve({ status: res.status, text: res.responseText ?? res.response }),
        onerror: () => reject(new Error("Couldn't reach the Claude API. Check your connection.")),
        ontimeout: () => reject(new Error("The Claude API took too long to answer.")),
      });
    });
  }

  async function askClaude(elements) {
    const elementList = elements.map((e) => `[${e.id}] ${e.text}`).join("\n");
    const { status, text } = await post(
      "https://api.anthropic.com/v1/messages",
      {
        "content-type": "application/json",
        "x-api-key": settings.apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "server-side-fallback-2026-07-01",
      },
      {
        model: settings.model,
        max_tokens: 16000,
        fallbacks: "default",
        system: SYSTEM_PROMPT,
        output_config: { effort: settings.effort, format: OUTPUT_FORMAT },
        messages: [
          {
            role: "user",
            content: `Page: ${document.title}\nURL: ${location.href}\n\nVisible elements:\n${elementList}`,
          },
        ],
      },
    );

    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(`Unexpected reply from the API (HTTP ${status}).`);
    }
    if (status === 401) throw new Error("Your API key was rejected. Tap ⚙︎ to check it.");
    if (status === 429) throw new Error("Rate limited. Will try again on the next change.");
    if (status >= 400) throw new Error(data?.error?.message || `Claude API error (HTTP ${status}).`);
    if (data.stop_reason === "refusal") throw new Error("Claude declined to answer this page.");
    if (data.stop_reason === "max_tokens") throw new Error("Answer was cut off. Scroll so fewer questions are visible.");

    const block = data.content?.find((b) => b.type === "text");
    const parsed = block ? JSON.parse(block.text) : { questions: [] };
    const validIds = new Set(elements.map((e) => e.id));
    return parsed.questions.map((q) => ({
      ...q,
      answer_element_id: validIds.has(q.answer_element_id) ? q.answer_element_id : null,
    }));
  }

  async function analyzeNow({ force = false } = {}) {
    if (!watching) return;
    if (!settings.apiKey) {
      setStatus("Tap ⚙︎ to add your API key", "error");
      panel.classList.add("open");
      return;
    }
    if (inFlight) {
      pending = true;
      return;
    }
    const elements = collectElements();
    const fingerprint = elements.map((e) => e.text).join("␞");
    if (!force && fingerprint === lastFingerprint) {
      layout();
      return;
    }
    lastFingerprint = fingerprint;
    if (!elements.length) return;

    inFlight = true;
    setStatus("Thinking…", "busy");
    try {
      const questions = await askClaude(elements);
      if (!watching) return;
      showResults(questions);
      const n = questions.length;
      setStatus(n ? `Watching · ${n} answer${n === 1 ? "" : "s"}` : "Watching · no questions seen", "on");
    } catch (err) {
      setStatus(err?.message ?? String(err), "error");
      lastFingerprint = ""; // allow a retry on the next change
    } finally {
      inFlight = false;
      if (pending && watching) {
        pending = false;
        schedule();
      }
    }
  }

  function schedule() {
    if (!watching) return;
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => analyzeNow(), DEBOUNCE_MS);
  }

  // ---------- Draw bubbles ----------
  function make(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }

  function makeBubble(q, onClose) {
    const bubble = make("div", "bubble");
    const head = make("div", "head");
    head.append(make("span", "answer", `✓ ${q.answer_text}`), make("span", "conf", `${q.confidence} confidence`));
    const close = make("button", "close", "×");
    close.addEventListener("click", onClose);
    bubble.append(close, head, make("div", "why", q.explanation));
    return bubble;
  }

  function clearResults() {
    results = [];
    layer.replaceChildren();
    dock.replaceChildren();
  }

  function showResults(questions) {
    clearResults();
    for (const q of questions) {
      const answerEl = q.answer_element_id ? document.querySelector(`[${ID_ATTR}="${q.answer_element_id}"]`) : null;
      const entry = { q, answerEl, ring: null, bubble: null };
      entry.bubble = makeBubble(q, () => {
        entry.bubble.remove();
        entry.ring?.remove();
        results = results.filter((r) => r !== entry);
      });
      if (answerEl) {
        entry.ring = make("div", `ring ${q.confidence === "low" ? "low" : ""}`);
        layer.append(entry.ring, entry.bubble);
      } else {
        dock.append(entry.bubble);
      }
      results.push(entry);
    }
    layout();
  }

  function layout() {
    const placed = [];
    for (const r of results) {
      if (!r.answerEl || !r.ring) continue;
      const rect = r.answerEl.getBoundingClientRect();
      const offscreen = rect.bottom < 0 || rect.top > innerHeight || !r.answerEl.isConnected;
      r.ring.style.display = r.bubble.style.display = offscreen ? "none" : "";
      if (offscreen) continue;

      const pad = 4;
      Object.assign(r.ring.style, {
        left: `${rect.left - pad}px`,
        top: `${rect.top - pad}px`,
        width: `${rect.width + pad * 2}px`,
        height: `${rect.height + pad * 2}px`,
      });

      const bw = r.bubble.offsetWidth || 260;
      const bh = r.bubble.offsetHeight || 80;
      let left = rect.right + 12;
      let top = rect.top;
      if (left + bw > innerWidth - 8) {
        left = Math.max(8, Math.min(rect.left, innerWidth - bw - 8));
        top = rect.bottom + 8;
      }
      for (const p of placed) {
        if (left < p.left + p.w && left + bw > p.left && top < p.top + p.h && top + bh > p.top) {
          top = p.top + p.h + 6;
        }
      }
      top = Math.max(8, Math.min(top, innerHeight - bh - 8));
      r.bubble.style.left = `${left}px`;
      r.bubble.style.top = `${top}px`;
      placed.push({ left, top, w: bw, h: bh });
    }
  }

  let rafQueued = false;
  function onScrollOrResize() {
    if (!rafQueued) {
      rafQueued = true;
      requestAnimationFrame(() => {
        rafQueued = false;
        layout();
      });
    }
    schedule();
  }

  // ---------- Watch on/off ----------
  function setWatching(on) {
    if (on === watching) return;
    watching = on;
    try {
      on ? sessionStorage.setItem(WATCH_KEY, "1") : sessionStorage.removeItem(WATCH_KEY);
    } catch {}
    if (on) {
      setStatus("Watching", "on");
      observer = new MutationObserver((mutations) => {
        if (mutations.every((m) => m.target === host || host.contains(m.target))) return;
        schedule();
      });
      observer.observe(document.body, { childList: true, subtree: true, characterData: true });
      addEventListener("scroll", onScrollOrResize, { passive: true, capture: true });
      addEventListener("resize", onScrollOrResize, { passive: true });
      lastFingerprint = "";
      analyzeNow({ force: true });
    } else {
      observer?.disconnect();
      observer = null;
      clearTimeout(debounceTimer);
      removeEventListener("scroll", onScrollOrResize, { capture: true });
      removeEventListener("resize", onScrollOrResize);
      clearResults();
      setStatus("Study Buddy", "");
    }
  }

  // Stay on after a reload or when the quiz moves to its next page.
  let resume = false;
  try {
    resume = sessionStorage.getItem(WATCH_KEY) === "1";
  } catch {}
  if (resume) setWatching(true);
})();
