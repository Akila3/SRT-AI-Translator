import { spawn } from 'child_process'
import { keySlotsFor, resolveGstBin } from './pythonBridge'
import { envWithFfmpeg } from './ffmpeg'
import { DEFAULT_MODELS, getSettings } from './store'
import { activeKeySlots } from '../shared/keyOrder'
import type {
  CheckKeysResult,
  KeyCheck,
  ModelInfo,
  RefreshOutcome,
  SlotFetchResult
} from '../shared/types'

type Family = 'flash-lite' | 'flash' | 'pro' | 'other'

/**
 * Ids we invented and injected unconditionally in an earlier build. Google does not
 * publish them, so the engine's membership check rejects them outright (main.py:645),
 * and even a real one would defeat its thinking-config substring match
 * (main.py:207-243). They are filtered out of every path: the fetch, the cache and the
 * seed.
 */
const ALIAS_RE = /-latest$/

/** Version as an ordered tuple. NEVER parse this with parseFloat — `3.10` must beat `3.9`. */
export interface ModelVersion {
  major: number
  minor: number
}

interface Parsed {
  id: string
  versioned: boolean
  family: Family
  version: ModelVersion | null
  variant: string
  preview: boolean
}

const FAMILY_RANK: Record<Family, number> = { flash: 0, 'flash-lite': 1, pro: 2, other: 3 }

/** Anything below Gemini 2.x is long deprecated and only clutters the picker. */
const MIN_DISPLAYED_MAJOR = 2

function familyOf(variant: string): Family {
  if (variant.startsWith('flash-lite')) return 'flash-lite'
  if (variant.startsWith('flash')) return 'flash'
  if (variant.startsWith('pro')) return 'pro'
  return 'other'
}

function isPreviewVariant(variant: string): boolean {
  return /preview|exp/.test(variant)
}

function parse(id: string): Parsed {
  const v = id.match(/^gemini-(\d+)(?:\.(\d+))?-(.+)$/)
  if (v) {
    const variant = v[3]
    return {
      id,
      versioned: true,
      family: familyOf(variant),
      version: { major: parseInt(v[1], 10), minor: v[2] ? parseInt(v[2], 10) : 0 },
      variant,
      preview: isPreviewVariant(variant)
    }
  }
  return { id, versioned: false, family: 'other', version: null, variant: '', preview: /preview|exp/.test(id) }
}

/**
 * Ordered version comparison. Returns >0 when `a` is newer.
 *
 * The previous implementation used `parseFloat`, which makes `parseFloat('3.10') === 3.1`
 * and therefore ranks `gemini-3.10-flash-lite` BELOW `gemini-3.9-flash-lite` — silently
 * picking the older model as "newest lite".
 */
export function compareVersions(a: ModelVersion | null, b: ModelVersion | null): number {
  if (!a && !b) return 0
  if (!a) return -1
  if (!b) return 1
  if (a.major !== b.major) return a.major - b.major
  return a.minor - b.minor
}

export function formatVersion(v: ModelVersion | null): string {
  if (!v) return ''
  return v.minor ? `${v.major}.${v.minor}` : `${v.major}`
}

