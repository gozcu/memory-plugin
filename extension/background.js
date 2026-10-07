// All server calls go through the service worker so a save keeps running
// even if the popup is closed before the request finishes.

const DEFAULTS = { serverUrl: "http://localhost:8765", apiKey: "" };

async function api(path, { method = "GET", body } = {}) {
  const { serverUrl, apiKey } = await chrome.storage.local.get(DEFAULTS);
  const base = serverUrl.replace(/\/+$/, "");
  const headers = {};
  if (body) headers["Content-Type"] = "application/json";
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

  let res;
  try {
    res = await fetch(base + path, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new Error(`Can't reach the Page Memory server at ${base}. Is it running?`);
  }
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const data = await res.json();
      detail = typeof data.detail === "string" ? data.detail : JSON.stringify(data.detail);
    } catch {}
    throw new Error(`Server error ${res.status}: ${detail}`);
  }
  return res.json();
}

const query = (params) => new URLSearchParams(params).toString();

const routes = {
  health: () => api("/health"),
  save: ({ page }) => api("/pages", { method: "POST", body: page }),
  recent: ({ limit = 20 }) => api(`/pages?${query({ limit })}`),
  lookup: ({ url }) => api(`/pages/by-url?${query({ url })}`),
  search: ({ q, limit = 10 }) => api(`/search?${query({ q, limit })}`),
  remove: ({ pageId }) => api(`/pages/${encodeURIComponent(pageId)}`, { method: "DELETE" }),
};

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const handler = routes[msg?.type];
  if (!handler) return false;
  handler(msg).then(
    (data) => sendResponse({ ok: true, data }),
    (err) => sendResponse({ ok: false, error: err.message }),
  );
  return true; // keep the channel open for the async response
});
