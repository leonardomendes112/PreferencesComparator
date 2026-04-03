const state = {
  result: null,
};

const oldFileInput = document.getElementById("old-file");
const newFileInput = document.getElementById("new-file");
const oldJsonInput = document.getElementById("old-json");
const newJsonInput = document.getElementById("new-json");
const oldUrlInput = document.getElementById("old-url");
const newUrlInput = document.getElementById("new-url");
const oldFileName = document.getElementById("old-file-name");
const newFileName = document.getElementById("new-file-name");
const compareBtn = document.getElementById("compare-btn");
const printBtn = document.getElementById("print-btn");
const resetBtn = document.getElementById("reset-btn");
const copyPreviousBookmarkletBtn = document.getElementById("copy-previous-bookmarklet");
const copyUpdatedBookmarkletBtn = document.getElementById("copy-updated-bookmarklet");
const refreshImportsBtn = document.getElementById("refresh-imports");
const importStatus = document.getElementById("import-status");
const errorBanner = document.getElementById("error-banner");
const emptyState = document.getElementById("empty-state");
const results = document.getElementById("results");
const reportMeta = document.getElementById("report-meta");
const reportCover = document.getElementById("report-cover");
const reportPeriod = document.getElementById("report-period");
const template = document.getElementById("entry-template");
const lastImportedAt = {
  previous: "",
  updated: "",
};

oldFileInput.addEventListener("change", async (event) => {
  await loadFileIntoTextarea(event.target.files[0], oldJsonInput, oldFileName, oldUrlInput);
});

newFileInput.addEventListener("change", async (event) => {
  await loadFileIntoTextarea(event.target.files[0], newJsonInput, newFileName, newUrlInput);
});

compareBtn.addEventListener("click", handleCompare);
printBtn.addEventListener("click", () => window.print());
resetBtn.addEventListener("click", resetApp);
copyPreviousBookmarkletBtn.addEventListener("click", () => copyBookmarklet("previous"));
copyUpdatedBookmarkletBtn.addEventListener("click", () => copyBookmarklet("updated"));
refreshImportsBtn.addEventListener("click", syncImportedSlots);

syncImportedSlots();
window.setInterval(syncImportedSlots, 3000);

async function loadFileIntoTextarea(file, textarea, nameTarget, urlInput) {
  if (!file) {
    return;
  }

  try {
    const text = await file.text();
    textarea.value = text;
    nameTarget.textContent = file.name;
    if (urlInput) {
      urlInput.value = "";
    }
    clearError();
  } catch (error) {
    showError(`Could not read "${file.name}". ${error.message}`);
  }
}

async function resolveInput(textarea, urlInput, label, nameTarget) {
  const directText = textarea.value.trim();
  const url = urlInput.value.trim();

  if (directText) {
    return directText;
  }

  if (!url) {
    throw new Error(`The ${label} JSON is empty.`);
  }

  try {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const text = await response.text();
    textarea.value = text;
    nameTarget.textContent = url;
    return text;
  } catch (error) {
    throw new Error(
      `Could not load the ${label} JSON from the provided link. ${error.message}. This usually means the source does not allow browser access from this page.`
    );
  }
}

async function syncImportedSlots() {
  try {
    const response = await fetch("/api/state");
    if (!response.ok) {
      return;
    }

    const payload = await response.json();
    hydrateImportedSlot("previous", payload.slots?.previous, oldJsonInput, oldFileName, oldUrlInput);
    hydrateImportedSlot("updated", payload.slots?.updated, newJsonInput, newFileName, newUrlInput);

    const previousReady = Boolean(payload.slots?.previous?.content);
    const updatedReady = Boolean(payload.slots?.updated?.content);

    if (previousReady || updatedReady) {
      importStatus.textContent = `Imported from Optibus: ${previousReady ? "Previous ready" : "Previous missing"} | ${updatedReady ? "Updated ready" : "Updated missing"}`;
    }
  } catch (error) {
    // Keep the app usable even if the helper API is not running yet.
  }
}

