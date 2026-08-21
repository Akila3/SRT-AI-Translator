import { spawn, ChildProcessWithoutNullStreams } from 'child_process'
import { app } from 'electron'
import path from 'path'
import fs from 'fs'
import { gstLanguageName } from '../shared/languages'
import { convertAudioToMp3, envWithFfmpeg } from './ffmpeg'
import { getSettings } from './store'
import { orderKeySlots, type KeySlot } from '../shared/keyOrder'
import { maskCommandLine } from '../shared/maskedCommand'
import { createConsoleLog, consoleLogPathFor } from '../shared/consoleLog'
import { createStallWatch } from '../shared/stallBudget'
import { effectiveThinkingLevel, modelCapabilities } from '../shared/modelCaps'
import {
  DEFAULT_RESUME_CONTEXT_SIZE,
  type EngineInfo,
  type FfmpegProgress,
  type TerminalReason,
  type TranslateArgs,
  type TranscribeArgs
} from '../shared/types'

/**
 * The one job the app runs at a time.
 *
 * This used to be a bare `ChildProcessWithoutNullStreams | null`, which was sufficient only
 * while "a job" and "a spawned process" were the same thing. Transcription now has a
 * preparation step (audio conversion) that runs BEFORE anything is spawned, and during that
 * window a process-shaped lock reports idle: Stop would find nothing to kill and the job
 * would carry on into the API, and a second job could start and later be refused with no
 * terminal event, leaving its page running forever.
 *
 * So the slot is reserved for the whole lifetime of a job, and every terminal path goes
 * through `finish()`, which fires `onDone` exactly once, releases the slot, and deletes the
 * scratch files the job created.
 */
interface Job {
  /** The gst child once spawned; null while preparing. */
  proc: ChildProcessWithoutNullStreams | null
  /** Aborts an in-flight preparation step. Null when nothing is being prepared. */
  prep: AbortController | null
  /**
   * Set when the APP ends the run rather than the engine, and carried through to the renderer
   * so it can say what happened. Non-null also means "this job has been told to stop", which is
   * what the paths below check before doing any more work.
   */
  endReason: TerminalReason | null
  /** Temp files this job created and owns. Deleted when it ends, whatever the outcome. */
  scratch: string[]
  /**
   * This run's console, on disk. Deliberately NOT in `scratch`: scratch is deleted when the job
   * ends and the entire purpose of this file is to outlive the run. Null if it could not be
   * opened, which is never allowed to stop the run.
   */
  console: JobConsoleLog | null
  finished: boolean
  handlers: SpawnHandlers
  outputPath: string
}

interface JobConsoleLog {
  path: string
  write(line: string): void
  close(): void
}

/**
 * Bind the capped writer to a real file beside the job's output.
 *
 * Written synchronously, one line at a time. An async stream would be cheaper per line and
 * would also mean the last thing a run said is sitting in a buffer at the moment the run ends —
 * which is the moment a crash, a Stop or a `taskkill` on a frozen engine is most likely to
 * arrive. The volume is bounded by the ceiling, so the cost of being sure is small.
 */
function openJobConsoleLog(outputPath: string): JobConsoleLog | null {
  if (!outputPath) return null
  const logPath = consoleLogPathFor(outputPath)
  let fd: number
  try {
    fd = fs.openSync(logPath, 'w')
  } catch {
    // A log we cannot write is not a reason to refuse a translation.
    return null
  }
  let broken = false
  const log = createConsoleLog((chunk) => {
    if (broken) return
    try {
      fs.writeSync(fd, chunk)
    } catch {
      // A full disk or a revoked handle: stop trying rather than throw once per line into a
      // path that is only observing.
      broken = true
    }
  })
  let closed = false
  return {
    path: logPath,
    write: (line) => {
      if (!closed) log.write(line)
    },
    close: () => {
      if (closed) return
      closed = true
      log.close()
      try {
        fs.closeSync(fd)
      } catch {
        /* best effort: the descriptor is going away with the job either way */
      }
    }
  }
}

let job: Job | null = null

