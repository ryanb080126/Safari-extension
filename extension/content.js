// Content script: while watching is on, it collects the visible page elements,
// asks the background script for answers, and draws highlight + chat bubbles.
(() => {
  if (window.__studyBuddyLoaded) return;
  window.__studyBuddyLoaded = true;

  const api = globalThis.browser ?? globalThis.chrome;
  const ID_ATTR = "data-sb-id";
  const MAX_ELEMENTS = 300;
  const MAX_TEXT = 300;
  const DEBOUNCE_MS = 1500;

  const OPTION_SELECTOR = [
    "label",
    "li",
    "button",
    "td",
    "option",
    "[role=radio]",
    "[role=checkbox]",
    "[role=option]",
    "[role=menuitemradio]",
    "[role=button]",
  ].join(",");

  let watching = false;
  let inFlight = false;
  let pending = false;
  let lastFingerprint = "";
  let debounceTimer = null;
  let nextId = 1;
  let observer = null;
  let results = []; // [{ q, answerEl, questionEl }]

  // ---------- Overlay (shadow DOM so page styles can't break it) ----------
  const host = document.createElement("div");
  host.setAttribute("data-study-buddy", "");
  host.style.cssText = "all: initial; position: fixed; inset: 0; pointer-events: none; z-index: 2147483647;";
  const shadow = host.attachShadow({ mode: "open" });
  shadow.innerHTML = `
    <style>
      :host { --accent: #16a34a; --bg: #ffffff; --fg: #1f2937; --muted: #6b7280; --border: #e5e7eb; }
      @media (prefers-color-scheme: dark) {
        :host { --accent: #4ade80; --bg: #1f2937; --fg: #f3f4f6; --muted: #9ca3af; --border: #374151; }
      }
      * { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
      .ring {
        position: fixed; border: 3px solid var(--accent); border-radius: 8px;
        background: color-mix(in srgb, var(--accent) 12%, transparent);
        pointer-events: none; transition: all .15s ease;
      }
      .ring.low { border-style: dashed; }
      .bubble {
        position: fixed; max-width: 300px; min-width: 180px; padding: 10px 12px 10px 12px;
        background: var(--bg); color: var(--fg); border: 1px solid var(--border);
        border-left: 4px solid var(--accent); border-radius: 12px;
        box-shadow: 0 8px 24px rgba(0,0,0,.18); font-size: 13px; line-height: 1.4;
        pointer-events: auto;
      }
      .bubble .head { display: flex; align-items: baseline; gap: 6px; margin-bottom: 4px; padding-right: 16px; }
      .bubble .answer { font-weight: 600; }
      .bubble .conf { font-size: 11px; color: var(--muted); white-space: nowrap; }
      .bubble .why { color: var(--fg); opacity: .9; }
      .bubble .close {
        position: absolute; top: 4px; right: 6px; border: 0; background: none; color: var(--muted);
        font-size: 16px; cursor: pointer; line-height: 1; padding: 2px;
      }
      .dock {
        position: fixed; right: 16px; bottom: 64px; display: flex; flex-direction: column; gap: 8px;
        max-height: 60vh; overflow-y: auto; pointer-events: auto;
      }
      .dock .bubble { position: static; }
      .pill {
        position: fixed; right: 16px; bottom: 16px; padding: 6px 12px; border-radius: 999px;
        background: var(--bg); color: var(--fg); border: 1px solid var(--border);
        box-shadow: 0 4px 12px rgba(0,0,0,.15); font-size: 12px; pointer-events: auto;
        display: none; align-items: center; gap: 6px; cursor: pointer;
      }
      .pill .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--accent); }
      .pill.busy .dot { animation: pulse 1s infinite; }
      .pill.error .dot { background: #dc2626; }
      @keyframes pulse { 50% { opacity: .3; } }
    </style>
    <div class="layer"></div>
    <div class="dock"></div>
    <div class="pill" title="Click to stop watching"><span class="dot"></span><span class="label">Watching</span></div>
  `;
  const layer = shadow.querySelector(".layer");
  const dock = shadow.querySelector(".dock");
  const pill = shadow.querySelector(".pill");
  const pillLabel = shadow.querySelector(".pill .label");
  pill.addEventListener("click", () => {
    api.runtime.sendMessage({ type: "set-watching-self", watching: false }).catch(() => {});
    setWatching(false);
  });

  function mountOverlay() {
    if (!host.isConnected) document.documentElement.appendChild(host);
  }

  function setStatus(text, kind = "") {
    pill.style.display = watching ? "flex" : "none";
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
    // Radio/checkbox inputs often have their option text in an associated label.
    if (!text && el.labels?.length) text = el.labels[0].innerText.trim();
    if (!text && el.getAttribute) text = (el.getAttribute("aria-label") || "").trim();
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
      // Prefer the clickable option container (label, li, role=radio...) so the
      // highlight wraps the whole choice instead of one word inside it.
      let el = parent.closest(OPTION_SELECTOR) || parent;
      if (el === document.body || el === document.documentElement) el = parent;
      if (seen.has(el)) continue;
      seen.add(el);
      if (!isVisible(el)) continue;
      const text = textOf(el);
      if (!text) continue;
      out.push({ id: idFor(el), text });
    }
    return out;
  }

  // ---------- Talk to the background script ----------
  async function analyzeNow({ force = false } = {}) {
    if (!watching) return;
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
      const reply = await api.runtime.sendMessage({
        type: "analyze",
        elements,
        url: location.href,
        title: document.title,
      });
      if (!watching) return;
      if (reply?.error) {
        setStatus(reply.error, "error");
        lastFingerprint = ""; // allow a retry on the next change
        return;
      }
      showResults(reply?.questions ?? []);
      const n = reply?.questions?.length ?? 0;
      setStatus(n ? `Watching · ${n} answer${n === 1 ? "" : "s"}` : "Watching · no questions seen");
    } catch (err) {
      setStatus(`Error: ${err?.message ?? err}`, "error");
      lastFingerprint = "";
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
  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }

  function makeBubble(q, onClose) {
    const bubble = el("div", "bubble");
    const head = el("div", "head");
    head.append(el("span", "answer", `✓ ${q.answer_text}`), el("span", "conf", `${q.confidence} confidence`));
    const close = el("button", "close", "×");
    close.title = "Dismiss";
    close.addEventListener("click", onClose);
    bubble.append(close, head, el("div", "why", q.explanation));
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
        entry.ring = el("div", `ring ${q.confidence === "low" ? "low" : ""}`);
        layer.append(entry.ring, entry.bubble);
      } else {
        dock.append(entry.bubble); // no element to point at: show in the corner
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
        // Not enough room to the right: put it below the option instead.
        left = Math.max(8, Math.min(rect.left, innerWidth - bw - 8));
        top = rect.bottom + 8;
      }
      // Nudge down so bubbles don't stack on top of each other.
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
    schedule(); // new content may have scrolled into view
  }

  // ---------- Watch on/off ----------
  function setWatching(on) {
    if (on === watching) return;
    watching = on;
    if (on) {
      mountOverlay();
      setStatus("Watching", "");
      observer = new MutationObserver((mutations) => {
        if (mutations.every((m) => host.contains(m.target) || m.target === host)) return;
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
      setStatus("");
      host.remove();
    }
  }

  api.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "set-watching") {
      setWatching(Boolean(message.watching));
      sendResponse({ ok: true });
    } else if (message?.type === "analyze-now") {
      if (!watching) setWatching(true);
      else analyzeNow({ force: true });
      sendResponse({ ok: true });
    }
  });

  // Resume if this tab was being watched before a reload / navigation.
  api.runtime
    .sendMessage({ type: "am-i-watching" })
    .then((reply) => reply?.watching && setWatching(true))
    .catch(() => {});
})();
