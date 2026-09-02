/**
 * The run's console, kept as a file (REP-1 / REP-3 / REP-26).
 *
 * Two reports independently asked for a way to keep what the run printed. The obvious
 * implementation — write out the array the panel is showing — is the one thing that must not
 * happen: FP-3 caps that array on purpose, and collapses repeated blocks into one row with a
 * counter, because rendering an uncapped run is what froze the window. Exporting it would hand
 * the user a file that is missing the middle of their run and has had its repetition folded
 * away, which is precisely the run they need to read when something went wrong.
 *
 * So the file is written from the source instead, as lines arrive, and the panel stays capped.
 * REP-26 then reduces *terminal chrome* in the file — ANSI cursor frames, progress bars,
 * token-tally redraws, carriage-return overwrites, and a block the engine reprints — because
 * a two-hour transcription otherwise records 25,000 TTY frames for a dozen lines of substance.
 * Distinct lines still land the moment they first appear. A speculative suffix
 * copy is held until it completes (counted, not written) or breaks (written), so
 * a repeated prefix with new context cannot vanish (SOL-60). A blank between
 * redraw frames is part of the frame, not a boundary — aborting on it is what
 * made every tally read `[redrawn 1 times]` (REP-38). A crash then costs
 * at most a missing `[redrawn N times]` tally and an in-flight unmatched prefix.
 * The panel's grow-frame folding stays in `logView.ts`; the two artefacts share
 * only the chrome predicates in `terminalNoise.ts`.
 *
 * This module is the fidelity policy and nothing else — it never touches the filesystem. That
 * keeps the ceiling, the truncation marker and the tail testable as data, and it keeps the
 * module importable from the renderer, which needs the suffix constant and must not pull a
 * Node API into the browser bundle. `TextEncoder` rather than `Buffer` for the same reason.
 */

import { isBarFrame, parseTokenLine, stripTerminalChrome } from './terminalNoise'

/**
 * The compound suffix. Exported rather than written out at each site because
 * `dialog:saveFile` matches sidecars by exact suffix, and a `.console.log` missing from that
 * list degrades to `path.extname()` — `.log` — which is a different file name than the one
 * this module chose and, alongside the progress and thoughts logs, an invitation to collide.
 */
export const CONSOLE_LOG_SUFFIX = '.console.log'

/** Searchable, stable, and the one string a gate or a human looks for to spot a cut. */
export const CONSOLE_LOG_TRUNCATION_MARK = '[log truncated]'

export interface ConsoleLogLimits {
  /** Bytes written verbatim from the start of the run before the cut begins. */
  headBytes: number
  /** Bytes of the most recent output held back and appended after the cut. */
  tailBytes: number
  /**
   * Bytes any SINGLE line may contribute.
   *
   * Without this the other two limits are not limits at all: both are checked *before* a line is
   * written, so one line arriving with budget remaining is written whole however large it is, and
   * the tail retains its newest line unconditionally so that it can never drop the last thing a
   * run said. A single enormous line therefore bypassed the ceiling in both directions.
   *
   * It is reachable rather than theoretical: `pythonBridge.run()` splits the engine's output on
   * newlines and holds the remainder, so a large chunk with no newline in it becomes exactly one
   * line — flushed in full when the process closes.
   */
  lineBytes: number
}

/**
 * Eight megabytes of head is on the order of a hundred thousand lines — far more than any run
 * that is behaving, and enough of a misbehaving one to see what it was doing. The tail is small
 * because its only job is to carry the ending across the cut. 64 KB is perhaps twenty times the
 * longest line this engine has ever been seen to emit, so an ordinary run never meets it.
 */
export const DEFAULT_CONSOLE_LOG_LIMITS: ConsoleLogLimits = {
  headBytes: 8 * 1024 * 1024,
  tailBytes: 512 * 1024,
  lineBytes: 64 * 1024
}

export interface ConsoleLog {
  /** Record one line. Newline is added here, so callers pass the line as they logged it. */
  write(line: string): void
  /** Emit the truncation marker and the retained tail, if the ceiling was reached. */
  close(): void
}

const encoder = new TextEncoder()
const decoder = new TextDecoder()
const byteLength = (s: string): number => encoder.encode(s).length