/** Reserve the single job slot, or return null if one is already held. */
function beginJob(handlers: SpawnHandlers, outputPath: string): Job | null {
  if (job) return null
  const consoleLog = openJobConsoleLog(outputPath)
  job = {
    proc: null,
    prep: null,
    endReason: null,
    scratch: [],
    console: consoleLog,
    finished: false,
    // Teed here rather than at each call site so the file gets what the panel gets, from every
    // path that reports anything: the masked command line, the preparation notices, the
    // engine's own two streams, the stall budget's verdict. A site that forgot to tee would be
    // a line the user can see but cannot send.
    handlers: consoleLog
      ? {
          ...handlers,
          onOutput: (stream, line) => {
            consoleLog.write(line)
            handlers.onOutput(stream, line)
          }
        }
      : handlers,
    outputPath
  }
  return job
}

/**
 * End a job exactly once: release the slot, remove its scratch files, emit the terminal
 * event. Idempotent, because several paths can race to end the same job (a Stop that kills
 * the child, and the child's own `close`).
 */
function finish(j: Job, code: number | null): void {
  if (j.finished) return
  j.finished = true
  if (job === j) job = null
  for (const file of j.scratch) {
    try {
      fs.unlinkSync(file)
    } catch {
      /* best effort: a temp file we cannot delete must not fail the job */
    }
  }
  j.scratch = []
  // How the run ended is the one fact the console never carries: the panel shows it as a
  // status, and a status is chrome a file does not have. Written here rather than through
  // `onOutput` so it does not become a second, redundant row on screen.
  j.console?.write(
    `[run ended: exit code ${code ?? 'none'}${j.endReason ? `, ended by the app: ${j.endReason}` : ''}]`
  )
  // Closed BEFORE the terminal event, so whatever the renderer does next — offer a Save that
  // copies this file, or open its folder — is looking at a complete one.
  j.console?.close()
  j.handlers.onDone(
    code,
    j.outputPath,
    j.endReason ?? undefined,
    j.console ? [j.console.path] : undefined
  )
}

/** Refuse a start request without leaving the caller's page spinning forever. */
function refuseStart(handlers: SpawnHandlers, outputPath: string): void {
  handlers.onOutput('stderr', 'A process is already running.')
  handlers.onDone(-1, outputPath)
}

/**
 * Kill the job's child process, whoever asked.
 *
 * One code path for a user's Stop and for the app's own termination, because the two differ
 * only in the reason recorded — and a second copy of this would eventually diverge on the part
 * that matters: the tree kill. A frozen PyInstaller build is a bootloader that spawns the real
 * interpreter as a child, so killing the pid we hold leaves the engine running, still talking to
 * the API and still writing output nobody is reading.
 *
 * The caller sets `endReason` BEFORE calling this: `close` fires asynchronously and reads it.
 */
function killJob(j: Job): void {
  const proc = j.proc
  if (!proc) {
    // Nothing spawned yet. A preparation step in flight owns the terminal event; with none,
    // end the job here so the slot is not held by a job that has no work to interrupt.
    if (!j.prep) finish(j, -1)
    return
  }
  try {
    if (process.platform === 'win32' && proc.pid) {
      treeKill(j, proc.pid)
    } else {
      proc.kill('SIGTERM')
    }
  } catch {
    // This used to end the job outright, reasoning that a failed kill means no `close` is
    // coming. True, and the wrong conclusion: if the kill failed the engine is still RUNNING,
    // and releasing the slot then is not a recovery, it is a second engine.
    //
    // Note how little this branch actually catches: `spawn()` reports almost every real failure
    // asynchronously, so this is the rare synchronous-argument case and NOT where a blocked or
    // missing `taskkill` arrives. That is `treeKill()`'s business.
    failedTermination(j, 'the termination could not be attempted')
  }
}

/**
 * Kill the engine's whole process tree on Windows — and find out whether that worked.
 *
 * The child used to be spawned and dropped on the floor, which is wrong twice over. A `taskkill`
 * that cannot START reports it through an **`error` event**, and an `error` on a child with no
 * listener is an uncaught exception: it does not merely go unnoticed, it takes the Electron main
 * process down. A `taskkill` that runs and **fails** — "Access is denied" is the ordinary case —
 * reports it by exiting non-zero, which nothing was reading. Both left the engine alive with the
 * UI stuck on Stopping… forever, because the only event that ends this run is a `close` from a
 * process that was never killed.
 *
 * Only failure is acted on. A successful tree kill exits 0 and the engine's own `close` ends the
 * run, which is the single path every other ending already goes through.
 */
