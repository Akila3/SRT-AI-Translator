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
 *
 * `acceptsSamplingParams` is the one rule here that comes from GOOGLE rather than from the
 * engine, and it is the only one that is about the future rather than the present. See
 * `SAMPLING_DEPRECATED_FROM`.
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
  /**
   * Whether `temperature` / `top_p` / `top_k` still do anything on this model.
   *
   * False means the three flags must not be sent AT ALL, regardless of what the user has
   * configured — see `SAMPLING_DEPRECATED_FROM` for why that is a correctness requirement
   * rather than tidiness.
   */
  acceptsSamplingParams: boolean
}

/**
 * Where Google's sampling-parameter deprecation begins, as a version rather than a list.
 *
 * > **Starting with Gemini 3.6 Flash and Gemini 3.5 Flash-Lite, the following API changes
 * > apply to these models and all future Gemini model releases.**
 * > `temperature`, `top_p`, and `top_k` are deprecated and ignored. In future model
 * > generations, supplying these parameters returns an **HTTP 400** error.
 *
 * Two things make this awkward, and both are why it is expressed as a comparison instead of
 * a set of ids. First, the boundary runs THROUGH the 3.5 generation: 3.5 Flash-Lite is named
 * and 3.5 Flash is not, so a major-version test cannot express it. Second, "all future
 * releases" is open-ended, and this app fetches its model list **live** — a build that is
 * correct today would otherwise acquire a hard failure on the day Google ships the next
 * model, for every user with the toggle on, with nothing in the app to explain it.
 *
 * So an unrecognised or unversioned id resolves to **false**. Guessing that way round costs
 * a user a control that does nothing anyway; guessing the other way round costs them every
 * run. `-latest` aliases land here too, correctly: they follow the model line forwards.
 */
const SAMPLING_DEPRECATED_FROM = { major: 3, minor: 5 }

/**
 * The only ids AT the boundary version that are known to be outside the deprecation.
 *
 * An allowlist rather than "everything at 3.5 that is not Flash-Lite", because those are not
 * the same statement and the difference is reachable. Google names Gemini 3.5 Flash-Lite;
 * Gemini 3.5 **Flash** is simply absent from the list, which is the only reason it is exempt.
 * Nothing is said about any other 3.5 model — `gemini-3.5-pro` exists in this app's own
 * `SUSPICIOUS_MODEL_IDS` and a stored profile can still hold it, and a live fetch can return a
 * 3.5 family that did not exist when this was written. Those are unknowns, and the rule for an
 * unknown is stated above: withhold.
 *
 * So the exemption is spelled out id by id. Adding one is a deliberate act that should carry
 * evidence that Google left it out; the cost of being wrong here is every run failing, while
 * the cost of an id missing from this list is a control that does nothing anyway.
 */
const SAMPLING_EXEMPT_AT_BOUNDARY = ['gemini-3.5-flash']

/**
 * Version taken from the canonical Gemini id grammar, or null when the whole id is
 * unrecognised.
 *
 * Sampling is withheld for anything unrecognised, so this must not pick a `major.minor`
 * out of an otherwise unknown name (`gemini-experimental-2.5-flash` is not a 2.5 model
 * we have classified). The optional `models/` prefix is the API's own spelling of the
 * same id, not a different one. Thinking/transcription still use substring matching —
 * that is the engine's grammar, and this function is not it.
 */
function modelVersion(model: string): { major: number; minor: number } | null {
  const m = model.match(/^(?:models\/)?gemini-(\d+)\.(\d+)(?:-[a-z0-9]+)*$/)
  return m ? { major: parseInt(m[1], 10), minor: parseInt(m[2], 10) } : null
}

function acceptsSampling(model: string, isGemini: boolean): boolean {
  if (!isGemini) return false
  const v = modelVersion(model)
  if (!v) return false
  const cut = SAMPLING_DEPRECATED_FROM
  // Everything BEFORE the boundary is unaffected whatever its family — the deprecation is
  // written as "starting with", so no family-level judgement is needed down here.
  if (v.major !== cut.major) return v.major < cut.major
  // Compared as numbers, not as text, so a future 3.10 sorts AFTER 3.6 rather than beside 3.1.
  if (v.minor !== cut.minor) return v.minor < cut.minor
  // Exactly at the boundary, and only here, the answer is per-model. The API's own `models/`
  // prefix is tolerated because that is the same model, not a different one.
  return SAMPLING_EXEMPT_AT_BOUNDARY.includes(model.replace(/^models\//, ''))
}

const NO_THINKING: Omit<ModelCapabilities, 'supportsTranscription' | 'acceptsSamplingParams'> = {
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
  const acceptsSamplingParams = acceptsSampling(model, isGemini)
  const shared = { supportsTranscription, acceptsSamplingParams }

  if (!isGemini || is20) {
    return { ...NO_THINKING, ...shared }
  }

  if (is25) {
    return {
      thinking: 'budget',
      // 2.5 Pro cannot disable thinking — the engine forces the budget back up to 128.
      canDisableThinking: !isPro,
      thinkingBudgetMin: isPro ? 128 : 0,
      thinkingBudgetMax: isPro ? 32768 : 24576,
      rejectsMinimalLevel: false,
      ...shared
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
      ...shared
    }
  }

  return { ...NO_THINKING, ...shared }
}

/**
 * The sampling values this model would be given if nobody had chosen any.
 *
 * A preview, not a recommendation: while the custom-parameters toggle is off none of this is
 * sent, and each model runs on Google's own tuning. It exists so the fields show something
 * plausible for the selected generation, and so "reset to this model's defaults" has
 * something to reset TO — which is what the old unconditional overwrite was really for.
 *
 * For a 3.x model these numbers ARE the model's own defaults, so "customising" to them sends
 * values that merely restate what it would have done anyway. Said out loud so nobody later
 * "improves" them into something that quietly changes behaviour.
 */
export function samplingDefaults(id: string): { temperature: number; topP: number } {
  const model = (id || '').toLowerCase()
  const is3x = !model.includes('2.0') && !model.includes('2.5') && model.includes('3')
  return is3x ? { temperature: 1.0, topP: 0.95 } : { temperature: 0.3, topP: 0.8 }
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
