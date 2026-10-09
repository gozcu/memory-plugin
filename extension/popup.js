const MIN_DESCRIPTION_WORDS = 3;
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
function extractPage() {
  const meta = (name) =>
    document.querySelector(`meta[name="${name}"], meta[property="${name}"]`)?.content?.trim() ?? "";

  return {
    url: location.href,
    title: document.title,
    description: meta("description") || meta("og:description"),
  };
}

// ---------- Save tab ----------

let page = null;
let saveable = false;
let saving = false;

function descriptionWords() {
  return $("description").value.trim().split(/\s+/).filter(Boolean).length;
}

// Saving needs a saveable page and a description of at least a few words.
function updateSave() {
  const missing = MIN_DESCRIPTION_WORDS - descriptionWords();
  $("description-hint").textContent =
    missing > 0 ? `Required: at least ${MIN_DESCRIPTION_WORDS} words (${missing} more).` : "";
  $("save").disabled = !saveable || saving || missing > 0;
}

async function loadPage() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  page = { url: tab?.url ?? "", title: tab?.title ?? "", description: "" };

  try {
    const [injection] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: extractPage,
    });
    page = injection.result;
  } catch {
    // Browser pages (chrome://, edge://, the extension stores) can't be read;
    // the tab's own title and link are enough to go on.
  }

  $("page-title").textContent = page.title || page.url || "Untitled page";
  $("page-url").textContent = page.url;
  // Start from the page's own description, unless the user already began typing.
  if (!$("description").value) $("description").value = page.description;
  saveable = /^(https?|file):/.test(page.url);
  if (!saveable) $("page-stats").textContent = "This kind of page can't be saved.";
  updateSave();
}

// Search only returns a memory's content, so the title, link and description travel
// inside it as a header block: title, URL, "Note: …". The page text is not sent.
function buildContent({ title, url, note }) {
  const head = [title.replace(/\s+/g, " ").trim() || url, url];
  if (note) head.push(`Note: ${note.replace(/\n{2,}/g, "\n")}`);
  return head.join("\n");
}

function parseContent(content) {
  const split = content.indexOf("\n\n");
  const head = (split === -1 ? content : content.slice(0, split)).split("\n");
  // Older memories also carry the page text after a blank line.
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
  const status = $("save-status");
  const description = $("description").value.trim();
  if (descriptionWords() < MIN_DESCRIPTION_WORDS) {
    setStatus(status, `Describe this page in at least ${MIN_DESCRIPTION_WORDS} words first.`, "error");
    return;
  }
  saving = true;
  updateSave();
  setStatus(status, "Saving…");
  try {
    await send("save", {
      content: buildContent({ title: page.title, url: page.url, note: description }),
      metadata: { url: page.url, title: page.title, description, saved_at: new Date().toISOString() },
    });
    // The service indexes the memory in the background after accepting it.
    setStatus(status, "Saved. It will show up in search in a few minutes.", "success");
  } catch (err) {
    setStatus(status, err.message, "error");
  } finally {
    saving = false;
    updateSave();
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
      updateCarousel();
      const { lastSearch } = await chrome.storage.session.get("lastSearch");
      if (lastSearch) {
        lastSearch.results = lastSearch.results.filter((kept) => kept.id !== result.id);
        await chrome.storage.session.set({ lastSearch });
      }
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
  if (body) item.append(el("div", "result-body", body));
  if (note) item.append(el("div", "result-note", note));
  return item;
}

// Results are a carousel: one whole memory per slide, scrolled sideways by
// swiping or with the buttons underneath.
function currentSlide() {
  const list = $("results");
  let best = 0;
  [...list.children].forEach((item, i) => {
    const gap = Math.abs(item.offsetLeft - list.scrollLeft);
    if (gap < Math.abs(list.children[best].offsetLeft - list.scrollLeft)) best = i;
  });
  return best;
}

function showSlide(index) {
  const list = $("results");
  const item = list.children[Math.max(0, Math.min(list.children.length - 1, index))];
  if (item) list.scrollTo({ left: item.offsetLeft });
}

function updateCarousel() {
  const count = $("results").children.length;
  const index = currentSlide();
  $("carousel-nav").hidden = count < 2;
  $("carousel-count").textContent = `${index + 1} of ${count}`;
  $("carousel-prev").disabled = index === 0;
  $("carousel-next").disabled = index >= count - 1;
}

function showResults(q, results) {
  $("results-heading").textContent = `Best matches for “${q}”`;
  $("results").replaceChildren(...results.map(renderResult));
  $("results").scrollLeft = 0;
  updateCarousel();
  setStatus($("search-status"), results.length ? "" : "Nothing matched.");
}

async function runSearch() {
  const q = $("query").value.trim();
  const status = $("search-status");
  if (!q) {
    $("results-heading").textContent = "";
    $("results").replaceChildren();
    updateCarousel();
    setStatus(status, "");
    chrome.storage.session.remove("lastSearch");
    return;
  }
  const button = $("search-form").querySelector("button");
  button.disabled = true;
  setStatus(status, "");
  showProgress(true);
  try {
    const { results } = await send("search", { q });
    showResults(q, results);
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
  chrome.storage.session.set({ tab: name });
}

$("tab-save").addEventListener("click", () => showTab("save"));
$("tab-search").addEventListener("click", () => showTab("search"));
$("open-options").addEventListener("click", () => chrome.runtime.openOptionsPage());
$("save").addEventListener("click", savePage);
$("description").addEventListener("input", updateSave);
$("results").addEventListener("scroll", updateCarousel);
$("carousel-prev").addEventListener("click", () => showSlide(currentSlide() - 1));
$("carousel-next").addEventListener("click", () => showSlide(currentSlide() + 1));
$("search-form").addEventListener("submit", (event) => {
  event.preventDefault();
  runSearch();
});

loadPage();
// Closing the popup discards its page, so the last search and the open tab
// are restored from session storage.
chrome.storage.session.get({ lastSearch: null, tab: "save" }).then(({ lastSearch, tab }) => {
  if (lastSearch) {
    $("query").value = lastSearch.q;
    showResults(lastSearch.q, lastSearch.results);
  }
  if (tab === "search") showTab("search");
});
chrome.storage.local.get({ token: "", salt: "" }).then(({ token, salt }) => {
  if (!token || !salt) {
    setStatus($("save-status"), "Add your security token and password in settings (⚙) to start saving.");
  }
});
