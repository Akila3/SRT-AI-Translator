# SRT AI Translation UI — Architecture & Workflow (Current State)

> **What this is:** An Electron + React/TypeScript desktop app that wraps the
> `gemini-srt-translator` ("**gst**") Python CLI in a modern UI: subtitle
> translation, audio/video transcription, settings management, TMDB-powered
> context enrichment, and embedded-subtitle-track detection/extraction.
>
> **Why this doc exists:** It is the up-to-date, source-of-truth snapshot of how
> the app is actually built today (not the original design intent), meant to be
> carried into a hard-fork ("New Gen") so the fork starts with full context.
>
> **Status:** Working. Produces a fully portable Windows build
> (`release\SRT AI Translator-1.0.0-portable.zip`, ~190 MB) that bundles Python
> (via PyInstaller), FFmpeg, and FFprobe — end users install nothing.

---

## 1. Tech Stack

- **Shell/build:** `electron-vite` (Vite-based main/preload/renderer build), `electron-builder` (packaging → portable `zip`).
- **UI:** React 18 + TypeScript, Tailwind CSS (class-based dark mode), hand-rolled component library in `src/components/ui.tsx` (no shadcn).
- **State:** Zustand (`src/store/useStore.ts`) for in-session settings mirror; `electron-store` for persistence (main process).
- **Engine:** `gemini-srt-translator` CLI invoked via Node `child_process.spawn`; stdout/stderr streamed line-by-line to the renderer over IPC.
- **External tools:** FFmpeg/FFprobe (bundled) for subtitle-track probing/extraction; TMDB REST API for cast/genre context.

---

## 2. Project Structure (actual)

```
SRT AI Translation UI/
├── package.json                 # scripts + electron-builder "build" config
├── electron.vite.config.ts
├── tailwind.config.js / postcss.config.js
├── tsconfig*.json
├── scripts/
│   ├── build_python.py          # PyInstaller → resources/bin/gst[.exe]
│   └── gst_entry.py             # PyInstaller entry shim (imports cli.main)
├── resources/bin/               # bundled binaries (NOT in npm/git-LFS):
│   ├── gst.exe   (~20 MB)       #   frozen gemini-srt-translator CLI
│   ├── ffmpeg.exe (~102 MB)
│   └── ffprobe.exe (~102 MB)
├── electron/
│   ├── main/
│   │   ├── index.ts             # window creation, app lifecycle
│   │   ├── ipc.ts               # ALL ipcMain handlers
│   │   ├── store.ts             # electron-store defaults + migrations
│   │   ├── pythonBridge.ts      # spawn gst, build args, UTF-8 input, key ordering
│   │   ├── modelsList.ts        # list-models, friendly names, key validation
│   │   ├── ffmpeg.ts            # probe/extract tracks, PATH/env helpers
│   │   └── tmdb.ts              # TMDB search + details/cast
│   ├── preload/
│   │   └── index.ts             # contextBridge → window.api (typed)
│   └── shared/
│       ├── types.ts             # all shared interfaces (AppSettings, args, etc.)
│       └── languages.ts         # 80-language table + gstName + ISO-639 normalize
└── src/
    ├── main.tsx / App.tsx       # tab shell (Translate / Transcribe / Settings) + theme
    ├── pages/
    │   ├── TranslatePage.tsx
    │   ├── TranscribePage.tsx
    │   └── SettingsPage.tsx
    ├── components/
    │   ├── ui.tsx               # Button, Select, NumberInput, Toggle, Tooltip, LogPanel, …
    │   ├── SubTrackPanel.tsx    # embedded subtitle-track UI + warnings
    │   └── TmdbSearch.tsx       # autocomplete search + cast card + description
    ├── data/
    │   ├── languages.ts         # SOURCE_LANGUAGES / TARGET_LANGUAGES (re-exported)
    │   └── freeTier.ts          # free-tier rate-limit table, THINKING_LEVELS, tooltips
    ├── lib/useRunner.ts         # run lifecycle: stream parsing, progress, token stats
    └── store/useStore.ts        # Zustand store (load/patch settings, setModels)
```

---

## 3. Process Model & Data Flow

