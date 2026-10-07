const MAX_TEXT_CHARS = 400_000;

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

  // If this URL was saved before, bring back the note and tags for editing.
  try {
    const { page: saved } = await send("lookup", { url: page.url });
    if (saved) {
      $("note").value ||= saved.note;
      $("tags").value ||= saved.tags.join(", ");
      $("save").textContent = "Update saved page";
      setStatus($("save-status"), `Saved on ${formatDate(saved.saved_at)}. Saving again replaces it.`);
    }
  } catch (err) {
    setStatus($("save-status"), err.message, "error");
  }
}

async function savePage() {
  const button = $("save");
  const status = $("save-status");
  button.disabled = true;
  setStatus(status, "Saving…");
  try {
    const useSelection = $("selection-only").checked && page.selection;
    const { chunks } = await send("save", {
      page: {
        url: page.url,
        title: page.title,
        description: page.description,
        text: useSelection ? page.selection : page.text,
        note: $("note").value,
        tags: $("tags").value.split(",").map((t) => t.trim()).filter(Boolean),
      },
    });
    button.textContent = "Update saved page";
    setStatus(status, `Saved (${chunks} chunk${chunks === 1 ? "" : "s"} indexed).`, "success");
  } catch (err) {
    setStatus(status, err.message, "error");
  } finally {
    button.disabled = false;
  }
}

// ---------- Search tab ----------

function formatDate(epochSeconds) {
  return new Date(epochSeconds * 1000).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
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

  const head = el("div", "result-head");
  const link = el("a", "", result.title);
  if (/^(https?|file):/.test(result.url)) link.href = result.url;
  link.target = "_blank";
  link.rel = "noreferrer";
  head.append(link);

  const remove = el("button", "delete", "Delete");
  remove.addEventListener("click", async () => {
    if (remove.dataset.armed !== "true") {
      remove.dataset.armed = "true";
      remove.textContent = "Confirm delete";
      return;
    }
    try {
      await send("remove", { pageId: result.page_id });
      item.remove();
    } catch (err) {
      setStatus($("search-status"), err.message, "error");
    }
  });
  head.append(remove);
  item.append(head);

  const match = result.score == null ? "" : ` · ${Math.round(result.score * 100)}% match`;
  item.append(el("div", "result-meta", `${hostOf(result.url)} · ${formatDate(result.saved_at)}${match}`));
  if (result.snippet) item.append(el("div", "result-snippet", result.snippet));
  if (result.note) item.append(el("div", "result-note", result.note));
  for (const tag of result.tags) item.append(el("span", "tag", tag));
  return item;
}

async function runSearch() {
  const q = $("query").value.trim();
  const status = $("search-status");
  setStatus(status, q ? "Searching…" : "");
  try {
    const { results } = q ? await send("search", { q }) : await send("recent");
    $("results-heading").textContent = q ? `Best matches for “${q}”` : "Recently saved";
    $("results").replaceChildren(...results.map(renderResult));
    setStatus(status, results.length ? "" : q ? "Nothing matched." : "Nothing saved yet.");
  } catch (err) {
    setStatus(status, err.message, "error");
  }
}

// ---------- Wiring ----------

function showTab(name) {
  for (const tab of ["save", "search"]) {
    $(`tab-${tab}`).setAttribute("aria-selected", String(tab === name));
    $(`panel-${tab}`).hidden = tab !== name;
  }
  if (name === "search") {
    $("query").focus();
    runSearch();
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
