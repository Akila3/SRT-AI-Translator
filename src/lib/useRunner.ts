import { useEffect, useRef, useState, useCallback } from 'react'
import { isBarFrame, parseTokenLine, stripTerminalChrome, type TokenTally } from '../../electron/shared/terminalNoise'
import {
  appendLogLine,
  readRetryState,
  terminalState,
  type LogRow,
  type RetryState,
  type RunStatus
} from './logView'

export type { RunStatus, LogRow, RetryState, TokenTally }

export interface RunnerState {
  status: RunStatus
  /**
   * The log as the panel shows it: repeated blocks folded into a counter, the middle capped.
   * See `logView.ts` — the folding is a display transform applied AFTER the parsing below, so
   * a collapsed block still updates progress, tokens and status.
   */
  log: LogRow[]
  progress: number
  tokenStats: string
  tokens: TokenTally | null
  currentLine: number
  totalLines: number
  statusText: string
  outputPath: string
  logPaths: string[]
  /** Advisory notes about the finished file, shown beside Save. Never blocks anything. */
  warnings: string[]
  /** The batch the engine is currently retrying, if it is retrying one. */
  retry: RetryState | null
  exitCode: number | null
}

const INITIAL: RunnerState = {
  status: 'idle',
  log: [],
  progress: 0,
  tokenStats: '',
  tokens: null,
  currentLine: 0,
  totalLines: 0,
  statusText: '',
  outputPath: '',
  logPaths: [],
  warnings: [],
  retry: null,
  exitCode: null
}

function deriveStatus(s: string): string | null {
  if (/sending batch/i.test(s)) return 'Sending batch…'
  if (/validating token size/i.test(s)) return 'Validating tokens…'
  if (/token size validated|translating/i.test(s)) return 'Translating…'
  if (/starting translation/i.test(s)) return 'Starting…'
  return null
}

/**
 * Fold one engine line into the run state.
 *
 * Extracted so a batch of lines can be applied in one state update: the parsing is
 * per-line and order-dependent, but committing per line is what costs a render each.
 */
function applyLine(s: RunnerState, clean: string): RunnerState {
  let { progress, tokenStats, tokens, currentLine, totalLines, statusText } = s

  // Total line count — announced once at the start.
  const totalDecl = clean.match(/translation of (\d+) lines/i)
  if (totalDecl) totalLines = parseInt(totalDecl[1], 10)

  // Progress "(cur/total)" — usually inside the spinner line.
  const frac = clean.match(/(\d+)\s*\/\s*(\d+)/)
  if (frac && /translat|batch|processing|%/i.test(clean)) {
    const cur = parseInt(frac[1], 10)
    const tot = parseInt(frac[2], 10)
    if (tot > 0) {
      currentLine = cur
      totalLines = tot
      progress = Math.min(100, Math.round((cur / tot) * 100))
    }
  }

  const pct = clean.match(/(\d{1,3})\s?%/)
  if (pct) progress = Math.min(100, parseInt(pct[1], 10))

  // Token breakdown line.
  const tk = parseTokenLine(clean)
  if (tk) {
    tokens = tk
    tokenStats = clean
  }

  const st = deriveStatus(clean)
  if (st) statusText = st

  // Keep a clean log for error inspection: drop spinner/progress noise and token lines, which
  // are surfaced separately. Everything else goes through the collapser, which folds repeats
  // rather than dropping them — note this happens AFTER the parsing above, because the same
  // lines carry progress, token and status state and collapsing first would blank them.
  const skip = isBarFrame(clean) || tk !== null
  const log = skip ? s.log : appendLogLine(s.log, clean)

  return { ...s, log, progress, tokenStats, tokens, currentLine, totalLines, statusText }
}

/**
 * How long arriving lines are gathered before one state update is committed.
 *
 * Each commit re-renders the whole log panel, so the cost is per COMMIT, not per line;
 * without this, a line rate sets the render rate. Short enough to be imperceptible — a
 * lone line, such as each of the engine's extraction steps, still lands within a frame or
 * two — and long enough that a sustained ~25 line/s retry storm cannot drive rendering.
 */
const FLUSH_MS = 100

/**
 * A name for one run, unique for the life of the window.
 *
 * `crypto.randomUUID` is present in Electron's renderer, but a counter and a timestamp are enough
 * for something that only has to be distinct from the other runs of this session, and this cannot
 * fail in a context where the crypto API is unavailable.
 */
let runSeq = 0
function mintRunId(): string {
  runSeq += 1
  return `r${Date.now().toString(36)}-${runSeq}`
}

