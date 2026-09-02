# Changelog

All notable changes to SRT AI Translator are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.1.0] - 2026-09-02

Everything below is what changed since 1.0.0.

A large release. The bundled engine moved to `gemini-srt-translator` 3.7.0, subtitle format support
widened to `.ass`, API keys became a ranked pool instead of a flat list, and the model picker is now
built from what your own keys can actually see. Much of the rest of the work went into a single
theme: **the app should tell you the truth about what it is doing** — while it works, when it
finishes, and when it fails.

### Added

- **`.ass` subtitle translation.** An `.ass` file is translated directly and saved back as `.ass`,
  keeping its styling. A non-UTF-8 `.ass` is refused rather than transcoded, because guessing an
  encoding for a styled file risks mangling its formatting.
- **Subtitle track export from video.** Any embedded track can be saved out, not just the one you
  are translating. Text tracks export as `.srt`, image/PGS tracks as `.sup`. Each extracted file is
  named after its **own** language rather than the target language.
- **Ranked API keys.** Up to five Gemini keys, ordered by the result of the last check. A run uses
  the two highest-ranked valid keys; the rest wait as a reserve pool and are promoted automatically
  when a key above them turns invalid. Settings shows each key's role — Primary, Fallback or
  Reserve — so the displayed tier and the key a run actually uses always agree.
- **A live model list with provenance.** Models come from what your keys report, replacing a curated
  list that contained moving `-latest` aliases. Each entry is labelled by what has actually been
  verified: which of your keys can run it, or that it has not been checked yet.
- **A `.console.log` beside every run's output.** It contains what the run really said — the command
  line, the app's own notices and both engine streams, uncapped and unfolded. The on-screen panel is
  capped and folded and so is the wrong thing to export. The file is written as the run happens and
  closed on every ending, so a run that failed or was stopped still leaves a complete record.
- **Progress reporting for long waits.** Track extraction and audio conversion report a real
  percentage. Work that cannot be measured — the engine's own internal ffmpeg, and the stretch before
  the first batch — gets an indeterminate bar and an elapsed clock instead. Nothing invents a
  percentage it cannot compute.
- **The command line for each run, with keys masked.** Shown in the log so you can see exactly what
  was executed. Keys are masked by position, and keys the run did not send are swept from the text
  too, so a key pasted into the Description field cannot come back out.
- **An advisory check on the finished subtitle.** The engine validates a batch by counting items
  rather than reading them, so a model that returns filler still reports success. After a successful
  run the app compares the output against its source and warns when several independent signals
  agree that something looks wrong. It is **advisory only** — nothing is repaired, no save is
  blocked, and the file on disk stays byte-identical to what the engine wrote.
- **New settings:** resume context size, service tier, and a **Custom Generation Parameters** toggle
  that keeps temperature / Top-P / Top-K out of the request unless you deliberately turn them on.
- **Automatic, non-destructive settings migration** on first launch, with a backup of the previous
  settings file written before anything changes.
- **A packaging preflight.** The build refuses to package an engine that was not frozen from the
  current inputs, and refuses to package at all when a required binary is missing, empty or named
  differently from what the target platform expects.

### Changed

- **Bundled engine updated to `gemini-srt-translator` 3.7.0**, frozen with PyInstaller and shipped
  inside the portable build. The build asserts the engine version before freezing, so a package can
  never silently ship a different engine than the UI was built against.
- **Thinking controls now follow the selected model.** A 3.x model exposes a thinking level, a 2.5
  model exposes a thinking budget, and a 2.0 model exposes neither, instead of offering controls the
  engine would ignore.
- **Temperature / Top-P / Top-K are no longer sent to models that have deprecated them.** Google
  deprecated these parameters from Gemini 3.6 Flash and 3.5 Flash-Lite onward and says future
  releases will reject them outright, so the rule is a version comparison rather than a list of
  model ids — an unrecognised model is treated as a later release that does not accept them.
