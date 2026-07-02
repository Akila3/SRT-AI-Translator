import { spawn } from 'child_process'
import { resolveGstBin } from './pythonBridge'
import { envWithFfmpeg } from './ffmpeg'
import { DEFAULT_MODELS, LATEST_ALIAS_IDS, getSettings } from './store'
import type { ModelInfo } from '../shared/types'

type Family = 'flash-lite' | 'flash' | 'pro' | 'other'

interface Parsed {
  id: string
  kind: 'latest' | 'versioned' | 'other'
  family: Family
  version: number
  variant: string
}

const FAMILY_RANK: Record<Family, number> = { flash: 0, 'flash-lite': 1, pro: 2, other: 3 }
const FAMILY_WORDS: Record<Exclude<Family, 'other'>, string> = {
  flash: 'Flash',
  'flash-lite': 'Flash Lite',
  pro: 'Pro'
}
// Sensible floors so "latest" still shows a version even before a fetch.
const FAMILY_FLOOR: Record<Exclude<Family, 'other'>, number> = { flash: 3.5, 'flash-lite': 3.1, pro: 3.1 }

function familyOf(variant: string): Family {
  if (variant.startsWith('flash-lite')) return 'flash-lite'
  if (variant.startsWith('flash')) return 'flash'
  if (variant.startsWith('pro')) return 'pro'
  return 'other'
}

function isPreview(variant: string): boolean {
  return /preview|exp/.test(variant)
}

function parse(id: string): Parsed {
  const latest = id.match(/^gemini-(flash-lite|flash|pro)-latest$/)
  if (latest) {
    return { id, kind: 'latest', family: latest[1] as Family, version: 0, variant: '' }
  }
  const v = id.match(/^gemini-(\d+(?:\.\d+)?)-(.+)$/)
  if (v) {
    const variant = v[2]
    return { id, kind: 'versioned', family: familyOf(variant), version: parseFloat(v[1]), variant }
  }
  return { id, kind: 'other', family: 'other', version: 0, variant: '' }
}

function titleCase(s: string): string {
  return s
    .split('-')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')
}

/** Build a friendly label from a raw model id, e.g. gemini-3.1-flash-lite → Gemini Flash Lite 3.1 */
export function friendlyLabel(id: string): string {
  const known = DEFAULT_MODELS.find((m) => m.id === id)
  if (known) return known.label
  const p = parse(id)
  if (p.kind === 'versioned') return `Gemini ${titleCase(p.variant)} ${p.version}`
  return id
}

/**
 * Resolve the version a "-latest" alias currently points to, by taking the
 * highest version seen for that family (across fetched + core models), floored
 * at a sensible minimum so it never shows blank.
 */
function latestVersion(family: Exclude<Family, 'other'>, all: Parsed[]): number {
  let max = FAMILY_FLOOR[family]
  for (const p of all) {
    if (p.kind === 'versioned' && p.family === family && p.version > max) max = p.version
  }
  return max
}

/**
 * Turn a set of raw model ids into the curated, friendly, ordered dropdown list:
 *  - Always include the 3 "latest" aliases (with resolved version in parentheses).
 *  - Always include the core models (defined in DEFAULT_MODELS).
 *  - Additionally include any fetched flash / flash-lite / pro model at v3.0+.
 *  - Drop everything older than 3.x and non-translation families (robotics, etc.).
 */
