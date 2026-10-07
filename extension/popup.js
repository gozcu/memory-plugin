const MAX_TEXT_CHARS = 20_000;
const SNIPPET_CHARS = 240;
const SEARCH_ESTIMATE_MS = 30_000;
const PROGRESS_FINISH_MS = 200;
// Estimated stages of a search, each starting at a fraction of SEARCH_ESTIMATE_MS.
const SEARCH_STAGES = [
  { at: 0, label: "Submitting" },
  { at: 0.05, label: "Understanding your request" },
  { at: 0.25, label: "Working" },
  { at: 0.5, label: "Searching your records" },
  { at: 1, label: "Still searching your records" },
];

const $ = (id) => document.getElementById(id);

async function send(type, payload = {}) {
  const res = await chrome.runtime.sendMessage({ type, ...payload });
  if (!res?.ok) throw new Error(res?.error ?? "No response from the extension");
  return res.data;
}

function setStatus(el, text, kind = "") {
  el.textContent = text;
  el.className = `status ${kind}`.trim();
}

// Runs inside the page, so it must be self-contained.
function extractPage(maxChars) {
  const meta = (name) =>
    document.querySelector(`meta[name="${name}"], meta[property="${name}"]`)?.content?.trim() ?? "";

  // Prefer the main content region so navigation and footers don't drown it out.
  const candidates = [...document.querySelectorAll("article, main, [role='main']")];
  const main = candidates
    .map((el) => el.innerText ?? "")
    .sort((a, b) => b.length - a.length)[0];
  const body = document.body?.innerText ?? "";
  const text = main && main.length > 500 ? main : body;

  return {
    url: location.href,
    title: document.title,
    description: meta("description") || meta("og:description"),
    selection: String(getSelection() ?? "").trim().slice(0, maxChars),
    text: text.slice(0, maxChars),
  };
}

// ---------- Save tab ----------

let page = null;

async function loadPage() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  page = { url: tab?.url ?? "", title: tab?.title ?? "", description: "", selection: "", text: "" };

  try {
    const [injection] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: extractPage,
      args: [MAX_TEXT_CHARS],
    });
    page = injection.result;
    $("page-stats").textContent = `${page.text.length.toLocaleString()} characters of page text`;
  } catch {
    // Browser pages (chrome://, edge://, the extension stores) can't be read.
    $("page-stats").textContent = "This page's content can't be read; only the link and your note will be saved.";
  }

  $("page-title").textContent = page.title || page.url || "Untitled page";
  $("page-url").textContent = page.url;
  $("selection-row").hidden = !page.selection;
  $("save").disabled = !/^(https?|file):/.test(page.url);
  if ($("save").disabled) {
    $("page-stats").textContent = "This kind of page can't be saved.";
    return;
  }
}

// Search only returns a memory's content, so the title, link and note travel
// inside it as a header block: title, URL, optional "Note: …", blank line, text.
function buildContent({ title, url, note, text }) {
  const head = [title.replace(/\s+/g, " ").trim() || url, url];
  if (note) head.push(`Note: ${note.replace(/\n{2,}/g, "\n")}`);
  return `${head.join("\n")}\n\n${text}`.trim();
}

function parseContent(content) {
  const split = content.indexOf("\n\n");
  const head = (split === -1 ? content : content.slice(0, split)).split("\n");
  const body = split === -1 ? "" : content.slice(split + 2);
  // Memories saved by other clients have no header; show them as plain text.
  if (!/^(https?|file):/.test(head[1] ?? "")) return { title: "", url: "", note: "", body: content };
  const note = head.slice(2).join("\n");
  return {
    title: head[0],
    url: head[1],
    note: note.startsWith("Note: ") ? note.slice(6) : "",
    body: note && !note.startsWith("Note: ") ? `${note}\n\n${body}` : body,
  };
}

async function savePage() {
  const button = $("save");
  const status = $("save-status");
  button.disabled = true;
  setStatus(status, "Saving…");
  try {
    const useSelection = $("selection-only").checked && page.selection;
    const note = $("note").value.trim();
    const text = useSelection ? page.selection : page.text || page.description;
    await send("save", {
      content: buildContent({ title: page.title, url: page.url, note, text }),
      metadata: { url: page.url, title: page.title, note, saved_at: new Date().toISOString() },
    });
    // The service indexes the memory in the background after accepting it.
    setStatus(status, "Saved. It will show up in search in a few minutes.", "success");
  } catch (err) {
    setStatus(status, err.message, "error");
  } finally {
    button.disabled = false;
  }
}

// ---------- Search tab ----------

