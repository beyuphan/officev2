🌊 officev2

The Ultimate Desktop Productivity, Local AI, and File Assistant for Power Users.

officev2 is a modular desktop application built with Tauri and Python (FastAPI). It brings together powerful tools—from offline AI capabilities and deep system automation to developer utilities and PDF manipulation—all running locally on your machine without relying on external cloud APIs. Windows is the primary target platform; see the "Platform Support" section.

Read this in Turkish (Türkçe): [README-tr.md](README-tr.md)

## Project status

Implemented and covered by tests (86 backend, 27 UI unit, 31 end-to-end checks, 9 Rust): PDF (merge, extract, organize, encrypt/unlock, watermark, redact, compress, metadata cleaner, PDF to Word, Office to PDF, OCR), image and video conversion, background removal, speech transcription, document index with search and optional Ollama answers, Vault, bulk rename, temp/dev-junk/duplicate cleanup with quarantine, disk map, Autopilot rules, undo log, job progress and cancel, Model Manager, command palette, clipboard history (text and images), page preview in every PDF tool, color picker, pin image, text capture from screen, Dev Lab, Clean Paste, Scratchpad.

Not done yet: Upscaler needs a manual install of a third-party binary from the Models screen (not yet checksum-pinned); LocalDrop and the Local Exposer; clipboard encryption at rest; production packaging of the Python sidecar (development layout only); macOS and Linux support; Pin-to-Screen, color picker and text capture were verified through mocked commands and Rust unit tests, not by driving the real overlay windows.

✨ Features

1. 📄 Comprehensive PDF & Document Studio

Bi-directional Format Converter: Convert PDFs to editable PPTX, DOCX, XLSX and Office files back to PDF. Fidelity for complex layouts is best-effort (see the "Dependencies & Honest Limitations" section).

Smart OCR (Image-to-Text): Extract selectable and searchable text from scanned documents or unselectable PDFs.

PDF Split & Merge: Extract specific pages from massive PDFs or merge multiple documents with drag-and-drop.

Encrypt & Unlock: Apply AES encryption to documents or remove restrictions (copy/print locks) from PDFs whose password you know.

Watermark & Signature Injection: Inject transparent logos, "CONFIDENTIAL" stamps, or digital signatures at specific X-Y coordinates. Includes a built-in Quick Asset Library—a persistent mini-drawer for frequently used logos, signatures, and icons.

2. 🎨 Media & Image Processing Hub

Offline Background Remover: Strip backgrounds from images to create transparent PNGs instantly using local AI power.

Offline AI Upscaler: Enhance low-resolution or blurry images up to 4X using local AI models (e.g., Real-ESRGAN).

Bulk Media Compressor & Converter: Compress entire folders of heavy images/videos and convert them to modern formats (WebP, MP4) in bulk.

Live Text (Screen OCR): Select any area on your screen (videos, protected websites) and copy the text instantly.

3. 🧠 Local AI & Privacy

Offline Voice Transcription (Local Whisper): Transcribe meeting or lecture recordings locally into text/SRT formats without sending data to the cloud.

Privacy-Focused Document Chat (Local RAG): Chat with your sensitive PDFs and contracts using a local vector index and a local LLM. Works completely offline.

Encrypted Local Vault: An encrypted virtual folder for sensitive files (ID copies, SSH/PEM keys) accessible only via a master password. Uses Argon2id key derivation and AES-256-GCM, with a mandatory recovery key (losing both the password and the recovery key means the data is unrecoverable).

4. ⚙️ Smart File & System Automation

Downloads Autopilot: Monitors your Downloads folder and automatically routes files to specific folders based on extension or content. Will be built on top of the general Rule Engine (see Planned Core Features).

Bulk Renamer: Rename hundreds of files in seconds using specific rules or Regex formats, with a live preview.

Silent System Cleaner: Schedules background cleaning of OS temp files, app caches, and the recycle bin.

Dev-Junk Sweeper: Scans your disk for forgotten node_modules, __pycache__, or dangling Docker images and reclaims gigabytes of space.

Visual Storage Mapper: Displays an interactive Treemap visualization of your disk to identify exactly which folders are taking up space.

🛡️ Safety rules for every destructive feature (Cleaner, Sweeper, Autopilot, Renamer):
- Dry-run preview before anything is changed or removed.
- Files go to the Recycle Bin / a quarantine folder instead of being permanently deleted.
- Per-feature exclusion lists.
- Every operation is written to an Undo Log so it can be reverted.

5. 🛠️ Developer & Design Tools

