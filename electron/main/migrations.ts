/**
 * Versioned, non-destructive settings migrations.
 *
 * DATA-LOSS SENSITIVE. Persisted user data — API keys, the model cache and the model
 * selection — flows through here, so every rule below is deliberate:
 *
 *  - `defaults.schemaVersion` MUST be 0. electron-store returns the default for any
 *    absent key, so any other default makes legacy profiles report "already migrated"
 *    and skip the entire chain.
 *  - Migrations run at module load, offline, before any window or fetch exists. They
 *    therefore cannot prove that a model is gone and MUST NOT replace one. The strongest
 *    action available to them is to raise `modelNeedsVerification`.
 *  - Filter, never reset. The pre-existing code wiped the whole model cache whenever it
 *    contained one of four ids; M4 removes only the offending entries.
 *  - Idempotent throughout, because electron-store gives no cross-key transaction: a
 *    crash between the write and the version bump must be harmless on the next launch.
 *  - Malformed data is left untouched and noted rather than "repaired", and the version
 *    still bumps, so a bad field can never wedge the app in a migration loop.
 *
 * Kept free of electron-store and electron imports so the gate G1/G1b fixtures can run
 * the real chain rather than a copy of it.
 */
import type { AppSettings } from '../shared/types'

/** Bumped by the step that owns the migration: Steps 5 (1-3) and 3b (4). */
export const CURRENT_SCHEMA_VERSION = 4

/**
 * Ids a previous build removed from the picker. Two of them (`gemini-2.0-flash`,
 * `gemini-2.0-flash-lite`) are REAL models listed in the engine's own pricing.json;
 * they were dropped by a display-curation rule, not because they ceased to exist. That
 * is precisely why M1 only flags them.
 */
export const SUSPICIOUS_MODEL_IDS = [
  'gemini-3.5-flash-lite',
  'gemini-3.5-pro',
  'gemini-2.0-flash',
  'gemini-2.0-flash-lite'
]

const ALIAS_RE = /-latest$/

export interface MigrationContext {
  /** The static fallback M3 remaps aliases to. MUST already be alias-free (Step 5a.0). */
  defaultModelId: string
  /** Used by M5 to fill fields that a legacy profile has never heard of. */
  defaults: Pick<AppSettings, 'customGenerationParams' | 'resumeContextSize' | 'modelNeedsVerification'>
}