function formatDate(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

// Page-derived strings are only ever set via textContent, never as HTML.
function renderResult(result) {
  const item = el("li");
  const { title, url, note, body } = parseContent(String(result.content ?? ""));
  const snippet = body.length > SNIPPET_CHARS ? `${body.slice(0, SNIPPET_CHARS).trimEnd()}…` : body;

  const head = el("div", "result-head");
  if (url) {
    const link = el("a", "", title || url);
    link.href = url;
    link.target = "_blank";
    link.rel = "noreferrer";
    head.append(link);
  } else {
    head.append(el("span", "", "Saved memory"));
  }

  const remove = el("button", "delete", "Delete");
  remove.addEventListener("click", async () => {
    if (remove.dataset.armed !== "true") {
      remove.dataset.armed = "true";
      remove.textContent = "Confirm delete";
      return;
    }
    try {
      await send("remove", { memoryId: result.id });
      item.remove();
    } catch (err) {
      setStatus($("search-status"), err.message, "error");
    }
  });
  // Search results carry no memory id, and without one there is nothing to delete.
  if (result.id) head.append(remove);
  item.append(head);

  const match =
    typeof result.distance === "number"
      ? `${Math.round(Math.max(0, Math.min(1, 1 - result.distance)) * 100)}% match`
      : "";
  const meta = [url && hostOf(url), formatDate(result.created_at), match].filter(Boolean);
  item.append(el("div", "result-meta", meta.join(" · ")));
  if (snippet) item.append(el("div", "result-snippet", snippet));
  if (note) item.append(el("div", "result-note", note));
  return item;
}

async function runSearch() {
  const q = $("query").value.trim();
  const status = $("search-status");
  if (!q) {
    $("results-heading").textContent = "";
    $("results").replaceChildren();
    setStatus(status, "");
    return;
  }
  const button = $("search-form").querySelector("button");
  button.disabled = true;
  setStatus(status, "");
  showProgress(true);
  try {
    const { results } = await send("search", { q });
    $("results-heading").textContent = `Best matches for “${q}”`;
    $("results").replaceChildren(...results.map(renderResult));
    setStatus(status, results.length ? "" : "Nothing matched.");
  } catch (err) {
    setStatus(status, err.message, "error");
  } finally {
    showProgress(false);
    button.disabled = false;
  }
}

// The search call gives no progress of its own, so the bar is an estimate: it
// fills over SEARCH_ESTIMATE_MS and waits just short of full until the reply.
// The stage label and elapsed-seconds ticker follow the same clock.
let progressTicker = 0;
let progressHide = 0;

function showProgress(active) {
  const box = $("search-progress");
  const bar = box.querySelector(".progress");
  const fill = bar.firstElementChild;
  clearInterval(progressTicker);
  clearTimeout(progressHide);

  if (!active) {
    if (box.hidden) return;
    // Snap to full before hiding so the bar visibly finishes.
    fill.style.transition = `width ${PROGRESS_FINISH_MS}ms ease-out`;
    fill.style.width = "100%";
    progressHide = setTimeout(() => {
      box.hidden = true;
    }, PROGRESS_FINISH_MS + 100);
    return;
  }

  const started = Date.now();
  const tick = () => {
    const elapsed = Date.now() - started;
    const stage = SEARCH_STAGES.findLast((s) => elapsed >= s.at * SEARCH_ESTIMATE_MS);
    // Only touch the label when it changes, so screen readers aren't re-notified every second.
    if ($("search-stage").textContent !== stage.label) {
      $("search-stage").textContent = stage.label;
      bar.setAttribute("aria-valuetext", stage.label);
    }
    $("search-elapsed").textContent = `${Math.floor(elapsed / 1000)}s`;
  };

  box.hidden = false;
  fill.style.transition = "none";
  fill.style.width = "0";
  fill.getBoundingClientRect(); // commit the reset before animating
  fill.style.transition = `width ${SEARCH_ESTIMATE_MS}ms cubic-bezier(0.2, 0.6, 0.4, 1)`;
  fill.style.width = "95%";
  tick();
  progressTicker = setInterval(tick, 250);
}

// ---------- Wiring ----------

function showTab(name) {
  for (const tab of ["save", "search"]) {
    $(`tab-${tab}`).setAttribute("aria-selected", String(tab === name));
    $(`panel-${tab}`).hidden = tab !== name;
  }
  if (name === "search") {
    $("query").focus();
  }
}

$("tab-save").addEventListener("click", () => showTab("save"));
$("tab-search").addEventListener("click", () => showTab("search"));
$("open-options").addEventListener("click", () => chrome.runtime.openOptionsPage());
$("save").addEventListener("click", savePage);
$("search-form").addEventListener("submit", (event) => {
  event.preventDefault();
  runSearch();
});

loadPage();
chrome.storage.local.get({ token: "", salt: "" }).then(({ token, salt }) => {
  if (!token || !salt) {
    setStatus($("save-status"), "Add your security token and salt in settings (⚙) to start saving.");
  }
});