```mermaid
flowchart TD
    R["Renderer (React)"]
    P["Preload (contextBridge → window.api)"]
    M["Main process (ipc.ts)"]
    S["electron-store (config.json in userData)"]
    G["gst subprocess (translate/transcribe/list-models)"]
    F["ffmpeg / ffprobe subprocess"]
    T["TMDB REST API"]
    Tmp["userData/temp/*.srt"]

    R -->|invoke| P --> M
    M --> S
    M -->|spawn + env(PATH,UTF8)| G
    G -->|stdout/stderr lines| M -->|translate:output / translate:done| R
    G -->|writes translated .srt| Tmp
    M -->|spawn| F
    M -->|fetch + key| T
    R -->|Save…| M -->|copyFile| Tmp
```

Key points:
- **contextIsolation: true, nodeIntegration: false, sandbox: false.** Renderer only sees `window.api` (see `preload/index.ts`).
- gst writes to a temp file in `app.getPath('userData')/temp/<timestamp>.srt`; the user explicitly **Save…**s it to a chosen path (copyFile).
- Streaming uses two events: `translate:output` (`{stream,line}`) and `translate:done` (`{code,outputPath}`). Both translate and transcribe reuse the same two channels.

---

## 4. IPC Channels (actual, from `ipc.ts` / `preload/index.ts`)

| `window.api` method | Channel | Purpose |
|---|---|---|
| `getSettings()` | `settings:get` | full `AppSettings` |
| `setSettings(patch)` | `settings:set` | merge-write, returns full settings |
| `getCachedModels()` | `models:getCached` | re-curates cached ids via `buildModelList`, returns `{models,updatedAt}` |
| `refreshModels(apiKey)` | `models:refresh` | single-key `gst list-models`; persists list if key valid |
| `checkApiKeys(keys)` | `models:checkKeys` | validates each key; persists per-key `apiKeyValid/apiKeyError`; models from first valid |
| `openFile(filters)` | `dialog:openFile` | native open dialog |
| `openFolder()` | `dialog:openFolder` | native folder dialog |
| `saveFile({srcPath,defaultName,defaultDir})` | `dialog:saveFile` | Save-As; copies temp file to chosen path |
| `showItemInFolder(p)` | `shell:showItem` | reveal in explorer |
| `openExternal(url)` | `shell:openExternal` | open URL in browser |
| `probeTracks(filePath)` | `video:probeTracks` | ffprobe → `SubtitleTrack[]` |
| `extractToTemp({filePath,subtitleIndex})` | `video:extractToTemp` | silent extract chosen track → temp `.srt` (used as translate input) |
| `extractTrack({filePath,subtitleIndex,isImage,defaultName})` | `video:extractTrack` | Save-As extract (`.srt` text or `.sup` image-copy) |
| `tmdbSearch(query,type)` | `tmdb:search` | name / `tt…` IMDb id / numeric TMDB id |
| `tmdbCast(tmdbId,mediaType)` | `tmdb:cast` | details + cast/genders (note: handler still named `tmdb:cast`; returns full `TmdbDetails`) |
| `startTranslate(args)` | `translate:start` | spawn `gst translate` |
| `startTranscribe(args)` | `transcribe:start` | spawn `gst transcribe` |
| `stop()` | `translate:stop` | kill current child (taskkill /T on Windows) |
| `isRunning()` | `translate:isRunning` | bool |
| `onOutput(cb)` / `onDone(cb)` | events | streaming listeners (return unsubscribe fn) |

Only **one** gst child runs at a time (`current` guard in `pythonBridge.ts`).

---

## 5. Persistent Settings (`AppSettings`, defaults in `store.ts`)

