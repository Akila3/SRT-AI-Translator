import { spawn, ChildProcessWithoutNullStreams } from 'child_process'
import { app } from 'electron'
import path from 'path'
import fs from 'fs'
import { gstLanguageName } from '../shared/languages'
import { envWithFfmpeg } from './ffmpeg'
import { getSettings } from './store'
import { orderKeySlots, type KeySlot } from '../shared/keyOrder'
import { effectiveThinkingLevel, modelCapabilities } from '../shared/modelCaps'
import { DEFAULT_RESUME_CONTEXT_SIZE, type TranslateArgs, type TranscribeArgs } from '../shared/types'

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

/**
 * Resolve a bare executable name against the same PATH a spawned child would see.
 * Only used for the startup log below — spawn does its own resolution.
 */
function resolveOnPath(name: string): string | null {
  const env = envWithFfmpeg(getSettings().ffmpegPath)
  const sep = process.platform === 'win32' ? ';' : ':'
  const exts =
    process.platform === 'win32'
      ? (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
      : ['']
  for (const dir of (env.PATH ?? '').split(sep)) {
    if (!dir) continue
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext)
      try {
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate
      } catch {
        /* unreadable PATH entry */
      }
    }
  }
  return null
}

/**
 * Log which `gst` binary this process will actually run.
 *
 * This is permanent by design. `resolveGstBin()` returns a bare `gst` unless packaged,
 * and `envWithFfmpeg` deliberately APPENDS the bundled dir to PATH, so a globally pip
 * installed engine silently wins in dev — which would make every dev-run test measure a
 * different binary from the one that ships. Without this line, "which binary am I
 * running" is unanswerable at runtime.
 */
export function logResolvedGstBin(): void {
  const bin = resolveGstBin()
  if (path.isAbsolute(bin)) {
    console.log(`[gst] resolveGstBin() -> ${bin} (bundled, packaged build)`)
    return
  }
  const resolved = resolveOnPath(bin)
  console.log(
    `[gst] resolveGstBin() -> "${bin}" (resolved via PATH to: ${resolved ?? 'NOT FOUND ON PATH'})`
  )
  if (resolved && !resolved.toLowerCase().includes(`${path.sep}resources${path.sep}bin${path.sep}`)) {
    console.warn(
      '[gst] WARNING: the resolved binary is not the bundled resources/bin copy. ' +
        'Dev runs are exercising a different engine build than the one that ships.'
    )
  }
}

export function tempOutputPath(suffix = '.srt'): string {
  const dir = path.join(app.getPath('userData'), 'temp')
  fs.mkdirSync(dir, { recursive: true })
  return path.join(dir, `${Date.now()}${suffix}`)
}

export type SubtitleNormalizeResult = { ok: true; path: string } | { ok: false; error: string }

/** Subtitle formats the engine accepts for `-i` (cli.py:114). */
const SUBTITLE_EXTS = ['.srt', '.ass']

/**
 * Normalize a subtitle file to plain UTF-8 (no BOM) before handing it to `gst`, which
 * opens its input with `encoding="utf-8"`. Guards two failure modes: a UTF-16/legacy
 * encoded file making gst raise UnicodeDecodeError, and a BOM leaking into the first cue.
 *
 * Invariants:
 *  - The user's original file is NEVER modified. This returns either the input path
 *    untouched or the path of a separate temp copy.
 *  - The input's EXTENSION is preserved. The previous version hardcoded `.utf8.srt`, so
 *    a converted `.ass` reached gst with an `.srt` name — gst then parses ASS content as
 *    SRT and names the output `.srt` instead of `_translated.ass` (main.py:141-142 keys
 *    off the extension). Corrupt output, no error.
 *  - An ambiguous encoding is NOT guessed for `.ass`. The windows-1252/latin1 fallback
 *    stays for `.srt` (preserving today's behaviour for the format it was written for),
 *    but silently transcoding a styled format with a guessed code page mangles dialogue
 *    AND non-ASCII style names with no signal, so ASS is refused with an actionable error.
 */
export function ensureUtf8Subtitle(inputPath: string): SubtitleNormalizeResult {
  let buf: Buffer
  try {
    buf = fs.readFileSync(inputPath)
  } catch {
    return { ok: true, path: inputPath }
  }

  const ext = (path.extname(inputPath) || '.srt').toLowerCase()
  const suffix = SUBTITLE_EXTS.includes(ext) ? ext : '.srt'

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
      return { ok: true, path: inputPath }
    } catch {
      if (suffix === '.ass') {
        return {
          ok: false,
          error:
            'This .ass file is not UTF-8. Re-save it as UTF-8 (most subtitle editors offer ' +
            '"Save as UTF-8") and try again. It was left untouched — guessing a legacy code page ' +
            'would corrupt styled text and style names.'
        }
      }
      // Not UTF-8: assume a legacy Windows code page (covers most Latin SRTs).
      try {
        text = new TextDecoder('windows-1252').decode(buf)
      } catch {
        text = buf.toString('latin1')
      }
    }
  }

  try {
    const outPath = tempOutputPath(`.utf8${suffix}`)
    fs.writeFileSync(outPath, text, 'utf-8')
    return { ok: true, path: outPath }
  } catch {
    return { ok: true, path: inputPath }
  }
}

/**
 * Thinking flags for the chosen model, derived from the ONE shared capability helper.
 *
 * This used to be implemented twice — here and inline in SettingsPage — with different
 * logic, which is exactly how the `-latest` bug survived: the UI offered a control the
 * engine then ignored.
 */
