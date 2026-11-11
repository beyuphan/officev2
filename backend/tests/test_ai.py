import subprocess
import sys
import time
from pathlib import Path

import pymupdf
import pytest

from localflow import extras
from localflow.modules.ai import llm
from localflow.modules.ai.index import chunk_text
from localflow.modules.ai.transcribe import to_srt, to_txt, to_vtt
from test_api import AUTH, client  # noqa: F401
from test_files import post, post_job


# ---- pure helpers -----------------------------------------------------------------------------------


def test_chunk_text_overlap_and_boundaries():
    text = ("Sentence number %d is here. " * 1) % 1
    long = " ".join(f"Sentence number {i} is here." for i in range(200))
    chunks = chunk_text(long, size=300, overlap=60)
    assert len(chunks) > 5 and all(len(c) <= 300 for c in chunks)
    assert all(c.endswith(".") for c in chunks[:-1])  # broke on sentence boundaries
    # overlap: consecutive chunks share some text so context is not cut mid-thought
    assert any(chunks[i][-20:] in chunks[i + 1] for i in range(len(chunks) - 1))
    assert chunk_text("   \n  ") == [] and chunk_text(text) == [text.strip()]


def test_subtitle_formats():
    segs = [{"start": 0.0, "end": 1.5, "text": "Merhaba"}, {"start": 3661.25, "end": 3662.0, "text": "dünya"}]
    srt = to_srt(segs)
    assert "1\n00:00:00,000 --> 00:00:01,500\nMerhaba" in srt
    assert "01:01:01,250 --> 01:01:02,000" in srt
    assert to_vtt(segs).startswith("WEBVTT\n\n") and "00:00:01.500" in to_vtt(segs)
    assert to_txt(segs) == "Merhaba\ndünya\n"


def test_llm_status_and_prompt_without_ollama(monkeypatch):
    monkeypatch.setattr(llm, "OLLAMA", "http://127.0.0.1:9")  # nothing listens here
    assert llm.status() == {"available": False, "models": []}
    res = llm.answer("q?", [{"path": "a.txt", "page": 0, "text": "x"}])
    assert res["answer"] is None and "Ollama" in res["note"]
    prompt = llm.build_prompt("Why?", [{"path": "a.pdf", "page": 3, "text": "Because."}])
    assert "[1] (a.pdf, page 3)" in prompt and prompt.endswith("Question: Why?")


def test_llm_answer_uses_first_model_when_unspecified(monkeypatch):
    calls = []

    def fake(path, payload=None, timeout=5.0):
        calls.append((path, payload))
        return {"models": [{"name": "m1"}]} if path == "/api/tags" else {"message": {"content": "42 [1]"}}

    monkeypatch.setattr(llm, "_request", fake)
    res = llm.answer("answer?", [{"path": "a", "page": 0, "text": "t"}], model="missing")
    assert res == {"answer": "42 [1]", "model": "m1"}
    assert calls[-1][1]["model"] == "m1" and calls[-1][1]["stream"] is False


# ---- API gating ------------------------------------------------------------------------------------------


def test_search_requires_embedding_model(client):
    r = post(client, "/ai/search", {"query": "anything"})
    assert r.status_code == 409 and "embed-multilingual" in r.json()["detail"]
    assert post(client, "/ai/ask", {"question": "anything"}).status_code == 409


@pytest.mark.skipif(not extras.is_installed("documents"), reason="needs the Ask your documents add-on")
def test_index_stats_empty_and_validation(client, tmp_path):
    assert client.get("/ai/index", headers=AUTH).json() == {"documents": 0, "chunks": 0, "sources": []}
    assert post(client, "/ai/index", {"paths": [str(tmp_path / "nope")]}).status_code == 404
    assert post(client, "/ai/index", {"paths": ["C:/Windows"]}).status_code == 403
    assert post(client, "/ai/transcribe", {"input": str(tmp_path / "x.wav"), "out_dir": str(tmp_path)}).status_code == 404
    f = tmp_path / "x.exe"
    f.write_bytes(b"MZ")
    assert post(client, "/ai/transcribe", {"input": str(f), "out_dir": str(tmp_path)}).status_code == 422


def test_llm_endpoint(client):
    body = client.get("/ai/llm", headers=AUTH).json()
    assert set(body) == {"available", "models"}


# ---- end to end with real models (first run downloads them) ---------------------------------------


