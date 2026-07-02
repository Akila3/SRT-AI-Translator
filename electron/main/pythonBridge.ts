import { spawn, ChildProcessWithoutNullStreams } from 'child_process'
import { app } from 'electron'
import path from 'path'
import fs from 'fs'
import { gstLanguageName } from '../shared/languages'
import { envWithFfmpeg } from './ffmpeg'
import { getSettings } from './store'
import type { TranslateArgs, TranscribeArgs } from '../shared/types'

let current: ChildProcessWithoutNullStreams | null = null

/** Resolve the bundled `gst` executable, or fall back to PATH in dev. */
export function resolveGstBin(): string {
  if (app.isPackaged) {
    const bin = process.platform === 'win32' ? 'gst.exe' : 'gst'
    const bundled = path.join(process.resourcesPath, 'bin', bin)
    if (fs.existsSync(bundled)) return bundled
  }
  return 'gst'
}

export function tempOutputPath(suffix = '.srt'): string {
  const dir = path.join(app.getPath('userData'), 'temp')
  fs.mkdirSync(dir, { recursive: true })
  return path.join(dir, `${Date.now()}${suffix}`)
}

/**
 * Normalize an SRT to plain UTF-8 (no BOM) before handing it to `gst`, which
 * opens its input with `encoding="utf-8"`. This guards against two failure
 * modes: a UTF-16/legacy-encoded file making gst raise UnicodeDecodeError, and
 * a BOM leaking into the first cue. Returns a converted temp copy when needed,
 * otherwise the original path unchanged.
 */
export function ensureUtf8Srt(inputPath: string): string {
  let buf: Buffer
  try {
    buf = fs.readFileSync(inputPath)
  } catch {
    return inputPath
  }

  let text: string
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    text = buf.subarray(3).toString('utf-8') // UTF-8 with BOM → strip BOM
  } else if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    text = new TextDecoder('utf-16le').decode(buf.subarray(2))
  } else if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    text = new TextDecoder('utf-16be').decode(buf.subarray(2))
  } else {
    try {
      // Already valid, BOM-less UTF-8 — feed it straight through.
      new TextDecoder('utf-8', { fatal: true }).decode(buf)
      return inputPath
    } catch {
      // Not UTF-8: assume a legacy Windows code page (covers most Latin SRTs).
      try {
        text = new TextDecoder('windows-1252').decode(buf)
      } catch {
        text = buf.toString('latin1')
      }
    }
  }

  try {
    const outPath = tempOutputPath('.utf8.srt')
    fs.writeFileSync(outPath, text, 'utf-8')
    return outPath
  } catch {
    return inputPath
  }
}

function thinkingArgs(level: string, budget: number, model: string): string[] {
  // "-latest" aliases currently resolve to a Gemini 3.x model, which uses
  // thinking levels rather than a numeric budget.
  const isGen3 = model.startsWith('gemini-3') || model.endsWith('-latest')
  if (level === 'disabled') return ['--no-thinking']
  if (isGen3) {
    return ['--thinking-level', level]
  }
  if (model.startsWith('gemini-2.5')) {
    return ['--thinking-budget', String(budget)]
  }
  return []
}

export interface SpawnHandlers {
  onOutput: (stream: 'stdout' | 'stderr', line: string) => void
  onDone: (code: number | null, outputPath: string) => void
}

/**
 * Order the provided keys so a known-valid key is always used as the primary
 * (-k), with valid keys first, unknown-status keys next, and known-invalid keys
 * dropped (kept only as a last resort if nothing else is available). Also reports
 * the effective primary key's tier so rate-limiting matches the key actually used.
 */
export function orderKeysByValidity(apiKeys: string[]): { keys: string[]; paid: boolean } {
  const s = getSettings()
  const entries = apiKeys
    .map((k) => k.trim())
    .filter((k) => k.length > 0)
    .map((k) => {
      const idx = s.apiKeys.indexOf(k)
      const valid = idx >= 0 ? s.apiKeyValid?.[idx] ?? null : null
      const tier = idx >= 0 ? s.apiKeyTiers?.[idx] ?? 'free' : 'free'
      return { k, valid, tier }
    })
  const rank = (v: boolean | null): number => (v === true ? 0 : v === null ? 1 : 2)
  const usable = entries.filter((e) => e.valid !== false)
  const ordered = (usable.length ? usable : entries).slice().sort((a, b) => rank(a.valid) - rank(b.valid))
  return { keys: ordered.map((e) => e.k), paid: (ordered[0]?.tier ?? 'free') === 'paid' }
}

export function buildTranslateArgs(a: TranslateArgs, outputPath: string): string[] {
  const args: string[] = ['translate', '-i', a.inputFile, '-o', outputPath]

  const langName = gstLanguageName(a.targetLang)
  if (langName) args.push('-l', langName)

  const { keys, paid } = orderKeysByValidity(a.apiKeys)
  if (keys[0]) args.push('-k', keys[0])
  if (keys[1]) args.push('-k2', keys[1])

  if (a.audioFile) args.push('-a', a.audioFile)

  args.push('-m', a.model)
  args.push('-b', String(a.batchSize))
  args.push('--temperature', String(a.temperature))
  args.push('--top-p', String(a.topP))
  if (a.topK != null) args.push('--top-k', String(a.topK))

  args.push(...thinkingArgs(a.thinkingLevel, a.thinkingBudget, a.model))

  if (a.serviceTier && a.serviceTier !== 'standard') {
    args.push('--service-tier', a.serviceTier)
  }
  // Use the effective primary key's tier (it may differ if the configured
  // primary was invalid and a fallback got promoted).
  if (paid) args.push('--paid-quota')
  if (!a.batchContext) args.push('--no-context')
  if (a.disableStreaming) args.push('--no-streaming')

  // Source language has no dedicated flag — fold it into the description.
  let description = a.description?.trim() ?? ''
  if (a.sourceLang && a.sourceLang !== 'auto') {
    const srcName = gstLanguageName(a.sourceLang)
    if (srcName) description = `Source language: ${srcName}.${description ? ' ' + description : ''}`
  }
  if (description) args.push('-d', description)

  if (a.resumeFrom && a.resumeFrom > 0) {
    args.push('-s', String(a.resumeFrom), '--resume')
  } else {
    args.push('--no-resume')
  }

  args.push('--token-stats', '--skip-upgrade', '--no-colors')

  if (a.progressLog) args.push('--progress-log')
  if (a.thoughtsLog) args.push('--thoughts-log')
  // --token-report takes an explicit path; gst derives progress/thoughts paths
  // from the output path automatically (replaces extension).
  if (a.writeTokenReport) {
    const reportPath = outputPath.replace(/\.[^.]+$/, '.tokens.json')
    args.push('--token-report', reportPath)
  }

  return args
}

