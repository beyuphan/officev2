"""Optional local LLM through Ollama (http://127.0.0.1:11434). Without it, search still works."""
from __future__ import annotations

import json
import urllib.error
import urllib.request

OLLAMA = "http://127.0.0.1:11434"

SYSTEM = (
    "You answer questions using ONLY the provided document excerpts. "
    "If the excerpts do not contain the answer, say you could not find it in the documents. "
    "Answer in the language of the question. Cite sources like [1], [2]."
)


def _request(path: str, payload: dict | None = None, timeout: float = 5.0) -> dict:
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(OLLAMA + path, data=data, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read())


def status() -> dict:
    try:
        tags = _request("/api/tags", timeout=2.0)
        return {"available": True, "models": [m["name"] for m in tags.get("models", [])]}
    except (urllib.error.URLError, OSError, ValueError):
        return {"available": False, "models": []}


def build_prompt(question: str, sources: list[dict]) -> str:
    excerpts = "\n\n".join(
        f"[{i}] ({s['path']}{', page ' + str(s['page']) if s['page'] else ''})\n{s['text']}"
        for i, s in enumerate(sources, 1)
    )
    return f"Document excerpts:\n\n{excerpts}\n\nQuestion: {question}"


def answer(question: str, sources: list[dict], model: str | None = None) -> dict:
    st = status()
    if not st["available"]:
        return {"answer": None, "note": "No local LLM found. Install Ollama and pull a model to get written answers."}
    if not st["models"]:
        return {"answer": None, "note": "Ollama is running but has no models. Run `ollama pull <model>`."}
    chosen = model if model in st["models"] else st["models"][0]
    try:
        res = _request(
            "/api/chat",
            {
                "model": chosen,
                "stream": False,
                "messages": [
                    {"role": "system", "content": SYSTEM},
                    {"role": "user", "content": build_prompt(question, sources)},
                ],
            },
            timeout=300.0,
        )
    except (urllib.error.URLError, OSError, ValueError) as e:
        return {"answer": None, "note": f"The local LLM did not answer: {e}"}
    return {"answer": res.get("message", {}).get("content", ""), "model": chosen}