def make_speech_wav(path: Path, text: str):
    ps = (
        "Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; "
        f"$s.SetOutputToWaveFile('{path}'); $s.Speak('{text}'); $s.Dispose()"
    )
    subprocess.run(["powershell", "-NoProfile", "-Command", ps], check=True, timeout=60)


@pytest.mark.network
@pytest.mark.skipif(sys.platform != "win32", reason="uses Windows speech synthesis to create the sample")
def test_whisper_transcribes_speech(client, tmp_path):
    wav = tmp_path / "meeting.wav"
    make_speech_wav(wav, "Hello everyone. The quarterly budget meeting starts now.")
    out = tmp_path / "out"
    job = post_job(client, "/ai/transcribe", {"input": str(wav), "out_dir": str(out), "model": "tiny", "language": "en",
                                              "formats": ["txt", "srt", "vtt"]})
    assert job["state"] == "done", job
    text = (out / "meeting.txt").read_text(encoding="utf-8").lower()
    assert "budget" in text and "meeting" in text
    assert "-->" in (out / "meeting.srt").read_text(encoding="utf-8")
    assert (out / "meeting.vtt").read_text(encoding="utf-8").startswith("WEBVTT")
    assert job["result"]["language"] == "en" and job["result"]["segments"] >= 1
    # model got installed by first use and shows up in the Model Manager
    listed = {m["id"]: m for m in client.get("/models", headers=AUTH).json()}
    assert listed["whisper-tiny"]["installed"]


@pytest.mark.network
def test_index_search_and_incremental_update(client, tmp_path):
    docs = tmp_path / "docs"
    docs.mkdir()
    (docs / "cooking.txt").write_text(
        "Domates soslu makarna yapmak için önce soğanı kavurun, sonra domates ve sarımsak ekleyin. "
        "Tuz ve karabiber ile tatlandırıp on beş dakika pişirin.", encoding="utf-8")
    (docs / "space.txt").write_text(
        "The rocket lifted off from the launch pad and reached low earth orbit eight minutes later. "
        "Mission control confirmed the satellite deployment.", encoding="utf-8")
    pdf = pymupdf.open()
    page = pdf.new_page()
    page.insert_text((72, 100), "The lease agreement requires thirty days written notice before the tenant "
                                "terminates the contract. Late rent incurs a five percent penalty.", fontsize=11)
    pdf.save(str(docs / "lease.pdf"))
    pdf.close()

    job = post_job(client, "/ai/index", {"paths": [str(docs)]})
    assert job["state"] == "done", job
    assert job["result"]["indexed"] == 3 and job["result"]["chunks"] >= 3
    stats = client.get("/ai/index", headers=AUTH).json()
    assert stats["documents"] == 3 and stats["sources"] == [str(docs)]

    def top(q, **kw):
        r = post(client, "/ai/search", {"query": q, **kw}, 200).json()
        return Path(r[0]["path"]).name, r

    assert top("how do I launch a satellite into orbit")[0] == "space.txt"
    assert top("makarna nasıl yapılır")[0] == "cooking.txt"  # cross-language: Turkish query, Turkish doc
    name, hits = top("how much notice do I have to give my landlord")
    assert name == "lease.pdf" and hits[0]["page"] == 1
    assert len(post(client, "/ai/search", {"query": "rocket", "per_document": True, "k": 3}, 200).json()) == 3

    # nothing changed: second run skips everything
    again = post_job(client, "/ai/index", {"paths": [str(docs)]})
    assert again["result"]["indexed"] == 0 and again["result"]["unchanged"] == 3

    # edit one file and delete another: index follows
    (docs / "space.txt").write_text("Gardening tips: water the tomatoes every morning and prune the roses in spring.")
    (docs / "cooking.txt").unlink()
    time.sleep(0.05)
    third = post_job(client, "/ai/index", {"paths": [str(docs)]})
    assert third["result"]["indexed"] == 1 and third["result"]["removed"] == 1
    assert top("tomatoes and roses")[0] == "space.txt"
    assert client.get("/ai/index", headers=AUTH).json()["documents"] == 2

    # /ai/ask returns sources even when no LLM is available
    ans = post(client, "/ai/ask", {"question": "what is the late rent penalty"}, 200).json()
    assert Path(ans["sources"][0]["path"]).name == "lease.pdf"
    assert "answer" in ans

    # forgetting a folder removes its entries but not the files
    assert post(client, "/ai/index/forget", {"path": str(docs)}, 200).json()["forgotten_documents"] == 2
    assert (docs / "lease.pdf").exists()
    assert client.get("/ai/index", headers=AUTH).json() == {"documents": 0, "chunks": 0, "sources": []}
