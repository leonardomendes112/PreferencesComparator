const apiBaseUrlInput = document.getElementById("api-base-url");
const settingsStatus = document.getElementById("settings-status");

document.getElementById("save-settings").addEventListener("click", saveSettings);

loadSettings();

async function loadSettings() {
  const { apiBaseUrl } = await chrome.storage.sync.get(["apiBaseUrl"]);
  apiBaseUrlInput.value = apiBaseUrl || "";
  settingsStatus.textContent = apiBaseUrl ? `Saved backend URL: ${apiBaseUrl}` : "No backend URL saved yet.";
}

async function saveSettings() {
  const value = apiBaseUrlInput.value.trim();
  await chrome.storage.sync.set({ apiBaseUrl: value });
  settingsStatus.textContent = value ? `Saved backend URL: ${value}` : "Backend URL cleared.";
}
