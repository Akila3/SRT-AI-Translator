/**
 * Ending a run that has stopped getting anywhere.
 *
 * REP-2: a key the API rejects makes the engine answer `Retrying immediately...` — no backoff,
 * no ceiling, no distinction between a transient 503 and a permanent 400 — and it means it
 * literally. Two measured runs did that for six hours and forty minutes and stopped only when
 * the disk filled at 97 GB each. Inside the app the same loop produced 173 lines in five to ten
 * seconds, of which **twelve were distinct**. Translation is safe: its `ListModels` preflight
 * exits 1. Transcription has no such preflight, so this is where the loop lands.
 *
 * Two decisions shape everything here, and both came from that evidence rather than from taste.
 *
 * **The budget comes first; the pattern only refines it.** Classifying free-form engine text as
 * fatal is how a working run gets killed by a message that merely resembles an auth error, and
 * a false positive destroys a paid, half-finished run. So nothing here terminates on a phrase.
 * A recognised marker only chooses which tier applies and what the message says.
 *
 * **The measure is absence of novelty, not repetition.** The obvious rule — "N identical
 * consecutive error lines" — is disproved by REP-2's own log: the engine redraws its live
 * display every cycle, so what arrives is an alternating block (a progress line, a segment line,
 * an error line, repeat) in more than one wording. No two error lines are ever adjacent, so a
 * consecutive-identical counter never reaches 2, let alone N. A run that is working produces
 * lines it has not produced before — new segment numbers, new batch numbers, new percentages. A
 * run that is storming produces the same small set forever, whatever those lines happen to say.
 *
 * Deliberately NOT parsed: segment numbers, timestamps, percentages. Reading progress out of the
 * text would re-import the engine's stdout contract into the termination path and break the
 * moment a line is reworded — turning a cosmetic engine change into a killed run.
 */

/**
 * Distinct lines remembered. A line absent from this set is novel and resets the counters.
 *
 * The declared limit of the whole approach: a loop whose cycle contains more than this many
 * distinct lines evicts its own earliest members before they come round again, so every line
 * looks novel and neither tier fires. The measured storm cycles twelve, so the margin is more
 * than an order of magnitude — but a future engine that stamped every line with a changing
 * counter would defeat this, and the honest answer then is a new signal, not a bigger window.
 */
export const NOVELTY_WINDOW = 200

/**
 * Tier 1 — fast, but only for a failure we recognise as permanent.
 *
 * Both conditions must hold, which is what keeps a fast burst of genuinely new output safe: at
 * 25 lines per second (the measured storm rate) 500 lines takes twenty seconds, so the minute of
 * quiet is the binding constraint and a run has to be visibly stuck before this can fire.
 */
export const TIER1_LINES = 500
export const TIER1_QUIET_MS = 60_000

/**
 * Tier 2 — slow, and needs to recognise nothing at all.
 *
 * The safety net for an error we do not know about, including one the engine has not shipped
 * yet. Five thousand lines of nothing new over ten minutes is a dead run whatever it says.
 */
export const TIER2_LINES = 5_000
export const TIER2_QUIET_MS = 600_000

/**
 * Errors that are permanent by nature: retrying cannot fix a credential the API has refused.
 *
 * These NEVER terminate on their own — they select tier 1 and name the cause. The list is the
 * one REP-2 recorded, plus nothing invented: an unrecognised storm still dies at tier 2.
 */
const FATAL_MARKERS: { re: RegExp; cause: string }[] = [
  { re: /api key not valid/i, cause: 'the API rejected the key as invalid' },
  { re: /API_KEY_INVALID/, cause: 'the API rejected the key as invalid' },
  { re: /\b400\b[^\n]{0,40}invalid_argument/i, cause: 'the API refused the request as invalid' },
  { re: /\b401\b[^\n]{0,40}UNAUTHENTICATED/i, cause: 'the API refused the request as unauthenticated' }
]

/** Cursor moves and erases from the engine's live display, which are not part of the text. */
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g

export interface StallVerdict {
  tier: 1 | 2
  /** Shown to the user as the reason the run ended. Says what was counted, not just that it was. */
  message: string
}

export interface StallWatch {
  /**
   * Take one line of engine output. Returns a verdict exactly once, on the line that exhausts
   * the budget; null every other time, including every line after the verdict.
   */
  observe: (line: string, now: number) => StallVerdict | null
}

function normalize(line: string): string {
  return line.replace(ANSI, '').trim()
}

/** Whole minutes and seconds, for a message a user has to act on. */
function humanQuiet(ms: number): string {
  const seconds = Math.round(ms / 1000)
  if (seconds < 90) return `${seconds} seconds`
  return `${Math.round(seconds / 60)} minutes`
}

/**
 * Watch one run's output for the loop that never ends.
 *
 * Time is a parameter rather than a call to `Date.now()` so the thresholds can be exercised
 * exactly, at the real production values, without a test that takes ten minutes to run.
 */
export function createStallWatch(): StallWatch {
  const recent: string[] = []
  const seen = new Set<string>()
  let sinceNovel = 0
  let lastNovelAt = 0
  let started = false
  let marker: string | null = null
  let tripped = false

  const remember = (text: string): void => {
    if (seen.has(text)) return
    seen.add(text)
    recent.push(text)
    if (recent.length > NOVELTY_WINDOW) {
      const dropped = recent.shift()
      if (dropped !== undefined) seen.delete(dropped)
    }
  }

  return {
    observe(line: string, now: number): StallVerdict | null {
      if (tripped) return null
      const text = normalize(line)
      if (!started) {
        started = true
        lastNovelAt = now
      }

      if (!seen.has(text)) {
        // Forward progress. Everything the budget had accumulated is void, including the
        // recognised marker: an auth error followed by real work is a run that recovered.
        remember(text)
        sinceNovel = 0
        lastNovelAt = now
        marker = null
        return null
      }

      remember(text)
      sinceNovel++
      if (!marker) {
        const hit = FATAL_MARKERS.find((m) => m.re.test(text))
        if (hit) marker = hit.cause
      }

      const quietMs = now - lastNovelAt
      if (marker && sinceNovel >= TIER1_LINES && quietMs >= TIER1_QUIET_MS) {
        tripped = true
        return {
          tier: 1,
          message:
            `Ended by the app: ${marker}, and the engine has repeated the same output ` +
            `${sinceNovel} times over ${humanQuiet(quietMs)} without getting any further. ` +
            'This error is permanent — the engine retries it forever — so the run was stopped ' +
            'rather than left to spin. Check the API key in Settings, then try again.'
        }
      }
      if (sinceNovel >= TIER2_LINES && quietMs >= TIER2_QUIET_MS) {
        tripped = true
        return {
          tier: 2,
          message:
            `Ended by the app: ${sinceNovel} lines over ${humanQuiet(quietMs)} with nothing ` +
            'new in any of them, so the engine has stopped making progress. The last lines above ' +
            'are the best evidence of why; nothing was written, and you can start again.'
        }
      }
      return null
    }
  }
}