/**
 * Cut one line down to a byte budget without cutting a character in half.
 *
 * Three properties it has to have at once, which is why it is not a `slice`:
 *
 *  - **Cheap for the lines that actually occur.** No code unit encodes to more than three bytes
 *    (a surrogate pair is two units and four bytes), so `length * 3 <= max` settles every
 *    ordinary line without encoding anything at all.
 *  - **Bounded for the line that does not.** No code unit encodes to *fewer* than one byte
 *    either, so the budget can never need more than `max` of them — slicing there first means a
 *    500 MB line is never encoded in full just to find out it is too long.
 *  - **UTF-8 safe.** Cutting at an arbitrary byte would split a multi-byte character and put a
 *    replacement character in a file whose entire value is being a faithful record, so the cut
 *    walks back over continuation bytes to the last character boundary.
 */
function clampLine(line: string, maxBytes: number): { text: string; dropped: number } {
  if (line.length * 3 <= maxBytes) return { text: line, dropped: 0 }
  const candidate = line.slice(0, maxBytes)
  const bytes = encoder.encode(candidate)
  if (bytes.length <= maxBytes && candidate.length === line.length) {
    return { text: line, dropped: 0 }
  }
  let end = Math.min(maxBytes, bytes.length)
  // 0b10xxxxxx is a UTF-8 continuation byte: stopping on one would leave half a character.
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--
  const text = decoder.decode(bytes.subarray(0, end))
  return { text, dropped: line.length - text.length }
}

/**
 * A ceiling that keeps both ends of the run, and that no single line can step over.
 *
 * Keeping only the head would be simpler and would satisfy a literal reading of "stops
 * growing", but it fails at the one moment it is asked to work: a run long enough to be cut is
 * a run that went wrong, and what went wrong is at the end. So the head streams to disk as it
 * happens — surviving even a crash that never reaches `close()` — and once the ceiling is
 * reached the newest output is held in a bounded buffer instead, and appended after a marker
 * that says how much of the middle is missing. The shape is FP-3's, one artefact down.
 *
 * Reduction (ANSI, bars, tokens, redraws) runs before the clamp, so an oversized payload
 * is still cut to `lineBytes` and an S8-style `payload:xxx…` stays legible.
 *
 * @param append receives already-newline-terminated text; the caller decides where it lands.
 */