function treeKill(j: Job, pid: number): void {
  const killer = spawn('taskkill', ['/pid', String(pid), '/f', '/t'])
  // `taskkill` says why in one line, and that line is the difference between "run it as
  // administrator" and "the anti-virus is holding it". Bounded: this is a diagnostic, not a feed.
  let why = ''
  killer.stderr?.on('data', (d: Buffer) => {
    if (why.length < 400) why += String(d)
  })
  killer.on('error', (e) => failedTermination(j, `taskkill could not run: ${e.message}`))
  killer.on('close', (code) => {
    if (code === 0) return
    // Both lines, joined: `taskkill` names the process on the first and gives the REASON on the
    // second, and the reason is the half the user can act on.
    const said = why
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
      .join(' ')
    failedTermination(j, `taskkill exited ${code}${said ? ` — ${said}` : ''}`)
  })
}

/**
 * A termination attempt failed. End the job only if the engine turns out to be gone anyway.
 *
 * The `finished` guard matters more than it looks: these handlers fire asynchronously, so this
 * one can arrive after the engine's own `close` has already ended the run — and by then the slot
 * may belong to a DIFFERENT job, whose panel would receive a stop failure that has nothing to do
 * with it. Reporting is left to `engineOutlivedItsKill()` for the same reason in miniature: a Stop
 * pressed just as the engine exits on its own makes `taskkill` report "process not found", and
 * announcing a failed termination for a process that is already gone is a false alarm.
 */
function failedTermination(j: Job, detail: string): void {
  if (j.finished) return
  if (engineOutlivedItsKill(j, detail)) return
  finish(j, -1)
}

/**
 * Is that process still out there?
 *
 * Signal 0 runs the existence and permission checks without delivering anything, which is the only
 * way to tell apart the two things a failed termination can mean. EPERM counts as ALIVE: a process
 * we are not allowed to signal is the worst version of this, not an absent one.
 */
