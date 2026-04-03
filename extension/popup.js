const statusNode = document.getElementById("status");
const slotsNode = document.getElementById("slots");

document.getElementById("set-previous").addEventListener("click", () => captureCurrentTab("previous"));
document.getElementById("set-updated").addEventListener("click", () => captureCurrentTab("updated"));
document.getElementById("generate-report").addEventListener("click", generateReport);
document.getElementById("open-settings").addEventListener("click", () => chrome.runtime.openOptionsPage());

refreshSlotState();

async function captureCurrentTab(slot) {
  try {
    setStatus("Reading the current Optibus tab...");
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) {
      throw new Error("Could not find the active tab.");
    }

    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: extractVisibleStructuredText,
    });

    if (!result?.text) {
      throw new Error("Could not find visible JSON or YAML on this page.");
    }

    await chrome.storage.local.set({
      [slot]: {
        text: result.text,
        sourceUrl: tab.url || "",
        sourceTitle: tab.title || "",
        savedAt: new Date().toISOString(),
      },
    });

    refreshSlotState();
    setStatus(`Saved the current page as ${slot}.`, "success");
  } catch (error) {
    setStatus(error.message, "error");
  }
}

async function generateReport() {
  try {
    const { previous, updated } = await chrome.storage.local.get(["previous", "updated"]);
    if (!previous?.text || !updated?.text) {
      throw new Error("Please set both Previous and Updated before generating the report.");
    }

    const { apiBaseUrl } = await chrome.storage.sync.get(["apiBaseUrl"]);
    if (!apiBaseUrl) {
      throw new Error("Backend URL is not set. Click Open Settings and paste your deployed API URL.");
    }

    setStatus("Generating the PDF report...");
    const response = await fetch(`${trimTrailingSlash(apiBaseUrl)}/api/report`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        previous_text: previous.text,
        updated_text: updated.text,
        previous_source: previous.sourceUrl || previous.sourceTitle || "",
        updated_source: updated.sourceUrl || updated.sourceTitle || "",
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Report generation failed: ${response.status} ${errorText}`);
    }

    const blob = await response.blob();
    const objectUrl = URL.createObjectURL(blob);
    await chrome.downloads.download({
      url: objectUrl,
      filename: "optibus-preference-comparison-report.pdf",
      saveAs: true,
    });
    setStatus("PDF report downloaded.", "success");
  } catch (error) {
    setStatus(error.message, "error");
  }
}

async function refreshSlotState() {
  const { previous, updated } = await chrome.storage.local.get(["previous", "updated"]);
  slotsNode.textContent = `Previous: ${previous?.text ? "ready" : "empty"} | Updated: ${updated?.text ? "ready" : "empty"}`;
}

function setStatus(message, tone = "") {
  statusNode.textContent = message;
  statusNode.className = `status${tone ? ` ${tone}` : ""}`;
}

function trimTrailingSlash(value) {
  return value.replace(/\/+$/, "");
}

function extractVisibleStructuredText() {
  const candidates = [];

  const pushValue = (value) => {
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed) {
        candidates.push(trimmed);
      }
    }
  };

  if (window.monaco?.editor?.getModels) {
    for (const model of window.monaco.editor.getModels()) {
      pushValue(model.getValue());
    }
  }

  document.querySelectorAll("textarea").forEach((node) => pushValue(node.value));
  document.querySelectorAll("pre, code, [contenteditable='true']").forEach((node) => pushValue(node.innerText));

  const best = candidates.sort((a, b) => b.length - a.length)[0] || "";
  return { text: best };
}