function hydrateImportedSlot(slot, data, textarea, fileNameTarget, urlTarget) {
  if (!data?.content || data.updated_at === lastImportedAt[slot]) {
    return;
  }

  textarea.value = data.content;
  fileNameTarget.textContent = data.source_title || data.source_url || `Imported ${slot} JSON`;
  urlTarget.value = data.source_url || "";
  lastImportedAt[slot] = data.updated_at;
}

async function copyBookmarklet(slot) {
  const bookmarklet = buildBookmarklet(slot);
  await navigator.clipboard.writeText(bookmarklet);
  importStatus.textContent = `Copied the ${slot} bookmarklet. Open the Optibus JSON editor, then paste the bookmarklet into the browser address bar or save it as a bookmark.`;
}

function buildBookmarklet(slot) {
  const appOrigin = window.location.origin;
  const script = `
    (async()=> {
      try {
        const getLongest = (values) => values.filter(Boolean).sort((a, b) => b.length - a.length)[0] || "";
        let text = "";

        if (window.monaco && window.monaco.editor && window.monaco.editor.getModels) {
          text = getLongest(window.monaco.editor.getModels().map((model) => model.getValue()));
        }

        if (!text) {
          text = getLongest(Array.from(document.querySelectorAll("textarea")).map((node) => node.value));
        }

        if (!text) {
          text = getLongest(Array.from(document.querySelectorAll("pre, code, [contenteditable='true']")).map((node) => node.innerText));
        }

        if (!text) {
          throw new Error("Could not find visible JSON on this page.");
        }

        const response = await fetch("${appOrigin}/api/import-json?slot=${slot}", {
          method: "POST",
          mode: "cors",
          headers: {
            "Content-Type": "application/json",
            "X-Source-Url": location.href,
            "X-Source-Title": document.title
          },
          body: text
        });

        if (!response.ok) {
          throw new Error("Local import failed: " + response.status);
        }

        alert("Optibus JSON sent to the comparison app as ${slot}.");
      } catch (error) {
        alert("Optibus import failed: " + error.message);
      }
    })();
  `;

  return `javascript:${encodeURIComponent(script)}`;
}

async function handleCompare() {
  clearError();

  try {
    const originalRaw = await resolveInput(oldJsonInput, oldUrlInput, "previous", oldFileName);
    const updatedRaw = await resolveInput(newJsonInput, newUrlInput, "updated", newFileName);
    const original = parseStructuredInput(originalRaw, "previous");
    const updated = parseStructuredInput(updatedRaw, "updated");

    const normalizedOriginal = normalizeForDiff(original);
    const normalizedUpdated = normalizeForDiff(updated);
    const diff = diffNodes(normalizedOriginal, normalizedUpdated);

    state.result = {
      summary: {
        added: diff.added.length,
        removed: diff.removed.length,
        changed: diff.changed.length,
      },
      entries: diff,
      executiveSummary: buildExecutiveSummary(diff),
    };

    renderResult(state.result);
    printBtn.disabled = false;
  } catch (error) {
    showError(error.message);
  }
}

function parseStructuredInput(raw, label) {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error(`The ${label} JSON is empty.`);
  }

  try {
    return JSON.parse(trimmed);
  } catch (jsonError) {
    try {
      if (window.jsyaml?.load) {
        return window.jsyaml.load(trimmed);
      }
    } catch (yamlError) {
      throw new Error(
        `The ${label} file is not valid JSON or YAML. JSON error: ${jsonError.message}. YAML error: ${yamlError.message}`
      );
    }

    throw new Error(`The ${label} file is not valid JSON. YAML parser not available.`);
  }
}

function normalizeForDiff(value, path = "$") {
  if (Array.isArray(value)) {
    const keyed = createKeyedObjectIfPossible(value, path);
    if (keyed) {
      return normalizeForDiff(keyed, path);
    }
    return value
      .map((item, index) => normalizeForDiff(item, `${path}[${index}]`))
      .sort(compareNormalizedValues);
  }

  if (value && typeof value === "object") {
    const normalized = {};
    for (const key of Object.keys(value).sort()) {
      normalized[key] = normalizeForDiff(value[key], `${path}.${key}`);
    }
    return normalized;
  }

  return value;
}

