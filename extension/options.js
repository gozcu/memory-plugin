const tokenInput = document.getElementById("token");
const saltInput = document.getElementById("salt");
const status = document.getElementById("options-status");

function setStatus(text, kind = "") {
  status.textContent = text;
  status.className = `status ${kind}`.trim();
}

chrome.storage.local.get({ token: "", salt: "" }).then(({ token, salt }) => {
  tokenInput.value = token;
  saltInput.value = salt;
});

document.getElementById("options-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  // Accept a pasted "Bearer …" header value as well as the bare token.
  const token = tokenInput.value.trim().replace(/^Bearer\s+/i, "");
  if (!token) {
    setStatus("Enter your security token.", "error");
    return;
  }
  const salt = saltInput.value.trim();
  if (!salt) {
    setStatus("Enter your password.", "error");
    return;
  }
  // The password travels as an HTTP header value, which must be printable ASCII.
  if (!/^[\x20-\x7e]+$/.test(salt)) {
    setStatus("The password can only contain plain ASCII characters.", "error");
    return;
  }

  await chrome.storage.local.set({ token, salt });
  tokenInput.value = token;
  saltInput.value = salt;
  setStatus("Testing…");

  const res = await chrome.runtime.sendMessage({ type: "health" });
  if (res?.ok) setStatus("Saved. Connected to the memory service.", "success");
  else setStatus(`Saved, but: ${res?.error ?? "no response"}`, "error");
});