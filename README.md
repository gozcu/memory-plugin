# Page Memory

A Chrome / Edge extension that saves the page you're on, together with your own
notes, into your status402 memory so you can find it again later by meaning
rather than by exact keywords.

- `extension/` — Manifest V3 extension (the same folder loads in Chrome and Edge)
- `server/` — the earlier local FastAPI + ChromaDB backend; the extension no
  longer talks to it

## 1. Get a security token and choose a password

Tokens are issued at [status402.io](https://status402.io). The extension talks
to a fixed MCP endpoint and sends the token as a `Bearer` header:

```
https://platform.status402.io/mcp/paid/veryliz/scope/dev/gozcu/group/memory
```

Every request also carries your password in the `x-secret-key` header. Both the
token and the password are required.

The password encrypts everything you save, and only the same password can
decrypt it. It can't be recovered or reset: memories saved with a password you
lose or change stay unreadable.

## 2. Load the extension

1. Open `chrome://extensions` (Chrome) or `edge://extensions` (Edge).
2. Turn on **Developer mode**.
3. Click **Load unpacked** and choose the `extension/` folder.
4. Open the extension's settings (⚙ in the popup), paste your security token and
   password, and click **Save and test connection**.

## 3. Use it

Click the toolbar icon (or press `Ctrl+Shift+M` / `Cmd+Shift+M`):

- **Save** — shows the current page, asks for a short description (at
  least three words), and stores it.
- **Search** — type a question or phrase to get the closest memories. Results
  show one at a time as a carousel, each with the whole memory; swipe or use
  the arrows to move between them. Results
  can't be deleted from there for now: search no longer returns memory ids.

The extension only reads a page when you open the popup on it (`activeTab`); it
has no standing access to your browsing.

## MCP tools

| Tool | Used for | Arguments |
| --- | --- | --- |
| `memorise` | Save a page | `content`, `metadata` (JSON string) |
| `recollect` | Search | `query` |
| `forget` | Delete a memory | `memory_id` |

Tool names are matched by suffix, so a server prefix (`p1-gozcu-memorise`) works
too. `memorise` is asynchronous: the service accepts the page and stores it in
the background, so a new memory shows up in search a few minutes after saving.
`recollect` answers within the call, typically in about 30 seconds.

Search returns only a memory's content, so each saved page is stored as one
memory whose content is a header block — title, URL and a `Note: …` line with
your description. The page text itself is not sent. Memories without that
header (saved by other clients) are shown as plain text.
