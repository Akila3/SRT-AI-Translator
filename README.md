# SRT AI Translator

SRT AI Translator is a portable Windows desktop app for translating, transcribing, and extracting subtitles with Google Gemini. It wraps the [`gemini-srt-translator`](https://github.com/MaKTaiL/gemini-srt-translator) CLI in an Electron + React interface and bundles the runtime pieces needed for normal end-user use.

## What It Does

- Translate `.srt` and `.ass` subtitle files into many target languages, including non-Latin languages such as Hebrew. An `.ass` file keeps its styling and is saved back as `.ass`.
- Translate subtitle tracks from video files after extracting the selected track.
- Detect embedded subtitle tracks and warn when the video already contains a subtitle track matching the chosen target language.
- Export text subtitle tracks to `.srt` and image/PGS subtitle tracks to `.sup`.
- Transcribe audio or video into a new `.srt` file using Gemini speech recognition.
- Search TMDB metadata and use cast/context details to improve gendered and contextual translation.
- Manage up to five Gemini API keys ranked by validity: a run uses the two highest-ranked keys, and the rest are a reserve pool promoted automatically when a key above them turns invalid.
- Fetch the Gemini model list from your own keys, with each model labelled by what the app has actually verified — which of your keys can run it, or that it has not been checked yet.
- Configure generation options: batch size, cross-batch context, thinking level or budget (whichever the selected model supports), resume context size, service tier, and an optional custom temperature / Top-P / Top-K.
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

### What's New in 1.1.0

- Bundled engine updated to `gemini-srt-translator` 3.7.0.
- `.ass` subtitle files can be translated directly, keeping their styling.
- API keys are now ranked: a run uses the two highest-ranked valid keys and promotes a reserve key automatically when one above it fails. Settings shows each key's role and which key a run will actually use.
- The model list is built from what your own keys report, with per-model availability, instead of a curated list containing moving `-latest` aliases. A failed or partial check keeps your previous list instead of clearing it.
- The app no longer displays free-tier rate-limit figures, which Google stopped publishing; it links to the live source and to AI Studio instead.
- New options: resume context size, and a Custom Generation Parameters toggle that keeps temperature / Top-P / Top-K off unless you deliberately want them.
- Thinking controls now follow the selected model instead of being offered where the engine would ignore them.
- Settings migrate automatically and non-destructively on first launch, with a backup written beforehand.

### Upgrading From 1.0.0

Extract the new ZIP and run it; your settings and keys are picked up from `%APPDATA%` as before. Settings are migrated automatically and non-destructively — your keys, cached model list, and preferences are carried forward, and a backup of the previous settings file is written before anything changes.

One thing to expect on first launch: if your saved model was one of the old moving aliases (`gemini-flash-latest` and similar), it is remapped to a concrete model, since the app now lists only models your own keys report. Press **Fetch Models & Check API Keys** once to get the verified list.

### Gemini API Key

You need a Gemini API key from Google AI Studio:

<https://aistudio.google.com/apikey>

The app supports up to five keys, listed in priority order. Keys are ranked by the result of the last check: a run passes the two highest-ranked valid keys to the engine, and any keys below them wait as a reserve pool, promoted only when a key above becomes invalid. A key marked invalid is skipped entirely, so a dead key at the top of the list costs you nothing.

Mark each key Free or Paid yourself — Google does not expose a key's billing tier through the API. The tier of the key that is actually promoted to primary is what drives rate-limiting, and Settings shows you which key that is, so the displayed tier and the run always agree.

Note that free-tier quota is shared per Google Cloud project. Several keys created in one project do not multiply your quota; they only give you fallbacks. Google no longer publishes per-model free-tier limits, so the app links to the live rate-limit page and to AI Studio rather than quoting figures that would silently go stale.

### Optional TMDB API Key

The app includes TMDB-powered search/context features. You can use the bundled/default TMDB behavior or provide your own TMDB key in Settings if you want your own quota.

## How To Use

### Translate an SRT

1. Open the Translate page.
2. Select an input `.srt` or `.ass` file.
3. Choose source language or leave it on auto-detect.
4. Choose the target language.
5. Optionally search TMDB and apply movie/TV context.
6. Choose the Gemini model and generation settings in Settings if needed.
7. Start translation.
8. Save the translated `.srt` when the run completes.

If token/progress/thoughts logging is enabled in Settings, the selected log files are copied next to the saved translated SRT.

Subtitle files must be UTF-8. A non-UTF-8 `.srt` is converted automatically to a temporary copy, leaving your original untouched. A non-UTF-8 `.ass` is refused instead, because guessing an encoding for a styled file risks mangling its formatting — convert it to UTF-8 yourself and retry.

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

- **Gemini API Keys**: add up to five keys, reveal/hide them, mark each Free or Paid, and see each key's role (Primary, Fallback, or Reserve) and last check result.
- **Fetch Models & Check API Keys**: checks every configured key and rebuilds the model list from what those keys can actually see. A model is offered unqualified only when both keys a run would use can serve it; otherwise it is labelled "some keys only" or "unverified". If a check fails or only some keys answer, the previous list is kept rather than discarded, so a network blip never empties your picker.
- **Model & Generation**: select the model, batch size, and cross-batch context. Thinking controls follow the model — a 3.x model exposes a thinking level, a 2.5 model exposes a thinking budget, and a 2.0 model exposes neither. Custom Generation Parameters is off by default; turn it on to set temperature, Top-P, and Top-K, otherwise the engine's own defaults apply.
- **Service**: choose the Gemini service tier. Paid-quota behavior is shown here as a read-only reflection of the promoted primary key's tier, which is set per key in the API Keys section.
- **Advanced**: resume context size, streaming, and other engine-level options.
- **Logging**: enable token report (`.tokens.json`), progress log (`.progress.log`), and thoughts log (`.thoughts.log`) output.
- **FFmpeg Path**: leave empty to use bundled FFmpeg in the portable build; set a path only if you want to override it.
- **Theme**: choose Light, Dark, or Auto.

## Development

### Requirements

- Node.js 18 or newer.
- Python 3.10 or newer, only when rebuilding the bundled `gst` executable. The build script creates its own isolated `.venv-build` and installs the pinned `gemini-srt-translator` and PyInstaller versions itself, so nothing needs to be installed into your ambient Python.

Install dependencies and run the app in development mode:

```bash
npm install
npm run dev
```

In development mode, the app falls back to `gst` from your system PATH unless a bundled executable exists where the app expects it.

### Checks

```bash
npm run typecheck   # tsc for the main/preload project, then the renderer project
npm run test:gates  # settings migrations, model selection, key ranking, argv, encoding
npm run check:bin   # release preflight: the binaries a package needs are present
```

`test:gates` bundles the real main-process modules with esbuild and stubs only `electron` and `electron-store`, so a gate cannot pass against a stale copy of the logic. It prints its own assertion total on every run.

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

`build:python` asserts the engine version (currently `gemini-srt-translator` 3.7.0) before freezing, so a package can never silently ship a different engine than the UI was built against.

None of those three binaries are tracked in git, so a fresh clone has none of them. `build:win` and `build:dir` therefore run `check:bin` first, which fails the build when a binary the packaged app resolves is missing, empty, or named differently from what the target platform expects. Without it, packaging succeeds and the app only fails later, on the end user's first run.

PyInstaller does not cross-compile, so build the Windows executable on Windows.

## Project Layout

```text
electron/
  main/       Electron main process, IPC handlers, Python bridge, FFmpeg, TMDB, settings store,
              model list policy, versioned settings migrations
  preload/    Typed contextBridge API exposed to the renderer
  shared/     Types, language data, model capability rules, API key ranking
src/
  components/ Reusable UI components, subtitle track panel, TMDB search
  lib/        Runtime hooks such as translation runner state
  pages/      Translate, Transcribe, and Settings pages
  store/      Zustand settings store
scripts/
  build_python.py  PyInstaller build for the bundled gst executable
  check-bin.mjs    Release preflight for the bundled binaries
  gates/           Automated checks for migrations, model rules, key ranking and argv
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