| Field | Default | Notes |
|---|---|---|
| `sourceLang` | `'auto'` | |
| `targetLang` | `''` | must be chosen to translate |
| `apiKeys` | `['']` | up to 5 |
| `apiKeyTiers` | `['free']` | per-key `'free' | 'paid'` (manual — API can't report tier) |
| `apiKeyValid` | `[null]` | per-key `true/false/null`, persisted |
| `apiKeyError` | `['']` | per-key friendly error |
| `theme` | `'auto'` | `light/dark/auto` |
| `model` | `'gemini-flash-lite-latest'` | |
| `batchSize` | `100` | |
| `batchContext` | **`false`** | toggles `--no-context`; sends whole prior batch when ON |
| `temperature` | `1.0` | 3.x default 1.0 / 2.x default 0.3 (auto-set on model change) |
| `topP` | `0.95` | 3.x 0.95 / 2.x 0.80 |
| `topK` | `null` | omitted unless set |
| `thinkingLevel` | `'low'` | 3.x only |
| `thinkingBudget` | `512` | 2.5 only |
| `serviceTier` | `'standard'` | standard/flex/priority |
| `paidQuota` | `false` | derived per-run from effective primary key tier |
| `disableStreaming` | `false` | |
| `tmdbApiKey` | `a07324c669cac4d96789197134ce272b` | public fallback key (themoviedb.helper) |
| `outputFolder` | `''` | |
| `ffmpegPath` | `''` | optional override |
| `systemPrompt` | `''` | |
| `showTokenStats` | `true` | |
| `writeTokenReport` / `progressLog` / `thoughtsLog` | `false` | |
| `cachedModels` | `DEFAULT_MODELS` | curated list |
| `modelsUpdatedAt` | `null` | |

**Migrations in `store.ts`** (run at module load): reset removed/invalid model ids (`gemini-3.5-flash-lite`, `gemini-3.5-pro`, `gemini-2.0-*`) back to default; coerce older scalar `apiKeyValid/apiKeyError` into arrays.

> ⚠️ **`electron-store` uses no custom `name`/`cwd`** — the store path derives from the app identity (`package.json` `name`/`productName`/`appId`). A 1:1 clone MUST change these or the fork will share the original's settings/keys. (Relevant to the upcoming hard fork.)

---

## 6. Translate workflow (`TranslatePage.tsx` + `pythonBridge.ts`)

1. **Inputs:** subtitle file — `.srt` or `.ass` (required) **or** a Video file (extract an embedded track) + optional Audio file (gender context). Languages (source incl. Auto Detect; target required). TMDB context (optional).
2. **Persistence across tabs:** `App.tsx` keeps all pages **mounted** and toggles visibility with `hidden`, so inputs/TMDB selection survive tab switches. Language pickers seed from settings **once** (`langSeeded` ref) to avoid clobbering in-progress edits when Settings changes.
3. **New SRT resets TMDB:** picking a new SRT clears `description` and bumps `tmdbResetKey` (remounts `TmdbSearch`, wiping its selection/cast).
4. **Start:** if translating from a video track, `extractToTemp` runs ffmpeg first to get a temp `.srt`. Then `startTranslate(args)`.
5. **UTF-8 normalization (`ensureUtf8Subtitle`)**: before spawning gst, the input is sniffed (UTF-8 BOM / UTF-16 LE/BE / valid UTF-8 / Windows-1252 fallback) and rewritten to a clean BOM-less temp copy when needed, **preserving the original extension** (`*.utf8.srt` / `*.utf8.ass`). A non-UTF-8 `.ass` is refused rather than transcoded from a guessed code page, which would mangle styling. The user's file is never modified. Output is already UTF-8 (gst opens output with `encoding="utf-8"`).
6. **Arg building (`buildTranslateArgs`)**: `translate -i <utf8 input> -o <temp, same extension as input> -l <gstName> -k <primary> [-k2 <fallback>] [-a audio] -m <model> -b <batch> [--temperature --top-p [--top-k]] <thinking> [--service-tier] [--paid-quota] [--no-context] [--no-streaming] [-d "<desc>"] (--no-resume | -s N --resume) [--resume-context-size N] --token-stats --skip-upgrade --no-colors`.
   - Source language is folded into `-d` as `"Source language: <Name>. <desc>"` (no dedicated CLI flag).
   - **Generation parameters** are emitted only when `customGenerationParams` is on; otherwise the model's own defaults apply. A zero is never emitted — the engine's truthiness check would silently drop it.
   - **Thinking (`thinkingArgs`)** is derived from `shared/modelCaps.ts`, the single capability table shared with the UI: 3.x → `--thinking-level` (coerced exactly as the engine does); 2.5 → `--thinking-budget` clamped to that model's range; `--no-thinking` only where the engine honours it; 2.0/non-Gemini → nothing.
   - `--resume-context-size` is emitted only when it differs from the engine default (50).
7. **Key ordering (`orderKeysByValidity`)**: ranks slots via `shared/keyOrder.ts` — known-valid first, unknown next, known-invalid dropped (unless nothing else). Effective primary `-k`, next `-k2`; anything beyond is a reserve pool that is never passed to a run. `--paid-quota` is derived from the **effective** primary key's tier.
8. **Spawn env**: `envWithFfmpeg(ffmpegPath, { PYTHONUNBUFFERED:1, PYTHONUTF8:1, PYTHONIOENCODING:utf-8 })`.
9. **Streaming (`useRunner`)**: parses `cur/total` and `NN%` for the progress bar; lines containing `total … token` populate the token-stats footer; sets `done` on exit 0, else `error` with exit code.
10. **Save:** `Save Subtitles…` → `saveFile` copies temp output to `<base>_<tgtLang>.<srt|ass>` — the extension follows the format the engine actually produced (defaults to Output Folder or source dir).

---

## 7. Embedded subtitle tracks (`SubTrackPanel.tsx` + `ffmpeg.ts`)

- `probeTracks` runs `ffprobe -select_streams s -show_entries stream=index,codec_name:stream_tags=language,title -of json`. Each track → `{index (subtitle-relative, for 0:s:N), codec, lang (ISO-639-1 normalized), name, isImage}`.
- Image codecs treated as PGS-like: `hdmv_pgs_subtitle, pgssub, dvd_subtitle, dvdsub, xsub` → `isImage:true`, name suffixed `(PGS)`.
- Auto-select on scan: first English text track, else first text track, else none. PGS rows are not auto-selected/translatable.
- If a track's `lang` matches the chosen **target** language → warning + offer to extract instead of re-translate.
- Extraction: text → `-c:s srt`; image → `-c:s copy` to `.sup`. Save-As via `extractTrack`; silent temp via `extractToTemp`.
- Language compare uses `normalizeTrackLang` (ISO-639-2/B → 639-1) in `shared/languages.ts`.

---

## 8. Transcribe workflow (`TranscribePage.tsx`)

- Generates a brand-new SRT from audio/video via `gst transcribe` (speech recognition). For content with no subtitles at all. Requires FFmpeg.
- `buildTranscribeArgs`: `transcribe -o <out> (-v|-a) <media> -k <primary> -m <model> <thinking> [-d desc] --token-stats --skip-upgrade --no-colors`. Video vs audio chosen by extension regex.

---

## 9. Model management (`modelsList.ts` + `store.ts`)

- **No aliases anywhere.** The invented `*-latest` ids are filtered out of the seed, the cache and the fetch path: Google does not publish them, so the engine rejects them outright, and even a real one would defeat its thinking-config substring match.
- **`DEFAULT_MODELS`**: display-only seed of real versioned ids (`3.5-flash`, `3.1-flash-lite`, `3.1-pro`, `2.5-flash`, `2.5-flash-lite`, `2.5-pro`), each marked `source: 'seed'`. Static fallback `DEFAULT_MODEL_ID = gemini-3.1-flash-lite`; the live rule supersedes it on the first successful refresh.
- **`buildModelList(rawIds, availability)`**: curates and sorts by a **version tuple** (`3.10 > 3.9`; never `parseFloat`). Previews are always offered and marked, never auto-selected. Each entry records `source: 'live' | 'seed'` and `availableOn` — the key slots that actually returned it.
- **`refreshModels(apiKey)`**: `gst list-models -k <key> --skip-upgrade` (env forces UTF-8 + `NO_COLOR`). Returns the raw ids that key reported, never a curated list — availability decisions must rest on what the API said, not on display filtering.
- **`friendlyError`**: maps raw dumps to messages for invalid key / 403 / quota-429 / network.
- **`checkApiKeys(keys)`**: validates every non-empty key and keeps EACH one's list. `summarizeRefresh` derives the union, the runnable intersection over the active set, and a `refreshOutcome` of `allComplete | activeComplete | partial | failed`.
- **Selection rules** (`applyModelSelectionRules`, `ipc.ts`): a refresh may change the stored model in exactly three cases — fresh install, proven absence (only on `allComplete` with a non-empty union), and auto-advance to a newer default (at the `activeComplete` bar). Everything else is preserved; a model present in the union but not on every active key warns rather than resets.
- **`guardModelForSpawn`**: pre-spawn check that blocks only on positive evidence of absence and warns when availability is unknown.
- Model-aware UI: all three consumers (`thinkingArgs`, Settings, Transcribe) read `shared/modelCaps.ts`, so the UI cannot offer a combination the engine will silently override.

---

## 10. API key UX (`SettingsPage.tsx`)

- Up to 5 keys; each row: masked input + eye toggle + ✓/✗ status + **role badge** (Primary `-k` / Fallback `-k2` / Reserve) + Free/Paid selector + remove. Roles come from the same `shared/keyOrder.ts` ranking the spawn path uses, so the labels cannot disagree with what a run does. The renderer works from slot indices only and never handles key material.
- Copy states plainly that only **two** keys are passed per run and that the rest are a reserve pool promoted on invalidity — not extra parallel quota.
- "Fetch Models & Check API Keys" → `checkApiKeys`; shows per-key ✓/✗ (persisted), a "Primary key tier" badge, "X of Y keys valid — N models", which keys the next run will use, which slots could not be checked, and any model change the selection rules made.
- Tier is **manual** (Google's API doesn't expose billing tier). Rate-limit figures are presented as approximate, note that quota is per Google Cloud **project** rather than per key, and link to Google's live table.

---

## 11. TMDB (`tmdb.ts` + `TmdbSearch.tsx`)

- Search accepts: plain title (`/search/multi|movie|tv`), IMDb id `tt\d+` (`/find`), or numeric TMDB id (`/{movie|tv}/{id}`).
- Selecting a result fetches details + credits (cast trimmed to 12, gender labels) and auto-generates an editable `description` like: `"TV series: <title> (<year>). Genre: …. Characters: Name (gender), …"`.
- Debounced autocomplete (300 ms), clickable TMDB/IMDb badges (open externally).
- Key resolution: user key from settings, else bundled public fallback.

---

## 12. Python bundling & `gst` resolution

### 12.0 Pinned engine version

| Item | Value |
|---|---|
| Engine shipped before this upgrade | **`gemini-srt-translator` 3.5.8** |
| Engine shipped from this upgrade on | **`gemini-srt-translator` 3.7.0** |
| Build interpreter | Python 3.14.6 (`C:\Program Files\Python314\python.exe`) |
| Freezer | `pyinstaller==6.22.1` |
| Reproducibility record | `scripts/build-python-requirements.lock` (committed) |

The 3.5.8 baseline was established by three independent CLI probes of the frozen
`resources/bin/gst.exe` (19.7 MB, frozen 2026-07-01), so it never has to be re-derived:

- `gst extract --help` showed `--srt` and **not** `--subtitle` ⇒ predates 3.7.0.
- `gst list-models --help` had **no** `--skip-upgrade` ⇒ predates 3.6.2.
- `gst translate --help` had **no** `--resume-context-size` ⇒ predates 3.6.0.

Corroborated by `Source Codes/gemini-srt-translator-3.5.8.zip` (dated 2026-06-29).
The 3.5.8 executable is preserved for instant rollback at
`C:\Projects\_Backups\gst-3.5.8.exe`, alongside the pre-upgrade source snapshot and the
git tag `v1.0.0-pre-3.7.0`.

- **Build**: `scripts/build_python.py` runs PyInstaller `--onefile --name gst --collect-all gemini_srt_translator --collect-all pysubs2 --collect-all google.genai --copy-metadata gemini-srt-translator --copy-metadata pysubs2 --copy-metadata google-genai scripts/gst_entry.py` → `resources/bin/gst[.exe]`. Entry shim imports `gemini_srt_translator.cli.main` to preserve package context. **PyInstaller does not cross-compile** — build each OS on that OS.
- **Isolated build env**: the engine is installed into `.venv-build/` (git-ignored) and **never** onto the ambient PATH. A global pip install would make `npm run dev` resolve bare `gst` to the pip package instead of the shipped binary, invalidating every dev-run test (see §13.2 and the startup log below).
- **Packaging**: `electron-builder` `extraResources` copies `resources/bin/{gst*,ffmpeg*,ffprobe*}` → app `resources/bin`.
- **Runtime resolution (`resolveGstBin`)**: packaged → absolute `resources/bin/gst.exe`; dev → bare `gst` from PATH (the pip install). `logResolvedGstBin()` runs at startup and prints the path that bare name actually resolves to, so "which engine did this session run" is always answerable — a dev run silently exercising a different build would invalidate any conclusion drawn from it.
- **FFmpeg resolution (`resolveTool`)**: explicit Settings path → bundled `resources/bin` → system PATH.

---

## 13. ⚠️ Hard-won lessons / gotchas (read before changing engine code)

1. **`charmap` crash on non-Latin output (Hebrew):** Windows Python defaults stdio to cp1252. Fixed by forcing `PYTHONUTF8=1` (+`PYTHONIOENCODING=utf-8`) on every gst spawn. Verified: under this env, stdout/stderr/locale all resolve to utf-8.
2. **PATH shadowing:** `resources/bin` contains **both** ffmpeg and `gst.exe`. Originally we *prepended* it to PATH so gst could find ffmpeg — which made `spawn('gst')` resolve to the **frozen** `gst.exe` (which ignores `PYTHONUTF8`) instead of the pip gst, re-triggering the charmap crash. **Fix:** `envWithFfmpeg` now **appends** the bin dir (`[base, ...dirs]`), so the intended `gst` wins while ffmpeg stays discoverable. (Packaged builds resolve gst by absolute path, so unaffected.)
   - **Open risk for packaged builds:** the frozen `gst.exe` is used in production and *may* not honor `PYTHONUTF8`. Verify a Hebrew translation in a packaged build; if it recurs, add a UTF-8 runtime hook to the PyInstaller build.
3. **Defensive input encoding:** `ensureUtf8Subtitle` converts a non-UTF-8 input to a clean UTF-8 temp copy before translating (guards UTF-16/Windows-1252 inputs from `UnicodeDecodeError`), keeping the original extension. It refuses a non-UTF-8 `.ass` instead of guessing a code page. The user's file is never modified.
4. **gst `list-models` flags:** 3.6.2 added `--skip-upgrade`, which is now used instead of the old trick of writing `n\n` to stdin to answer the blocking upgrade prompt. `--no-colors` is still not accepted there; use `NO_COLOR=1` env. (translate/transcribe accept both.)
5. **ffmpeg on the child PATH:** 3.5.8 hard-exited without ffmpeg even on `list-models`. 3.7.0 no longer does, but ffmpeg is still required for every audio/video path, so it stays on the child PATH.
6. **Never `parseFloat` a model version.** `parseFloat('3.10') === 3.1`, so a two-digit minor sorts below `3.9` and "newest flash-lite" silently picks the older model. Compare the `{major, minor}` tuple via `compareVersions`.
7. **`-latest` aliases are fabricated, not real.** Injecting them produced ids Google does not publish (engine `exit(1)`), and they also defeat the engine's thinking-config substring match. They are filtered from the seed, the cache and the fetch.
8. **A migration cannot prove a model is gone.** It runs offline at store load. Only an `allComplete` refresh is allowed to replace a user's model; a migration may at most flag it.

---

## 14. Cross-batch context & token economics (analysis)

- The library translates as a **chat**: each request (after the first) re-sends the **entire previous batch** (original lines + their translations) as history, then the new batch. It's a **sliding window of exactly one batch** (`previous_message` is replaced, not accumulated — confirmed in `gemini_srt_translator/main.py`), so prompt tokens **plateau** rather than grow quadratically.
- The resent context is **NOT cached** — no `cachedContentTokenCount` in any logged request; the library uses neither explicit caching nor a stable implicit-cache prefix (the rotating window defeats it). So every resent token is billed as fresh input.
- Measured on a ~530-line run: context ON ≈ **42.6k** prompt tokens vs OFF ≈ **14k** (~⅔ savings).
- **Decisions made:** "Previous Lines (1–10)" control was **removed** (the CLI has no such knob — context is all-or-nothing). The toggle is now **"Cross-Batch Context"**, **default OFF**, with a tooltip explaining cost vs. consistency. Generation params (temperature/top-p/thinking) ARE sent (in the request `generationConfig`); `top_k` is omitted unless set.

---

## 15. Build & distribution

- Scripts: `dev` (electron-vite dev), `build` (build only), `build:win` (`electron-vite build && electron-builder --win`), `build:python`, `build:dir`, `typecheck`, `test:gates`.
- **`npm run test:gates`** runs the migration/model/argv/encoding gate suite (`scripts/gates/`). It bundles the real main-process modules with esbuild (already a Vite dependency) and stubs only `electron` and `electron-store`, so a gate cannot pass against a stale copy of the logic. Run it after any change to migrations, model selection, key ranking or argument building.
- `electron-builder` config (in `package.json`): `appId com.srtai.translationui`, `productName "SRT AI Translator"`, win target **`zip`** (portable), `signAndEditExecutable:false`, artifact `${productName}-${version}-portable.${ext}`, `asar:true`, extraResources as above.
- **Portable output:** `release\SRT AI Translator-1.0.0-portable.zip` (~190 MB) and `release\win-unpacked\` (contains `SRT AI Translator.exe` + `resources/bin/{gst,ffmpeg,ffprobe}.exe`). Unzip-and-run; no install, no Python.
- **Build gotcha:** the unsigned `gst.exe` can be transiently locked by Windows Defender during zipping (`process cannot access the file`). Re-running `npx electron-builder --win` succeeds once the scan releases it.

---

## 16. Fork notes ("New Gen" — deviating from the CLI engine)

- **Engine seam:** the CLI-specific code is `pythonBridge.ts`, `modelsList.ts`, `data/freeTier.ts`, and the gst-specific Settings fields (thinking, paid quota, service tier, cross-batch context). Everything else (Electron shell, IPC plumbing, TMDB, FFmpeg/SRT/track handling, UTF-8 conversion, theming, `useRunner`, page layouts) is **engine-agnostic** and reusable.
- **Recommended first step (even for a fork):** introduce a `TranslationEngine` interface (`listModels`, `validateKeys`, `startJob(args, handlers)`, `capabilities()`), make the current gst code one adapter, and render Settings from `capabilities()`. A new engine (direct Gemini SDK, OpenAI, DeepL, local LLM) becomes another adapter.
- **On cloning:** change `name` / `productName` / `appId` so the fork gets its own `electron-store` userData dir (otherwise it shares settings/keys with the original). Don't copy `node_modules/`, `out/`, `release/` (reinstall); DO copy `resources/bin/` (large, not in npm) or rerun `build:python`.
- **Direct-API opportunity:** going straight to the Gemini API (instead of the CLI) would unlock real **prompt caching** / a configurable context window and remove the frozen-exe UTF-8 risk — the main reasons the current engine is token-heavy and Windows-fragile.

---

## 17. Known open items / backlog

- Verify Hebrew (and other non-Latin) translation in a **packaged** build (frozen `gst.exe` + `PYTHONUTF8` caveat, §13.2).
- `resumeFrom`/`--resume` plumbing exists in args but there is no UI to resume an interrupted job yet. `resumeContextSize` therefore ships **dormant**: it is persisted and emitted, but changes nothing until a resume happens, and the Settings label says so.
- A permanently dead key slot makes `allComplete` unreachable, so a genuinely withdrawn model stays selected indefinitely. Deliberate (overrides must survive) and non-fatal — auto-advance still works, the pre-spawn guard explains the failure, and the key list shows which slot is failing.
- macOS/Linux bundled binaries not yet produced (PyInstaller must run per-OS).

### 17.1 Verification status of the 3.7.0 upgrade

Automated and green (`npm run typecheck`, `npm run test:gates` — 130 checks):
migration fixtures F1-F9, version-tuple ordering and default selection, refresh-outcome
classification, the three-case selection rule, the pre-spawn guard, key ranking, argv
construction (keys, thinking, generation parameters, resume flags), and subtitle
normalisation including the ASS encoding rules.

Still requires a human with a real API key and a packaged build — these cannot be
automated here and must be run before release:

| Check | Why it cannot be automated here |
|---|---|
| A1-A5 engine probes on `resources/bin/gst.exe` | Needs the rebuilt binary and a live key |
| A6 startup binary log | Implemented (`logResolvedGstBin`); read it once in `npm run dev` |
| B1-B4 probes, incl. B3 persistence | Needs live fetches; enable with `SRT_DEBUG_MODELS=1` |
| C20/C21 ASS + embedded-track round trip | Needs the engine to actually translate a file |
| D1-D2 packaged build, Hebrew output | Needs `npm run build:win` and a manual run |