export function useRunner(): {
  state: RunnerState
  start: (launch: (runId: string) => Promise<string>) => Promise<void>
  stop: () => Promise<void>
  reset: () => void
} {
  const [state, setState] = useState<RunnerState>(INITIAL)
  const cleanup = useRef<Array<() => void>>([])
  const pending = useRef<string[]>([])
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const flushPending = useRef<(() => void) | null>(null)
  /**
   * Which run this hook is currently listening for.
   *
   * Read inside the event handlers rather than captured, so it is always the CURRENT run: both
   * pages stay mounted and both listen on the same two channels, so without this a finished
   * translation would absorb a later transcription's ending — taking its `outputPath` and
   * `logPaths` with it, which is what Save then copies (SOL-01).
   */
  const runId = useRef<string | null>(null)
  /**
   * Taken before any listener teardown so a second Start cannot orphan the first run (SOL-39).
   * Cleared when the run ends, the launch throws, or the user hits New.
   */
  const armed = useRef(false)

  useEffect(() => {
    return () => cleanup.current.forEach((fn) => fn())
  }, [])

  const reset = useCallback(() => {
    pending.current = []
    runId.current = null
    armed.current = false
    if (timer.current !== null) {
      clearTimeout(timer.current)
      timer.current = null
    }
    setState(INITIAL)
  }, [])

  const start = useCallback(async (launch: (id: string) => Promise<string>) => {
    if (armed.current) return
    armed.current = true
    cleanup.current.forEach((fn) => fn())
    cleanup.current = []
    const id = mintRunId()
    runId.current = id
    setState({ ...INITIAL, status: 'running' })

    const flush = (): void => {
      if (timer.current !== null) {
        clearTimeout(timer.current)
        timer.current = null
      }
      if (pending.current.length === 0) return
      const batch = pending.current
      pending.current = []
      setState((s) => {
        const next = batch.reduce(applyLine, s)
        // Once per commit, not once per line: the retry count is read off the collapsed rows,
        // so it costs a pass over the panel's contents rather than a per-line tally that the
        // engine's redraws would inflate.
        return next.log === s.log ? next : { ...next, retry: readRetryState(next.log) }
      })
    }
    flushPending.current = flush

    const offOut = window.api.onOutput(({ line, runId: from }) => {
      // Not ours: another page's run, or a run this hook has already finished with. An event
      // without an id is accepted, so a producer that has not been taught to stamp one still
      // reaches the only runner that can be listening.
      if (from !== undefined && from !== runId.current) return
      if (!line) return
      const clean = stripTerminalChrome(line).trim()
      if (!clean) return

      pending.current.push(clean)
      if (timer.current === null) timer.current = setTimeout(flush, FLUSH_MS)
    })

    const offDone = window.api.onDone(({ code, outputPath, logPaths, warnings, reason, runId: from }) => {
      if (from !== undefined && from !== runId.current) return
      // Nothing else can end this run now. Clearing the id first means a late stray from the same
      // run — or a second terminal event, were one ever produced — cannot reopen a settled panel.
      runId.current = null
      armed.current = false
      // The last lines of a run are usually the interesting ones, so they must be committed
      // before the terminal state rather than left to a timer that unmounting could cancel.
      // A Stop ends the job through the same terminal event, so this covers it too.
      flush()
      const end = terminalState(code, reason)
      setState((s) => ({
        ...s,
        status: end.status,
        progress: end.status === 'done' ? 100 : s.progress,
        statusText: end.statusText,
        outputPath,
        logPaths: logPaths ?? [],
        warnings: warnings ?? [],
        exitCode: code
      }))
    })

    cleanup.current = [
      offOut,
      offDone,
      () => {
        if (timer.current !== null) clearTimeout(timer.current)
        timer.current = null
        pending.current = []
        flushPending.current = null
      }
    ]

    try {
      await launch(id)
    } catch (e) {
      // The launch itself failed, so no terminal event is coming for this id. Retiring it here
      // stops a later run's events being matched against a run that never began.
      runId.current = null
      armed.current = false
      setState((s) => ({ ...s, status: 'error', log: appendLogLine(s.log, String(e)) }))
    }
  }, [])

  const stop = useCallback(async () => {
    await window.api.stop()
    flushPending.current?.()
    // Deliberately does NOT set a terminal status. Every stop ends the job in the main process,
    // which reports it as a user stop on the same `done` event every other ending uses — so the
    // panel says "Stopped" because the app knows it was stopped, not because the renderer
    // guessed from a non-zero exit code it cannot tell apart from a crash.
    setState((s) => (s.status === 'running' ? { ...s, statusText: 'Stopping…' } : s))
  }, [])

  return { state, start, stop, reset }
}