export function buildModelList(rawIds: string[]): ModelInfo[] {
  const coreVersioned = DEFAULT_MODELS.filter((m) => !LATEST_ALIAS_IDS.includes(m.id)).map((m) => m.id)
  const allIds = Array.from(new Set([...coreVersioned, ...rawIds]))
  const parsedAll = allIds.map(parse)
  const coreSet = new Set(coreVersioned)

  // Highest released (non-preview) version per family — used to drop redundant
  // previews that are at or below an already-released model.
  const releasedMax: Record<Family, number> = { flash: 0, 'flash-lite': 0, pro: 0, other: 0 }
  for (const p of parsedAll) {
    if (p.kind === 'versioned' && !isPreview(p.variant) && p.version > releasedMax[p.family]) {
      releasedMax[p.family] = p.version
    }
  }

  const keptVersioned = parsedAll.filter((p) => {
    if (p.kind !== 'versioned') return false
    if (coreSet.has(p.id)) return true
    if (p.family === 'other' || p.version < 3) return false
    // Only keep a preview if it's NEWER than the latest released model in its tier.
    if (isPreview(p.variant) && p.version <= releasedMax[p.family]) return false
    return true
  })

  keptVersioned.sort((a, b) => {
    if (b.version !== a.version) return b.version - a.version
    if (FAMILY_RANK[a.family] !== FAMILY_RANK[b.family]) return FAMILY_RANK[a.family] - FAMILY_RANK[b.family]
    return a.variant.length - b.variant.length
  })

  const aliasModels: ModelInfo[] = LATEST_ALIAS_IDS.map((id) => {
    const fam = parse(id).family as Exclude<Family, 'other'>
    const ver = latestVersion(fam, parsedAll)
    return { id, label: `Gemini ${FAMILY_WORDS[fam]} Latest (${ver})`, available: true }
  })

  const versionedModels: ModelInfo[] = keptVersioned.map((p) => ({
    id: p.id,
    label: friendlyLabel(p.id),
    available: true
  }))

  return [...aliasModels, ...versionedModels]
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
  models: ModelInfo[]
  keyValid: boolean
  error: string
}

export async function refreshModels(apiKey: string): Promise<RefreshResult> {
  if (!apiKey || !apiKey.trim()) {
    return { models: DEFAULT_MODELS, keyValid: false, error: 'No API key provided.' }
  }

  const bin = resolveGstBin()
  const { out } = await new Promise<{ out: string; code: number | null }>((resolve) => {
    let stdout = ''
    let proc
    try {
      proc = spawn(bin, ['list-models', '-k', apiKey], {
        env: envWithFfmpeg(getSettings().ffmpegPath, {
          PYTHONUTF8: '1',
          PYTHONIOENCODING: 'utf-8',
          NO_COLOR: '1'
        })
      })
      // `list-models` has no --skip-upgrade flag and prints an interactive
      // "upgrade? (y/n)" prompt that blocks on stdin forever. Answer "n" so the
      // upgrade is skipped and the tool proceeds to print the model list.
      // (Harmless when no prompt appears — the input is simply never read.)
      try {
        proc.stdin.write('n\n')
        proc.stdin.end()
      } catch {
        /* stdin may already be closed */
      }
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
  const re = /gemini-[a-z0-9.\-]+/gi
  let match: RegExpExecArray | null
  while ((match = re.exec(out)) !== null) {
    const id = match[0].toLowerCase().replace(/[.,)]+$/, '')
    // Skip non-model matches: the CLI's own package name appears in the
    // upgrade banner ("gemini-srt-translator"), and various non-translation
    // model families are irrelevant here.
    if (/srt-translator|embedding|aqa|tts|image|vision|robotics|computer-use/.test(id)) continue
    ids.add(id)
  }

  if (ids.size === 0) {
    // Could not reach the API / invalid key — keep the built-in list usable.
    return { models: DEFAULT_MODELS, keyValid: false, error: friendlyError(out) }
  }

  return { models: buildModelList(Array.from(ids)), keyValid: true, error: '' }
}

export interface KeyCheck {
  valid: boolean | null
  error: string
}

export interface CheckKeysResult {
  results: KeyCheck[]
  models: ModelInfo[]
  anyValid: boolean
}

/**
 * Validate each provided key individually. Empty slots get a null status.
 * The model list is taken from the first valid key.
 */
export async function checkApiKeys(keys: string[]): Promise<CheckKeysResult> {
  const results: KeyCheck[] = []
  let models: ModelInfo[] = DEFAULT_MODELS
  let anyValid = false

  for (const key of keys) {
    if (!key || !key.trim()) {
      results.push({ valid: null, error: '' })
      continue
    }

    const res = await refreshModels(key)
    results.push({ valid: res.keyValid, error: res.keyValid ? '' : res.error })
    if (res.keyValid && !anyValid) {
      models = res.models
      anyValid = true
    }
  }

  return { results, models, anyValid }
}