/** Newest first, fully deterministic so the dropdown order never flickers. */
function compareForDisplay(a: Parsed, b: Parsed): number {
  if (a.versioned !== b.versioned) return a.versioned ? -1 : 1
  const byVersion = compareVersions(b.version, a.version)
  if (byVersion !== 0) return byVersion
  if (FAMILY_RANK[a.family] !== FAMILY_RANK[b.family]) return FAMILY_RANK[a.family] - FAMILY_RANK[b.family]
  if (a.preview !== b.preview) return a.preview ? 1 : -1
  if (a.variant.length !== b.variant.length) return a.variant.length - b.variant.length
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

function titleCase(s: string): string {
  return s
    .split('-')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')
}

/** Build a friendly label from a raw model id, e.g. gemini-3.1-flash-lite -> Gemini Flash Lite 3.1 */
export function friendlyLabel(id: string): string {
  const known = DEFAULT_MODELS.find((m) => m.id === id)
  if (known) return known.label
  const p = parse(id)
  if (p.versioned) return `Gemini ${titleCase(p.variant)} ${formatVersion(p.version)}`
  return id
}

/** Model id -> the API-key slot indices whose fetch returned it. */
export type ModelAvailability = Record<string, number[]>

/**
 * Turn raw model ids into the curated, friendly, ordered dropdown list.
 *
 * Pure and idempotent, because it runs on BOTH the cache read (`models:getCached`) and
 * the cache write — a non-idempotent change here corrupts the stored list on the next
 * launch.
 *
 * @param rawIds       ids to offer: the union of everything the queried keys returned,
 *                     or the ids already in the cache.
 * @param availability per-id evidence of which key slots returned it. Supplying a
 *                     non-empty map means a fetch has succeeded, which is what switches
 *                     the seed off — the seed is a display fallback for profiles that
 *                     have never fetched, never a claim that a model is runnable.
 */
export function buildModelList(rawIds: string[], availability: ModelAvailability = {}): ModelInfo[] {
  const hasLiveEvidence = Object.keys(availability).length > 0

  const ids = new Set<string>()
  for (const raw of rawIds) {
    const id = (raw || '').trim().toLowerCase()
    if (!id || ALIAS_RE.test(id)) continue
    ids.add(id)
  }
  if (!hasLiveEvidence) for (const m of DEFAULT_MODELS) ids.add(m.id)

  const kept = Array.from(ids)
    .map(parse)
    // Unparseable ids stay in the list (grouped last) but are excluded from the default
    // computation in resolveDefaultModel, so they can never win by accident.
    .filter((p) => !p.versioned || (p.version?.major ?? 0) >= MIN_DISPLAYED_MAJOR)
    .sort(compareForDisplay)

  return kept.map((p) => {
    const slots = availability[p.id]
    const live = Array.isArray(slots) && slots.length > 0
    const base = friendlyLabel(p.id)
    return {
      id: p.id,
      // Previews are always offered (never auto-selected) and must be visibly marked so
      // the choice is informed.
      label: p.preview && !/preview/i.test(base) ? `${base} (Preview)` : base,
      source: live ? 'live' : 'seed',
      availableOn: live ? [...slots].sort((a, b) => a - b) : []
    }
  })
}

/**
 * The newest `flash-lite`, per the user's rule: "we go by newest flash-lite model, not
 * by cheapest". Falls back to the newest `flash`, then to the newest model of any
 * family.
 *
 * The caller MUST pass the runnable set (Step 3b) — never the seed and never the union.
 * Previews and unparseable ids are excluded from the computation entirely.
 * Returns null when nothing qualifies, which callers must treat as "leave the user's
 * selection alone".
 */
export function resolveDefaultModel(models: ModelInfo[]): string | null {
  return resolveDefaultModelWithBasis(models).id
}

/** How a default was arrived at. See `resolveDefaultModelWithBasis`. */
export type DefaultBasis = 'flash-lite' | 'flash' | 'fallback' | 'none'

/**
 * The same computation, plus WHY that model won.
 *
 * The auto-advance rule identifies "the user never overrode the default" by comparing the
 * stored id against the previous list's default. That test is only meaningful when the
 * previous default was a genuine flash-lite/flash pick. When neither family was present,
 * `resolveDefaultModel` falls back to "the newest of anything", which would make a
 * deliberately chosen `pro` look like an un-overridden default and let auto-advance move
 * the user off it — a silent override loss. Callers making that comparison must require a
 * basis of `flash-lite` or `flash`.
 */
export function resolveDefaultModelWithBasis(models: ModelInfo[]): {
  id: string | null
  basis: DefaultBasis
} {
  const eligible = models
    .map((m) => parse(m.id))
    .filter((p) => p.versioned && !p.preview)
    .sort(compareForDisplay)
  if (eligible.length === 0) return { id: null, basis: 'none' }

  const newestOf = (family: Family): string | null => eligible.find((p) => p.family === family)?.id ?? null
  const lite = newestOf('flash-lite')
  if (lite) return { id: lite, basis: 'flash-lite' }
  const flash = newestOf('flash')
  if (flash) return { id: flash, basis: 'flash' }
  return { id: eligible[0].id, basis: 'fallback' }
}

/** Turn a raw CLI/API failure dump into a short, user-friendly message. */
function friendlyError(out: string): string {
  const clean = out.replace(/\u001b\[[0-9;]*m/g, ' ')
  if (/API_KEY_INVALID|api key not valid|invalid authentication|unauthenticated|\b401\b/i.test(clean)) {
    return 'Invalid API key. Double-check the key from Google AI Studio and try again.'
  }
  if (/permission_denied|\b403\b/i.test(clean)) {
    return 'This API key is not authorized for the Gemini API. Enable it in Google AI Studio.'
  }
  if (/resource_exhausted|quota|\b429\b/i.test(clean)) {
    return 'Quota exceeded for this key. Wait a bit and retry, or use a paid key.'
  }
  if (/getaddrinfo|enotfound|etimedout|econnrefused|network|failed to fetch|connection/i.test(clean)) {
    return 'Could not reach Google. Check your internet connection and try again.'
  }
  return 'Could not retrieve models. Check the API key and your internet connection.'
}

export interface RefreshResult {
  /** Raw ids this key reported, alias-filtered. Empty when the fetch failed. */
  ids: string[]
  keyValid: boolean
  error: string
}

/**
 * Ask one API key what models it can see.
 *
 * Returns raw ids rather than a curated list on purpose: availability decisions
 * (union / intersection / "provably absent") must be made on what the API actually said,
 * never on what our display curation chose to keep. Curating first would let a cosmetic
 * filter masquerade as proof that a model no longer exists.
 */
export async function refreshModels(apiKey: string): Promise<RefreshResult> {
  if (!apiKey || !apiKey.trim()) {
    return { ids: [], keyValid: false, error: 'No API key provided.' }
  }

  const bin = resolveGstBin()
  const { out } = await new Promise<{ out: string; code: number | null }>((resolve) => {
    let stdout = ''
    let proc
    try {
      // 3.6.2 added --skip-upgrade, which replaces the old workaround of writing 'n\n'
      // to stdin to answer the blocking "upgrade? (y/n)" prompt.
      proc = spawn(bin, ['list-models', '-k', apiKey, '--skip-upgrade'], {
        env: envWithFfmpeg(getSettings().ffmpegPath, {
          PYTHONUTF8: '1',
          PYTHONIOENCODING: 'utf-8',
          NO_COLOR: '1'
        })
      })
    } catch {
      resolve({ out: '', code: -1 })
      return
    }
    proc.stdout.on('data', (d) => (stdout += d.toString()))
    proc.stderr.on('data', (d) => (stdout += d.toString()))
    proc.on('error', () => resolve({ out: stdout, code: -1 }))
    proc.on('close', (code) => resolve({ out: stdout, code }))
  })

  const ids = new Set<string>()
  let aliasesSeen = 0
  const re = /gemini-[a-z0-9.\-]+/gi
  let match: RegExpExecArray | null
  while ((match = re.exec(out)) !== null) {
    const id = match[0].toLowerCase().replace(/[.,)]+$/, '')
    // Skip non-model matches: the CLI's own package name appears in the upgrade banner
    // ("gemini-srt-translator"), and various non-translation model families are
    // irrelevant here.
    if (/srt-translator|embedding|aqa|tts|image|vision|robotics|computer-use/.test(id)) continue
    // Drop aliases at the FETCH path too. Removing our own injection is not enough: if
    // Google ever publishes one, it would re-enter the picker through the fetch and
    // still bypass the engine's thinking-config match.
    if (ALIAS_RE.test(id)) {
      aliasesSeen++
      continue
    }
    ids.add(id)
  }
  if (aliasesSeen > 0) {
    console.log(`[models] ignored ${aliasesSeen} "-latest" alias id(s) returned by the API`)
  }

  if (ids.size === 0) {
    return { ids: [], keyValid: false, error: friendlyError(out) }
  }

  return { ids: Array.from(ids), keyValid: true, error: '' }
}

export interface RefreshSummary {
  unionIds: string[]
  runnableIds: string[]
  models: ModelInfo[]
  availability: ModelAvailability
  refreshOutcome: RefreshOutcome
}

/**
 * Turn per-slot fetch results into the availability picture the model rules depend on.
 *
 * Pure, so the evidence rules can be exercised directly by the gate fixtures.
 *
 * @param activeSlots the ACTIVE SET — `orderKeySlots(...).slice(0, 2)` computed from the
 *        validity that was in force BEFORE this refresh. It must be the pre-refresh
 *        ranking: ranking on the fresh results would drop every slot that just failed,
 *        making `activeComplete` vacuously true and defeating the whole point of the bar.
 */
export function summarizeRefresh(slots: SlotFetchResult[], activeSlots: number[]): RefreshSummary {
  const queried = slots.filter((s) => s.queried)
  const answered = queried.filter((s) => s.ok)

  const availability: ModelAvailability = {}
  for (const slot of answered) {
    for (const id of slot.ids) {
      if (!availability[id]) availability[id] = []
      if (!availability[id].includes(slot.slot)) availability[id].push(slot.slot)
    }
  }
  const unionIds = Object.keys(availability)

  // Runnable = present on EVERY active-set slot, because the engine may switch between
  // -k and -k2 mid-run (_switch_api, main.py:1001-1018). With one key that is simply
  // that key's list. If no active slot answered, fall back to whatever did answer, so a
  // fresh install can still be seeded.
  const activeAnswered = answered.filter((s) => activeSlots.includes(s.slot))
  const basis = activeAnswered.length ? activeAnswered : answered
  const runnableIds = basis.length ? unionIds.filter((id) => basis.every((s) => s.ids.includes(id))) : []

  const allComplete = queried.length > 0 && answered.length === queried.length
  const activeComplete =
    activeSlots.length > 0 && activeSlots.every((i) => answered.some((s) => s.slot === i))
  const refreshOutcome: RefreshOutcome = allComplete
    ? 'allComplete'
    : activeComplete
      ? 'activeComplete'
      : answered.length > 0
        ? 'partial'
        : 'failed'

  return {
    unionIds,
    runnableIds,
    // Never degrade to the seed on a failed refresh: the caller keeps the last known
    // list instead. Handing back the seed here is what made a failed fetch look like a
    // successful one ("N models available") in the old UI.
    models: unionIds.length ? buildModelList(unionIds, availability) : [],
    availability,
    refreshOutcome
  }
}

/**
 * Validate every provided key individually and record what EACH one returned.
 *
 * The previous implementation kept only the first valid key's list and threw the rest
 * away, while spawn time may promote a different pair — so a model visible only to a
 * reserve key could be selected and then fail partway through a job.
 */
export async function checkApiKeys(keys: string[]): Promise<CheckKeysResult> {
  // Snapshot the ranking BEFORE the new results land (see summarizeRefresh). Built with
  // the same helper spawn uses, so "active" here means exactly the slots a run would use.
  const activeSlots = activeKeySlots(keySlotsFor(keys))

  const results: KeyCheck[] = []
  const slots: SlotFetchResult[] = []

  for (let i = 0; i < keys.length; i++) {
    const key = keys[i]
    if (!key || !key.trim()) {
      results.push({ valid: null, error: '' })
      slots.push({ slot: i, queried: false, ok: false, ids: [] })
      continue
    }
    const res = await refreshModels(key)
    results.push({ valid: res.keyValid, error: res.keyValid ? '' : res.error })
    slots.push({ slot: i, queried: true, ok: res.keyValid, ids: res.ids })
  }

  const summary = summarizeRefresh(slots, activeSlots)
  return {
    results,
    slots,
    models: summary.models,
    unionIds: summary.unionIds,
    runnableIds: summary.runnableIds,
    activeSlots,
    refreshOutcome: summary.refreshOutcome,
    anyValid: results.some((r) => r.valid === true)
  }
}

export type ModelGuardVerdict = { ok: boolean; warning?: string; error?: string }

/**
 * Pre-spawn guard: check the chosen model against the runnable set so a doomed run fails
 * immediately with an actionable message instead of after the user has waited for the
 * engine's own `exit(1)` (main.py:645).
 *
 * Deliberately asymmetric: it BLOCKS only on positive evidence of absence, and merely
 * WARNS when availability is unknown. Refusing to start because the network was down
 * would be worse than letting the engine report the truth.
 */
export function guardModelForSpawn(
  model: string,
  cachedModels: ModelInfo[],
  activeSlots: number[]
): ModelGuardVerdict {
  const live = cachedModels.filter((m) => m.source === 'live')
  if (live.length === 0) {
    return {
      ok: true,
      warning:
        'Models have not been verified against your API key yet. If the run fails with ' +
        '"model not available", open Settings and use "Fetch Models & Check API Keys".'
    }
  }

  const entry = cachedModels.find((m) => m.id === model)
  if (!entry || entry.source !== 'live') {
    return {
      ok: false,
      error:
        `The selected model "${model}" was not in the list your API key returned. ` +
        'Open Settings > Gemini API Keys, run "Fetch Models & Check API Keys", and pick a model from the refreshed list.'
    }
  }

  const missingOn = activeSlots.filter((slot) => !entry.availableOn.includes(slot))
  if (missingOn.length > 0) {
    return {
      ok: true,
      warning:
        `"${model}" was not reported by API key slot ${missingOn.map((i) => i + 1).join(', ')}, ` +
        'which this run may switch to for extra quota. The run may fail if that happens.'
    }
  }

  return { ok: true }
}