function createKeyedObjectIfPossible(array, path) {
  if (!array.length) {
    return null;
  }

  const outerKeyCounts = countOuterKeys(array);
  const entries = [];

  for (let index = 0; index < array.length; index += 1) {
    const item = array[index];
    const keyedEntry = toComparableEntry(item, index, path, outerKeyCounts);
    if (!keyedEntry) {
      return null;
    }
    entries.push(keyedEntry);
  }

  const obj = {};
  for (const { key, value } of entries) {
    obj[key] = value;
  }
  return obj;
}

function countOuterKeys(array) {
  const counts = new Map();
  for (const item of array) {
    if (item && typeof item === "object" && !Array.isArray(item)) {
      const keys = Object.keys(item);
      if (keys.length === 1) {
        const outer = keys[0];
        counts.set(outer, (counts.get(outer) || 0) + 1);
      }
    }
  }
  return counts;
}

function toComparableEntry(item, index, path, outerKeyCounts = new Map()) {
  if (!item || typeof item !== "object" || Array.isArray(item)) {
    return null;
  }

  const keys = Object.keys(item);

  if (keys.length === 1) {
    const outerKey = keys[0];
    const payload = item[outerKey];
    if (payload && typeof payload === "object" && !Array.isArray(payload)) {
      const qualifier =
        payload.name ||
        payload.id ||
        payload.module_name ||
        payload.preference_folder_name ||
        payload.catalog ||
        payload.depot_name;

      if (qualifier) {
        return {
          key: `${outerKey}::${String(qualifier)}`,
          value: payload,
        };
      }

      if ((outerKeyCounts.get(outerKey) || 0) === 1) {
        return {
          key: outerKey,
          value: payload,
        };
      }

      return {
        key: `${outerKey}::anon_${hashString(stableSerialize(payload))}`,
        value: payload,
      };
    }

    if ((outerKeyCounts.get(outerKey) || 0) === 1) {
      return {
        key: outerKey,
        value: payload,
      };
    }

    return {
      key: `${outerKey}::anon_${hashString(stableSerialize(payload))}`,
      value: payload,
    };
  }

  if ("id" in item || "name" in item) {
    const qualifier = item.id || item.name;
    return {
      key: `${path.includes("items") ? "item" : "entry"}::${String(qualifier)}`,
      value: item,
    };
  }

  return {
    key: `${path.includes("items") ? "item" : "entry"}::anon_${hashString(stableSerialize(item))}`,
    value: item,
  };
}

function diffNodes(before, after, path = "$") {
  const result = { added: [], removed: [], changed: [] };

  if (before === undefined && after !== undefined) {
    result.added.push(createValueEntry("added", path, after));
    return result;
  }

  if (before !== undefined && after === undefined) {
    result.removed.push(createValueEntry("removed", path, before));
    return result;
  }

  if (isPrimitive(before) || isPrimitive(after)) {
    if (!Object.is(before, after)) {
      result.changed.push({
        type: "changed",
        path,
        label: humanizePath(path),
        changes: [{ path, before, after }],
      });
    }
    return result;
  }

  if (Array.isArray(before) || Array.isArray(after)) {
    if (stableSerialize(before) !== stableSerialize(after)) {
      result.changed.push({
        type: "changed",
        path,
        label: humanizePath(path),
        changes: [{ path, before, after }],
      });
    }
    return result;
  }

  const keys = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);

  for (const key of [...keys].sort()) {
    const childPath = joinPath(path, key);
    const child = diffNodes(before?.[key], after?.[key], childPath);
    result.added.push(...child.added);
    result.removed.push(...child.removed);
    result.changed.push(...child.changed);
  }

  return collapseEntries(result);
}

