import React, { useEffect, useRef, useState } from 'react'
import { useStore } from '../store/useStore'
import {
  Box,
  BoxTitle,
  Label,
  Select,
  FilePicker,
  Button,
  Elapsed,
  ProgressBar,
  LogPanel,
  RetryNotice,
  StatusCard,
  Working
} from '../components/ui'
import { SubTrackPanel } from '../components/SubTrackPanel'
import { TmdbSearch } from '../components/TmdbSearch'
import { SOURCE_LANGUAGES, TARGET_LANGUAGES } from '../data/languages'
import { consoleLogPathFor, findConsoleLog } from '../../electron/shared/consoleLog'
import { retryIsCurrent } from '../lib/logView'
import { companionName } from '../lib/outputName'
import { useRunner } from '../lib/useRunner'
import type { SubtitleTrack, TranslateArgs } from '../../electron/shared/types'

const VIDEO_FILTERS = [{ name: 'Video', extensions: ['mp4', 'mkv', 'mov', 'avi', 'webm', 'm4v', 'ts'] }]
// 3.7.0 swapped the engine's parser to pysubs2, which reads and writes ASS as well as SRT.
const SUBTITLE_FILTERS = [{ name: 'Subtitles', extensions: ['srt', 'ass'] }]
const AUDIO_FILTERS = [
  { name: 'Audio/Video', extensions: ['mp3', 'aac', 'wav', 'm4a', 'flac', 'mp4', 'mkv'] }
]

/**
 * One piece of ffmpeg work this page is waiting on.
 *
 * `export` is a track written to a file the user chose; `prepare` is the silent extraction
 * that turns a chosen track into translation input. `pct` is null until the first report,
 * and stays null for a container that will not say how long it is.
 */
interface FfmpegTask {
  kind: 'export' | 'prepare'
  pct: number | null
  startedAt: number
}

