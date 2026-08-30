/**
 * What the engine's live terminal UI looks like, once, for both artefacts.
 *
 * The panel (`useRunner`) and the console file (`createConsoleLog`) used to each know a
 * slightly different subset of the chrome: the file kept every `ESC[F`/`ESC[K` frame, and
 * the panel's bar predicate missed `Transcribing: |`. One definition means a line dropped
 * as a spinner on screen is the same line dropped from the sendable file (REP-26).
 *
 * The panel's *folding* (grow-frame, counters on blocks) stays in `logView.ts`. This
 * module is only the chrome: ANSI, carriage-return redraws, progress bars, token tallies.
 */

export interface TokenTally {
  prompt: number
  thoughts: number
  output: number
  total: number
}

/** CSI sequences (cursor moves, erases, colors) the CLI emits for a TTY. */
export const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]/g

export function stripAnsi(s: string): string {
  ANSI_RE.lastIndex = 0
  return s.replace(ANSI_RE, '')
}

/**
 * In-place terminal updates overwrite the current line with `\r`. Keep whatever
 * ended up visible — the text after the last carriage return.
 */
export function afterLastCarriageReturn(s: string): string {
  const i = s.lastIndexOf('\r')
  return i === -1 ? s : s.slice(i + 1)
}

/** Strip TTY chrome and trailing space; does not trim leading text. */
export function stripTerminalChrome(line: string): string {
  return afterLastCarriageReturn(stripAnsi(line)).replace(/[ \t]+$/g, '')
}

/**
 * A line that is only the animated progress bar.
 *
 * Anchored on the engine's own prefixes plus the bar's `|` gutter. A lone █ or ░
 * anywhere in a warning, filename, or cue must not hide the line (SOL-58).
 * `Transcribing:` was missing from the old panel predicate and is why a transcribe
 * run's bar reached the file.
 */
export function isBarFrame(s: string): boolean {
  return /^(?:Translating|Transcribing):\s*\|/.test(s)
}

export const TOKEN_LINE =
  /Prompt Tokens:\s*(\d+)\s*\|\s*Thoughts Tokens:\s*(\d+)\s*\|\s*Output Tokens:\s*(\d+)\s*\|\s*Total Tokens:\s*(\d+)/i

export function parseTokenLine(s: string): TokenTally | null {
  const m = s.match(TOKEN_LINE)
  if (!m) return null
  return {
    prompt: parseInt(m[1], 10),
    thoughts: parseInt(m[2], 10),
    output: parseInt(m[3], 10),
    total: parseInt(m[4], 10)
  }
}