export interface MigrationResult {
  /** The migrated object. Unknown keys are passed through untouched. */
  settings: Record<string, unknown>
  /** Version the profile came in at (absent === 0). */
  fromVersion: number
  /** Version the profile is at on the way out. */
  toVersion: number
  /** True when anything at all needs writing back. */
  changed: boolean
  /** True when the profile came from a NEWER build and was deliberately left alone. */
  downgrade: boolean
  /** Human-readable trail; the caller logs these once. */
  notes: string[]
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function readVersion(raw: Record<string, unknown>): number {
  const v = raw.schemaVersion
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0
}

export function migrateSettings(
  raw: Record<string, unknown>,
  ctx: MigrationContext
): MigrationResult {
  const from = readVersion(raw)
  const next: Record<string, unknown> = { ...raw }
  const notes: string[] = []
  let changed = false

  const setField = (key: string, value: unknown, note: string): void => {
    next[key] = value
    changed = true
    notes.push(note)
  }

  if (from > CURRENT_SCHEMA_VERSION) {
    // Downgrade guard. A profile written by a newer build must not be "repaired" —
    // rewriting fields we do not understand is data loss, not recovery.
    return {
      settings: raw,
      fromVersion: from,
      toVersion: from,
      changed: false,
      downgrade: true,
      notes: [
        `settings schemaVersion ${from} is newer than this build's ${CURRENT_SCHEMA_VERSION}; ` +
          'skipping all migrations and leaving the profile untouched'
      ]
    }
  }

  if (from === CURRENT_SCHEMA_VERSION) {
    return {
      settings: raw,
      fromVersion: from,
      toVersion: from,
      changed: false,
      downgrade: false,
      notes: []
    }
  }

  // ── M1 (v<1): flag a suspicious model id. NEVER replace it. ────────────────────
  // A migration runs offline and cannot prove a model is gone; only an `allComplete`
  // refresh can. Replacing here would silently destroy a valid user override.
  if (from < 1) {
    const model = next.model
    if (typeof model === 'string' && SUSPICIOUS_MODEL_IDS.includes(model)) {
      if (next.modelNeedsVerification !== true) {
        setField(
          'modelNeedsVerification',
          true,
          `M1: stored model "${model}" was dropped by an older build's picker; flagged for verification (left unchanged)`
        )
      }
    }
  }

  // ── M2 (v<1): per-key validity/error became arrays. ────────────────────────────
  if (from < 1) {
    if (!Array.isArray(next.apiKeyValid)) {
      const v = next.apiKeyValid
      setField(
        'apiKeyValid',
        [v === true || v === false ? v : null],
        'M2: coerced scalar apiKeyValid into a single-element array'
      )
    }
    if (!Array.isArray(next.apiKeyError)) {
      const e = next.apiKeyError
      setField(
        'apiKeyError',
        [typeof e === 'string' ? e : ''],
        'M2: coerced scalar apiKeyError into a single-element array'
      )
    }
  }

  // ── M3 (v<2): remap an invented "-latest" alias to a real, versioned id. ───────
  // The alias is a name WE fabricated and injected, not a choice among real models, so
  // remapping it is not destroying a user selection. It maps to the STATIC constant —
  // migrations have no live model data and must never call a resolver.
  if (from < 2) {
    const model = next.model
    if (typeof model === 'string' && ALIAS_RE.test(model)) {
      if (ALIAS_RE.test(ctx.defaultModelId)) {
        // Step 5a.0 was skipped. Remapping an alias to another alias would strand the
        // profile permanently, because the version bump makes this unreachable again.
        notes.push(
          `M3: REFUSED to remap "${model}" — DEFAULT_MODEL_ID is itself an alias ` +
            `("${ctx.defaultModelId}"). De-alias the store constants (Step 5a.0) first.`
        )
      } else {
        setField('model', ctx.defaultModelId, `M3: remapped alias "${model}" to "${ctx.defaultModelId}"`)
        if (next.modelNeedsVerification !== true) {
          setField('modelNeedsVerification', true, 'M3: flagged the remapped model for verification')
        }
      }
    }
  }

  // ── M4 (v<2): filter aliases out of the model cache. ───────────────────────────
  // Replaces the old unconditional `cachedModels = DEFAULT_MODELS` reset, which is the
  // one genuinely destructive operation in the previous code.
  if (from < 2) {
    const cached = next.cachedModels
    if (Array.isArray(cached)) {
      const kept = cached.filter(
        (m) => !(isPlainObject(m) && typeof m.id === 'string' && ALIAS_RE.test(m.id))
      )
      if (kept.length !== cached.length) {
        setField(
          'cachedModels',
          kept,
          `M4: removed ${cached.length - kept.length} "-latest" alias entr${
            cached.length - kept.length === 1 ? 'y' : 'ies'
          } from the model cache; kept the other ${kept.length}`
        )
      }
    } else if (cached !== undefined) {
      notes.push('M4: cachedModels is not an array; left untouched')
    }
  }

  // ── M5 (v<3): introduce fields that legacy profiles have never seen. ───────────
  if (from < 3) {
    const introduced: [string, unknown][] = [
      ['customGenerationParams', ctx.defaults.customGenerationParams],
      ['resumeContextSize', ctx.defaults.resumeContextSize],
      ['modelNeedsVerification', ctx.defaults.modelNeedsVerification]
    ]
    for (const [key, value] of introduced) {
      if (next[key] === undefined) {
        setField(key, value, `M5: added missing field ${key}`)
      }
    }
  }

  // ── M6 (v<4, owned by Step 3b): backfill model provenance. ─────────────────────
  // A cache written before provenance existed carries no evidence that anything is
  // runnable, so it backfills as `seed` — unverified — rather than as false `live`.
  if (from < 4) {
    const cached = next.cachedModels
    if (Array.isArray(cached)) {
      let touched = 0
      const backfilled = cached.map((m) => {
        if (!isPlainObject(m)) return m
        const hasSource = m.source === 'live' || m.source === 'seed'
        const hasAvailability = Array.isArray(m.availableOn)
        if (hasSource && hasAvailability) return m
        touched++
        return {
          ...m,
          source: hasSource ? m.source : 'seed',
          availableOn: hasAvailability ? m.availableOn : []
        }
      })
      if (touched > 0) {
        setField(
          'cachedModels',
          backfilled,
          `M6: backfilled provenance (source/availableOn) on ${touched} cached model entr${
            touched === 1 ? 'y' : 'ies'
          }`
        )
      }
    } else if (cached !== undefined) {
      notes.push('M6: cachedModels is not an array; left untouched')
    }
  }

  // The version bump comes LAST, so a crash mid-chain simply re-runs it next launch.
  next.schemaVersion = CURRENT_SCHEMA_VERSION

  return {
    settings: next,
    fromVersion: from,
    toVersion: CURRENT_SCHEMA_VERSION,
    changed: true,
    downgrade: false,
    notes: changed ? notes : [...notes, 'no field changes were required; version bumped only']
  }
}

/** Convenience for callers that already hold a typed settings object. */
export function migrateAppSettings(raw: AppSettings, ctx: MigrationContext): MigrationResult {
  return migrateSettings(raw as unknown as Record<string, unknown>, ctx)
}
