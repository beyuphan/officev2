"""Local speech-to-text with faster-whisper."""
from __future__ import annotations

from pathlib import Path

from ... import jobctl, models
from ..files.ops import unique_path

AUDIO_VIDEO_EXTS = {".wav", ".mp3", ".m4a", ".flac", ".ogg", ".opus", ".aac", ".wma",
                    ".mp4", ".mkv", ".mov", ".avi", ".webm", ".m4v"}


def _ts(seconds: float, sep: str) -> str:
    ms = int(round(seconds * 1000))
    h, ms = divmod(ms, 3_600_000)
    m, ms = divmod(ms, 60_000)
    s, ms = divmod(ms, 1000)
    return f"{h:02d}:{m:02d}:{s:02d}{sep}{ms:03d}"


def to_srt(segments: list[dict]) -> str:
    return "\n".join(
        f"{i}\n{_ts(s['start'], ',')} --> {_ts(s['end'], ',')}\n{s['text']}\n" for i, s in enumerate(segments, 1)
    )


def to_vtt(segments: list[dict]) -> str:
    body = "\n".join(f"{_ts(s['start'], '.')} --> {_ts(s['end'], '.')}\n{s['text']}\n" for s in segments)
    return "WEBVTT\n\n" + body


def to_txt(segments: list[dict]) -> str:
    return "\n".join(s["text"] for s in segments) + "\n"


WRITERS = {"srt": to_srt, "vtt": to_vtt, "txt": to_txt}


def _decode_audio(path: Path):
    """Decode any audio/video file to 16 kHz mono float32 with the system ffmpeg."""
    import shutil
    import subprocess

    import numpy as np

    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        raise ValueError("ffmpeg was not found. Install ffmpeg and make sure it is on PATH.")
    proc = subprocess.run(
        [ffmpeg, "-nostdin", "-loglevel", "error", "-i", str(path), "-vn", "-ac", "1", "-ar", "16000", "-f", "f32le", "-"],
        capture_output=True,
    )
    if proc.returncode != 0 or not proc.stdout:
        raise ValueError("could not read audio: " + proc.stderr.decode(errors="replace").strip()[-200:])
    return np.frombuffer(proc.stdout, dtype=np.float32)


def _run_model(model_dir: Path, audio, language: str | None, device: str, compute: str) -> tuple[list[dict], dict]:
    from ... import extras

    extras.require("speech")
    from faster_whisper import WhisperModel

    model = WhisperModel(str(model_dir), device=device, compute_type=compute)
    seg_iter, info = model.transcribe(audio, language=language, vad_filter=True, beam_size=5)
    total = info.duration or 0.0
    segments = []
    for seg in seg_iter:
        jobctl.check()
        segments.append({"start": seg.start, "end": seg.end, "text": seg.text.strip()})
        jobctl.report(min(seg.end, total), total, "transcribing")
    return segments, {"language": info.language, "duration": total, "device": device}


def transcribe(
    input_path: str,
    out_dir: str,
    data_dir: str,
    model: str = "small",
    language: str | None = None,
    formats: list[str] | None = None,
    device: str = "auto",
) -> dict:
    formats = formats or ["txt", "srt"]
    for f in formats:
        if f not in WRITERS:
            raise ValueError(f"unsupported format '{f}'")
    src = Path(input_path)
    if src.suffix.lower() not in AUDIO_VIDEO_EXTS:
        raise ValueError(f"unsupported file type '{src.suffix}'")
    model_dir = models.ensure(data_dir, f"whisper-{model}")
    jobctl.report(0, 1, "decoding audio")
    audio = _decode_audio(src)

    # GPU when it works, otherwise CPU. A broken CUDA setup must not fail the whole job.
    attempts = [("cuda", "float16"), ("cpu", "int8")] if device == "auto" else [(device, "float16" if device == "cuda" else "int8")]
    last_error: Exception | None = None
    segments, meta = [], {}
    for dev, compute in attempts:
        try:
            if dev == "cuda":
                import ctranslate2

                if ctranslate2.get_cuda_device_count() == 0:
                    continue
            segments, meta = _run_model(model_dir, audio, language, dev, compute)
            last_error = None
            break
        except jobctl.Cancelled:
            raise
        except Exception as e:
            last_error = e
    if last_error is not None:
        raise ValueError(f"transcription failed: {last_error}")

    base = Path(out_dir)
    base.mkdir(parents=True, exist_ok=True)
    created = []
    for fmt in formats:
        dest = unique_path(base / f"{src.stem}.{fmt}")
        dest.write_text(WRITERS[fmt](segments), encoding="utf-8")
        created.append(str(dest))
    return {"outputs": created, "created": created, "segments": len(segments), **meta}
