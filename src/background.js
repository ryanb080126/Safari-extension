// Background script: owns the API key, takes screenshots, and calls Claude.
// The content script sends it the visible page elements; it replies with answers.

import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod/v4";

const api = globalThis.browser ?? globalThis.chrome;

const DEFAULT_SETTINGS = {
  apiKey: "",
  model: "claude-opus-5-5",
  effort: "medium",
  useScreenshot: true,
};

const AnswerSchema = z.object({
  questions: z.array(
    z.object({
      question: z.string().describe("Short restatement of the question"),
      question_element_id: z
        .string()
        .nullable()
        .describe("id of the element holding the question text, or null"),
      answer_element_id: z
        .string()
        .nullable()
        .describe("id of the element for the correct option, or null if no element matches"),
      answer_text: z.string().describe("The correct answer, e.g. 'B) Mitochondria'"),
      explanation: z.string().describe("One or two sentences explaining why"),
      confidence: z.enum(["high", "medium", "low"]),
    }),
  ),
});

const SYSTEM_PROMPT = `You are a study helper looking at the user's browser tab with them.

You receive (1) a screenshot of what is currently visible, when available, and (2) a list of the visible page elements, each written as [id] text.

Find every question that is visible right now: multiple choice, true/false, select-all-that-apply, or a short question with a clear answer. For each one:
- Work out the correct answer yourself. Do not assume any option is already selected correctly.
- Set answer_element_id to the id of the element that holds the correct option. If several options are correct (select all that apply), add one entry per correct option, repeating the question.
- Set question_element_id to the id of the element holding the question text when you can tell.
- Keep the explanation to one or two plain sentences that teach the idea, not just restate the answer.
- Use "low" confidence when the question is ambiguous, depends on course material you cannot see, or is cut off.

If no questions are visible, return an empty list. Only use ids that appear in the element list.`;

async function getSettings() {
  const stored = await api.storage.local.get(Object.keys(DEFAULT_SETTINGS));
  return { ...DEFAULT_SETTINGS, ...stored };
}

async function captureScreenshot(tab) {
  if (!tab?.active) return null;
  try {
    const dataUrl = await api.tabs.captureVisibleTab(tab.windowId, {
      format: "jpeg",
      quality: 70,
    });
    return dataUrl.replace(/^data:image\/jpeg;base64,/, "");
  } catch (err) {
    console.warn("Screenshot failed, continuing with page text only:", err);
    return null;
  }
}

function friendlyError(err) {
  if (err instanceof Anthropic.AuthenticationError) {
    return "Your API key was rejected. Check it in the extension popup.";
  }
  if (err instanceof Anthropic.RateLimitError) {
    return "Rate limited by the API. Waiting a moment before trying again.";
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return "Couldn't reach the Claude API. Check your connection.";
  }
  if (err instanceof Anthropic.APIError) {
    return `Claude API error (${err.status ?? "unknown"}): ${err.message}`;
  }
  return err?.message ?? String(err);
}

async function analyze({ elements, url, title }, tab) {
  const settings = await getSettings();
  if (!settings.apiKey) {
    return { error: "Add your Anthropic API key in the extension popup first." };
  }

  const client = new Anthropic({
    apiKey: settings.apiKey,
    // The key is the user's own, stored only in this extension's local storage.
    dangerouslyAllowBrowser: true,
  });

  const screenshot = settings.useScreenshot ? await captureScreenshot(tab) : null;

  const elementList = elements.map((e) => `[${e.id}] ${e.text}`).join("\n");
  const content = [];
  if (screenshot) {
    content.push({
      type: "image",
      source: { type: "base64", media_type: "image/jpeg", data: screenshot },
    });
  }
  content.push({
    type: "text",
    text: `Page: ${title}\nURL: ${url}\n\nVisible elements:\n${elementList}`,
  });

  try {
    const response = await client.beta.messages.parse({
      model: settings.model,
      max_tokens: 16000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system: SYSTEM_PROMPT,
      output_config: {
        effort: settings.effort,
        format: betaZodOutputFormat(AnswerSchema),
      },
      messages: [{ role: "user", content }],
    });

    if (response.stop_reason === "refusal") {
      return { error: "Claude declined to answer this page." };
    }
    if (response.stop_reason === "max_tokens") {
      return { error: "The response was cut off. Try scrolling so fewer questions are visible." };
    }
    const parsed = response.parsed_output;
    if (!parsed) return { error: "Couldn't read Claude's response. Trying again on the next change." };

    const validIds = new Set(elements.map((e) => e.id));
    const questions = parsed.questions.map((q) => ({
      ...q,
      answer_element_id: validIds.has(q.answer_element_id) ? q.answer_element_id : null,
      question_element_id: validIds.has(q.question_element_id) ? q.question_element_id : null,
    }));
    return { questions };
  } catch (err) {
    console.error("Claude request failed:", err);
    return { error: friendlyError(err) };
  }
}

// Which tabs are being watched survives page reloads inside the same session.
async function getWatchedTabs() {
  const area = api.storage.session ?? api.storage.local;
  const { watchedTabs = [] } = await area.get("watchedTabs");
  return { area, watchedTabs };
}

async function setWatching(tabId, watching) {
  const { area, watchedTabs } = await getWatchedTabs();
  const next = new Set(watchedTabs);
  if (watching) next.add(tabId);
  else next.delete(tabId);
  await area.set({ watchedTabs: [...next] });
  try {
    await api.tabs.sendMessage(tabId, { type: "set-watching", watching });
  } catch {
    // Content script not loaded on this page (e.g. a browser settings page).
  }
  api.action.setBadgeText({ tabId, text: watching ? "ON" : "" });
  return watching;
}

async function isWatching(tabId) {
  const { watchedTabs } = await getWatchedTabs();
  return watchedTabs.includes(tabId);
}

api.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    switch (message?.type) {
      case "analyze":
        return analyze(message, sender.tab);
      case "am-i-watching":
        return { watching: sender.tab ? await isWatching(sender.tab.id) : false };
      case "get-watching":
        return { watching: await isWatching(message.tabId) };
      case "set-watching":
        return { watching: await setWatching(message.tabId, message.watching) };
      case "set-watching-self":
        if (!sender.tab) return undefined;
        return { watching: await setWatching(sender.tab.id, message.watching) };
      default:
        return undefined;
    }
  })().then(sendResponse, (err) => sendResponse({ error: String(err) }));
  return true; // keep the channel open for the async reply
});

api.tabs.onRemoved.addListener(async (tabId) => {
  const { area, watchedTabs } = await getWatchedTabs();
  if (watchedTabs.includes(tabId)) {
    await area.set({ watchedTabs: watchedTabs.filter((id) => id !== tabId) });
  }
});

api.commands?.onCommand.addListener(async (command) => {
  if (command !== "toggle-watch") return;
  const [tab] = await api.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;
  await setWatching(tab.id, !(await isWatching(tab.id)));
});