function childIsAlive(pid: number | undefined): boolean {
  if (pid === undefined) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * A termination attempt failed — did the engine survive it?
 *
 * If it did, the job must NOT end. This is the harder half of the invariant to see: an ending
 * releases the single slot, so declaring a run over while its engine is alive lets a SECOND engine
 * start against the same API, and the survivor keeps pushing lines through the shared output
 * channel into the new run's panel. A slot held by a process that genuinely still exists is
 * accurate; a slot released for one that does is a lie the rest of the app then acts on.
 *
 * So the run stays open and waits for the `close` that arrives whenever the engine does exit. If
 * it never exits, that is said plainly rather than hidden behind a spinner — and pressing Stop
 * again re-enters `killJob()`, so the sentence is advice the user can act on twice.
 */
function engineOutlivedItsKill(j: Job, detail = ''): boolean {
  const pid = j.proc?.pid
  if (!childIsAlive(pid)) return false
  j.handlers.onOutput(
    'stderr',
    `${j.endReason ? 'The engine did not stop' : 'The engine is still running'} (pid ${pid})` +
      `${detail ? ` — ${detail}` : ''}. ` +
      'This run stays open until it exits, because starting another one now would put two engines ' +
      'on the same API key. Press Stop again to retry, or end that process yourself.'
  )
  return true
}

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
 * Which `gst` binary this process will actually run, as a fact the UI can show.
 *
 * The question is permanent: `resolveGstBin()` returns a bare `gst` unless packaged, and
 * `envWithFfmpeg` deliberately APPENDS the bundled directory to PATH, so a globally pip-installed
 * engine silently wins in dev — which would make every dev-run measurement describe a different
 * binary from the one that ships.
 *
 * MAN-5 is why this returns a value rather than only printing one. The answer was a `console.log`,
 * and a packaged Electron app on Windows is a GUI-subsystem binary with no console attached, so
 * the single most useful diagnostic in the app was readable everywhere except where it mattered.
 * That left release-gate check D1 — "the packaged app runs the packaged engine" — impossible for
 * the person holding the checklist. The payload lives in `shared/types` so the preload can type
 * it without importing main-process code.
 */
export function describeEngine(): EngineInfo {
  const bin = resolveGstBin()
  if (path.isAbsolute(bin)) return { path: bin, bundled: true, found: true }
  const resolved = resolveOnPath(bin)
  return {
    path: resolved ?? bin,
    // A dev machine can have the bundled copy on PATH; what makes it "bundled" is where it
    // lives, never how it was found.
    bundled: !!resolved && resolved.toLowerCase().includes(`${path.sep}resources${path.sep}bin${path.sep}`),
    found: !!resolved
  }
}

/** The same answer on the console at startup, which is still the right place in dev. */
export function logResolvedGstBin(): void {
  const info = describeEngine()
  console.log(
    `[gst] resolveGstBin() -> ${info.path}` +
      (info.bundled ? ' (bundled)' : info.found ? ' (resolved via PATH)' : ' (NOT FOUND ON PATH)')
  )
  if (info.found && !info.bundled) {
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
 *
 * The model check is NOT a duplicate of the disabled fields in Settings, and must stay even
 * though the UI already prevents the combination. Settings can only reason about the model
 * selected right now; a saved configuration outlives the model it was made with, and the
 * model list is fetched live, so a stored `customGenerationParams: true` will eventually
 * meet a model that rejects these outright. This is the last point before the process is
 * spawned, and it is the one that has to hold.
 *
 * Withholding the flags genuinely removes the fields from the API request rather than
 * merely leaving them to the engine's defaults — the engine's are `None` and the Google SDK
 * omits `None`, which is confirmed in captured traffic (REP-6: a payload whose
 * `generationConfig` contains temperature and topP but no topK, because no --top-k was
 * passed).
 */
function generationParamArgs(a: {
  model: string
  customGenerationParams: boolean
  temperature: number
  topP: number
  topK: number | null
}): string[] {
  if (!a.customGenerationParams) return []
  if (!modelCapabilities(a.model).acceptsSamplingParams) {
    console.warn(
      `[gst] withholding --temperature/--top-p/--top-k: ${a.model} ignores them today and ` +
        'newer models reject the request outright'
    )
    return []
  }
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

/**
 * What a key preflight can conclude, and what to tell the user.
 *
 * Asymmetric on purpose, exactly like `guardModelForSpawn`: only `rejected` stops a run.
 * "I could not reach Google" is not evidence against the key, and refusing to start because the
 * network blinked would be a worse failure than letting the engine report the truth.
 */
export interface KeyPreflight {
  verdict: 'valid' | 'rejected' | 'unchecked'
  message: string
}

export interface SpawnHandlers {
  onOutput: (stream: 'stdout' | 'stderr', line: string) => void
  /**
   * `logPaths` names the sidecars THIS FILE owns — today, the console log — and is optional for
   * the same reason `onProgress` is: it is additional information, not a new meaning for the
   * existing arguments, so every caller that declares fewer parameters stays valid. It is the
   * bridge that reports it because the bridge is the only thing that knows whether the file was
   * opened at all; a caller deriving the name for itself would happily name a previous run's
   * log after a start that was refused.
   */
  onDone: (
    code: number | null,
    outputPath: string,
    reason?: TerminalReason,
    logPaths?: string[]
  ) => void
  /**
   * How far the job's ffmpeg preparation has got. Optional: it is a second channel, not a
   * second meaning for the first, so every existing caller — including the verification
   * probes, which have no window to send to — stays valid by simply not listening.
   */
  onProgress?: (p: FfmpegProgress) => void
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

/** Containers the engine treats as video, i.e. `-v` rather than `-a`. */
const VIDEO_MEDIA_RE = /\.(mp4|mkv|mov|avi|webm|m4v|ts|wmv|flv)$/i

export function isVideoMedia(mediaFile: string): boolean {
  return VIDEO_MEDIA_RE.test(mediaFile)
}

/**
 * Audio containers the frozen engine can actually read. Verified against gst 3.7.0 on
 * 2026-08-19 with a dummy key, so the result is local and precedes any API call: `.mp3`
 * and `.wav` pass pydub's conversion step; `.m4a`, `.aac` and `.flac` do not.
 */
const ENGINE_AUDIO_EXTS = ['.mp3', '.wav']

export function needsAudioConversion(mediaFile: string): boolean {
  if (isVideoMedia(mediaFile)) return false
  return !ENGINE_AUDIO_EXTS.includes(path.extname(mediaFile).toLowerCase())
}

export type AudioNormalizeResult =
  | { ok: true; path: string; converted: boolean }
  | { ok: false; error: string }

/**
 * Give the engine an audio file it can read, converting only when it must.
 *
 * Same contract as `ensureUtf8Subtitle`, for the same class of reason: the user's original
 * file is NEVER modified, and this returns either the input path untouched or the path of a
 * separate temp copy. Video is passed straight through — the engine extracts and compresses
 * its audio itself, which is why video never hit this defect.
 */
export async function ensureEngineReadableAudio(
  mediaFile: string,
  ffmpegPath?: string,
  signal?: AbortSignal,
  onProgress?: (pct: number | null, elapsedMs: number) => void
): Promise<AudioNormalizeResult> {
  if (!needsAudioConversion(mediaFile)) return { ok: true, path: mediaFile, converted: false }

  const outPath = tempOutputPath('.mp3')
  const res = await convertAudioToMp3(mediaFile, outPath, ffmpegPath, signal, onProgress)
  if (!res.ok) {
    return {
      ok: false,
      error:
        `Could not prepare "${path.basename(mediaFile)}" for transcription: ${res.error}\n` +
        'Convert it to MP3 or WAV and try again. Your original file was not modified.'
    }
  }
  return { ok: true, path: outPath, converted: true }
}

export function buildTranscribeArgs(a: TranscribeArgs, outputPath: string): string[] {
  const args: string[] = ['transcribe', '-o', outputPath]

  // transcribe requires -v (video) or -a (audio)
  args.push(isVideoMedia(a.mediaFile) ? '-v' : '-a', a.mediaFile)

  const { keys } = orderKeysByValidity(a.apiKeys)
  if (keys[0]) args.push('-k', keys[0])

  args.push('-m', a.model)
  args.push(...generationParamArgs(a))
  args.push(...thinkingArgs(a.thinkingLevel, a.thinkingBudget, a.model))
  if (a.description?.trim()) args.push('-d', a.description.trim())

  args.push('--token-stats', '--skip-upgrade', '--no-colors')
  return args
}

/** Spawn gst for a job whose slot the caller has already reserved. */
function run(j: Job, args: string[]): void {
  const { handlers, outputPath } = j
  if (j.finished) return
  // A Stop during preparation must not be followed by a spawn: the window between the two
  // is exactly where a cancelled job would otherwise still reach the API and spend quota.
  if (j.endReason) {
    handlers.onOutput('stderr', 'Stopped before the engine started.')
    finish(j, -1)
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
  // What this run actually is, in one line, before it can fail to start (MAN-7). It names the
  // binary — which answers "is the packaged app running the packaged engine" from the log as
  // well as from Settings — and every flag, so `--paid-quota`, the model and the thinking
  // budget are observable instead of inferred. `maskCommandLine` is the ONLY thing permitted
  // to turn an argv into text; nothing else may hand this array to a log, a file or a console.
  handlers.onOutput('stdout', `$ ${maskCommandLine(describeEngine().path, args)}`)

  let proc: ChildProcessWithoutNullStreams
  try {
    proc = spawn(bin, args, { env })
  } catch (err) {
    handlers.onOutput('stderr', `Failed to start gst: ${(err as Error).message}`)
    finish(j, -1)
    return
  }
  j.proc = proc
  // The gap between this spawn and the engine's first line is not nothing: a frozen build
  // unpacks itself into a temp directory before it runs any of our code, which on a cold
  // start is seconds of a window that says absolutely nothing. One line, once, at the only
  // moment the app knows something the engine cannot yet report about itself.
  handlers.onOutput('stdout', 'Starting engine…')

  let stdoutBuf = ''
  let stderrBuf = ''

  /**
   * End a run the engine will not end itself (REP-2).
   *
   * Only the engine's own output is measured. The lines this file emits — the command line
   * above, `Starting engine…`, and this message itself — are the app talking to the user and
   * would otherwise be counted as the engine making progress.
   *
   * The message is emitted BEFORE the kill so it precedes the terminal event, and the reason
   * is `stalled` rather than `user`: FP-3 renders `user` as "Stopped", and reporting an auth
   * failure as though the user had pressed the button would bury the cause this exists to give
   * them.
   */
  const stall = createStallWatch()
  const observe = (line: string): void => {
    if (j.finished || j.endReason) return
    const verdict = stall.observe(line, Date.now())
    if (!verdict) return
    j.endReason = 'stalled'
    handlers.onOutput('stderr', verdict.message)
    killJob(j)
  }

  proc.stdout.setEncoding('utf-8')
  proc.stderr.setEncoding('utf-8')

  proc.stdout.on('data', (chunk: string) => {
    stdoutBuf += chunk
    const lines = stdoutBuf.split(/\r?\n/)
    stdoutBuf = lines.pop() ?? ''
    for (const l of lines) {
      handlers.onOutput('stdout', l)
      observe(l)
    }
  })
  proc.stderr.on('data', (chunk: string) => {
    stderrBuf += chunk
    const lines = stderrBuf.split(/\r?\n/)
    stderrBuf = lines.pop() ?? ''
    for (const l of lines) {
      handlers.onOutput('stderr', l)
      observe(l)
    }
  })
  /** Whatever the two streams were still holding when the run ended, in order. */
  const flush = (): void => {
    if (stdoutBuf) handlers.onOutput('stdout', stdoutBuf)
    if (stderrBuf) handlers.onOutput('stderr', stderrBuf)
    stdoutBuf = ''
    stderrBuf = ''
  }
  proc.on('error', (err) => {
    handlers.onOutput('stderr', `Process error: ${err.message}`)
    // This used to report and stop there, on the assumption that `close` would follow and end
    // the job. Node does not promise that — "the exit event may or may not fire after an error"
    // — and one of the documented causes is a kill that FAILED, where the child is still alive
    // and no close is coming by definition. `killJob()` cannot cover it either: it catches a
    // synchronous throw, and `proc.kill()` reports EPERM through this event instead.
    //
    // The cost of getting it wrong is the whole application: the job slot stays held, so every
    // later run of either kind is refused for the life of the process, with no terminal event to
    // release the page that asked. Ending here is safe in the ordinary case too, because
    // `finish()` is idempotent and the close that usually does follow finds the job already done.
    //
    // But NOT unconditionally, because the failed-kill case is exactly the one where the child is
    // still alive: ending then would release the slot to a second engine while the first is still
    // running and still writing into the shared output channel. The child is asked directly.
    if (engineOutlivedItsKill(j)) return
    flush()
    finish(j, -1)
  })
  proc.on('close', (code) => {
    flush()
    finish(j, code)
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

  const j = beginJob(handlers, outputPath)
  if (!j) {
    refuseStart(handlers, outputPath)
    return { outputPath, logPaths: [] }
  }
  // Everything from here on speaks through the JOB's handlers, which tee into its console log.
  // Rebinding the parameter rather than changing each call site is deliberate: the alternative
  // relies on every future message remembering to use `j.handlers`, and a message that forgets
  // is a line the user can read on screen and cannot send to anyone.
  handlers = j.handlers

  const norm = ensureUtf8Subtitle(a.inputFile)
  if (!norm.ok) {
    handlers.onOutput('stderr', norm.error)
    finish(j, -1)
    return { outputPath, logPaths: [] }
  }
  const normalized: TranslateArgs = { ...a, inputFile: norm.path }
  // The normalized subtitle is deliberately NOT scratch: gst names the progress and thoughts
  // logs from this path, and TranslatePage copies those sidecars after the job ends.
  run(j, buildTranslateArgs(normalized, outputPath))

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

export async function startTranscribe(
  a: TranscribeArgs,
  handlers: SpawnHandlers,
  /**
   * Ask the API whether the key is any good, before a transcription commits to it.
   *
   * Injected rather than imported: `modelsList` already imports this file for `resolveGstBin`,
   * so calling it from here would close an import cycle. `ipc` sits above both and supplies it.
   *
   * It runs INSIDE the job, with the job's abort signal, for the reason FP6-01 taught: work
   * placed in front of cancellable work inherits its cancellation, or Stop does nothing while
   * it runs and the single job slot stays held.
   */
  preflight?: (apiKey: string, signal: AbortSignal) => Promise<KeyPreflight>
): Promise<string> {
  // The slot is taken BEFORE the conversion, not after it. Otherwise the app reports idle
  // for the length of the conversion, and a second job started in that window would later
  // be refused by a `run()` that had no way to tell this page it had ended.
  const j = beginJob(handlers, a.outputFile)
  if (!j) {
    refuseStart(handlers, a.outputFile)
    return a.outputFile
  }
  // As in `startTranslate`, and for the same reason. This path has more to say before the engine
  // exists than any other — the key preflight and the audio conversion both report here — so it
  // is the one that would lose the most.
  handlers = j.handlers

  // REP-2's cheaper half. Translation gets this free — the engine's own `ListModels` call
  // rejects a bad key and exits 1 — while transcription hands the same credential straight to
  // the per-segment retry loop, which has no ceiling and answers a permanent 400 with
  // `Retrying immediately...` for as long as it is left alone. The measured result was 97 GB.
  const primaryKey = orderKeysByValidity(a.apiKeys).keys[0] ?? ''
  if (preflight && primaryKey) {
    handlers.onOutput('stdout', 'Checking the API key…')
    j.prep = new AbortController()
    let verdict: KeyPreflight
    try {
      verdict = await preflight(primaryKey, j.prep.signal)
    } catch (err) {
      // A preflight that THROWS has learned nothing about the key, so it is treated as
      // exactly that and the run continues. Two reasons this is the safe direction:
      //
      //  - Refusing here would let a fault in the check make transcription impossible,
      //    which is a worse outcome than the runaway it guards against — and that runaway
      //    is already covered by the stall budget in `run()`, which needs no cooperation
      //    from this path.
      //  - Letting it propagate is worse still, and is what this guard exists for: the
      //    rejection would escape `startTranscribe` with the job slot reserved and
      //    `finish()` never called, so `isRunning()` would stay true for the life of the
      //    process and every later run — of either kind — would be refused.
      verdict = {
        verdict: 'unchecked',
        message: `Could not check the API key: ${err instanceof Error ? err.message : String(err)}`
      }
    } finally {
      // In `finally` so a throw cannot leave a used controller behind. Stop would then abort
      // a signal nobody is listening to and conclude a preparation step was still running.
      j.prep = null
    }
    if (j.finished) return a.outputFile
    if (j.endReason) {
      handlers.onOutput('stderr', 'Stopped while checking the API key.')
      finish(j, -1)
      return a.outputFile
    }
    if (verdict.verdict === 'rejected') {
      handlers.onOutput('stderr', verdict.message)
      j.endReason = 'guard'
      finish(j, -1)
      return a.outputFile
    }
    // Unreachable is a warning, never a refusal: the run may well succeed, and the stall
    // budget in `run()` is what catches a key that turns out to be bad after all.
    if (verdict.verdict === 'unchecked' && verdict.message) {
      handlers.onOutput('stderr', verdict.message)
    }
  }

  let mediaFile = a.mediaFile
  if (needsAudioConversion(a.mediaFile)) {
    // Announced before the work starts, because on a long file this is a visible pause and
    // the user is otherwise looking at a window that appears to be doing nothing.
    handlers.onOutput(
      'stdout',
      `Preparing ${path.basename(a.mediaFile)} — converting to MP3, which is the format the engine reads…`
    )
    j.prep = new AbortController()
    const startedAt = Date.now()
    const prepared = await ensureEngineReadableAudio(
      a.mediaFile,
      getSettings().ffmpegPath,
      j.prep.signal,
      (pct, elapsedMs) => handlers.onProgress?.({ kind: 'convert', pct, elapsedMs })
    )
    j.prep = null
    // Emitted on EVERY outcome, including an abort and a failure: the page showing this
    // conversion has no promise of its own to wait on, so this event is the only thing that
    // can tell it the conversion is over. It is sent before any terminal event below, so a
    // stopped run never leaves a bar behind.
    handlers.onProgress?.({
      kind: 'convert',
      pct: null,
      elapsedMs: Date.now() - startedAt,
      done: true
    })

    // A Stop that landed in the gap after the conversion finished has already ended the
    // job; saying anything more here would follow a terminal event with stray output.
    if (j.finished) return a.outputFile
    // Cancellation is checked first: an aborted conversion also reports failure, and
    // "Could not prepare…" would be a confusing thing to say to someone who pressed Stop.
    if (j.endReason) {
      handlers.onOutput('stderr', 'Stopped while preparing the audio.')
      finish(j, -1)
      return a.outputFile
    }
    if (!prepared.ok) {
      handlers.onOutput('stderr', prepared.error)
      finish(j, -1)
      return a.outputFile
    }
    if (prepared.converted) j.scratch.push(prepared.path)
    mediaFile = prepared.path
  }

  run(j, buildTranscribeArgs({ ...a, mediaFile }, a.outputFile))
  return a.outputFile
}

/**
 * End the current job because the USER asked to.
 *
 * `user` is set here and nowhere else: it is what makes the panel say "Stopped" instead of
 * "Failed", so anything else that ends a run must carry its own reason rather than borrow this
 * one, or a failure the user did not cause would be reported as their own doing.
 */
export function stopCurrent(): void {
  const j = job
  if (!j) return
  j.endReason = 'user'

  // Cancel a conversion that has not finished. The awaiting `startTranscribe` sees the reason
  // and ends the job, so this path still produces exactly one terminal event.
  j.prep?.abort()
  killJob(j)
}

export function isRunning(): boolean {
  return job !== null
}
