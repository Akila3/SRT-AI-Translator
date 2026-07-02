import React, { useEffect, useState } from 'react'
import { useStore } from '../store/useStore'
import { Box, BoxTitle, Label, FilePicker, Button, ProgressBar, LogPanel, Select } from '../components/ui'
import { THINKING_LEVELS } from '../data/freeTier'
import { useRunner } from '../lib/useRunner'
import type { TranscribeArgs } from '../../electron/shared/types'

const MEDIA_FILTERS = [
  { name: 'Audio/Video', extensions: ['mp4', 'mkv', 'mov', 'avi', 'webm', 'mp3', 'aac', 'wav', 'm4a', 'flac'] }
]

export default function TranscribePage(): React.JSX.Element {
  const settings = useStore((s) => s.settings)
  const { state, start, stop, reset } = useRunner()
  const [mediaFile, setMediaFile] = useState('')
  const [outputFile, setOutputFile] = useState('')
  const [description, setDescription] = useState('')
  const [startError, setStartError] = useState('')

  useEffect(() => {
    if (mediaFile && !outputFile) {
      setOutputFile(mediaFile.replace(/\.[^.]+$/, '') + '.srt')
    }
  }, [mediaFile, outputFile])

  if (!settings) return <div className="p-6 text-sm text-gray-500 dark:text-gray-400">Loading…</div>

  const is3x = settings.model.startsWith('gemini-3') || settings.model.endsWith('-latest')
  const isRunning = state.status === 'running'

  async function handleStart(): Promise<void> {
    setStartError('')
    if (!settings) return
    if (!mediaFile) {
      setStartError('Choose an audio or video file to transcribe.')
      return
    }
    const args: TranscribeArgs = {
      mediaFile,
      outputFile: outputFile || mediaFile.replace(/\.[^.]+$/, '') + '.srt',
      targetLang: '',
      model: settings.model,
      apiKeys: settings.apiKeys,
      thinkingLevel: settings.thinkingLevel,
      thinkingBudget: settings.thinkingBudget,
      description: description || undefined,
      ffmpegPath: settings.ffmpegPath || undefined
    }
    await start(() => window.api.startTranscribe(args))
  }

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <Box className="border-blue-200 bg-blue-50/40 dark:border-blue-900/50 dark:bg-blue-950/30">
        <BoxTitle>About Transcription</BoxTitle>
        <div className="grid grid-cols-2 gap-6 text-sm text-gray-700 dark:text-gray-300">
          <div>
            <div className="mb-1 font-semibold text-gray-900 dark:text-gray-100">When to use it</div>
            <p>
              Use this when you have <em>no subtitle file at all</em> — it listens to the spoken audio
              and generates a brand-new SRT in the original spoken language.
            </p>
          </div>
          <div>
            <div className="mb-1 font-semibold text-gray-900 dark:text-gray-100">What it outputs</div>
            <p>
              A timed .srt transcription. To then translate it, take the result over to the Translate
              tab. Requires FFmpeg for audio extraction.
            </p>
          </div>
        </div>
      </Box>

      <Box>
        <BoxTitle>Input</BoxTitle>
        <div className="space-y-4">
          <div>
            <Label tip="The audio or video file to transcribe. Gemini listens to the audio and produces timed subtitles in the language that is spoken. For video, the audio track is extracted automatically (requires FFmpeg).">
              Audio / Video File
            </Label>
            <FilePicker
              value={mediaFile}
              placeholder="Choose an audio or video file"
              onPick={async () => {
                const p = await window.api.openFile(MEDIA_FILTERS)
                if (p) setMediaFile(p)
              }}
              onClear={() => setMediaFile('')}
            />
          </div>
          <div>
            <Label tip="Where the generated .srt transcription will be written. Defaults to the same folder and name as the input file.">
              Output File
            </Label>
            <FilePicker
              value={outputFile}
              placeholder="Output .srt path"
              onPick={async () => {
                const p = await window.api.saveFile({ defaultName: outputFile || 'transcription.srt' })
                if (p) setOutputFile(p)
              }}
              onClear={() => setOutputFile('')}
            />
          </div>
        </div>
      </Box>

      <Box>
        <BoxTitle>Model</BoxTitle>
        <div className="flex gap-6">
          <div className="flex-1">
            <Label tip="The model used for transcription is taken from your Settings → Model & Generation. Shown here for reference.">
              Model (from Settings)
            </Label>
            <Select value={settings.model} onChange={() => {}} disabled options={settings.cachedModels.map((m) => ({ value: m.id, label: m.label }))} className="w-full" />
          </div>
          <div className="flex-1">
            <Label tip="Thinking level for transcription (Gemini 3.x). Low is usually sufficient. Disabled for 2.x models, which use the Thinking Budget from Settings instead.">
              Thinking Level
            </Label>
            <Select
              value={settings.thinkingLevel}
              onChange={() => {}}
              disabled={!is3x}
              options={is3x ? THINKING_LEVELS : [{ value: '', label: '3.x models only' }]}
              className="w-full"
            />
          </div>
        </div>
        <div className="mt-4">
          <Label tip="Optional context to help transcription accuracy — e.g. names, jargon, or the topic. Passed to the model as a hint.">
            Description / Context
          </Label>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={2}
            placeholder="Optional — names, jargon, topic…"
            className="w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 outline-none focus:border-brand focus:ring-1 focus:ring-brand dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 dark:placeholder:text-gray-500"
          />
        </div>
      </Box>

      <Box>
        <BoxTitle>Transcribe</BoxTitle>
        {startError && <p className="mb-3 text-sm text-red-600 dark:text-red-400">{startError}</p>}
        <div className="flex items-center gap-2">
          {!isRunning ? (
            <Button onClick={handleStart} disabled={!mediaFile}>
              Start Transcription
            </Button>
          ) : (
            <Button variant="danger" onClick={stop}>
              Stop
            </Button>
          )}
          {state.status === 'done' && (
            <>
              <Button variant="secondary" onClick={() => window.api.showItemInFolder(state.outputPath)}>
                Open folder
              </Button>
              <Button variant="ghost" onClick={reset}>
                New
              </Button>
            </>
          )}
        </div>

        {(isRunning || state.status === 'done' || state.status === 'error') && (
          <div className="mt-4 space-y-3">
            <ProgressBar pct={state.progress} />
            <LogPanel lines={state.log} />
            {state.status === 'done' && (
              <p className="text-sm font-medium text-green-700 dark:text-green-400">✅ Transcription saved → {state.outputPath}</p>
            )}
            {state.status === 'error' && (
              <p className="text-sm font-medium text-red-600 dark:text-red-400">
                Process ended with an error (exit code {state.exitCode}). Check the log above.
              </p>
            )}
          </div>
        )}
      </Box>
    </div>
  )
}
