/**
 * Turn a raw engine failure into a sentence a user can act on.
 *
 * Translate has no key preflight: a rejected key dies inside the engine's ListModels call and
 * the log is a Python 401 dict that never says "API key" and tells the user to obtain an OAuth 2
 * token this app cannot use (REP-34). The wording is copied from `classifyFetchFailure` in
 * `electron/main/modelsList.ts`, which the renderer cannot import. `modelsList.ts` is untouched
 * on purpose — consolidation is 1.2.0 (deferred B3).
 *
 * The *patterns* are not a straight copy. `classifyFetchFailure` sees only a failed model-list
 * fetch, so a bare `401` or `quota` is unambiguous there. This function sees a whole run log,
 * which always includes the command line (every paid run logs `--paid-quota`) and may include
 * progress like `401/600`, paths, or a description mentioning a network connection (SOL-64).
 * Command, progress, and non-terminal preflight ("could not be checked… Starting anyway")
 * lines are ignored. Remaining lines need an error-shaped signature. The latest matching
 * record wins unless a later batch/segment line differs from the one already on screen
 * when the error arrived — that is recovery. Identical redraws of that same line keep the
 * match, which is how a retry storm on one stuck segment stays diagnosed.
 *
 * Return `null` for anything unrecognised so the pages keep today's generic banner. Do not add
 * a `blocked` kind here — that exists only to serve deferred SF-2/SF-6.
 */

export type EngineErrorKind = 'rejected' | 'forbidden' | 'quota' | 'network'

export interface EngineError {
  kind: EngineErrorKind
  message: string
}

const ANSI = /\u001b\[[0-9;]*m/g

const REJECTED_MESSAGE =
  'Invalid API key. Double-check the key from Google AI Studio and try again.'
const FORBIDDEN_MESSAGE =
  'This API key is not authorized for the Gemini API. Enable it in Google AI Studio.'
const QUOTA_MESSAGE =
  'Quota exceeded for this key, so it could not be checked. The key itself is fine — wait a ' +
  'bit and retry, or use a paid key.'
const NETWORK_MESSAGE = 'Could not reach Google. Check your internet connection and try again.'

/** The `$ argv` line pythonBridge prints before spawn. Flags and paths live only here. */
const COMMAND_LINE = /^\s*\$\s/
/**
 * Work the engine is still doing. A batch/segment number of 401 must not look like HTTP 401.
 * Bar frames are skipped as matches but do not count toward recovery — they redraw in place.
 */
const PROGRESS_LINE =
  /^(?:Translating batch\b|Transcribing audio segment\b|Transcribing:\s*\|)/i
const RECOVERY_PROGRESS = /^(?:Translating batch\b|Transcribing audio segment\b)/i
/**
 * Unchecked transcribe preflight: the fetch failed, the run was started anyway
 * (`ipc.ts` "Starting anyway."). That record is not the terminal cause of a later failure.
 */
const NONTERMINAL_PREFLIGHT = /could not be checked first|Starting anyway\.?\s*$/i

function classifyRecord(clean: string): EngineError | null {
  // Exact sentences this app already wrote (preflight / Settings). Match these first so
  // "Nothing was sent and no quota was spent" cannot be read as a quota failure (SOL-65).
  if (clean.includes('Invalid API key. Double-check the key from Google AI Studio')) {
    return { kind: 'rejected', message: REJECTED_MESSAGE }
  }
  if (clean.includes('This API key is not authorized for the Gemini API')) {
    return { kind: 'forbidden', message: FORBIDDEN_MESSAGE }
  }
  if (/API_KEY_INVALID|api key not valid|invalid authentication|UNAUTHENTICATED/i.test(clean)) {
    return { kind: 'rejected', message: REJECTED_MESSAGE }
  }
  if (/permission_denied|\b403\b[^\n]{0,40}FORBIDDEN/i.test(clean)) {
    return { kind: 'forbidden', message: FORBIDDEN_MESSAGE }
  }
  if (/RESOURCE_EXHAUSTED|quota exceeded|quotas exceeded/i.test(clean)) {
    return { kind: 'quota', message: QUOTA_MESSAGE }
  }
  if (/getaddrinfo|enotfound|etimedout|econnrefused|failed to fetch/i.test(clean)) {
    return { kind: 'network', message: NETWORK_MESSAGE }
  }
  return null
}

export function classifyEngineFailure(text: string): EngineError | null {
  const lines = (text ?? '').replace(ANSI, ' ').split(/\r?\n/)
  let last: EngineError | null = null
  /** Batch/segment line on screen when `last` was recorded. Null if the error arrived first. */
  let progressAtError: string | null = null
  let currentProgress: string | null = null
  for (const raw of lines) {
    const line = raw.trim()
    if (!line || COMMAND_LINE.test(line) || NONTERMINAL_PREFLIGHT.test(line)) continue
    if (PROGRESS_LINE.test(line)) {
      if (RECOVERY_PROGRESS.test(line)) {
        if (last && line !== progressAtError) last = null
        currentProgress = line
      }
      continue
    }
    const hit = classifyRecord(line)
    if (hit) {
      last = hit
      progressAtError = currentProgress
    }
  }
  return last
}
