/**
 * What a Transcribe run actually uses, when the page can override Settings.
 *
 * The four `transcribe*` fields live on AppSettings so they survive restart. They are
 * not a schema migration: absent keys overlay from defaults (`false` / `''` / `0`).
 * `0` on the budget means "not set" — the engine cannot deliver a zero budget anyway.
 *
 * Every capability decision on the Transcribe page (thinking control, the
 * supportsTranscription refusal, argv) MUST read the resolved model, never
 * `settings.model` alone. Otherwise the page would describe one model and run another.
 */

import { modelCapabilities } from './modelCaps'

export interface TranscribeSettingsInput {
  transcribeOverride: boolean
  transcribeModel: string
  transcribeThinkingLevel: string
  transcribeThinkingBudget: number
  model: string
  thinkingLevel: string
  thinkingBudget: number
}

export interface ResolvedTranscribeSettings {
  model: string
  thinkingLevel: string
  thinkingBudget: number
}

/** The model and thinking values a Transcribe run will send. */
export function resolveTranscribeSettings(s: TranscribeSettingsInput): ResolvedTranscribeSettings {
  if (!s.transcribeOverride) {
    return {
      model: s.model,
      thinkingLevel: s.thinkingLevel,
      thinkingBudget: s.thinkingBudget
    }
  }
  return {
    model: s.transcribeModel || s.model,
    thinkingLevel: s.transcribeThinkingLevel || s.thinkingLevel,
    thinkingBudget: s.transcribeThinkingBudget || s.thinkingBudget
  }
}

/**
 * Seed the override fields from the current globals, keeping any values already stored
 * so turning the toggle off and on does not wipe a previous choice.
 */
export function seedTranscribeOverride(s: TranscribeSettingsInput): {
  transcribeOverride: true
  transcribeModel: string
  transcribeThinkingLevel: string
  transcribeThinkingBudget: number
} {
  return {
    transcribeOverride: true,
    transcribeModel: s.transcribeModel || s.model,
    transcribeThinkingLevel: s.transcribeThinkingLevel || s.thinkingLevel,
    transcribeThinkingBudget: s.transcribeThinkingBudget || s.thinkingBudget
  }
}

/**
 * Pre-flight refusal for a model the engine will not transcribe. Audio-incapable
 * (not Gemini 2.5/3.x) is a hard stop. Dedicated transcription models are a different
 * case: they can be selected (`supportsTranscription` stays true) and get
 * `transcribeEngineWarning` instead of this refusal.
 */
export function transcribeRefusalMessage(model: string, override: boolean): string {
  const where = override
    ? 'pick a different model above'
    : 'pick a different model in Settings → Model & Generation'
  return `Transcription requires a Gemini 2.5 or 3.x model. "${model}" cannot transcribe — ${where}.`
}

/**
 * Dedicated transcription ids (`transcribe` in the id) are engine-incompatible: Google
 * lists system instructions and structured output as unsupported, and the engine sends
 * both unconditionally. Warn, do not block — a future engine may gate those fields.
 * Distinct from `transcribeRefusalMessage`, which is the audio-incapable hard stop.
 *
 * REP-33: the substring is not enough. A stored or future id can contain `transcribe`
 * and still fail `supportsTranscription` (e.g. `gemini-2.0-transcribe`). That case is
 * the hard-stop UI; this warning is only the warn-and-allow overlay on a model that
 * can actually be started.
 */
export function isDedicatedTranscribeModel(model: string): boolean {
  return (model || '').toLowerCase().includes('transcribe')
}

/** `null` when the resolved model is not a startable dedicated transcription id. */
export function transcribeEngineWarning(model: string): string | null {
  if (!isDedicatedTranscribeModel(model)) return null
  if (!modelCapabilities(model).supportsTranscription) return null
  return (
    `"${model}" is a dedicated transcription model. It does not support the system instruction ` +
    'or JSON response schema this engine sends on every transcription request. ' +
    'You can start the run anyway; the API is likely to refuse with a 400.'
  )
}

/**
 * Serialise async writes so a later patch cannot land before an earlier one, and so
 * Start can wait until the store actually holds the selection the user just made.
 *
 * `useStore.patch` only updates after `setSettings` resolves. Overlapping calls would
 * otherwise complete out of order, and Start against `getState()` would still see the
 * previous override (SOL-55). This queue is local to the Transcribe page — Settings
 * callers keep using `patch` directly.
 *
 * Rejections do not strand later writes, but they are retained until `idle()`
 * reports and consumes them. `useStore.patch` merges partial payloads, so a later
 * successful write of a different field does not replay a failed one — clearing
 * the error on drain would let Start launch mixed (old model + new level) state.
 * Start must abort when `idle()` returns a message.
 */
export interface SerialPatchQueue<T> {
  enqueue(payload: T): void
  /**
   * Wait until nothing is in flight. `null` means every waited-for write succeeded.
   * A string means at least one write in this batch failed — Start must not launch,
   * even if a later partial write succeeded.
   */
  idle(): Promise<string | null>
  pending(): number
}

export function createSerialPatchQueue<T>(
  apply: (payload: T) => Promise<unknown>,
  onPending?: (n: number) => void
): SerialPatchQueue<T> {
  let tail: Promise<void> = Promise.resolve()
  let n = 0
  let batchErrors: string[] = []
  const bump = (delta: number): void => {
    n += delta
    onPending?.(n)
  }
  const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))
  return {
    enqueue(payload) {
      bump(1)
      tail = tail.then(async () => {
        try {
          await apply(payload)
          bump(-1)
        } catch (err) {
          batchErrors.push(messageOf(err))
          bump(-1)
        }
      })
    },
    async idle() {
      do {
        await tail
      } while (n > 0)
      if (batchErrors.length === 0) return null
      const msg = batchErrors[0]
      batchErrors = []
      return msg
    },
    pending() {
      return n
    }
  }
}
