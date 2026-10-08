// All MCP calls go through the service worker so a save keeps running
// even if the popup is closed before the request finishes.

const MCP_URL = "https://platform.status402.io/mcp/paid/veryliz/scope/dev/gozcu";
const PROTOCOL_VERSION = "2025-03-26";

// Per-credentials connection state: the MCP session and the server's tool names.
let conn = { token: null, salt: null, sessionId: null, tools: null };
let nextId = 1;

async function getCredentials() {
  const { token, salt } = await chrome.storage.local.get({ token: "", salt: "" });
  if (!token) throw new Error("Add your security token in the extension settings first.");
  if (!salt) throw new Error("Add your salt in the extension settings first.");
  if (token !== conn.token || salt !== conn.salt) conn = { token, salt, sessionId: null, tools: null };
  return { token, salt };
}

// The server may answer with plain JSON or with an SSE stream of JSON-RPC messages.
async function readRpcResponse(res, id) {
  const text = await res.text();
  if (!(res.headers.get("content-type") ?? "").includes("text/event-stream")) {
    return text ? JSON.parse(text) : null;
  }
  for (const event of text.split(/\r?\n\r?\n/)) {
    const data = event
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!data) continue;
    try {
      const msg = JSON.parse(data);
      if (msg.id === id) return msg;
    } catch {}
  }
  return null;
}

async function post(message) {
  const { token, salt } = await getCredentials();
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    Authorization: `Bearer ${token}`,
    "x-secret-key": salt,
  };
  if (conn.sessionId) headers["Mcp-Session-Id"] = conn.sessionId;

  let res;
  try {
    res = await fetch(MCP_URL, { method: "POST", headers, body: JSON.stringify(message) });
  } catch {
    throw new Error("Can't reach the memory service. Check your connection.");
  }
  if (res.status === 401) {
    throw new Error("The security token or salt was rejected. Check them in the extension settings.");
  }
  if (res.status === 402) {
    throw new Error("Payment required: check your balance at status402.io.");
  }
  if (!res.ok) {
    // A 403 can come from the service itself (JSON) or from the firewall in
    // front of it (HTML), so keep whatever the body says.
    const body = await res.text().catch(() => "");
    let detail = body.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 300) || res.statusText;
    try {
      const data = JSON.parse(body);
      detail = data.error?.message ?? data.error ?? data.detail ?? detail;
      if (typeof detail !== "string") detail = JSON.stringify(detail);
    } catch {}
    const step = message.params?.name ?? message.method;
    const err = new Error(`Memory service error ${res.status} on ${step}: ${detail}`);
    err.status = res.status;
    throw err;
  }
  return res;
}

async function rpc(method, params) {
  const id = nextId++;
  const res = await post({ jsonrpc: "2.0", id, method, params });
  const msg = await readRpcResponse(res, id);
  if (!msg) throw new Error("The memory service sent an empty response.");
  if (msg.error) throw new Error(msg.error.message ?? "The memory service returned an error.");
  return { result: msg.result, res };
}

async function connect() {
  await getCredentials();
  if (conn.tools) return;
  const { res } = await rpc("initialize", {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: "page-memory", version: chrome.runtime.getManifest().version },
  });
  conn.sessionId = res.headers.get("mcp-session-id");
  await post({ jsonrpc: "2.0", method: "notifications/initialized" });
  const { result } = await rpc("tools/list", {});
  conn.tools = (result?.tools ?? []).map((tool) => tool.name);
}

// Tool names may carry a server prefix (e.g. "p1-gozcu-memorise").
function findTool(base) {
  return conn.tools.find((name) => name === base || new RegExp(`[-_.]${base}$`).test(name));
}

async function callToolOnce(base, args) {
  await connect();
  const name = findTool(base);
  if (!name) throw new Error(`The memory service doesn't offer a "${base}" tool.`);
  const { result } = await rpc("tools/call", { name, arguments: args });
  const text = (result?.content ?? [])
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
  if (result?.isError) throw new Error(text || `"${base}" failed.`);
  if (result?.structuredContent) return { name, payload: result.structuredContent };
  try {
    return { name, payload: JSON.parse(text) };
  } catch {
    return { name, payload: text };
  }
}

async function callTool(base, args) {
  try {
    return await callToolOnce(base, args);
  } catch (err) {
    // An expired session is answered with 404 (or 400); reconnect once.
    if (!conn.sessionId || (err.status !== 404 && err.status !== 400)) throw err;
    conn = { ...conn, sessionId: null, tools: null };
    return callToolOnce(base, args);
  }
}

// Tools answer with a run: search and delete finish inside the call, while
// memorise only starts the run and finishes on the service some minutes later.
async function runTool(base, args) {
  const { payload } = await callTool(base, args);
  if (["failed", "error"].includes(payload?.state)) {
    throw new Error(`"${base}" failed on the memory service.`);
  }
  const failure = findFailure(payload);
  if (failure) throw new Error(`"${base}" failed on the memory service: ${failure}`);
  return payload;
}

// A run can complete while a step inside it was refused by the backend (e.g. a
// 422 when the salt can't decrypt a memory); that only shows in the step's result.
function findFailure(value) {
  if (!value || typeof value !== "object") return null;
  if (typeof value.status_code === "number" && value.status_code >= 400) {
    const detail = value.body?.error ?? value.body?.detail ?? value.body ?? "";
    return `${value.status_code} ${typeof detail === "string" ? detail : JSON.stringify(detail)}`.trim();
  }
  for (const child of Object.values(value)) {
    const found = findFailure(child);
    if (found) return found;
  }
  return null;
}

// The run returns the matching memories as a plain list of content strings,
// best match first; there is no id, date or distance to go with them.
function toResults(payload) {
  const list = payload?.return_value;
  if (!Array.isArray(list)) return [];
  return list
    .map((item) => (typeof item === "string" ? { content: item } : item))
    .filter((item) => item && typeof item.content === "string");
}

const routes = {
  health: async () => {
    conn = { token: null, salt: null, sessionId: null, tools: null };
    await connect();
    const missing = ["memorise", "recollect", "forget"].filter((base) => !findTool(base));
    if (missing.length) throw new Error(`The memory service is missing: ${missing.join(", ")}.`);
    return { status: "ok" };
  },
  save: async ({ content, metadata }) => {
    await runTool("memorise", { content, metadata: JSON.stringify(metadata) });
    return { saved: true };
  },
  search: async ({ q }) => {
    const results = toResults(await runTool("recollect", { query: q }));
    // Kept for the browser session (in memory only) so the popup can show the
    // last search again after it has been closed.
    await chrome.storage.session.set({ lastSearch: { q, results } });
    return { results };
  },
  remove: async ({ memoryId }) => {
    await runTool("forget", { memory_id: memoryId });
    return { deleted: true };
  },
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