import React, { useEffect, useRef, useState } from 'react'
import { useStore } from '../store/useStore'
import {
  Box,
  BoxTitle,
  Label,
  Select,
  FilePicker,
  Button,
  ProgressBar,
  LogPanel,
  RetryNotice,
  StatusCard
} from '../components/ui'
import { SubTrackPanel } from '../components/SubTrackPanel'
import { TmdbSearch } from '../components/TmdbSearch'
import { SOURCE_LANGUAGES, TARGET_LANGUAGES } from '../data/languages'
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
   * Whether an extraction started from the track panel is still running.
   *
   * It is held here rather than in the panel because the panel is keyed by `videoFile` and so
   * does not survive a video change — while the ffmpeg process it started does, and nothing in
   * the main process serialises `video:extractTrack`. Kept in the child, the lock was released
   * by the remount and a second extraction could start beside the first (validator finding
   * FP5-01). The panel takes and releases it; the promise that releases it outlives the panel.
   */
  const [extracting, setExtracting] = useState(false)

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
    // If translating from a video's embedded track, extract it silently first.
    if (!inputFile && videoFile && selectedTrack !== null) {
      const res = await window.api.extractToTemp({ filePath: videoFile, subtitleIndex: selectedTrack })
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
            {probing && <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">Scanning subtitle tracks…</p>}
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
                busy={extracting}
                onBusy={setExtracting}
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
              Disabled only while a job is running — and even that is belt-and-braces, since
              this branch is not rendered then. Everything else that would prevent a run is
              now reported by `handleStart` in words rather than by a button that does
              nothing. See `whyCannotStart`.
            */
            <Button onClick={handleStart} disabled={isRunning}>
              Start Translation
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

        {(isRunning || state.status === 'done' || state.status === 'error' || state.status === 'stopped') && (
          <div className="mt-4 space-y-3">
            <ProgressBar pct={state.progress} />

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
              <p className="text-sm text-gray-700 dark:text-gray-300">
                Saved → {savedPath}{' '}
                <button onClick={() => window.api.showItemInFolder(savedPath)} className="text-brand hover:underline">
                  Open folder
                </button>
              </p>
            )}
          </div>
        )}
      </Box>
    </div>
  )
}
