const DEFAULTS = { serverUrl: "http://localhost:8765", apiKey: "" };

const urlInput = document.getElementById("server-url");
const keyInput = document.getElementById("api-key");
const status = document.getElementById("options-status");

function setStatus(text, kind = "") {
  status.textContent = text;
  status.className = `status ${kind}`.trim();
}

chrome.storage.local.get(DEFAULTS).then(({ serverUrl, apiKey }) => {
  urlInput.value = serverUrl;
  keyInput.value = apiKey;
});

document.getElementById("options-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  let url;
  try {
    url = new URL(urlInput.value.trim());
  } catch {
    setStatus("That doesn't look like a valid URL.", "error");
    return;
  }

  // Localhost is granted in the manifest; any other server needs the user's
  // approval, which must be requested from this click handler.
  const granted = await chrome.permissions.request({ origins: [`${url.origin}/*`] });
  if (!granted) {
    setStatus(`Permission to contact ${url.origin} was not granted.`, "error");
    return;
  }

  await chrome.storage.local.set({ serverUrl: url.origin, apiKey: keyInput.value.trim() });
  urlInput.value = url.origin;

  const res = await chrome.runtime.sendMessage({ type: "health" });
  if (res?.ok) setStatus("Saved. Connected to the server.", "success");
  else setStatus(`Saved, but: ${res?.error ?? "no response"}`, "error");
});
