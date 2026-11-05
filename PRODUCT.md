# Product


> Drawn from README.md / README-tr.md / ARCHITECTURE.md. Every fact below is labeled by source, none was confirmed in conversation except Stack.

## Platform

web

## Stack

Tauri 2 (Rust shell) + React 19 + Vite + TypeScript, plain CSS. Python FastAPI sidecar on localhost. Confirmed by the existing codebase. Tailwind is mentioned in the README but not installed.

## Users

Power users on Windows (primary platform) who want many small desktop utilities in one local app: PDF work, media processing, local AI, file automation, clipboard. Developers are an explicit sub-audience. The user of this repo is Turkish-speaking; the UI is English today, with TR/EN i18n planned. (inferred from README)

## Product Purpose

A modular, offline-first desktop toolbox. Everything runs on the user's machine with no cloud API. Success: a task such as merging PDFs or cleaning a folder is done in seconds, safely, and can be undone. (README)

## Positioning

Local-only and reversible: heavy tools (OCR, Whisper, RAG, PDF studio) in one app without sending files anywhere, and every destructive file operation is previewable and undoable via an undo log. (ARCHITECTURE.md)

## Operating Context

Long-lived desktop app with tray, global hotkeys and a command palette (planned). Sessions are short, task-driven bursts: pick files, run, check result. Work is queued as jobs with history. (ARCHITECTURE.md)

## Capabilities and Constraints

- Implemented now: a full PDF editor and page tools, a photo editor, image and video tools, speech-to-text, document search, vault, file tools with undo, clipboard history, screen tools. See README.md.
- Planned: command palette, rule engine, media tools, clipboard manager, local RAG, vault, model manager.
- Constraints: offline; the UI talks to the sidecar over HTTP with a bearer token; file paths are limited to user-approved roots; destructive actions need dry-run and undo.
- Terminology used in code: Job, Activity, Undo, Module.

## Brand Commitments

Name: officev2. The README says "Quiet Luxury" dark mode and "native feeling, minimalist". The user explicitly rejected the first UI as looking AI-generated (emoji, blue accent, pill badges, centered cards).

## Evidence on Hand

No logo, screenshots, testimonials or user data exist. Do not invent any.

## Product Principles

1. Local and private by default; the UI should make that visible and never imply a cloud.
2. Reversible: every file operation shows what will happen and can be undone.
3. Fast to scan and repeat: dense, predictable tools beat showpiece screens.
4. One shell, many small modules: new tools must fit the same pattern without new UI inventions.

## Accessibility & Inclusion

No product-specific requirement stated. Keyboard operability and sufficient contrast expected from the craft floor.
