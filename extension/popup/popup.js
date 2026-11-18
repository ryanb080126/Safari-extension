const api = globalThis.browser ?? globalThis.chrome;
const $ = (id) => document.getElementById(id);

const DEFAULTS = { apiKey: "", workspaceId: "", model: "claude-opus-5-5", effort: "medium", useScreenshot: true };

async function currentTab() {
  const [tab] = await api.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function showStatus(text, isError = false) {
  $("status").textContent = text;
  $("status").classList.toggle("error", isError);
}

async function init() {
  const settings = { ...DEFAULTS, ...(await api.storage.local.get(Object.keys(DEFAULTS))) };
  $("apiKey").value = settings.apiKey;
  $("workspaceId").value = settings.workspaceId;
  $("model").value = settings.model;
  $("effort").value = settings.effort;
  $("useScreenshot").checked = settings.useScreenshot;
  if (!settings.apiKey) $("settings").open = true;

  const tab = await currentTab();
  if (!tab) return;
  const { watching } = await api.runtime.sendMessage({ type: "get-watching", tabId: tab.id });
  $("watch").checked = watching;
  showStatus(watching ? "Watching this tab." : "Off for this tab.");
  if (!settings.apiKey) showStatus("Add your API key below to get started.", true);
}

$("watch").addEventListener("change", async (e) => {
  const tab = await currentTab();
  if (!tab) return;
  const { watching } = await api.runtime.sendMessage({
    type: "set-watching",
    tabId: tab.id,
    watching: e.target.checked,
  });
  showStatus(watching ? "Watching this tab." : "Off for this tab.");
});

$("analyze").addEventListener("click", async () => {
  const tab = await currentTab();
  if (!tab) return;
  await api.runtime.sendMessage({ type: "set-watching", tabId: tab.id, watching: true });
  try {
    await api.tabs.sendMessage(tab.id, { type: "analyze-now" });
    $("watch").checked = true;
    showStatus("Checking this page…");
  } catch {
    showStatus("This page can't be read by extensions (try reloading it).", true);
  }
});

$("save").addEventListener("click", async () => {
  await api.storage.local.set({
    apiKey: $("apiKey").value.replace(/\s+/g, ""),
    workspaceId: $("workspaceId").value.trim(),
    model: $("model").value,
    effort: $("effort").value,
    useScreenshot: $("useScreenshot").checked,
  });
  $("saved").textContent = "Saved.";
  setTimeout(() => ($("saved").textContent = ""), 1500);
});

init();
