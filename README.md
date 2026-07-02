# SRT AI Translator

SRT AI Translator is a portable Windows desktop app for translating, transcribing, and extracting subtitles with Google Gemini. It wraps the [`gemini-srt-translator`](https://github.com/MaKTaiL/gemini-srt-translator) CLI in an Electron + React interface and bundles the runtime pieces needed for normal end-user use.

## What It Does

- Translate `.srt` subtitle files into many target languages, including non-Latin languages such as Hebrew.
- Translate subtitle tracks from video files after extracting the selected track.
- Detect embedded subtitle tracks and warn when the video already contains a subtitle track matching the chosen target language.
- Export text subtitle tracks to `.srt` and image/PGS subtitle tracks to `.sup`.
- Transcribe audio or video into a new `.srt` file using Gemini speech recognition.
- Search TMDB metadata and use cast/context details to improve gendered and contextual translation.
- Manage multiple Gemini API keys, validate each key independently, and use valid fallback keys when the primary key is invalid or quota-limited.
- Fetch Gemini models dynamically while keeping a curated friendly model list.
- Configure model generation options such as batch size, batch context, temperature, Top-P, Top-K, thinking level/budget, service tier, and paid-quota behavior.
- Save optional translation artifacts beside the exported SRT: token reports, progress logs, and thoughts logs.
- Use bundled FFmpeg/FFprobe in the portable build, with an optional manual FFmpeg override in Settings.
- Switch between light, dark, and automatic UI themes.

## Install

### Portable Windows Release

1. Download the latest `SRT AI Translator-<version>-portable.zip` from GitHub Releases.
2. Extract the ZIP anywhere, for example to your Desktop, a USB drive, or another folder.
3. Run `SRT AI Translator.exe` from the extracted folder.
4. Enter at least one Gemini API key in Settings.

The portable build is self-contained. End users do not need to install Node.js, Python, `gemini-srt-translator`, FFmpeg, or FFprobe separately.

Settings and API keys are stored per Windows user under `%APPDATA%`; they are not stored inside the portable ZIP.

### Gemini API Key

You need a Gemini API key from Google AI Studio:

<https://aistudio.google.com/apikey>

The app supports multiple keys. Each key can be marked as Free or Paid manually, because Google does not expose that tier through the API. The first valid key is used as the primary key, and additional valid keys can be used as fallbacks.

### Optional TMDB API Key

The app includes TMDB-powered search/context features. You can use the bundled/default TMDB behavior or provide your own TMDB key in Settings if you want your own quota.

## How To Use

### Translate an SRT

1. Open the Translate page.
2. Select an input `.srt` file.
3. Choose source language or leave it on auto-detect.
4. Choose the target language.
5. Optionally search TMDB and apply movie/TV context.
6. Choose the Gemini model and generation settings in Settings if needed.
7. Start translation.
8. Save the translated `.srt` when the run completes.

If token/progress/thoughts logging is enabled in Settings, the selected log files are copied next to the saved translated SRT.

### Translate or Export Subtitles From a Video

1. Select a video file on the Translate page.
2. If multiple subtitle tracks are available, choose the desired track.
3. If a subtitle track already matches the target language, the app warns you so you can choose whether to use the built-in subtitle instead of translating.
4. Export text subtitles as `.srt` or image/PGS subtitles as `.sup` when available.
5. Translate an extracted text subtitle track if needed.

### Transcribe Audio or Video

1. Open the Transcribe page.
2. Select an audio or video file.
3. Choose language/model settings as needed.
4. Start transcription and save the generated `.srt`.

## Settings Overview

- **Gemini API Keys**: add up to five keys, reveal/hide keys, mark each key Free/Paid, and validate them individually.
- **Fetch Models & Check API Keys**: validates keys and refreshes available Gemini models from the first valid key.
- **Model & Generation**: select model, batch size, batch context, temperature, Top-P, Top-K, thinking level, and thinking budget.
- **Quota and Service Tier**: configure paid quota behavior and Gemini service tier.
- **Logging**: enable token report (`.tokens.json`), progress log (`.progress.log`), and thoughts log (`.thoughts.log`) output.
- **FFmpeg Path**: leave empty to use bundled FFmpeg in the portable build; set a path only if you want to override it.
- **Theme**: choose Light, Dark, or Auto.

## Development

### Requirements

- Node.js 18 or newer.
- Python 3.10 or newer.
- `gemini-srt-translator` and PyInstaller when rebuilding the bundled `gst` executable.

Install dependencies and run the app in development mode:

```bash
npm install
npm run dev
```

In development mode, the app falls back to `gst` from your system PATH unless a bundled executable exists where the app expects it.

## Building

Build the Python CLI wrapper and the Windows portable package:

```bash
npm run build:python
npm run build:win
```

The Windows build output is:

```text
release/SRT AI Translator-<version>-portable.zip
```

The Electron build bundles:

- `resources/bin/gst.exe`
- `resources/bin/ffmpeg.exe`
- `resources/bin/ffprobe.exe`

PyInstaller does not cross-compile, so build the Windows executable on Windows.

## Project Layout

```text
electron/
  main/       Electron main process, IPC handlers, Python bridge, FFmpeg, TMDB, settings store
  preload/    Typed contextBridge API exposed to the renderer
  shared/     Shared TypeScript types and language data
src/
  components/ Reusable UI components, subtitle track panel, TMDB search
  lib/        Runtime hooks such as translation runner state
  pages/      Translate, Transcribe, and Settings pages
  store/      Zustand settings store
scripts/
  build_python.py  PyInstaller build for the bundled gst executable
resources/
  bin/        Local bundled runtime binaries; ignored by Git
```

## Repository Safety

The repository is configured to avoid committing local/generated data:

- `node_modules/`
- `out/`
- `release/`
- `resources/bin/`
- logs
- build caches

Do not commit Gemini API keys, TMDB keys, `.env` files, local app config, generated translations, or private subtitle/media files.