export default function TranslatePage(): React.JSX.Element {
  const settings = useStore((s) => s.settings)
  const { state, start, stop, reset } = useRunner()

  const [srtFile, setSrtFile] = useState('')
  const [videoFile, setVideoFile] = useState('')
  const [audioFile, setAudioFile] = useState('')
  const [tracks, setTracks] = useState<SubtitleTrack[]>([])
  const [selectedTrack, setSelectedTrack] = useState<number | null>(null)
  const [probing, setProbing] = useState(false)
  const [srcLang, setSrcLang] = useState('auto')
  const [tgtLang, setTgtLang] = useState('')
  const [description, setDescription] = useState('')
  const [tmdbResetKey, setTmdbResetKey] = useState(0)
  const [savedPath, setSavedPath] = useState('')
  /**
   * What the user chose to translate, frozen when the run started.
   *
   * The pickers stay live after a run finishes — Save and the file inputs are on screen together —
   * so reading them at save time would let a token report name a file that was never translated.
   * That is worse than the dead temp path REP-1 set out to fix: a stale path is obviously stale,
   * while a confident wrong one is not.
   */
  const [runSource, setRunSource] = useState('')
  const [startError, setStartError] = useState('')
  const [showLog, setShowLog] = useState(false)
  /**
   * The ffmpeg work this page is waiting on, or null when there is none.
   *
   * It is held here rather than in the panel because the panel is keyed by `videoFile` and so
   * does not survive a video change — while the ffmpeg process it started does, and nothing in
   * the main process serialises `video:extractTrack`. Kept in the child, the lock was released
   * by the remount and a second extraction could start beside the first (validator finding
   * FP5-01). The panel takes and releases it; the promise that releases it outlives the panel.
   *
   * It is now a task rather than a boolean because the same lock answers a second question —
   * how far along that work is. The two belong together: exactly one ffmpeg task runs from
   * this page at a time, so "is one running" and "which one, and how far" are one state.
   */
  const [ffmpeg, setFfmpeg] = useState<FfmpegTask | null>(null)
  /** When the current run started, for the clock shown while nothing measurable has happened. */
  const [runStartedAt, setRunStartedAt] = useState(0)
  /** When the track scan started, for the same reason: a 50 GB container takes a while. */
  const [probeStartedAt, setProbeStartedAt] = useState(0)

  /**
   * The console log's name once it has a home, or '' while the run has none.
   *
   * Derived from the SAVED path rather than read out of `logPaths`, because the path in there is
   * the temp original: `dialog:saveFile` copies every sidecar onto the destination the user
   * picked. `logPaths` is still what decides whether to mention it at all — no entry means the
   * file was never opened, and naming one that does not exist is worse than saying nothing.
   */
  const consoleLogName =
    savedPath && findConsoleLog(state.logPaths)
      ? (consoleLogPathFor(savedPath).split(/[\\/]/).pop() ?? '')
      : ''

  /**
   * Where the console log is RIGHT NOW, for a run with no saved subtitle to sit beside.
   *
   * `logPaths` is only ever populated by the terminal event, so a non-empty value here already
   * means the run has ended — there is no separate status to check. It empties on `reset()`,
   * which is correct: New starts a run that has no log yet.
   */
  const consoleLogPath = findConsoleLog(state.logPaths)

  /**
   * Follow the ffmpeg progress channel for as long as this page exists.
   *
   * A report for a kind this page is not waiting on is ignored rather than shown: a
   * transcription's audio conversion runs on the other page under the job lock, and can
   * genuinely overlap a track export started here.
   */
  useEffect(
    () =>
      window.api.onFfmpegProgress((p) => {
        setFfmpeg((cur) => {
          // `done` is deliberately not acted on: the awaits below own the end of these two
          // tasks, and clearing here as well would race a task that starts immediately after.
          if (!cur || cur.kind !== p.kind || p.done) return cur
          return { ...cur, pct: p.pct }
        })
      }),
    []
  )

  // Seed the language pickers from saved defaults once. We intentionally don't
  // re-run on every settings change: the page stays mounted across tabs, and
  // re-seeding would wipe an in-progress selection if the user edits Settings.
  const langSeeded = useRef(false)
  useEffect(() => {
    if (settings && !langSeeded.current) {
      langSeeded.current = true
      setSrcLang(settings.sourceLang)
      setTgtLang(settings.targetLang)
    }
  }, [settings])

  async function pickVideo(): Promise<void> {
    const p = await window.api.openFile(VIDEO_FILTERS)
    if (!p) return
    setVideoFile(p)
    setProbing(true)
    setProbeStartedAt(Date.now())
    setTracks([])
    setSelectedTrack(null)
    try {
      const t = await window.api.probeTracks(p)
      setTracks(t)
      autoSelect(t)
    } finally {
      setProbing(false)
    }
  }

  function autoSelect(t: SubtitleTrack[]): void {
    const text = t.filter((x) => !x.isImage)
    if (text.length === 0) {
      setSelectedTrack(null)
      return
    }
    const eng = text.find((x) => x.lang === 'en')
    setSelectedTrack((eng ?? text[0]).index)
  }

  function clearVideo(): void {
    setVideoFile('')
    setTracks([])
    setSelectedTrack(null)
  }

  /**
   * Take or release the lock on the track panel's behalf.
   *
   * The release only clears an export, never whatever else might hold the lock. The two
   * tasks cannot overlap today — each refuses to start while the other holds it — but a lock
   * that any caller can clear is one edit away from being no lock at all.
   */
  function setExportBusy(running: boolean): void {
    setFfmpeg((cur) => {
      if (running) return { kind: 'export', pct: null, startedAt: Date.now() }
      return cur?.kind === 'export' ? null : cur
    })
  }

  if (!settings) return <div className="p-6 text-sm text-gray-500 dark:text-gray-400">Loading…</div>

  const isRunning = state.status === 'running'

  /**
   * Why this run cannot start, or an empty string when it can.
   *
   * Every one of these used to be a silently disabled button (REP-10). A control that refuses
   * without saying what would enable it is indistinguishable from a broken one — the tester
   * reported Start as "not responding" — and the sentence explaining the commonest case was
   * already written inside `handleStart`, where the disabled gate guaranteed nobody would ever
   * see it.
   */
  function whyCannotStart(): string {
    if (!tgtLang) return 'Choose a target language first.'
    // One ffmpeg call at a time from this page. Two at once on a large container is exactly
    // the machine-load complaint REP-11 arrived with, and the second would appear to hang.
    if (ffmpeg) {
      return ffmpeg.kind === 'export'
        ? 'A track is still being extracted — wait for it to finish.'
        : 'Already preparing the selected track.'
    }
    if (srtFile) return ''
    if (!videoFile) {
      return 'Provide a subtitle file (.srt or .ass), or a video with a selectable text track.'
    }
    if (selectedTrack !== null) return ''
    // A video whose tracks are still being read has no tracks yet, and saying it contains none
    // would be a wrong answer rather than a slow one.
    if (probing) return 'Still scanning this video’s subtitle tracks — try again in a moment.'
    if (tracks.length === 0) {
      return 'No subtitle tracks were found in this video. Provide a subtitle file instead.'
    }
    // The reported case, which had no message anywhere: every track is a bitmap, so there is
    // no text to translate. Reading one would need OCR, which is a feature rather than a flag,
    // so the honest answer is to say so and point at what IS possible.
    if (tracks.every((t) => t.isImage)) {
      return (
        'This video’s subtitles are image-based (PGS) and cannot be translated — ' +
        'extract one as a .sup instead, or provide a subtitle file.'
      )
    }
    return 'Choose which subtitle track to translate.'
  }

  async function handleStart(): Promise<void> {
    setStartError('')
    setSavedPath('')
    setShowLog(false)
    const cfg = settings
    if (!cfg) return

    const refusal = whyCannotStart()
    if (refusal) {
      setStartError(refusal)
      return
    }

    // Read before the first await, not after: extracting a track from a large video runs for
    // minutes, and nothing stops the user editing the pickers while it does.
    const chosenSource = srtFile || videoFile

    let inputFile = srtFile
    // If translating from a video's embedded track, extract it first. This used to be silent
    // — the button still read "Start Translation" while ffmpeg walked a 50 GB container for
    // minutes (REP-11). The task state below is what puts a bar and a clock on screen, and
    // what stops a second ffmpeg call being started on top of this one.
    if (!inputFile && videoFile && selectedTrack !== null) {
      setFfmpeg({ kind: 'prepare', pct: null, startedAt: Date.now() })
      let res: { ok: boolean; path?: string }
      try {
        res = await window.api.extractToTemp({ filePath: videoFile, subtitleIndex: selectedTrack })
      } catch (e) {
        // A rejected invoke used to leave the press with no visible effect at all — the same
        // shape of dead end REP-10 records, arrived at from the other direction.
        setStartError(`Could not extract the selected subtitle track: ${String(e)}`)
        return
      } finally {
        // In a finally because a failure must not leave the page permanently unable to start
        // anything: this lock is what every other action on the page checks.
        setFfmpeg(null)
      }
      if (!res.ok || !res.path) {
        setStartError('Could not extract the selected subtitle track. Is FFmpeg installed?')
        return
      }
      inputFile = res.path
    }
    if (!inputFile) {
      // Unreachable while `whyCannotStart` covers every path above. Kept so that a later edit
      // to those rules cannot end with the engine spawned against no input at all.
      setStartError('Provide a subtitle file (.srt or .ass), or a video with a selectable text track.')
      return
    }

    const args: TranslateArgs = {
      inputFile,
      videoFile: videoFile || undefined,
      audioFile: audioFile || undefined,
      sourceLang: srcLang,
      targetLang: tgtLang,
      model: cfg.model,
      apiKeys: cfg.apiKeys,
      batchSize: cfg.batchSize,
      batchContext: cfg.batchContext,
      customGenerationParams: cfg.customGenerationParams,
      temperature: cfg.temperature,
      topP: cfg.topP,
      topK: cfg.topK,
      thinkingLevel: cfg.thinkingLevel,
      thinkingBudget: cfg.thinkingBudget,
      serviceTier: cfg.serviceTier,
      paidQuota: cfg.paidQuota,
      disableStreaming: cfg.disableStreaming,
      description: description || undefined,
      systemPrompt: cfg.systemPrompt || undefined,
      ffmpegPath: cfg.ffmpegPath || undefined,
      writeTokenReport: cfg.writeTokenReport,
      progressLog: cfg.progressLog,
      thoughtsLog: cfg.thoughtsLog
    }
    setRunSource(chosenSource)
    setRunStartedAt(Date.now())
    await start(() => window.api.startTranslate(args))
  }

  async function handleSave(): Promise<void> {
    if (!state.outputPath) return
    // Keep the format the engine actually produced. It writes according to the output
    // path's extension, so proposing ".srt" for an ASS job would mislabel the file.
    const ext = /\.ass$/i.test(state.outputPath) ? '.ass' : '.srt'
    // Same snapshot, same reason: the proposed filename must describe the run being saved, not
    // whatever happens to be in the pickers now. The convention itself now lives in one place,
    // shared with track extraction — see `outputName.ts`.
    const name = companionName(runSource, tgtLang, ext)
    const saved = await window.api.saveFile({
      srcPath: state.outputPath,
      defaultName: name,
      defaultDir: settings?.outputFolder || undefined,
      logPaths: state.logPaths.length ? state.logPaths : undefined,
      // What the user picked for THIS run, not what the engine was handed and not whatever the
      // pickers hold now: for a video the engine received an extracted temp track, and for a
      // re-encoded subtitle a temp `.utf8.srt`. Neither exists by the time they open the token
      // report sitting next to the file they saved.
      inputPath: runSource || undefined
    })
    if (saved) setSavedPath(saved)
  }

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <Box>
        <BoxTitle>Input Files</BoxTitle>
        <div className="space-y-4">
          <div>
            <Label tip="The subtitle file you want to translate — .srt or .ass. This is the only required input for basic translation: no video or audio needed. An .ass file keeps its styling and is saved back as .ass. If you have a video file instead, use the Video File field below to extract subtitles from it. Subtitle files must be UTF-8; a non-UTF-8 .srt is converted automatically, while a non-UTF-8 .ass is refused rather than risk mangling its styling.">
              Subtitle File (.srt / .ass)
            </Label>
            <FilePicker
              value={srtFile}
              placeholder="Required (unless Video File is provided)"
              onPick={async () => {
                const p = await window.api.openFile(SUBTITLE_FILTERS)
                if (!p) return
                setSrtFile(p)
                // Loading a new SRT invalidates the prior TMDB context.
                setDescription('')
                setTmdbResetKey((k) => k + 1)
              }}
              onClear={() => setSrtFile('')}
            />
          </div>

          <div>
            <Label tip="Optional. Provide a video file to scan its embedded subtitle tracks — pick which track to translate without extracting it first. Requires FFmpeg (configure path in Settings → Advanced if not on PATH).">
              Video File
            </Label>
            <FilePicker
              value={videoFile}
              placeholder="Optional — extract embedded subtitles (FFmpeg)"
              onPick={pickVideo}
              onClear={clearVideo}
            />
            {/*
              The clock is the point. ffprobe on a 50 GB file over a network share can take
              a while, and a static line gives no way to tell "working" from "wedged".
            */}
            {probing && (
              <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">
                Scanning subtitle tracks… <Elapsed since={probeStartedAt} />
              </p>
            )}
            <div className="mt-2">
              {/*
                REP-9: the key is what clears the panel's extraction result when a different
                video is loaded. Without it React keeps the same instance, and the previous
                film's "Saved → …" survives — pointing at a real file, so the panel actively
                asserts that THIS video's subtitles were extracted. Resetting by `key` cannot
                miss a field the way a hand-written reset of three named values can.
              */}
              <SubTrackPanel
                key={videoFile}
                videoFile={videoFile}
                tracks={tracks}
                targetLang={tgtLang}
                selectedIndex={selectedTrack}
                onSelect={setSelectedTrack}
                busy={ffmpeg !== null}
                busyPct={ffmpeg?.kind === 'export' ? ffmpeg.pct : null}
                onBusy={setExportBusy}
              />
            </div>
          </div>

          <div>
            <Label tip="Optional. An audio track (or video) whose audio Gemini analyses to determine speaker genders — improves gendered pronouns in languages like Hebrew, Spanish, French. Requires FFmpeg.">
              Audio File
            </Label>
            <FilePicker
              value={audioFile}
              placeholder="Optional — gender-aware context (FFmpeg)"
              onPick={async () => {
                const p = await window.api.openFile(AUDIO_FILTERS)
                if (p) setAudioFile(p)
              }}
              onClear={() => setAudioFile('')}
            />
          </div>
        </div>
      </Box>

      <Box>
        <BoxTitle>Languages</BoxTitle>
        <div className="flex gap-6">
          <div className="flex-1">
            <Label tip="The language the original subtitles are written in. 'Auto Detect' works for most common languages and is recommended. Set a specific language only if auto-detect gives wrong results.">
              Source Language
            </Label>
            <Select value={srcLang} onChange={setSrcLang} options={SOURCE_LANGUAGES} className="w-full" />
          </div>
          <div className="flex-1">
            <Label tip="The language to translate into. Required. If a video track already matches this language, you'll be warned and offered to extract it instead of re-translating.">
              Target Language
            </Label>
            <Select
              value={tgtLang}
              onChange={setTgtLang}
              options={[{ value: '', label: '— choose —' }, ...TARGET_LANGUAGES]}
              className="w-full"
            />
          </div>
        </div>
      </Box>

      <Box>
        <TmdbSearch key={tmdbResetKey} description={description} onDescription={setDescription} />
      </Box>

      <Box>
        <BoxTitle>Translate</BoxTitle>
        {startError && <p className="mb-3 text-sm text-red-600 dark:text-red-400">{startError}</p>}
        <div className="flex items-center gap-2">
          {!isRunning ? (
            /*
              Disabled only while a job is running or its track is being extracted — and the
              first of those is belt-and-braces, since this branch is not rendered then.
              Everything else that would prevent a run is now reported by `handleStart` in
              words rather than by a button that does nothing. See `whyCannotStart`.

              The label changes during preparation because the reported complaint was
              precisely that it did not: a button still offering to start something is the
              strongest possible claim that nothing has started.
            */
            <Button onClick={handleStart} disabled={isRunning || ffmpeg !== null}>
              {ffmpeg?.kind === 'prepare' ? 'Extracting track…' : 'Start Translation'}
            </Button>
          ) : (
            <Button variant="danger" onClick={stop}>
              Stop
            </Button>
          )}
          {state.status === 'done' && (
            <>
              <Button variant="secondary" onClick={handleSave}>
                Save Subtitles…
              </Button>
              <Button variant="ghost" onClick={reset}>
                New
              </Button>
            </>
          )}
          {!tgtLang && <span className="text-xs text-gray-400 dark:text-gray-500">Choose a target language to begin.</span>}
        </div>

        {ffmpeg?.kind === 'prepare' && (
          <div className="mt-4">
            <Working
              label="Extracting the selected subtitle track"
              pct={ffmpeg.pct}
              since={ffmpeg.startedAt}
              note="FFmpeg reads the whole container to find the track, so this takes as long as the film is big. The translation starts on its own when it finishes."
            />
          </div>
        )}

        {(isRunning || state.status === 'done' || state.status === 'error' || state.status === 'stopped') && (
          <div className="mt-4 space-y-3">
            {/*
              Nothing measurable has happened yet, so the bar says "alive" instead of "0%".
              The engine's own preparation — extracting the audio for gender context, sizing
              the first batch — reports nothing at all while it runs, and a 0% bar under a
              window that has been open for two minutes reads as a hang.
            */}
            <ProgressBar pct={state.progress} indeterminate={isRunning && state.progress === 0} />
            {isRunning && state.progress === 0 && (
              <p className="text-xs text-gray-500 dark:text-gray-400">
                Working for <Elapsed since={runStartedAt} /> — the engine reports no progress
                while it prepares, which on a large file takes a few minutes.
              </p>
            )}

            {isRunning && retryIsCurrent(state.retry, state.currentLine) && state.retry && (
              <RetryNotice retry={state.retry} />
            )}

            {state.status === 'error' || state.status === 'stopped' ? (
              <LogPanel rows={state.log} />
            ) : (
              <StatusCard
                running={isRunning}
                statusText={state.statusText}
                currentLine={state.currentLine}
                totalLines={state.totalLines}
                batchSize={settings.batchSize}
                tokens={state.tokens}
                showTokens={settings.showTokenStats}
                model={settings.model}
              />
            )}

            {state.status === 'done' && (
              <p className="text-sm font-medium text-green-700 dark:text-green-400">✅ Translation complete.</p>
            )}

            {/*
              REP-16. The engine validates a batch by counting items, not by reading them, so a run
              that filled 136 cues with two characters still reported success. This says so before
              the user picks a destination — it never blocks the save, and the file is untouched.
            */}
            {state.status === 'done' && state.warnings.length > 0 && (
              <div className="rounded-md border border-amber-400 bg-amber-50 px-3.5 py-3 dark:border-amber-700/60 dark:bg-amber-900/25">
                <p className="text-sm font-semibold text-amber-900 dark:text-amber-200">
                  ⚠ Part of this translation does not look right.
                </p>
                {state.warnings.map((w, i) => (
                  <p key={i} className="mt-1 text-sm text-amber-800 dark:text-amber-300">
                    {w}
                  </p>
                ))}
              </div>
            )}
            {state.status === 'error' && (
              <p className="text-sm font-medium text-red-600 dark:text-red-400">
                Process ended with an error (exit code {state.exitCode}). Check the log above.
              </p>
            )}
            {/*
              A run the user ended is not a failure, and saying so in red told them the app had
              broken when it had done exactly what they asked.
            */}
            {state.status === 'stopped' && (
              <div className="flex items-center gap-2">
                <p className="text-sm font-medium text-gray-700 dark:text-gray-300">
                  Stopped. Nothing was saved.
                </p>
                <Button variant="ghost" onClick={reset}>
                  New
                </Button>
              </div>
            )}

            {/* Raw log is hidden by default on success; power users can expand it. */}
            {state.status !== 'error' && state.status !== 'stopped' && state.log.length > 0 && (
              <div>
                <button
                  onClick={() => setShowLog((v) => !v)}
                  className="text-xs text-gray-500 hover:text-brand dark:text-gray-400"
                >
                  {showLog ? 'Hide' : 'Show'} log
                </button>
                {showLog && (
                  <div className="mt-2">
                    <LogPanel rows={state.log} />
                  </div>
                )}
              </div>
            )}

            {savedPath && (
              <>
                <p className="text-sm text-gray-700 dark:text-gray-300">
                  Saved → {savedPath}{' '}
                  <button onClick={() => window.api.showItemInFolder(savedPath)} className="text-brand hover:underline">
                    Open folder
                  </button>
                </p>
                {/*
                  Said once, after the save, because that is the moment the file exists where the
                  user can reach it: until then it is in temp, waiting for a destination. The
                  panel above is capped and collapses repeats — this file is neither, which is
                  the whole reason it was asked for (REP-1, REP-3).
                */}
                {consoleLogName && (
                  <p className="text-xs text-gray-500 dark:text-gray-400">
                    The complete console for this run was saved beside it, as {consoleLogName} —
                    uncapped and uncollapsed, unlike the panel above.
                  </p>
                )}
              </>
            )}

            {/*
              The run that did NOT reach a Save.

              Routing this page's console through `dialog:saveFile` is right for a successful run
              and wrong for every other one: a stopped or failed translation has no subtitle to
              save, so gating the log on `savedPath` withheld it from precisely the runs it exists
              for. The file is already written — `finish()` reports it on every ending — so this
              points at the original in temp rather than at a copy that will never be made.
            */}
            {!savedPath && consoleLogPath && (
              <p className="text-xs text-gray-500 dark:text-gray-400">
                The complete console for this run → {consoleLogPath}{' '}
                <button
                  onClick={() => window.api.showItemInFolder(consoleLogPath)}
                  className="text-brand hover:underline"
                >
                  Show it
                </button>
              </p>
            )}
          </div>
        )}
      </Box>
    </div>
  )
}
