/**
 * The single source of truth for what a given Gemini model id supports.
 *
 * This exists because the same rules used to be implemented twice — in
 * `pythonBridge.thinkingArgs()` and inline in `SettingsPage` — with different logic.
 * That divergence is how the `-latest` bug survived: the UI happily offered a Thinking
 * Level control for an id the engine classified as "no thinking config at all".
 *
 * Every rule below mirrors the engine's own substring matching, in the same order, so
 * the UI can never offer a combination the engine will reject:
 *
 *   main.py:210  `if "2.0" in model or "gemini" not in model:`  -> no thinking config
 *   main.py:212  `elif "2.5" in model:`                          -> thinking_budget
 *   main.py:227  `elif "3" in model:`                            -> thinking_level
 *   main.py:229  Gemini 3 Pro rejects "minimal" (coerced to "low")
 *   main.py:235  thinking cannot be disabled for 3.x (coerced to the lowest level)
 *   main.py:214  Gemini 2.5 Pro cannot disable thinking; budget floor is 128
 *   main.py:603  non-pro 2.5 budget range 0..24576; main.py:609 pro range 128..32768
 *   main.py:1544 transcription requires "gemini" AND ("2.5" OR "3")
 *
 * Verified against `Source Codes/gemini-srt-translator-3.7.0.zip`.
 */

export type ThinkingMode = 'level' | 'budget' | 'none'

export interface ModelCapabilities {
  /** Which thinking control (if any) the engine reads for this model. */
  thinking: ThinkingMode
  /** Whether `--no-thinking` is honoured rather than silently coerced. */
  canDisableThinking: boolean
  /** Valid `--thinking-budget` range; only meaningful when `thinking === 'budget'`. */
  thinkingBudgetMin: number
  thinkingBudgetMax: number
  /** Gemini 3 Pro coerces `minimal` to `low`, so the UI should not offer it. */
  rejectsMinimalLevel: boolean
  /** `gst transcribe` hard-errors for anything that is not a Gemini 2.5/3.x model. */
  supportsTranscription: boolean
}

const NO_THINKING: Omit<ModelCapabilities, 'supportsTranscription'> = {
  thinking: 'none',
  canDisableThinking: false,
  thinkingBudgetMin: 0,
  thinkingBudgetMax: 0,
  rejectsMinimalLevel: false
}

export function modelCapabilities(id: string): ModelCapabilities {
  const model = (id || '').toLowerCase()
  const isGemini = model.includes('gemini')
  const is20 = model.includes('2.0')
  const is25 = model.includes('2.5')
  // Checked last, exactly like the engine, so "gemini-2.5-...-03-25" stays a 2.5 model.
  const is3x = !is20 && !is25 && model.includes('3')
  const isPro = model.includes('pro')

  const supportsTranscription = isGemini && (is25 || is3x)

  if (!isGemini || is20) {
    return { ...NO_THINKING, supportsTranscription }
  }

  if (is25) {
    return {
      thinking: 'budget',
      // 2.5 Pro cannot disable thinking — the engine forces the budget back up to 128.
      canDisableThinking: !isPro,
      thinkingBudgetMin: isPro ? 128 : 0,
      thinkingBudgetMax: isPro ? 32768 : 24576,
      rejectsMinimalLevel: false,
      supportsTranscription
    }
  }

  if (is3x) {
    return {
      thinking: 'level',
      // "You cannot disable thinking for Gemini 3 models" — it coerces to the lowest level.
      canDisableThinking: false,
      thinkingBudgetMin: 0,
      thinkingBudgetMax: 0,
      rejectsMinimalLevel: isPro,
      supportsTranscription
    }
  }

  return { ...NO_THINKING, supportsTranscription }
}

/**
 * The thinking level the engine will actually apply, after its own coercions. Used so
 * the UI never claims a setting that the engine silently overrides.
 */
export function effectiveThinkingLevel(id: string, level: string): string {
  const caps = modelCapabilities(id)
  if (caps.thinking !== 'level') return level
  if (level === 'disabled') return caps.rejectsMinimalLevel ? 'low' : 'minimal'
  if (level === 'minimal' && caps.rejectsMinimalLevel) return 'low'
  return level
}