Infinite Clipboard Manager: Keeps a history of your last 100 copied texts, snippets, or images, accessible via a quick UI. Includes:
- Smart Preview: color blocks next to HEX/RGB codes and the site name next to URLs (no favicon is downloaded, so copying a link never contacts that site).
- Clean Paste: removes line breaks from text copied out of PDFs and pastes it as one continuous paragraph.
- Scratchpad: a volatile note area for temporary pastes—no "Do you want to save?" prompts.
- Privacy: content flagged by password managers (Windows' `ExcludeClipboardContentFromMonitorProcessing` format) is never recorded. The history is plain text in a local SQLite file for now; encryption at rest is planned. Text only; images are not captured yet.

On-Screen Color Detective: A system-wide eyedropper tool to copy HEX/RGB codes from any pixel on your screen.

Pin-to-Screen: Pin reference images, invoices, or drafts as a transparent, "always-on-top" mini window.

6. 🧭 Planned Core Features

These are not implemented yet; they are design priorities because they tie the rest together.

Command Palette: A global launcher (e.g. `Ctrl+Space`) that reaches every tool from one place.

Rule Engine: A generic `trigger → condition → action` system (e.g. "new PDF in Downloads → OCR → move to Documents"). Downloads Autopilot becomes one preset.

Shared Index Service: One file watcher + embedding + vector store used by both Local RAG and Semantic File Search.

Model Manager: Download, size, GPU detection, and removal of AI models (Whisper, Real-ESRGAN, rembg, LLM/embedding models). Keeps the base installer small.

Undo / Operation History: Unified history for all file operations.

Explorer Context Menu: Right-click → "Compress / OCR / Merge with officev2".

More PDF & privacy tools: PDF compression, page reorder/rotate, true content redaction, EXIF/PDF metadata cleaner.

Duplicate File Finder: Hash-based, integrated with the Storage Mapper and Cleaner.

Local translation & summarization using the already-installed local models.

7. 🧪 Experimental / Optional

These features have network or security implications and are opt-in only.

LocalDrop (Network File Tosser): Send large files to other devices on the same Wi-Fi network using a temporary local server—no internet required. Requires device pairing/PIN and TLS. May adopt an existing open protocol (e.g. LocalSend) instead of a custom one.

One-Click Local Exposer: Expose a local project (e.g., localhost:3000) via a temporary public URL. Needs a third-party relay (e.g. cloudflared), so it is explicitly outside the "no cloud" guarantee, and it must never be able to expose officev2's own API.

🖥️ Platform Support

| Feature area | Windows | macOS | Linux |
|---|---|---|---|
| PDF, Media, Local AI, Vault, File automation | Primary | Planned | Planned |
| Color picker, Pin-to-Screen, Live Text, Clipboard hooks | Primary | Planned (needs per-OS code) | Planned (X11/Wayland differences) |
| System Cleaner (temp/recycle bin paths) | Primary | Planned | Planned |

📦 Dependencies & Honest Limitations

- OCR: on Windows, the built-in Windows OCR is used when an OCR language pack is installed (accurate for Turkish and other languages with diacritics). Otherwise the bundled RapidOCR (ONNX) is used, which works offline everywhere but drops Turkish diacritics (for example `Çalışma` becomes `Calisma`).
- Office → PDF requires LibreOffice (or Microsoft Office on Windows). PDF → DOCX/PPTX/XLSX is lossy for complex layouts.
- Video compression and conversion requires ffmpeg (bundled).
- Local AI features need disk space for models and benefit from a GPU; models are downloaded on first use, not at install time.

🏗️ Architecture & Tech Stack

officev2 uses a separated frontend-backend architecture running entirely on the localhost. System-level tasks live in the Rust (Tauri) layer; heavy compute lives in an on-demand Python sidecar. See [ARCHITECTURE.md](ARCHITECTURE.md) for details.

Shell (Rust / Tauri): tray, global hotkeys, clipboard, screen capture, file watching, disk scanning, sidecar supervision, updater.

Frontend (UI): React (Vite), TailwindCSS, TypeScript. (Provides a native, lightweight, "Quiet Luxury" dark mode interface).

Backend (Engine): Python, FastAPI, Uvicorn—bound to `127.0.0.1` on a random port and protected by a per-session token.

Core Libraries: PyMuPDF (PDFs), OpenCV / rembg (Image Processing), RapidOCR / pytesseract (OCR), faster-whisper (Transcription), llama.cpp or Ollama (local LLM).

Database: SQLite for settings, rules, clipboard history, jobs and the undo log; `sqlite-vec` (or LanceDB) for the vector index used by Local RAG and semantic search.

🚀 Installation & Development

# 1. Clone the repository
git clone https://github.com/beyuphan/officev2.git

# 2. Setup Python Backend
cd officev2/backend
python -m venv venv
source venv/bin/activate  # On Windows: venv\Scripts\activate
pip install -r requirements.txt
# Dev only: fixed port and a fixed token. In production Tauri picks a random port and token.
LOCALFLOW_DEV_TOKEN=dev uvicorn main:app --reload --host 127.0.0.1 --port 8000

# 3. Setup Tauri Frontend
cd ../frontend
npm install
npm run tauri dev


🗺️ Roadmap

[ ] Core: Command Palette, Rule Engine, Job Manager, Model Manager, Undo Log.

[ ] Semantic File Explorer: AI-powered visual and document search based on context, not just file names (built on the Shared Index Service).

[ ] Offline Dev Lab: Local tools to beautify JSON, decode JWTs, and format SQL without using insecure web tools.