export function buildTranscribeArgs(a: TranscribeArgs, outputPath: string): string[] {
  const args: string[] = ['transcribe', '-o', outputPath]

  // transcribe requires -v (video) or -a (audio)
  const isVideo = /\.(mp4|mkv|mov|avi|webm|m4v|ts|wmv|flv)$/i.test(a.mediaFile)
  args.push(isVideo ? '-v' : '-a', a.mediaFile)

  const { keys } = orderKeysByValidity(a.apiKeys)
  if (keys[0]) args.push('-k', keys[0])

  args.push('-m', a.model)
  args.push(...thinkingArgs(a.thinkingLevel, a.thinkingBudget, a.model))
  if (a.description?.trim()) args.push('-d', a.description.trim())

  args.push('--token-stats', '--skip-upgrade', '--no-colors')
  return args
}

function run(args: string[], outputPath: string, handlers: SpawnHandlers): void {
  if (current) {
    handlers.onOutput('stderr', 'A process is already running.')
    return
  }
  const bin = resolveGstBin()
  const env = envWithFfmpeg(getSettings().ffmpegPath, {
    PYTHONUNBUFFERED: '1',
    // Force full UTF-8 mode so non-Latin output (Hebrew, etc.) doesn't crash on
    // Windows' legacy cp1252 ("charmap") console/locale encoding.
    PYTHONUTF8: '1',
    PYTHONIOENCODING: 'utf-8'
  })
  let proc: ChildProcessWithoutNullStreams
  try {
    proc = spawn(bin, args, { env })
  } catch (err) {
    handlers.onOutput('stderr', `Failed to start gst: ${(err as Error).message}`)
    handlers.onDone(-1, outputPath)
    return
  }
  current = proc

  let stdoutBuf = ''
  let stderrBuf = ''

  proc.stdout.setEncoding('utf-8')
  proc.stderr.setEncoding('utf-8')

  proc.stdout.on('data', (chunk: string) => {
    stdoutBuf += chunk
    const lines = stdoutBuf.split(/\r?\n/)
    stdoutBuf = lines.pop() ?? ''
    for (const l of lines) handlers.onOutput('stdout', l)
  })
  proc.stderr.on('data', (chunk: string) => {
    stderrBuf += chunk
    const lines = stderrBuf.split(/\r?\n/)
    stderrBuf = lines.pop() ?? ''
    for (const l of lines) handlers.onOutput('stderr', l)
  })
  proc.on('error', (err) => {
    handlers.onOutput('stderr', `Process error: ${err.message}`)
  })
  proc.on('close', (code) => {
    if (stdoutBuf) handlers.onOutput('stdout', stdoutBuf)
    if (stderrBuf) handlers.onOutput('stderr', stderrBuf)
    current = null
    handlers.onDone(code, outputPath)
  })
}

export interface StartTranslateResult {
  outputPath: string
  /** Paths of any log/report files gst will write alongside outputPath (may be empty). */
  logPaths: string[]
}

export function startTranslate(a: TranslateArgs, handlers: SpawnHandlers): StartTranslateResult {
  const outputPath = tempOutputPath('.srt')
  const normalized: TranslateArgs = { ...a, inputFile: ensureUtf8Srt(a.inputFile) }
  run(buildTranslateArgs(normalized, outputPath), outputPath, handlers)

  const logPaths: string[] = []
  // The token report is written to the explicit --token-report path we pass
  // (derived from the OUTPUT file). Progress/thoughts logs, however, are named
  // by gst from the INPUT file's basename/dir (see gemini_srt_translator main.py),
  // so they must be derived from the normalized input path, not the output.
  const outBase = outputPath.replace(/\.[^.]+$/, '')
  const inBase = normalized.inputFile.replace(/\.[^.]+$/, '')
  if (a.writeTokenReport) logPaths.push(`${outBase}.tokens.json`)
  if (a.progressLog)      logPaths.push(`${inBase}.progress.log`)
  if (a.thoughtsLog)      logPaths.push(`${inBase}.thoughts.log`)

  return { outputPath, logPaths }
}

export function startTranscribe(a: TranscribeArgs, handlers: SpawnHandlers): string {
  run(buildTranscribeArgs(a, a.outputFile), a.outputFile, handlers)
  return a.outputFile
}

export function stopCurrent(): void {
  if (!current) return
  try {
    if (process.platform === 'win32' && current.pid) {
      spawn('taskkill', ['/pid', String(current.pid), '/f', '/t'])
    } else {
      current.kill('SIGTERM')
    }
  } catch {
    /* ignore */
  }
  current = null
}

export function isRunning(): boolean {
  return current !== null
}