export function createConsoleLog(
  append: (chunk: string) => void,
  overrides: Partial<ConsoleLogLimits> = {}
): ConsoleLog {
  // Partial so that a caller narrowing one limit — a test reaching the ceiling in a few lines —
  // does not have to restate the other two, and silently lose a limit added after it was written.
  const limits: ConsoleLogLimits = { ...DEFAULT_CONSOLE_LOG_LIMITS, ...overrides }
  let headBytes = 0
  let tailBytes = 0
  let dropped = 0
  let closed = false
  const tail: string[] = []
  /**
   * Last distinct lines actually written. Bounded so a pathological growing reprint cannot
   * keep the entire run in memory; independent of the panel's MAX_FRAME. Matching is by
   * suffix — a redraw starts at the last occurrence of its first line, so the app preamble
   * in front of the engine history is not part of the frame (SOL-57).
   */
  const REDRAW_WINDOW = 200
  let window: string[] = []
  /** Start of the suffix currently being matched; -1 when not in a redraw. */
  let matchFrom = -1
  let matchAt = 0
  /**
   * Lines consumed as a speculative suffix copy. Discarded only when the suffix
   * completes (it was a redraw). Emitted on mismatch, end marker, close, or when
   * a match swallows more blanks than MAX_REDRAW_BLANKS, so a repeated prefix
   * with new context cannot vanish (SOL-60). Empty strings in this array are
   * collapsed blanks kept in their original position (SOL-67); they are not
   * compared to the redraw window and are not written into it.
   */
  let pending: string[] = []
  let redraws = 0
  let lastToken: string | null = null
  let lastBlank = false
  /**
   * Blanks swallowed while a suffix match is in progress. The engine puts one
   * blank between redraw frames; aborting on it is REP-38. Unbounded swallowing
   * would hold `pending` across an endless blank run, so a crash could lose an
   * unmatched prefix of unbounded age. Eight is well above one-per-frame and
   * still a hard stop.
   */
  const MAX_REDRAW_BLANKS = 8
  let blanksInMatch = 0

  function emit(line: string): void {
    // Clamped before any accounting, so ONE bounded value flows into both the head and the
    // tail. Doing it at either of the two sites below would leave the other one open.
    const clamped = clampLine(line, limits.lineBytes)
    const text = clamped.dropped
      ? `${clamped.text} ${CONSOLE_LOG_TRUNCATION_MARK} ${clamped.dropped} more character(s) on this line\n`
      : `${line}\n`
    if (headBytes < limits.headBytes) {
      headBytes += byteLength(text)
      append(text)
      return
    }
    tail.push(text)
    tailBytes += byteLength(text)
    // `length > 1` so a single line larger than the whole tail budget is still kept: the last
    // thing a run said is never the thing this drops.
    while (tailBytes > limits.tailBytes && tail.length > 1) {
      tailBytes -= byteLength(tail.shift() as string)
      dropped++
    }
  }

  function flushRedraw(): void {
    if (redraws === 0) return
    emit(`[redrawn ${redraws} times]`)
    redraws = 0
  }

  function flushToken(): void {
    if (lastToken === null) return
    emit(lastToken)
    lastToken = null
  }

  function noteUnique(line: string): void {
    emit(line)
    window.push(line)
    if (window.length > REDRAW_WINDOW) window.shift()
  }

  function abortMatch(): void {
    flushRedraw()
    for (const line of pending) {
      if (line === '') {
        if (!lastBlank) {
          lastBlank = true
          emit('')
        }
      } else {
        noteUnique(line)
        lastBlank = false
      }
    }
    pending = []
    matchFrom = -1
    matchAt = 0
    blanksInMatch = 0
  }

  function consider(line: string): void {
    // A redraw is a suffix of what has already been written, not the whole window.
    // The app preamble (`$ …`, `Starting engine…`) sits at the front and is never
    // reprinted; the engine reprints from its first history line (SOL-57).
    if (matchFrom >= 0 && matchAt < window.length && line === window[matchAt]) {
      pending.push(line)
      matchAt++
      if (matchAt === window.length) {
        pending = []
        redraws++
        matchAt = matchFrom
      }
      return
    }

    if (matchFrom >= 0) abortMatch()

    const idx = window.lastIndexOf(line)
    if (idx >= 0) {
      matchFrom = idx
      matchAt = idx + 1
      if (matchAt === window.length) {
        redraws++
        matchAt = matchFrom
        return
      }
      pending = [line]
      return
    }

    noteUnique(line)
  }

  return {
    write(line: string): void {
      if (closed) return
      const cleaned = stripTerminalChrome(line)
      if (cleaned.trim() === '') {
        // A blank between redraw frames is part of the frame (REP-38). Aborting
        // here is why every tally used to read `[redrawn 1 times]`.
        if (matchFrom >= 0) {
          blanksInMatch++
          if (blanksInMatch <= MAX_REDRAW_BLANKS) {
            if (pending[pending.length - 1] !== '') pending.push('')
            return
          }
        }
        abortMatch()
        if (lastBlank) return
        lastBlank = true
        emit('')
        return
      }
      lastBlank = false
      blanksInMatch = 0

      if (isBarFrame(cleaned)) return
      if (parseTokenLine(cleaned)) {
        lastToken = cleaned
        return
      }

      // Production writes this immediately before close(). Flush the deferred
      // token tally first so the file ends …tally, [run ended: …].
      if (cleaned.startsWith('[run ended:')) {
        abortMatch()
        flushToken()
        emit(cleaned)
        return
      }

      consider(cleaned)
      lastBlank = false
    },

    close(): void {
      if (closed) return
      abortMatch()
      flushToken()
      closed = true
      if (tail.length === 0 && dropped === 0) return
      const mb = Math.round(limits.headBytes / (1024 * 1024))
      append(
        `\n${CONSOLE_LOG_TRUNCATION_MARK} this run passed the ${mb} MB console log ceiling. ` +
          `${dropped} line(s) from the middle are not in this file. ` +
          `The last ${tail.length} line(s) follow.\n\n`
      )
      append(tail.join(''))
    }
  }
}

/**
 * Where a run's console lives: beside its output, sharing its name.
 *
 * The same base-name derivation `dialog:saveFile` uses to place the other sidecars, so the
 * whole set travels together and lands together.
 */
export function consoleLogPathFor(outputPath: string): string {
  return `${outputPath.replace(/\.[^.]+$/, '')}${CONSOLE_LOG_SUFFIX}`
}

/**
 * Pick this run's console out of the sidecar list a terminal event carried.
 *
 * By suffix, not by position: `logPaths` also carries whichever of the engine's own reports the
 * settings asked for, so which index the console lands at depends on those settings.
 */
export function findConsoleLog(paths: readonly string[] | undefined): string {
  return paths?.find((p) => p.endsWith(CONSOLE_LOG_SUFFIX)) ?? ''
}