- **Free-tier rate-limit figures were removed.** Google stopped publishing per-model limits, so the
  app links to the live rate-limit page and to AI Studio rather than quoting numbers that would go
  stale without anyone noticing.
- **A failed or partial model check keeps your previous list** instead of clearing it, so a network
  blip never empties the picker.
- **A key is only marked invalid when the API actually refused it.** A DNS failure, a timeout, an
  exhausted quota or an unrecognised error all mean *unchecked*, not invalid, because a false
  rejection silently demotes a working key.
- **Only one engine job runs at a time, and the lock now covers the whole job** rather than just the
  child process — including the preparation phase before anything is spawned.
- **Stopping a run reads as Stopped, not Failed.** A run the user ended is not an error, and the app
  distinguishes the two rather than leaving you to infer it from an exit code.
- **The run panel folds the engine's redrawn output.** The engine repaints its entire message history
  on every streamed chunk — one measured run emitted 9,900 lines carrying eleven distinct messages —
  so repeated frames collapse into one row with a counter. Scrolling up during a run now holds
  position instead of being dragged back to the bottom.

### Fixed

- **A rejected key no longer retries forever.** A transcription started with a rejected key was
  measured retrying for 6 hours 40 minutes and writing 97 GB of identical complaint before the disk
  filled. Two independent defences now bound this: a key preflight before anything is converted or
  spawned, and a stall budget that ends a run which has stopped making progress. Only a *rejected*
  key refuses the run — an unreachable network warns and continues.
- **`name 'exit' is not defined` no longer appears** when the engine aborts. The frozen interpreter
  had no `exit` builtin, so the engine's own abort paths raised a `NameError` into its retry handler
  instead of ending the run.
- **A rejected key on the Translate page now names the API key** and points at Google AI Studio,
  instead of surfacing a raw authentication dictionary. The raw response is still in the log.
- **A stopped transcription now says what actually happened.** The engine writes its `.srt` once at
  the end, so a stopped run leaves nothing behind — the message says so instead of pointing at a
  partial file that does not exist.
- **The Custom Generation Parameters toggle stays off** after you move from a model that rejects
  sampling parameters to one that accepts them, including when the model changes automatically
  during a model refresh. It previously reappeared switched on.
- **Console logs are readable.** Redraw frames that were being broken apart by blank lines now fold
  correctly, so the file shows `[redrawn 352 times]` rather than hundreds of `[redrawn 1 times]`.
- **Closing the app mid-run terminates the engine.** A frozen PyInstaller build is a bootloader that
  spawns the real interpreter as a child, so killing the process the app holds would have left the
  engine running and still calling the API. Terminations are now tree kills, and a failed
  termination is detected and reported rather than silently assumed to have worked.
- **A model version is never parsed as a float.** `parseFloat('3.10')` is `3.1`, which sorted a
  two-digit minor version below `3.9` and made "newest" silently pick the older model.
- **A literal `0` is no longer sent** for temperature, Top-P or Top-K. The engine tests those values
  for truthiness and drops a zero silently, so the UI would have been claiming to send something it
  did not.

### Upgrading from 1.0.0

Extract the new ZIP and run it. Settings and keys are read from `%APPDATA%` as before and are
migrated automatically and non-destructively, with a backup written first.

One thing to expect on first launch: a saved model that was one of the old moving aliases
(`gemini-flash-latest` and similar) is remapped to a concrete model, because the app now lists only
models your own keys report. Press **Fetch Models & Check API Keys** once to rebuild the verified
list.

### Known limitations

- Resuming an interrupted job is not yet available in the UI.
- A run that fails partway leaves its partial output in `%APPDATA%`; the app does not offer to save
  it, because a partial translation can be misaligned in ways that are not visible on inspection.
- When the model blocks content, the engine does not expose the reason, so the failure message is
  necessarily generic.
- Windows only. The build scripts target a portable Windows package; PyInstaller does not
  cross-compile, so the engine must be frozen on the platform it ships for.

[1.1.0]: https://github.com/Akila3/SRT-AI-Translator/releases/tag/v1.1.0
