"""Page Memory server: stores pages sent by the browser extension in ChromaDB.

Each saved page becomes one "head" chunk (title, description and the user's
note) plus N "body" chunks of page text. Search runs over all chunks and
collapses the hits back to pages.
"""

import hashlib
import os
import re
import time
from contextlib import asynccontextmanager
from pathlib import Path

import chromadb
import uvicorn
from fastapi import Depends, FastAPI, Header, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

DATA_DIR = Path(os.environ.get("MEMORY_DATA_DIR", Path(__file__).parent / "data"))
API_KEY = os.environ.get("MEMORY_API_KEY", "")
HOST = os.environ.get("MEMORY_HOST", "127.0.0.1")
PORT = int(os.environ.get("MEMORY_PORT", "8765"))

# Both Chrome and Edge send extension requests with a chrome-extension:// origin.
EXTENSION_ORIGIN = re.compile(r"^(chrome-)?extension://[a-z0-9]+$")

CHUNK_SIZE = 1000
CHUNK_OVERLAP = 150
MAX_TEXT_CHARS = 500_000

client = chromadb.PersistentClient(path=str(DATA_DIR))
collection = client.get_or_create_collection("pages", metadata={"hnsw:space": "cosine"})


@asynccontextmanager
async def lifespan(_app: FastAPI):
    # Chroma downloads its embedding model (~80MB) on first use; do it at
    # startup rather than during the first save.
    print("Loading embedding model (first run downloads it)...", flush=True)
    collection.query(query_texts=["warm up"], n_results=1)
    print(f"Ready. {collection.count()} chunks stored in {DATA_DIR}", flush=True)
    yield


app = FastAPI(title="Page Memory", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=EXTENSION_ORIGIN.pattern,
    allow_methods=["*"],
    allow_headers=["*"],
)


def guard(origin: str | None = Header(None), authorization: str | None = Header(None)):
    # Browsers attach Origin to cross-origin requests, so this stops arbitrary
    # web pages from reading or writing the store through localhost.
    if origin and not EXTENSION_ORIGIN.match(origin):
        raise HTTPException(403, "Origin not allowed")
    if API_KEY and authorization != f"Bearer {API_KEY}":
        raise HTTPException(401, "Invalid or missing API key")


class PageIn(BaseModel):
    url: str = Field(min_length=1, max_length=4000)
    title: str = Field("", max_length=1000)
    description: str = Field("", max_length=5000)
    text: str = Field("", max_length=MAX_TEXT_CHARS)
    note: str = Field("", max_length=20_000)


def page_id_for(url: str) -> str:
    return hashlib.sha256(url.encode()).hexdigest()[:16]


def chunk_text(text: str) -> list[str]:
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n\s*\n+", "\n\n", text).strip()
    chunks, start = [], 0
    while start < len(text):
        end = min(start + CHUNK_SIZE, len(text))
        if end < len(text):
            # Prefer to break on a line or sentence boundary in the second half.
            floor = start + CHUNK_SIZE // 2
            cut = max(text.rfind("\n", floor, end), text.rfind(". ", floor, end))
            if cut != -1:
                end = cut + 1
        chunks.append(text[start:end].strip())
        if end >= len(text):
            break
        start = end - CHUNK_OVERLAP
    return [c for c in chunks if c]


def to_result(meta: dict, snippet: str, score: float | None = None) -> dict:
    return {
        "page_id": meta["page_id"],
        "url": meta["url"],
        "title": meta["title"],
        "note": meta["note"],
        "saved_at": meta["saved_at"],
        "snippet": snippet,
        "score": score,
    }


def snippet_of(meta: dict, document: str) -> str:
    if meta["kind"] == "head":
        return meta["description"]
    # Body chunks are stored as "<title>\n<chunk>".
    return document[len(meta["title"]) + 1 :]


@app.get("/health")
def health():
    return {"status": "ok", "auth_required": bool(API_KEY)}


@app.post("/pages", dependencies=[Depends(guard)])
def save_page(page: PageIn):
    page_id = page_id_for(page.url)
    title = page.title.strip() or page.url
    meta = {
        "page_id": page_id,
        "url": page.url,
        "title": title,
        "description": page.description.strip(),
        "note": page.note.strip(),
        "saved_at": int(time.time()),
    }

    head = "\n".join(part for part in (title, meta["description"], meta["note"]) if part)
    documents = [head] + [f"{title}\n{chunk}" for chunk in chunk_text(page.text)]
    metadatas = [
        {**meta, "kind": "head" if i == 0 else "body", "chunk_index": i}
        for i in range(len(documents))
    ]
    ids = [f"{page_id}:{i}" for i in range(len(documents))]

    # Saving the same URL again replaces the previous version.
    collection.delete(where={"page_id": page_id})
    collection.add(ids=ids, documents=documents, metadatas=metadatas)
    return {"page_id": page_id, "chunks": len(documents)}


@app.get("/pages", dependencies=[Depends(guard)])
def list_pages(limit: int = Query(20, ge=1, le=200)):
    got = collection.get(where={"kind": "head"}, include=["metadatas"])
    metas = sorted(got["metadatas"], key=lambda m: m["saved_at"], reverse=True)
    return {"results": [to_result(m, m["description"]) for m in metas[:limit]]}


@app.get("/pages/by-url", dependencies=[Depends(guard)])
def get_page(url: str):
    got = collection.get(ids=[f"{page_id_for(url)}:0"], include=["metadatas"])
    if not got["metadatas"]:
        return {"page": None}
    meta = got["metadatas"][0]
    return {"page": to_result(meta, meta["description"])}


@app.get("/search", dependencies=[Depends(guard)])
def search(q: str = Query(min_length=1, max_length=2000), limit: int = Query(10, ge=1, le=50)):
    total = collection.count()
    if total == 0:
        return {"results": []}
    # Over-fetch chunks so several hits on one page still leave `limit` pages.
    hits = collection.query(
        query_texts=[q],
        n_results=min(limit * 5, total),
        include=["documents", "metadatas", "distances"],
    )
    results: dict[str, dict] = {}
    for doc, meta, dist in zip(hits["documents"][0], hits["metadatas"][0], hits["distances"][0]):
        if meta["page_id"] not in results:  # hits arrive best-first
            results[meta["page_id"]] = to_result(meta, snippet_of(meta, doc), round(1 - dist, 4))
    return {"results": list(results.values())[:limit]}


@app.delete("/pages/{page_id}", dependencies=[Depends(guard)])
def delete_page(page_id: str):
    collection.delete(where={"page_id": page_id})
    return {"deleted": page_id}


if __name__ == "__main__":
    uvicorn.run(app, host=HOST, port=PORT)
