# Page Memory

A Chrome / Edge extension that saves the page you're on, together with your own
notes and tags, into a vector database so you can find it again later by meaning
rather than by exact keywords.

- `extension/` — Manifest V3 extension (the same folder loads in Chrome and Edge)
- `server/` — local FastAPI service storing pages in ChromaDB, with embeddings
  computed locally (no API keys, nothing leaves your machine)

## 1. Start the server

```bash
cd server && uv run app.py
```

The first run downloads the embedding model (~80MB). The server listens on
`http://127.0.0.1:8765` and keeps its data in `server/data/`.

Environment variables: `MEMORY_PORT`, `MEMORY_HOST`, `MEMORY_DATA_DIR`, and
`MEMORY_API_KEY` (if set, the same key must be entered in the extension's settings).

## 2. Load the extension

1. Open `chrome://extensions` (Chrome) or `edge://extensions` (Edge).
2. Turn on **Developer mode**.
3. Click **Load unpacked** and choose the `extension/` folder.

## 3. Use it

Click the toolbar icon (or press `Ctrl+Shift+M` / `Cmd+Shift+M`):

- **Save** — shows the current page, lets you add a note and tags, and stores it.
  If you have text selected you can save just the selection. Saving a URL again
  replaces the earlier version.
- **Search** — type a question or phrase to get the closest saved pages; leave it
  empty to see what you saved most recently.

The extension only reads a page when you open the popup on it (`activeTab`); it
has no standing access to your browsing.

## API

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/pages` | Save a page: `{url, title, description, text, note, tags}` |
| `GET` | `/pages?limit=` | Recently saved pages |
| `GET` | `/pages/by-url?url=` | Look up one saved page |
| `GET` | `/search?q=&limit=` | Semantic search |
| `DELETE` | `/pages/{page_id}` | Remove a page |
| `GET` | `/health` | Liveness check |
