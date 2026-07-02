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
  StatusCard
} from '../components/ui'
import { SubTrackPanel } from '../components/SubTrackPanel'
import { TmdbSearch } from '../components/TmdbSearch'
import { SOURCE_LANGUAGES, TARGET_LANGUAGES } from '../data/languages'
import { useRunner } from '../lib/useRunner'
import type { SubtitleTrack, TranslateArgs } from '../../electron/shared/types'

const VIDEO_FILTERS = [{ name: 'Video', extensions: ['mp4', 'mkv', 'mov', 'avi', 'webm', 'm4v', 'ts'] }]
const SRT_FILTERS = [{ name: 'Subtitles', extensions: ['srt'] }]
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
  const [startError, setStartError] = useState('')
  const [showLog, setShowLog] = useState(false)

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
  const canStart = !isRunning && (srtFile !== '' || (videoFile !== '' && selectedTrack !== null)) && tgtLang !== ''

  async function handleStart(): Promise<void> {
    setStartError('')
    setSavedPath('')
    setShowLog(false)
    const cfg = settings
    if (!cfg) return

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
      setStartError('Provide an SRT file, or a video with a selectable text track.')
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
    await start(() => window.api.startTranslate(args))
  }

  async function handleSave(): Promise<void> {
    if (!state.outputPath) return
    const base = (srtFile || videoFile || 'subtitle').replace(/\.[^.]+$/, '')
    const name = `${base.split(/[\\/]/).pop()}_${tgtLang}.srt`
    const saved = await window.api.saveFile({
      srcPath: state.outputPath,
      defaultName: name,
      defaultDir: settings?.outputFolder || undefined,
      logPaths: state.logPaths.length ? state.logPaths : undefined
    })
    if (saved) setSavedPath(saved)
  }

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <Box>
        <BoxTitle>Input Files</BoxTitle>
        <div className="space-y-4">
          <div>
            <Label tip="The .srt subtitle file you want to translate. This is the only required input for basic translation — no video or audio needed. If you have a video file instead, use the Video File field below to extract subtitles from it.">
              SRT File
            </Label>
            <FilePicker
              value={srtFile}
              placeholder="Required (unless Video File is provided)"
              onPick={async () => {
                const p = await window.api.openFile(SRT_FILTERS)
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
              <SubTrackPanel
                videoFile={videoFile}
                tracks={tracks}
                targetLang={tgtLang}
                selectedIndex={selectedTrack}
                onSelect={setSelectedTrack}
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
            <Button onClick={handleStart} disabled={!canStart}>
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

        {(isRunning || state.status === 'done' || state.status === 'error') && (
          <div className="mt-4 space-y-3">
            <ProgressBar pct={state.progress} />

            {state.status === 'error' ? (
              <LogPanel lines={state.log} />
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
            {state.status === 'error' && (
              <p className="text-sm font-medium text-red-600 dark:text-red-400">
                Process ended with an error (exit code {state.exitCode}). Check the log above.
              </p>
            )}

            {/* Raw log is hidden by default on success; power users can expand it. */}
            {state.status !== 'error' && state.log.length > 0 && (
              <div>
                <button
                  onClick={() => setShowLog((v) => !v)}
                  className="text-xs text-gray-500 hover:text-brand dark:text-gray-400"
                >
                  {showLog ? 'Hide' : 'Show'} log
                </button>
                {showLog && (
                  <div className="mt-2">
                    <LogPanel lines={state.log} />
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