function collapseEntries(result) {
  return {
    added: mergeValueEntries(result.added),
    removed: mergeValueEntries(result.removed),
    changed: mergeChangedEntries(result.changed),
  };
}

function mergeValueEntries(entries) {
  const grouped = new Map();

  for (const entry of entries) {
    const key = groupKey(entry.path);
    const current = grouped.get(key) || {
      type: entry.type,
      path: key,
      label: humanizePath(key),
      items: [],
    };

    current.items.push({
      path: entry.path,
      value: entry.value,
    });
    grouped.set(key, current);
  }

  return [...grouped.values()].sort((a, b) => a.label.localeCompare(b.label));
}

function mergeChangedEntries(entries) {
  const grouped = new Map();

  for (const entry of entries) {
    const key = groupKey(entry.path);
    const current = grouped.get(key) || {
      type: "changed",
      path: key,
      label: humanizePath(key),
      changes: [],
    };

    current.changes.push(...entry.changes);
    grouped.set(key, current);
  }

  return [...grouped.values()]
    .map((entry) => ({
      ...entry,
      changes: entry.changes.sort((a, b) => a.path.localeCompare(b.path)),
    }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

function createValueEntry(type, path, value) {
  return {
    type,
    path,
    label: humanizePath(path),
    value,
  };
}

function groupKey(path) {
  const parts = path.split(".");
  if (parts.length <= 2) {
    return path;
  }

  const keyPart = parts[1];
  if (keyPart.includes("::")) {
    return `${parts[0]}.${keyPart}`;
  }

  if (parts[2] && parts[2].includes("::")) {
    return `${parts[0]}.${parts[1]}.${parts[2]}`;
  }

  return `${parts[0]}.${parts[1]}`;
}

function humanizePath(path) {
  if (path === "$") {
    return "Root";
  }

  return path
    .replace(/^\$\./, "")
    .split(".")
    .map((part) =>
      part
        .replace(/::/g, " / ")
        .replace(/_/g, " ")
        .replace(/\b\w/g, (char) => char.toUpperCase())
    )
    .join(" > ");
}

function joinPath(base, key) {
  return `${base}.${key}`;
}

function isPrimitive(value) {
  return value === null || (typeof value !== "object" && typeof value !== "function");
}

function renderResult(result) {
  emptyState.classList.add("hidden");
  results.classList.remove("hidden");
  reportMeta.classList.remove("hidden");
  reportCover.classList.remove("hidden");

  setText("added-count", result.summary.added);
  setText("removed-count", result.summary.removed);
  setText("changed-count", result.summary.changed);
  setText("added-total-pill", result.summary.added);
  setText("removed-total-pill", result.summary.removed);
  setText("changed-total-pill", result.summary.changed);

  document.getElementById("added-total-pill").className = "pill added";
  document.getElementById("removed-total-pill").className = "pill removed";
  document.getElementById("changed-total-pill").className = "pill changed";

  reportMeta.textContent = `Prepared ${new Date().toLocaleString()}`;
  reportPeriod.innerHTML = `
    <strong>Report Details</strong><br />
    Previous source: ${formatSourceForReport(oldFileName.textContent, oldUrlInput.value)}<br />
    Updated source: ${formatSourceForReport(newFileName.textContent, newUrlInput.value)}
  `;

  renderExecutiveSummary(result.executiveSummary);
  renderValueEntries("added-list", result.entries.added, "added");
  renderValueEntries("removed-list", result.entries.removed, "removed");
  renderChangedEntries("changed-list", result.entries.changed);
}

function renderExecutiveSummary(lines) {
  const target = document.getElementById("executive-summary");
  target.replaceChildren();

  if (!lines.length) {
    target.appendChild(createSummaryNote("No preference differences were identified between the two files."));
    return;
  }

  for (const line of lines) {
    target.appendChild(createSummaryNote(line));
  }
}

function renderValueEntries(targetId, entries, type) {
  const target = document.getElementById(targetId);
  target.replaceChildren();

  if (!entries.length) {
    target.appendChild(createEmptyNote(`No ${type} preferences.`));
    return;
  }

  for (const entry of entries) {
    const node = template.content.firstElementChild.cloneNode(true);
    node.querySelector(".entry-title").textContent = entry.label;
    node.querySelector(".entry-path").textContent = entry.path;
    const badge = node.querySelector(".entry-badge");
    badge.textContent = type;
    badge.className = `entry-badge ${type}`;

    const body = node.querySelector(".entry-body");
    body.appendChild(createSummaryList(buildValueSummaryLines(entry, type)));

    target.appendChild(node);
  }
}

function renderChangedEntries(targetId, entries) {
  const target = document.getElementById(targetId);
  target.replaceChildren();

  if (!entries.length) {
    target.appendChild(createEmptyNote("No changed preferences."));
    return;
  }

  for (const entry of entries) {
    const node = template.content.firstElementChild.cloneNode(true);
    node.querySelector(".entry-title").textContent = entry.label;
    node.querySelector(".entry-path").textContent = entry.path;
    const badge = node.querySelector(".entry-badge");
    badge.textContent = "changed";
    badge.className = "entry-badge changed";

    const list = document.createElement("ul");
    list.className = "diff-list";

    for (const change of entry.changes) {
      const row = document.createElement("li");
      row.className = "diff-row";
      row.textContent = formatChangeSentence(change);
      list.appendChild(row);
    }

    node.querySelector(".entry-body").appendChild(list);
    target.appendChild(node);
  }
}

function createEmptyNote(message) {
  const note = document.createElement("div");
  note.className = "diff-row";
  note.textContent = message;
  return note;
}

function createSummaryNote(message) {
  const note = document.createElement("div");
  note.className = "summary-note";
  note.textContent = message;
  return note;
}

function formatInlineValue(value) {
  if (typeof value === "string") {
    return value;
  }

  return JSON.stringify(value);
}

function createSummaryList(lines) {
  const list = document.createElement("ul");
  list.className = "detail-list";

  for (const line of lines) {
    const row = document.createElement("li");
    row.className = "diff-row";
    row.textContent = line;
    list.appendChild(row);
  }

  return list;
}

function buildValueSummaryLines(entry, type) {
  const plainEnglish = describePreferenceEntry(entry, type);
  const lines = [];

  if (plainEnglish) {
    lines.push(plainEnglish);
  }

  for (const item of entry.items.slice(0, 8)) {
    const fieldName = getReadableLeaf(item.path, entry.path);
    const summary = summarizeValue(item.value);

    if (fieldName === "This preference") {
      lines.push(type === "added" ? `Added ${summary}.` : `Removed ${summary}.`);
    } else {
      lines.push(type === "added" ? `${fieldName} added: ${summary}.` : `${fieldName} removed: ${summary}.`);
    }
  }

  if (entry.items.length > 8) {
    lines.push(`${entry.items.length - 8} more ${type} details not shown.`);
  }

  return lines;
}

function formatChangeSentence(change) {
  const interpreted = interpretChange(change);
  if (interpreted) {
    return interpreted;
  }

  const fieldName = getReadableLeaf(change.path);
  return `${fieldName} changed from ${summarizeValue(change.before)} to ${summarizeValue(change.after)}.`;
}

function buildExecutiveSummary(diff) {
  const lines = [];
  const total = diff.added.length + diff.removed.length + diff.changed.length;

  if (!total) {
    return lines;
  }

  lines.push(
    `Overall, ${diff.added.length} preference${diff.added.length === 1 ? "" : "s"} were added, ${diff.removed.length} removed, and ${diff.changed.length} updated.`
  );

  for (const entry of diff.added) {
    lines.push(describePreferenceEntry(entry, "added"));
  }

  for (const entry of diff.removed) {
    lines.push(describePreferenceEntry(entry, "removed"));
  }

  for (const entry of diff.changed) {
    const important = entry.changes.slice(0, 3).map((change) => interpretChange(change) || formatGenericChange(change));
    lines.push(`${stripPathDecorations(entry.label)}: ${important.join(" ")}`);
  }

  return lines;
}

function describePreferenceEntry(entry, type) {
  const context = getEntryContext(entry.path);
  const value = entry.items?.[0]?.value;
  const action = type === "added" ? "Added" : "Removed";
  const subject = context.kindLabel || "preference";
  const name = context.name ? ` "${context.name}"` : "";

  const qualifiers = [];
  if (value && typeof value === "object") {
    if (typeof value.enabled === "boolean") {
      qualifiers.push(value.enabled ? "enabled" : "disabled");
    }
    if (Array.isArray(value.pref_group_ids) && value.pref_group_ids.length) {
      qualifiers.push(`applies to ${joinList(value.pref_group_ids.map(String))}`);
    }
    const parameterSummary = summarizeParameters(value.parameters);
    if (parameterSummary) {
      qualifiers.push(parameterSummary);
    }
  }

  const suffix = qualifiers.length ? `, ${qualifiers.join(", ")}` : "";
  return `${action} ${subject}${name}${suffix}.`;
}

function interpretChange(change) {
  const context = getEntryContext(change.path);
  const leaf = getReadableLeaf(change.path);

  if (leaf === "Enabled" && typeof change.after === "boolean") {
    return `${stripPathDecorations(context.display)} was ${change.after ? "enabled" : "disabled"}.`;
  }

  if (leaf === "Name") {
    return `${context.kindLabel || "Preference"} was renamed from ${summarizeValue(change.before)} to ${summarizeValue(change.after)}.`;
  }

  if (change.path.includes(".pref_group_ids")) {
    return `${stripPathDecorations(context.display)} now applies to ${joinList(normalizeArraySummary(change.after))} instead of ${joinList(normalizeArraySummary(change.before))}.`;
  }

  if (change.path.includes(".parameters.") && leaf === "Value") {
    const parameter = getParameterName(change.path);
    return `${stripPathDecorations(context.display)} changed ${parameter} from ${summarizeValue(change.before)} to ${summarizeValue(change.after)}.`;
  }

  if (leaf === "Module Name") {
    return `${stripPathDecorations(context.display)} changed module from ${summarizeValue(change.before)} to ${summarizeValue(change.after)}.`;
  }

  if (leaf === "Catalog") {
    return `${stripPathDecorations(context.display)} changed catalog from ${summarizeValue(change.before)} to ${summarizeValue(change.after)}.`;
  }

  return "";
}

function formatGenericChange(change) {
  return `${getReadableLeaf(change.path)} changed from ${summarizeValue(change.before)} to ${summarizeValue(change.after)}.`;
}

function getEntryContext(path) {
  const cleaned = path.replace(/^\$\./, "");
  const parts = cleaned.split(".");
  const primary = parts[0] || "";
  const primaryHuman = humanizeToken(primary.split("::")[0] || primary);
  const namedPart = parts.find((part) => part.includes("::"));
  const name = namedPart ? namedPart.split("::")[1] : "";
  const kindLabel = primaryHuman ? primaryHuman.toLowerCase() : "preference";
  const display = name ? `${primaryHuman} "${name}"` : primaryHuman;
  return { primary, primaryHuman, name, kindLabel, display };
}

function stripPathDecorations(value) {
  return value.replace(/\s*>\s*/g, " ").replace(/\s+\/\s+/g, " ");
}

function summarizeParameters(parameters) {
  if (!parameters || typeof parameters !== "object") {
    return "";
  }

  const summaries = [];
  for (const [key, config] of Object.entries(parameters)) {
    const actualValue = config?.value;
    if (actualValue !== undefined && summaries.length < 2) {
      summaries.push(`${humanizeToken(config.display_name || key)} ${summarizeValue(actualValue)}`);
    }
  }
  return summaries.join(", ");
}

function normalizeArraySummary(value) {
  if (!Array.isArray(value)) {
    return [String(value)];
  }
  return value.map((item) => String(item));
}

function joinList(values) {
  const filtered = values.filter(Boolean);
  if (!filtered.length) {
    return "no groups";
  }
  if (filtered.length === 1) {
    return filtered[0];
  }
  if (filtered.length === 2) {
    return `${filtered[0]} and ${filtered[1]}`;
  }
  return `${filtered.slice(0, -1).join(", ")}, and ${filtered[filtered.length - 1]}`;
}

function getParameterName(path) {
  const match = path.match(/\.parameters\.([^.]*)/);
  if (!match) {
    return "the parameter";
  }
  return humanizeToken(match[1]);
}

function getReadableLeaf(path, groupPath = "") {
  const cleaned = path.replace(/^\$\./, "");
  const groupCleaned = groupPath.replace(/^\$\./, "");
  const suffix = cleaned.startsWith(groupCleaned) ? cleaned.slice(groupCleaned.length).replace(/^\./, "") : cleaned;

  if (!suffix) {
    return "This preference";
  }

  const parts = suffix.split(".").filter(Boolean);
  const last = parts[parts.length - 1];
  return humanizeToken(last);
}

function humanizeToken(token) {
  return token
    .replace(/::/g, " / ")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function summarizeValue(value) {
  if (value === null) {
    return "empty";
  }

  if (typeof value === "string") {
    return `"${value}"`;
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  if (Array.isArray(value)) {
    if (!value.length) {
      return "none";
    }
    if (value.length <= 3 && value.every((item) => isPrimitive(item))) {
      return value.map((item) => summarizeValue(item)).join(", ");
    }
    return `${value.length} item${value.length === 1 ? "" : "s"}`;
  }

  if (value && typeof value === "object") {
    if (value.name) {
      return `${value.name}`;
    }
    if (value.id) {
      return `${value.id}`;
    }

    const keys = Object.keys(value);
    if (!keys.length) {
      return "empty";
    }

    const priorityKeys = ["display_name", "value", "module_name", "type"];
    for (const key of priorityKeys) {
      if (key in value && isPrimitive(value[key])) {
        return `${humanizeToken(key)} ${summarizeValue(value[key])}`;
      }
    }

    return `${keys.length} setting${keys.length === 1 ? "" : "s"}`;
  }

  return formatInlineValue(value);
}

function compareNormalizedValues(left, right) {
  return stableSerialize(left).localeCompare(stableSerialize(right));
}

function stableSerialize(value) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => stableSerialize(item)).join(",")}]`;
  }

  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableSerialize(value[key])}`).join(",")}}`;
}

function hashString(value) {
  let hash = 5381;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 33) ^ value.charCodeAt(index);
  }
  return (hash >>> 0).toString(36);
}

function setText(id, value) {
  document.getElementById(id).textContent = String(value);
}

function showError(message) {
  errorBanner.textContent = message;
  errorBanner.classList.remove("hidden");
}

function clearError() {
  errorBanner.textContent = "";
  errorBanner.classList.add("hidden");
}

function resetApp() {
  state.result = null;
  oldJsonInput.value = "";
  newJsonInput.value = "";
  oldFileInput.value = "";
  newFileInput.value = "";
  oldUrlInput.value = "";
  newUrlInput.value = "";
  oldFileName.textContent = "No file selected";
  newFileName.textContent = "No file selected";
  importStatus.textContent = "Waiting for imported Optibus JSON.";
  clearError();
  printBtn.disabled = true;
  results.classList.add("hidden");
  reportMeta.classList.add("hidden");
  reportCover.classList.add("hidden");
  emptyState.classList.remove("hidden");
  document.getElementById("added-list").replaceChildren();
  document.getElementById("removed-list").replaceChildren();
  document.getElementById("changed-list").replaceChildren();
}

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function formatSourceForReport(nameText, urlValue) {
  const trimmedUrl = (urlValue || "").trim();
  if (trimmedUrl) {
    const safeUrl = escapeHtml(trimmedUrl);
    return `<a href="${safeUrl}" target="_blank" rel="noreferrer">${safeUrl}</a>`;
  }

  return escapeHtml(nameText || "Provided JSON");
}