function thinkingArgs(level: string, budget: number, model: string): string[] {
  const caps = modelCapabilities(model)
  if (level === 'disabled' && caps.canDisableThinking) return ['--no-thinking']
  if (caps.thinking === 'level') {
    return ['--thinking-level', effectiveThinkingLevel(model, level)]
  }
  if (caps.thinking === 'budget') {
    const clamped = Math.min(caps.thinkingBudgetMax, Math.max(caps.thinkingBudgetMin, budget))
    return ['--thinking-budget', String(clamped)]
  }
  return []
}

/**
 * Emit --temperature / --top-p / --top-k only when the user has opted into custom
 * generation parameters; otherwise omit them entirely so the model's own defaults apply
 * (all three default to None in the engine and flow into GenerateContentConfig unchanged
 * — main.py:100-112, 245-251).
 *
 * The zero trap: `cli.py` tests these with plain truthiness (lines 153-158), so a literal
 * 0 is silently dropped. The UI clamps above zero; this skips-and-logs as a second line
 * of defence rather than letting a user believe a 0 was applied.
 */
function generationParamArgs(a: {
  customGenerationParams: boolean
  temperature: number
  topP: number
  topK: number | null
}): string[] {
  if (!a.customGenerationParams) return []
  const args: string[] = []
  const push = (flag: string, value: number): void => {
    if (!value) {
      console.warn(`[gst] skipping ${flag} ${value}: the engine silently ignores a zero value`)
      return
    }
    args.push(flag, String(value))
  }
  push('--temperature', a.temperature)
  push('--top-p', a.topP)
  if (a.topK != null) push('--top-k', a.topK)
  return args
}

export interface SpawnHandlers {
  onOutput: (stream: 'stdout' | 'stderr', line: string) => void
  onDone: (code: number | null, outputPath: string) => void
}

/**
 * Describe each non-empty key slot with the validity/tier metadata stored for it.
 *
 * THE single place slot metadata is assembled in the main process. `modelsList` ranks
 * the same descriptors to decide which keys are "active", and that answer must match the
 * pair this file actually spawns with — if the two drifted, a model could be offered
 * because a reserve key can see it and then 404 at spawn time.
 *
 * `apiKeyValid`/`apiKeyTiers` are index-aligned with `apiKeys`, so slot i is read
 * directly; the indexOf fallback covers a caller passing a re-ordered/partial array.
 */
export function keySlotsFor(apiKeys: string[]): KeySlot[] {
  const s = getSettings()
  const slots: KeySlot[] = []
  apiKeys.forEach((raw, i) => {
    const k = (raw ?? '').trim()
    if (!k) return
    const idx = s.apiKeys?.[i]?.trim() === k ? i : (s.apiKeys ?? []).findIndex((x) => x?.trim() === k)
    slots.push({
      index: i,
      valid: idx >= 0 ? s.apiKeyValid?.[idx] ?? null : null,
      tier: idx >= 0 ? s.apiKeyTiers?.[idx] ?? 'free' : 'free'
    })
  })
  return slots
}

/**
 * Order the provided keys so a known-valid key is always used as the primary
 * (-k), with valid keys first, unknown-status keys next, and known-invalid keys
 * dropped (kept only as a last resort if nothing else is available). Also reports
 * the effective primary key's tier so rate-limiting matches the key actually used.
 *
 * The ranking itself lives in `shared/keyOrder` so the Settings UI can label the exact
 * same slots "primary / fallback / reserve" without re-deriving (and mis-deriving) it.
 */
export function orderKeysByValidity(apiKeys: string[]): { keys: string[]; paid: boolean } {
  const slots = keySlotsFor(apiKeys)
  const ordered = orderKeySlots(slots)
  const tierOf = new Map(slots.map((s) => [s.index, s.tier]))
  return {
    keys: ordered.map((i) => apiKeys[i].trim()),
    paid: (tierOf.get(ordered[0]) ?? 'free') === 'paid'
  }
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
  args.push(...generationParamArgs(a))

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
    // Exactly one of --resume/--no-resume must always be present: without either, the
    // engine falls back to an interactive stdin prompt, which would hang the UI (C22b).
    args.push('--no-resume')
  }

  // Ships DORMANT: the engine consults resume_context_size only when start_line > 1
  // (main.py:718-719), i.e. on a resumed run. Emitted only when it differs from the
  // engine default so argv stays clean for everyone who never touches it.
  const resumeContext = a.resumeContextSize ?? DEFAULT_RESUME_CONTEXT_SIZE
  if (resumeContext !== DEFAULT_RESUME_CONTEXT_SIZE) {
    args.push('--resume-context-size', String(resumeContext))
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
  args.push(...generationParamArgs(a))
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
  // The output must keep the input's format. gst decides how to WRITE the result from the
  // output path's extension (main.py:141-142), so handing it a `.srt` name for an `.ass`
  // job silently downgrades a styled subtitle to plain SRT.
  const inExt = path.extname(a.inputFile).toLowerCase()
  const outputPath = tempOutputPath(SUBTITLE_EXTS.includes(inExt) ? inExt : '.srt')

  const norm = ensureUtf8Subtitle(a.inputFile)
  if (!norm.ok) {
    handlers.onOutput('stderr', norm.error)
    handlers.onDone(-1, outputPath)
    return { outputPath, logPaths: [] }
  }
  const normalized: TranslateArgs = { ...a, inputFile: norm.path }
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
