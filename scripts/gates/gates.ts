/**
 * Executable gate suite for the 3.7.0 upgrade.
 *
 * Vitest adoption was declined, and the plan's fallback is "run the fixtures manually and
 * keep the before/after pairs". Manual execution of nine data-in/data-out fixtures is both
 * slower and less trustworthy than this file, which imports the SHIPPED modules — so a
 * gate cannot pass against a copy of the logic that has since drifted.
 *
 * Covers:
 *   G1   migration fixtures F1-F8 + F3b
 *   G1b  fixture F9 (provenance backfill)
 *   G2   the automatable half of the ASS gate (extension preserved, non-UTF-8 ASS refused,
 *        the user's original left byte-identical). The engine round-trip stays manual — it
 *        needs a real API key.
 *   plus the model-rule and argv cases the plan lists as C16/C17/C22/C22b/C24/C25/C29/C30/
 *   C32/C33/C34/C35/C36.
 *
 * Run with: npm run test:gates
 */
import fs from 'fs'
import os from 'os'
import path from 'path'

import {
  CURRENT_SCHEMA_VERSION,
  migrateSettings,
  type MigrationContext
} from '../../electron/main/migrations'
import { DEFAULT_MODELS, DEFAULT_MODEL_ID, store, setSettings } from '../../electron/main/store'
import {
  buildModelList,
  compareVersions,
  guardModelForSpawn,
  resolveDefaultModel,
  summarizeRefresh
} from '../../electron/main/modelsList'
import {
  applyModelSelectionRules,
  retargetTokenReport,
  scanOutputFiles,
  singleKeyRefreshScope
} from '../../electron/main/ipc'
import { scanTranslatedOutput } from '../../electron/shared/outputSanity'
import {
  buildTranscribeArgs,
  buildTranslateArgs,
  ensureUtf8Subtitle,
  orderKeysByValidity
} from '../../electron/main/pythonBridge'
import {
  activeKeySlots,
  forgetSlotEvidence,
  keyRoles,
  orderKeySlots,
  reindexEvidenceAfterRemoval
} from '../../electron/shared/keyOrder'
import { RATE_LIMITS_URL, lookupFreeTier, paidQuotaTooltip } from '../../src/data/freeTier'
import {
  HEAD_LINES,
  TAIL_LINES,
  appendLogLine,
  readRetryState,
  retryIsCurrent,
  terminalState,
  type LogBlock,
  type LogGap,
  type LogRow
} from '../../src/lib/logView'
import {
  effectiveThinkingLevel,
  modelCapabilities,
  samplingDefaults
} from '../../electron/shared/modelCaps'
import { valueOnBlur, valueWhileTyping, type NumberFieldRules } from '../../src/lib/numberField'
import type { ModelInfo, SlotFetchResult, TranslateArgs } from '../../electron/shared/types'

// ── harness ────────────────────────────────────────────────────────────────────

let failures = 0
let passes = 0
let group = ''

function section(name: string): void {
  group = name
  console.log(`\n=== ${name} ===`)
}

function check(name: string, ok: boolean, detail?: string): void {
  if (ok) {
    passes++
    console.log(`  PASS  ${name}`)
  } else {
    failures++
    console.log(`  FAIL  ${name}${detail ? `\n        ${detail}` : ''} [${group}]`)
  }
}

function eq<T>(name: string, actual: T, expected: T): void {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  check(name, a === e, a === e ? undefined : `expected ${e}\n        actual   ${a}`)
}

/** Replay a run's output through the panel's collapser, one line at a time as it arrives. */
function feedLog(lines: string[]): LogRow[] {
  let rows: LogRow[] = []
  for (const l of lines) rows = appendLogLine(rows, l)
  return rows
}

// ── fixtures ───────────────────────────────────────────────────────────────────

const CTX: MigrationContext = {
  defaultModelId: DEFAULT_MODEL_ID,
  defaults: { customGenerationParams: false, resumeContextSize: 50, modelNeedsVerification: false }
}

const ALIAS_RE = /-latest$/

function pristineProfile(): Record<string, unknown> {
  return {
    schemaVersion: 0,
    model: DEFAULT_MODEL_ID,
    modelNeedsVerification: false,
    customGenerationParams: false,
    resumeContextSize: 50,
    apiKeys: [''],
    apiKeyTiers: ['free'],
    apiKeyValid: [null],
    apiKeyError: [''],
    cachedModels: DEFAULT_MODELS.map((m) => ({ ...m }))
  }
}

// ── G1: migration fixtures ─────────────────────────────────────────────────────

section('G1 — migration fixtures (F1-F8, F3b)')

// F1: pristine defaults. The chain must be a no-op apart from the version bump.
{
  const before = pristineProfile()
  const res = migrateSettings(before, CTX)
  eq('F1 schemaVersion reaches target', res.settings.schemaVersion, CURRENT_SCHEMA_VERSION)
  const beforeSansVersion = { ...before, schemaVersion: CURRENT_SCHEMA_VERSION }
  eq('F1 no field altered', res.settings, beforeSansVersion)
}

// F2: legacy scalar validity/error fields.
{
  const before = { ...pristineProfile(), apiKeys: ['KEY-A', 'KEY-B'], apiKeyValid: true, apiKeyError: 'boom' }
  const res = migrateSettings(before, CTX)
  eq('F2 apiKeyValid coerced to array', res.settings.apiKeyValid, [true])
  eq('F2 apiKeyError coerced to array', res.settings.apiKeyError, ['boom'])
  eq('F2 API keys untouched', res.settings.apiKeys, ['KEY-A', 'KEY-B'])
}

// F3: alias model + 9 cached models of which 3 are aliases.
{
  const cached = [
    { id: 'gemini-flash-lite-latest', label: 'Flash Lite Latest' },
    { id: 'gemini-flash-latest', label: 'Flash Latest' },
    { id: 'gemini-pro-latest', label: 'Pro Latest' },
    { id: 'gemini-3.5-flash', label: 'Flash 3.5' },
    { id: 'gemini-3.1-flash-lite', label: 'Flash Lite 3.1' },
    { id: 'gemini-3.1-pro', label: 'Pro 3.1' },
    { id: 'gemini-2.5-flash', label: 'Flash 2.5' },
    { id: 'gemini-2.5-flash-lite', label: 'Flash Lite 2.5' },
    { id: 'gemini-2.5-pro', label: 'Pro 2.5' }
  ]
  const res = migrateSettings({ ...pristineProfile(), model: 'gemini-flash-lite-latest', cachedModels: cached }, CTX)
  const model = res.settings.model as string
  check('F3 model remapped away from the alias', model !== 'gemini-flash-lite-latest')
  check('F3 remapped model is NOT itself an alias (5a.0 guard)', !ALIAS_RE.test(model), `model=${model}`)
  eq('F3 flagged for verification', res.settings.modelNeedsVerification, true)
  const kept = res.settings.cachedModels as { id: string }[]
  eq('F3 exactly the 3 alias entries removed', kept.length, 6)
  check('F3 no alias survives in the cache', kept.every((m) => !ALIAS_RE.test(m.id)))
  check(
    'F3 the other 6 preserved',
    ['gemini-3.5-flash', 'gemini-3.1-flash-lite', 'gemini-3.1-pro', 'gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-2.5-pro'].every(
      (id) => kept.some((m) => m.id === id)
    )
  )
}

// F3b: cachedModels absent entirely, so electron-store hands back `defaults`.
{
  const profile = pristineProfile()
  delete profile.cachedModels
  const res = migrateSettings(profile, CTX)
  const effective = (res.settings.cachedModels as { id: string }[] | undefined) ?? DEFAULT_MODELS
  check('F3b seed list contains no alias', effective.every((m) => !ALIAS_RE.test(m.id)))
  check('F3b DEFAULT_MODEL_ID is not an alias', !ALIAS_RE.test(DEFAULT_MODEL_ID))
}

// F4: a suspicious id in the cache must not wipe the rest (the C2 regression).
{
  const cached = [
    { id: 'gemini-2.0-flash', label: 'Flash 2.0' },
    { id: 'gemini-3.1-flash-lite', label: 'Flash Lite 3.1' },
    { id: 'gemini-2.5-pro', label: 'Pro 2.5' }
  ]
  const res = migrateSettings({ ...pristineProfile(), cachedModels: cached }, CTX)
  const kept = res.settings.cachedModels as { id: string }[]
  eq('F4 cache not wiped', kept.length, 3)
  check('F4 all ids preserved', cached.every((c) => kept.some((k) => k.id === c.id)))
}

// F5: idempotency — a second pass must change nothing.
{
  const first = migrateSettings({ ...pristineProfile(), model: 'gemini-flash-lite-latest' }, CTX)
  const second = migrateSettings(first.settings, CTX)
  eq('F5 second pass is a no-op', second.settings, first.settings)
  eq('F5 second pass reports no change', second.changed, false)
}

// F6: downgrade guard.
{
  const profile = { ...pristineProfile(), schemaVersion: 99, mysteryField: 'from-the-future' }
  const res = migrateSettings(profile, CTX)
  eq('F6 downgrade detected', res.downgrade, true)
  eq('F6 nothing written', res.changed, false)
  eq('F6 profile returned untouched', res.settings, profile)
}

// F7: five populated keys survive.
{
  const keys = ['K1', 'K2', 'K3', 'K4', 'K5']
  const res = migrateSettings({ ...pristineProfile(), apiKeys: keys }, CTX)
  eq('F7 all five keys preserved', res.settings.apiKeys, keys)
}

// F8: the defanged M1 — a real model id must NOT be replaced.
{
  const res = migrateSettings({ ...pristineProfile(), model: 'gemini-2.0-flash' }, CTX)
  eq('F8 model unchanged', res.settings.model, 'gemini-2.0-flash')
  eq('F8 flagged for verification only', res.settings.modelNeedsVerification, true)
}

// ── G1b: F9 provenance backfill ────────────────────────────────────────────────

section('G1b — fixture F9 (provenance backfill)')
{
  const cached = [
    { id: 'gemini-3.1-flash-lite', label: 'Gemini Flash Lite 3.1' },
    { id: 'gemini-2.5-pro', label: 'Gemini Pro 2.5', source: 'live', availableOn: [0] }
  ]
  const res = migrateSettings({ ...pristineProfile(), cachedModels: cached }, CTX)
  const out = res.settings.cachedModels as ModelInfo[]
  eq('F9 legacy entry backfilled as seed', out[0].source, 'seed')
  eq('F9 legacy entry availability empty', out[0].availableOn, [])
  eq('F9 id preserved', out[0].id, 'gemini-3.1-flash-lite')
  eq('F9 label preserved', out[0].label, 'Gemini Flash Lite 3.1')
  eq('F9 existing provenance untouched', out[1].source, 'live')
  eq('F9 existing availability untouched', out[1].availableOn, [0])
}

// ── version ordering and default selection ─────────────────────────────────────

section('C24 — tuple version ordering and default selection')
{
  eq('3.10 beats 3.9', compareVersions({ major: 3, minor: 10 }, { major: 3, minor: 9 }) > 0, true)
  eq('4.0 beats 3.10', compareVersions({ major: 4, minor: 0 }, { major: 3, minor: 10 }) > 0, true)
  eq('3.1 equals 3.1', compareVersions({ major: 3, minor: 1 }, { major: 3, minor: 1 }), 0)

  const ids = ['gemini-3.9-flash-lite', 'gemini-3.10-flash-lite', 'gemini-3.10-pro']
  const models = buildModelList(ids, { 'gemini-3.9-flash-lite': [0], 'gemini-3.10-flash-lite': [0], 'gemini-3.10-pro': [0] })
  eq('default picks 3.10, not 3.9', resolveDefaultModel(models), 'gemini-3.10-flash-lite')

  const withPreview = buildModelList(['gemini-4.0-flash-lite-preview', 'gemini-3.10-flash-lite'], {
    'gemini-4.0-flash-lite-preview': [0],
    'gemini-3.10-flash-lite': [0]
  })
  eq('preview never becomes the default', resolveDefaultModel(withPreview), 'gemini-3.10-flash-lite')
  check('preview is still offered', withPreview.some((m) => m.id === 'gemini-4.0-flash-lite-preview'))
  check(
    'preview is visibly marked',
    withPreview.find((m) => m.id === 'gemini-4.0-flash-lite-preview')!.label.toLowerCase().includes('preview')
  )

  const flashOnly = buildModelList(['gemini-3.1-flash', 'gemini-3.1-pro'], {
    'gemini-3.1-flash': [0],
    'gemini-3.1-pro': [0]
  })
  eq('falls back to newest flash when no lite exists', resolveDefaultModel(flashOnly), 'gemini-3.1-flash')
  eq('empty input yields null', resolveDefaultModel([]), null)

  const aliasFiltered = buildModelList(['gemini-flash-lite-latest', 'gemini-3.1-flash-lite'], {})
  check('alias ids never enter the list', aliasFiltered.every((m) => !ALIAS_RE.test(m.id)))

  const seeded = buildModelList([], {})
  check('no live evidence falls back to the seed', seeded.length > 0)
  check('seed entries are marked as seed', seeded.every((m) => m.source === 'seed'))
}

// ── refresh outcome classification ─────────────────────────────────────────────

section('Step 3b — refresh outcome and runnable set')
{
  const slot = (s: number, ok: boolean, ids: string[]): SlotFetchResult => ({ slot: s, queried: true, ok, ids })

  const all = summarizeRefresh([slot(0, true, ['a', 'b']), slot(1, true, ['a'])], [0, 1])
  eq('both answered -> allComplete', all.refreshOutcome, 'allComplete')
  eq('union is every id seen', all.unionIds.sort(), ['a', 'b'])
  eq('runnable is the intersection over the active set', all.runnableIds, ['a'])

  const active = summarizeRefresh(
    [slot(0, true, ['a']), slot(1, true, ['a']), slot(2, false, [])],
    [0, 1]
  )
  eq('stale reserve -> activeComplete', active.refreshOutcome, 'activeComplete')

  const partial = summarizeRefresh([slot(0, true, ['a']), slot(1, false, [])], [0, 1])
  eq('an active slot failing -> partial', partial.refreshOutcome, 'partial')

  const failed = summarizeRefresh([slot(0, false, []), slot(1, false, [])], [0, 1])
  eq('nothing answered -> failed', failed.refreshOutcome, 'failed')
  eq('failed refresh returns no models (never the seed)', failed.models.length, 0)

  const single = summarizeRefresh([slot(0, true, ['a', 'b'])], [0])
  eq('one key -> activeComplete counts as allComplete', single.refreshOutcome, 'allComplete')
  eq('one key runnable set is that key list', single.runnableIds.sort(), ['a', 'b'])

  const skipped = summarizeRefresh(
    [slot(0, true, ['a']), { slot: 1, queried: false, ok: false, ids: [] }],
    [0]
  )
  eq('an empty slot is not counted as a failure', skipped.refreshOutcome, 'allComplete')
}

// ── the three-case apply rule ──────────────────────────────────────────────────

section('C25/C29/C30/C32/C33/C34/C35/C36 — model selection rules')
{
  const live = (id: string, on: number[]): ModelInfo => ({ id, label: id, source: 'live', availableOn: on })
  const seed = (id: string): ModelInfo => ({ id, label: id, source: 'seed', availableOn: [] })

  // Fresh install: nothing to protect.
  {
    const next = { models: [live('gemini-3.1-flash-lite', [0])], unionIds: ['gemini-3.1-flash-lite'], runnableIds: ['gemini-3.1-flash-lite'], outcome: 'allComplete' as const }
    const r = applyModelSelectionRules('', [], next)
    eq('fresh install adopts the computed default', r.model, 'gemini-3.1-flash-lite')
    eq('fresh install counts as a change', r.changed, true)
  }

  // C25: proven absent after an allComplete refresh -> reset. A seed entry must not suppress it.
  {
    const prev = [seed('gemini-9.9-ghost'), live('gemini-3.1-flash-lite', [0])]
    const next = { models: [live('gemini-3.2-flash-lite', [0])], unionIds: ['gemini-3.2-flash-lite'], runnableIds: ['gemini-3.2-flash-lite'], outcome: 'allComplete' as const }
    const r = applyModelSelectionRules('gemini-9.9-ghost', prev, next)
    eq('C25 proven-absent model is reset', r.model, 'gemini-3.2-flash-lite')
    eq('C25 reset is reported', r.changed, true)
  }

  // C29: in the union but not the intersection -> PRESERVED, with a warning.
  {
    const prev = [live('gemini-3.1-pro', [0])]
    const next = { models: [live('gemini-3.1-pro', [0]), live('gemini-3.1-flash-lite', [0, 1])], unionIds: ['gemini-3.1-pro', 'gemini-3.1-flash-lite'], runnableIds: ['gemini-3.1-flash-lite'], outcome: 'allComplete' as const }
    const r = applyModelSelectionRules('gemini-3.1-pro', prev, next)
    eq('C29 selection preserved', r.model, 'gemini-3.1-pro')
    eq('C29 no change recorded', r.changed, false)
    check('C29 warns about the fallback key', r.notice.length > 0)
  }

  // C30: a member of the active set failed -> preserve everything, no auto-advance.
  {
    const prev = [live('gemini-3.1-pro', [0])]
    const next = { models: [live('gemini-3.2-flash-lite', [0])], unionIds: ['gemini-3.2-flash-lite'], runnableIds: ['gemini-3.2-flash-lite'], outcome: 'partial' as const }
    const r = applyModelSelectionRules('gemini-3.1-pro', prev, next)
    eq('C30 selection preserved on a partial refresh', r.model, 'gemini-3.1-pro')
    eq('C30 no reset', r.changed, false)
    check('C30 staleness is surfaced', r.notice.length > 0)
  }

  // C32/C34/C36: auto-advance fires at the activeComplete bar.
  {
    const prev = [live('gemini-3.1-flash-lite', [0, 1])]
    const next = { models: [live('gemini-3.2-flash-lite', [0, 1])], unionIds: ['gemini-3.2-flash-lite'], runnableIds: ['gemini-3.2-flash-lite'], outcome: 'activeComplete' as const }
    const r = applyModelSelectionRules('gemini-3.1-flash-lite', prev, next)
    eq('C32 auto-advance fires despite a dead reserve', r.model, 'gemini-3.2-flash-lite')
    eq('C32 change reported', r.changed, true)
  }

  // C33: stored model missing while allComplete is unreachable -> warn, never reset.
  {
    const prev = [live('gemini-3.1-pro', [0])]
    const next = { models: [live('gemini-3.2-flash-lite', [0])], unionIds: ['gemini-3.2-flash-lite'], runnableIds: ['gemini-3.2-flash-lite'], outcome: 'activeComplete' as const }
    const r = applyModelSelectionRules('gemini-3.1-pro', prev, next)
    eq('C33 no reset without allComplete', r.model, 'gemini-3.1-pro')
    eq('C33 no change', r.changed, false)
  }

  // C35: one key, stored model absent, refresh succeeded -> reset DOES fire.
  {
    const prev = [live('gemini-3.1-pro', [0])]
    const next = { models: [live('gemini-3.2-flash-lite', [0])], unionIds: ['gemini-3.2-flash-lite'], runnableIds: ['gemini-3.2-flash-lite'], outcome: 'allComplete' as const }
    const r = applyModelSelectionRules('gemini-3.1-pro', prev, next)
    eq('C35 single-key reset fires', r.model, 'gemini-3.2-flash-lite')
  }

  // An allComplete refresh that returned nothing is a bug, not a mass withdrawal.
  {
    const prev = [live('gemini-3.1-pro', [0])]
    const next = { models: [], unionIds: [], runnableIds: [], outcome: 'allComplete' as const }
    const r = applyModelSelectionRules('gemini-3.1-pro', prev, next)
    eq('empty union never triggers a reset', r.model, 'gemini-3.1-pro')
    eq('empty union is not a change', r.changed, false)
  }

  // Auto-advance still works when the previous default was a flash (no lite existed).
  {
    const prev = [live('gemini-3.1-flash', [0]), live('gemini-3.1-pro', [0])]
    const next = { models: [live('gemini-3.2-flash-lite', [0])], unionIds: ['gemini-3.2-flash-lite'], runnableIds: ['gemini-3.2-flash-lite'], outcome: 'activeComplete' as const }
    const r = applyModelSelectionRules('gemini-3.1-flash', prev, next)
    eq('a flash-based previous default still advances', r.model, 'gemini-3.2-flash-lite')
  }

  // …but a "default" that was only the newest of a pro-only list proves nothing.
  {
    const prev = [live('gemini-3.1-pro', [0])]
    const next = { models: [live('gemini-3.2-flash-lite', [0]), live('gemini-3.1-pro', [0])], unionIds: ['gemini-3.2-flash-lite', 'gemini-3.1-pro'], runnableIds: ['gemini-3.2-flash-lite', 'gemini-3.1-pro'], outcome: 'activeComplete' as const }
    const r = applyModelSelectionRules('gemini-3.1-pro', prev, next)
    eq('a degenerate previous default never authorises auto-advance', r.model, 'gemini-3.1-pro')
  }

  // A non-default override is preserved even when a newer model appears.
  {
    const prev = [live('gemini-3.1-flash-lite', [0]), live('gemini-3.1-pro', [0])]
    const next = { models: [live('gemini-3.2-flash-lite', [0]), live('gemini-3.1-pro', [0])], unionIds: ['gemini-3.2-flash-lite', 'gemini-3.1-pro'], runnableIds: ['gemini-3.2-flash-lite', 'gemini-3.1-pro'], outcome: 'allComplete' as const }
    const r = applyModelSelectionRules('gemini-3.1-pro', prev, next)
    eq('a deliberate override is never auto-advanced', r.model, 'gemini-3.1-pro')
  }
}

// ── pre-spawn guard ────────────────────────────────────────────────────────────

section('Step 3b — pre-spawn guard')
{
  const live = (id: string, on: number[]): ModelInfo => ({ id, label: id, source: 'live', availableOn: on })
  const seed = (id: string): ModelInfo => ({ id, label: id, source: 'seed', availableOn: [] })

  const unverified = guardModelForSpawn('gemini-3.1-flash-lite', [seed('gemini-3.1-flash-lite')], [0])
  eq('unverified cache warns but never blocks', unverified.ok, true)
  check('unverified cache explains itself', !!unverified.warning)

  const missing = guardModelForSpawn('gemini-9.9-ghost', [live('gemini-3.1-flash-lite', [0])], [0])
  eq('a model absent from a verified list is blocked', missing.ok, false)
  check('block message is actionable', (missing.error ?? '').includes('Fetch Models'))

  const partial = guardModelForSpawn('gemini-3.1-pro', [live('gemini-3.1-pro', [0])], [0, 1])
  eq('present on only one active key is allowed', partial.ok, true)
  check('…but warned about', !!partial.warning)

  const fine = guardModelForSpawn('gemini-3.1-pro', [live('gemini-3.1-pro', [0, 1])], [0, 1])
  eq('fully available model passes silently', fine.ok && !fine.warning, true)
}

// ── key ordering ───────────────────────────────────────────────────────────────

section('C16/C17/C28/C36 — key ranking')
{
  const slots = [
    { index: 0, valid: false, tier: 'free' },
    { index: 1, valid: true, tier: 'paid' },
    { index: 2, valid: null, tier: 'free' },
    { index: 3, valid: true, tier: 'free' }
  ]
  eq('invalid slots are dropped, valid first', orderKeySlots(slots), [1, 3, 2])
  eq('active set is the first two', activeKeySlots(slots), [1, 3])
  const roles = keyRoles(slots)
  eq('roles follow the ranking', [roles.get(1), roles.get(3), roles.get(2), roles.get(0)], [
    'primary',
    'fallback',
    'reserve',
    undefined
  ])

  const onlyInvalid = [{ index: 0, valid: false, tier: 'free' }]
  eq('a single invalid key is still used as a last resort', orderKeySlots(onlyInvalid), [0])

  // C36: one valid key plus invalid reserves => a ONE-slot active set.
  const oneValid = [
    { index: 0, valid: true, tier: 'free' },
    { index: 1, valid: false, tier: 'free' },
    { index: 2, valid: false, tier: 'free' }
  ]
  eq('C36 active set has one member', activeKeySlots(oneValid).length, 1)
}

// ── VAL-2: availability evidence follows the key, not the index ────────────────

section('VAL-2 — slot evidence is invalidated when a key changes')
{
  const live = (id: string, on: number[]): ModelInfo => ({ id, label: id, source: 'live', availableOn: on })
  const cache = (): ModelInfo[] => [
    live('on-both', [0, 1]),
    live('slot0-only', [0]),
    live('slot1-only', [1]),
    { id: 'seeded', label: 'seeded', source: 'seed', availableOn: [] }
  ]

  const edited = forgetSlotEvidence(cache(), 0)
  eq('editing a key drops only that slot', edited[0].availableOn, [1])
  eq('a model proven only by the edited key loses its evidence', edited[1].availableOn, [])
  eq('…and degrades to unverified rather than vanishing', edited[1].source, 'seed')
  eq('the model list itself is never shortened', edited.length, 4)
  eq('evidence from other slots survives', edited[2].availableOn, [1])
  eq('editing is idempotent', forgetSlotEvidence(edited, 0), edited)

  // The guard is the reason this matters: before the fix it read the stale [0] as proof.
  const guarded = guardModelForSpawn('slot0-only', edited, [0])
  eq('the guard no longer trusts evidence from a replaced key', !!guarded.warning || !guarded.ok, true)

  const removed = reindexEvidenceAfterRemoval(cache(), 0)
  eq('removing a key renumbers the slots above it', removed[0].availableOn, [0])
  eq('evidence that belonged to the removed key is gone', removed[1].source, 'seed')
  eq('former slot 1 evidence now reads as slot 0', removed[2].availableOn, [0])

  const removedLast = reindexEvidenceAfterRemoval(cache(), 1)
  eq('removing a higher slot leaves lower ones untouched', removedLast[0].availableOn, [0])
  eq('seed entries are never rewritten', removedLast[3].source, 'seed')
}

// ── VAL-4: an unconfigured key may not authorise anything ──────────────────────

section('VAL-4 — single-key refresh scope')
{
  const configured = ['KEY-A', 'KEY-B']

  const known = singleKeyRefreshScope(configured, 'KEY-A', ['gemini-3.1-flash-lite'])
  eq('a configured key is authoritative', known.authoritative, true)
  eq('every configured slot is represented', known.slots.length, 2)
  eq('the key that was not asked is recorded as unanswered', known.slots[1].ok, false)
  eq(
    'so one answer cannot claim a complete scan',
    summarizeRefresh(known.slots, known.activeSlots).refreshOutcome,
    'partial'
  )

  const stranger = singleKeyRefreshScope(configured, 'KEY-UNKNOWN', ['gemini-3.1-flash-lite'])
  eq('a key that is not configured is NOT authoritative', stranger.authoritative, false)
  // It still summarises as allComplete over its manufactured one-slot view — which is
  // exactly why the flag exists rather than a weaker outcome: the caller must refuse it.
  eq(
    'its summary alone would otherwise read as the strongest evidence bar',
    summarizeRefresh(stranger.slots, stranger.activeSlots).refreshOutcome,
    'allComplete'
  )

  const single = singleKeyRefreshScope(['KEY-A'], 'KEY-A', ['gemini-3.1-flash-lite'])
  eq('the supported one-configured-key path still completes', single.authoritative, true)
  eq(
    'and is allowed to be authoritative',
    summarizeRefresh(single.slots, single.activeSlots).refreshOutcome,
    'allComplete'
  )
}

// ── DOC-1: rate-limit honesty ──────────────────────────────────────────────────

section('Step 8b — TierInfo provenance')
{
  // Google withdrew its per-model free-tier table (verified 2026-08-18), so no figure can
  // be sourced officially and none is shipped. These gates assert that absence, because
  // the failure mode is a plausible number nobody can tell apart from a verified one.
  eq('a family with no published table returns unknown', lookupFreeTier('gemini-3.1-flash-lite').kind, 'unknown')
  eq('…including Flash', lookupFreeTier('gemini-3.5-flash').kind, 'unknown')
  eq('a non-Gemini id returns unknown', lookupFreeTier('some-other-model').kind, 'unknown')
  eq('an unseen Gemini id returns unknown, never a family guess', lookupFreeTier('gemini-4.0-flash').kind, 'unknown')

  const pro = lookupFreeTier('gemini-2.5-pro')
  eq('Pro reports NO free tier rather than numbers', pro.kind, 'none')
  check('…and attributes that claim', pro.kind === 'none' && !!pro.asOf && !!pro.source)

  const liteTip = paidQuotaTooltip('gemini-3.1-flash-lite', 'Lite')
  const proTip = paidQuotaTooltip('gemini-2.5-pro', 'Gemini Pro 2.5')
  check('no tooltip quotes an RPM figure', !/\d+\s*RPM/.test(liteTip) && !/\d+\s*RPM/.test(proTip))
  check('no tooltip quotes an RPD or TPM figure', !/\d[\d,]*\s*(RPD|TPM)/.test(liteTip + proTip))
  check('the Pro tooltip says there is no free tier', /no free tier/i.test(proTip))
  check('every tooltip points at the live source', liteTip.includes(RATE_LIMITS_URL))
  check('and at AI Studio for the account-specific value', /aistudio\.google\.com/.test(liteTip))
  check('and states the quota is per project', /per google cloud project/i.test(liteTip))
}

// ── argv construction ──────────────────────────────────────────────────────────

section('C16/C17/C22/C22b + Steps 6/7/9 — argv')

function baseArgs(over: Partial<TranslateArgs> = {}): TranslateArgs {
  return {
    inputFile: 'C:/in.srt',
    sourceLang: 'auto',
    targetLang: 'he',
    model: 'gemini-3.1-flash-lite',
    apiKeys: ['KEY-A'],
    batchSize: 100,
    batchContext: true,
    customGenerationParams: false,
    temperature: 1,
    topP: 0.95,
    topK: null,
    thinkingLevel: 'low',
    thinkingBudget: 512,
    serviceTier: 'standard',
    paidQuota: false,
    disableStreaming: false,
    writeTokenReport: false,
    progressLog: false,
    thoughtsLog: false,
    ...over
  }
}

function flagValue(args: string[], flag: string): string | null {
  const i = args.indexOf(flag)
  return i === -1 ? null : args[i + 1]
}

{
  setSettings({
    apiKeys: ['KEY-A', 'KEY-B', 'KEY-C'],
    apiKeyValid: [false, true, true],
    apiKeyTiers: ['paid', 'paid', 'free']
  })

  const args = buildTranslateArgs(baseArgs({ apiKeys: ['KEY-A', 'KEY-B', 'KEY-C'] }), 'C:/out.srt')
  eq('C17 the healthiest valid key is promoted to -k', flagValue(args, '-k'), 'KEY-B')
  eq('C17 the next valid key becomes -k2', flagValue(args, '-k2'), 'KEY-C')
  eq('C16 only two keys are ever emitted', args.filter((a) => a === '-k' || a === '-k2').length, 2)
  check('C17 the invalid key is not passed at all', !args.includes('KEY-A'))
  eq('tier follows the PROMOTED primary, not slot 0', args.includes('--paid-quota'), true)

  const ordered = orderKeysByValidity(['KEY-A', 'KEY-B', 'KEY-C'])
  eq('C28 displayed ranking matches the emitted argv', [ordered.keys[0], ordered.keys[1]], ['KEY-B', 'KEY-C'])

  setSettings({ apiKeys: ['KEY-A'], apiKeyValid: [true], apiKeyTiers: ['free'] })
  const single = buildTranslateArgs(baseArgs(), 'C:/out.srt')
  eq('a single key emits -k only', single.includes('-k2'), false)
  eq('free tier omits --paid-quota', single.includes('--paid-quota'), false)
}

{
  // Step 6: generation parameters are omitted unless explicitly enabled.
  const off = buildTranslateArgs(baseArgs(), 'C:/out.srt')
  check('temperature omitted when custom params are off', !off.includes('--temperature'))
  check('top-p omitted when custom params are off', !off.includes('--top-p'))
  check('top-k omitted when custom params are off', !off.includes('--top-k'))

  const on = buildTranslateArgs(
    baseArgs({ customGenerationParams: true, temperature: 0.7, topP: 0.8, topK: 40 }),
    'C:/out.srt'
  )
  eq('temperature emitted when enabled', flagValue(on, '--temperature'), '0.7')
  eq('top-p emitted when enabled', flagValue(on, '--top-p'), '0.8')
  eq('top-k emitted when enabled', flagValue(on, '--top-k'), '40')

  // The zero trap: the engine's truthiness test would silently drop these.
  const zero = buildTranslateArgs(
    baseArgs({ customGenerationParams: true, temperature: 0, topP: 0, topK: 0 }),
    'C:/out.srt'
  )
  check('a zero value is never emitted as if it applied', !zero.includes('--temperature') && !zero.includes('--top-p') && !zero.includes('--top-k'))

  const transcribe = buildTranscribeArgs(
    {
      mediaFile: 'C:/a.mp4',
      outputFile: 'C:/a.srt',
      targetLang: '',
      model: 'gemini-3.1-flash-lite',
      apiKeys: ['KEY-A'],
      thinkingLevel: 'low',
      thinkingBudget: 512,
      customGenerationParams: true,
      temperature: 0.5,
      topP: 0.9,
      topK: null
    },
    'C:/a.srt'
  )
  eq('transcribe honours the same toggle', flagValue(transcribe, '--temperature'), '0.5')
}

{
  // G5a (REP-6): a model that has deprecated these must never receive them, however the
  // toggle is set. This is the branch that stops a stored configuration from failing every
  // run the day Google ships a model that returns 400 instead of ignoring them.
  const wanted = { customGenerationParams: true, temperature: 0.7, topP: 0.8, topK: 40 }
  const sampled = (a: string[]): string[] =>
    ['--temperature', '--top-p', '--top-k'].filter((f) => a.includes(f))

  eq(
    'G5a a model at the boundary gets none of the three',
    sampled(buildTranslateArgs(baseArgs({ ...wanted, model: 'gemini-3.6-flash' }), 'C:/o.srt')),
    []
  )
  eq(
    'G5a Flash-Lite at 3.5 is named in the deprecation and gets none',
    sampled(buildTranslateArgs(baseArgs({ ...wanted, model: 'gemini-3.5-flash-lite' }), 'C:/o.srt')),
    []
  )
  eq(
    'G5a plain Flash at 3.5 is not, and still gets all three',
    sampled(buildTranslateArgs(baseArgs({ ...wanted, model: 'gemini-3.5-flash' }), 'C:/o.srt')),
    ['--temperature', '--top-p', '--top-k']
  )
  // The reachable trigger: a profile stored by an older build still names 3.5 Pro, and the
  // toggle is on. Being at 3.5 and not Lite is NOT the same as being exempt.
  eq(
    'G5a 3.5 Pro gets none of them either',
    sampled(buildTranslateArgs(baseArgs({ ...wanted, model: 'gemini-3.5-pro' }), 'C:/o.srt')),
    []
  )
  eq(
    'G5a a model we have never heard of is treated as a future one',
    sampled(buildTranslateArgs(baseArgs({ ...wanted, model: 'gemini-flash-latest' }), 'C:/o.srt')),
    []
  )
  // The same rule, on the other command. generationParamArgs feeds both, and a fix that
  // covered only translation would leave transcription sending the flags that fail.
  const txDeprecated = buildTranscribeArgs(
    {
      mediaFile: 'C:/a.mp4',
      outputFile: 'C:/a.srt',
      targetLang: '',
      model: 'gemini-3.7-flash',
      apiKeys: ['KEY-A'],
      thinkingLevel: 'low',
      thinkingBudget: 512,
      customGenerationParams: true,
      temperature: 0.5,
      topP: 0.9,
      topK: 40
    },
    'C:/a.srt'
  )
  eq('G5a transcribe withholds them for the same models', sampled(txDeprecated), [])
  check(
    'G5a withholding sampling flags leaves the rest of argv intact',
    txDeprecated.includes('--thinking-level') && flagValue(txDeprecated, '-m') === 'gemini-3.7-flash'
  )
}

{
  // C22 / C22b: resume flags.
  const atDefault = buildTranslateArgs(baseArgs({ resumeContextSize: 50 }), 'C:/out.srt')
  check('C22 flag omitted at the engine default', !atDefault.includes('--resume-context-size'))
  const changed = buildTranslateArgs(baseArgs({ resumeContextSize: 10 }), 'C:/out.srt')
  eq('C22 flag emitted when it differs', flagValue(changed, '--resume-context-size'), '10')
  const absent = buildTranslateArgs(baseArgs(), 'C:/out.srt')
  check('C22 an unset value behaves like the default', !absent.includes('--resume-context-size'))

  const resumeExclusive = (a: string[]): boolean =>
    a.includes('--resume') !== a.includes('--no-resume')
  check('C22b exactly one resume flag on a fresh run', resumeExclusive(absent))
  check('C22b exactly one resume flag on a resumed run', resumeExclusive(buildTranslateArgs(baseArgs({ resumeFrom: 42 }), 'C:/out.srt')))

  check('C19 --skip-upgrade is always present', absent.includes('--skip-upgrade'))
}

{
  // Step 7: thinking flags must match what the engine will actually honour.
  const lvl = buildTranslateArgs(baseArgs({ model: 'gemini-3.1-flash-lite', thinkingLevel: 'medium' }), 'C:/o.srt')
  eq('3.x uses --thinking-level', flagValue(lvl, '--thinking-level'), 'medium')
  check('3.x never receives --thinking-budget', !lvl.includes('--thinking-budget'))

  const disabled3x = buildTranslateArgs(baseArgs({ model: 'gemini-3.1-flash-lite', thinkingLevel: 'disabled' }), 'C:/o.srt')
  eq('3.x cannot disable thinking; coerced to minimal', flagValue(disabled3x, '--thinking-level'), 'minimal')
  check('3.x never receives --no-thinking', !disabled3x.includes('--no-thinking'))

  const pro3 = buildTranslateArgs(baseArgs({ model: 'gemini-3.1-pro', thinkingLevel: 'minimal' }), 'C:/o.srt')
  eq('3 Pro coerces minimal to low', flagValue(pro3, '--thinking-level'), 'low')

  const budget = buildTranslateArgs(baseArgs({ model: 'gemini-2.5-flash', thinkingBudget: 4096 }), 'C:/o.srt')
  eq('2.5 uses --thinking-budget', flagValue(budget, '--thinking-budget'), '4096')

  const disabled25 = buildTranslateArgs(baseArgs({ model: 'gemini-2.5-flash', thinkingLevel: 'disabled' }), 'C:/o.srt')
  check('2.5 non-pro honours --no-thinking', disabled25.includes('--no-thinking'))

  const pro25 = buildTranslateArgs(baseArgs({ model: 'gemini-2.5-pro', thinkingBudget: 0 }), 'C:/o.srt')
  eq('2.5 Pro budget is clamped to its floor', flagValue(pro25, '--thinking-budget'), '128')

  const legacy = buildTranslateArgs(baseArgs({ model: 'gemini-2.0-flash' }), 'C:/o.srt')
  check('2.0 receives no thinking flags at all', !legacy.includes('--thinking-level') && !legacy.includes('--thinking-budget') && !legacy.includes('--no-thinking'))

  eq('transcription capability matches the engine', modelCapabilities('gemini-2.0-flash').supportsTranscription, false)
  eq('2.5 can transcribe', modelCapabilities('gemini-2.5-flash').supportsTranscription, true)
  eq('3.x can transcribe', modelCapabilities('gemini-3.1-pro').supportsTranscription, true)
  eq('effective level is reported honestly', effectiveThinkingLevel('gemini-3.1-pro', 'minimal'), 'low')
}

// ── G2 (automatable half): subtitle normalisation ──────────────────────────────

section('G2 — subtitle normalisation (ASS/SRT encoding)')
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'srt-gate-subs-'))
  const write = (name: string, buf: Buffer): string => {
    const p = path.join(dir, name)
    fs.writeFileSync(p, buf)
    return p
  }

  const utf8Srt = write('plain.srt', Buffer.from('1\n00:00:01,000 --> 00:00:02,000\nHola señor\n', 'utf-8'))
  const r1 = ensureUtf8Subtitle(utf8Srt)
  eq('valid UTF-8 is passed straight through', r1.ok && r1.path === utf8Srt, true)

  const bomAss = write('styled.ass', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('[Script Info]\nTitle: Test\n', 'utf-8')]))
  const before = fs.readFileSync(bomAss)
  const r2 = ensureUtf8Subtitle(bomAss)
  check('a BOM-bearing ASS is converted', r2.ok && r2.path !== bomAss)
  if (r2.ok) {
    eq('G2 the converted copy keeps the .ass extension', path.extname(r2.path), '.ass')
    check('G2 the BOM is gone', !fs.readFileSync(r2.path).subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])))
  }
  check('G2 the user original is byte-identical afterwards', fs.readFileSync(bomAss).equals(before))

  const cp1252Ass = write('legacy.ass', Buffer.from([0x5b, 0x53, 0x63, 0x72, 0x69, 0x70, 0x74, 0x5d, 0x0a, 0xe9, 0xe8, 0x0a]))
  const assBefore = fs.readFileSync(cp1252Ass)
  const r3 = ensureUtf8Subtitle(cp1252Ass)
  eq('G2 a non-UTF-8 ASS is refused, not guessed', r3.ok, false)
  if (!r3.ok) check('G2 the refusal tells the user what to do', r3.error.toLowerCase().includes('utf-8'))
  check('G2 the refused file is left byte-identical', fs.readFileSync(cp1252Ass).equals(assBefore))

  const cp1252Srt = write('legacy.srt', Buffer.from([0x31, 0x0a, 0xe9, 0xe8, 0x0a]))
  const srtBefore = fs.readFileSync(cp1252Srt)
  const r4 = ensureUtf8Subtitle(cp1252Srt)
  check('a non-UTF-8 SRT is still converted (unchanged behaviour)', r4.ok && r4.path !== cp1252Srt)
  if (r4.ok) eq('the converted SRT keeps the .srt extension', path.extname(r4.path), '.srt')
  check('the original SRT is byte-identical', fs.readFileSync(cp1252Srt).equals(srtBefore))

  const utf16 = write('utf16.srt', Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('1\n', 'utf16le')]))
  const r5 = ensureUtf8Subtitle(utf16)
  check('UTF-16 input is decoded rather than passed through', r5.ok && r5.path !== utf16)
}

// ── G3: output sanity (REP-16) and the token report (REP-1) ────────────────────

section('G3 — output sanity: two signals must agree before anything is said')
{
  const srt = (cues: string[]): string =>
    cues
      .map((text, i) => {
        const s = i * 2
        const stamp = (sec: number): string =>
          `00:${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')},000`
        return `${i + 1}\n${stamp(s)} --> ${stamp(s + 1)}\n${text}\n`
      })
      .join('\n')

  // Deterministic, so a fixture cannot drift between runs and quietly stop testing what it tested.
  const rand = (seed: number) => () => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }

  /** A plausible clean pair: varied lengths, occasional two-line cues, a ~0.9x expansion factor. */
  function cleanPair(count: number): { source: string[]; output: string[] } {
    const next = rand(20260821)
    const source: string[] = []
    const output: string[] = []
    for (let i = 0; i < count; i++) {
      const words = 3 + Math.floor(next() * 9)
      const twoLine = next() < 0.3
      const src = Array.from({ length: words }, (_, w) => `word${(i + w) % 97}`).join(' ')
      const out = Array.from({ length: words }, (_, w) => `tr${(i + w) % 89}`).join(' ')
      source.push(twoLine ? src.replace(' ', '\n') : src)
      output.push(twoLine ? out.replace(' ', '\n') : out)
    }
    return { source, output }
  }

  // ---- the measured fault, reproduced at the indices it was measured at ----
  const FILLER = 'ב-'
  const bad = cleanPair(736)
  const corrupted = [...bad.output]
  for (let i = 463; i < 599; i++) corrupted[i] = FILLER // cues 464..599, 136 of them
  const warnings = scanTranslatedOutput(srt(bad.source), srt(corrupted))

  check('G3 the filler run produces exactly one warning', warnings.length === 1, `got ${warnings.length}`)
  if (warnings.length === 1) {
    const w = warnings[0]
    check(`G3 the range starts at or before the first bad cue`, w.from <= 464, `from ${w.from}`)
    eq('G3 the range ends at the last bad cue', w.to, 599)
    check('G3 all three signals fired', w.signals.length === 3, w.signals.join('+'))
    check('G3 the message says the file was not altered', /exactly\s+as the engine wrote it/i.test(w.message))
  }
  eq('G3 the same file without the filler is silent', scanTranslatedOutput(srt(bad.source), srt(bad.output)).length, 0)

  // ---- each signal alone must NOT warn: this is what makes "two of three" real ----
  const only = (source: string[], output: string[]): number =>
    scanTranslatedOutput(srt(source), srt(output)).length

  // S1 alone: every translation identical, but the right length and the right shape.
  const s1Source = Array.from({ length: 200 }, (_, i) => `source line number ${i} here`)
  const s1Output = Array.from({ length: 200 }, () => 'identical translation text!')
  eq('G3 S1 alone (repeated text, normal length) says nothing', only(s1Source, s1Output), 0)

  // S2 alone: everything far too short, but all distinct and all one line like their sources.
  const s2Source = Array.from({ length: 200 }, (_, i) => `a reasonably long source sentence ${i}`)
  const s2Output = Array.from({ length: 200 }, (_, i) => `x${i}`)
  eq('G3 S2 alone (length collapse) says nothing', only(s2Source, s2Output), 0)

  // S3 alone: right length, all distinct, but every cue re-wrapped onto two lines.
  const s3Source = Array.from({ length: 200 }, (_, i) => `single line source sentence ${i}`)
  const s3Output = Array.from({ length: 200 }, (_, i) => `two line\ntranslation ${i} here`)
  eq('G3 S3 alone (re-wrapping) says nothing', only(s3Source, s3Output), 0)

  // ---- each PAIR must warn: if a signal were dead code, two of these would go quiet ----
  // Each corrupts a stretch rather than the whole file, which is both the measured fault shape and
  // what leaves S2 a clean baseline to judge against.
  const damage = (clean: string[], bad: (i: number) => string): string[] =>
    clean.map((text, i) => (i >= 60 && i < 160 ? bad(i) : text))

  const s1s2Source = Array.from({ length: 200 }, (_, i) => `a reasonably long source sentence ${i}`)
  const s1s2Clean = Array.from({ length: 200 }, (_, i) => `a plausible translated sentence ${i}`)
  check('G3 S1+S2 warns (repeated AND collapsed)', only(s1s2Source, damage(s1s2Clean, () => FILLER)) > 0)

  const s1s3Source = Array.from({ length: 200 }, (_, i) => `single line source sentence ${i}`)
  const s1s3Clean = Array.from({ length: 200 }, (_, i) => `single line translated text ${i}`)
  check(
    'G3 S1+S3 warns (repeated AND re-shaped)',
    only(s1s3Source, damage(s1s3Clean, () => 'identical two\nline translation!!')) > 0
  )

  const s2s3Source = Array.from({ length: 200 }, (_, i) => `a two line\nsource sentence ${i}`)
  const s2s3Clean = Array.from({ length: 200 }, (_, i) => `a two line\ntranslated text ${i}`)
  check('G3 S2+S3 warns (collapsed AND re-shaped)', only(s2s3Source, damage(s2s3Clean, (i) => `y${i}`)) > 0)

  // The hole the pair fixtures exposed: a file that is MOSTLY filler must still be caught, even
  // though the corrupt cues then dominate the length distribution.
  const mostly = Array.from({ length: 200 }, (_, i) => (i < 40 ? `a plausible translation ${i}` : FILLER))
  check('G3 a file that is mostly filler is still caught', only(s1s2Source, mostly) > 0)

  // ---- the false positives that would teach a user to ignore the warning ----
  const sound = Array.from({ length: 200 }, () => '♪')
  eq('G3 a file of repeated sound cues is not corruption', only(sound, sound.map(() => '♪')), 0)

  const repeatedSource = Array.from({ length: 200 }, (_, i) => (i % 2 === 0 ? 'Yes.' : `line ${i}`))
  const repeatedOutput = Array.from({ length: 200 }, (_, i) => (i % 2 === 0 ? 'כן.' : `שורה ${i}`))
  eq('G3 a legitimately repeated short phrase is not corruption', only(repeatedSource, repeatedOutput), 0)

  const untranslated = Array.from({ length: 200 }, (_, i) => `${i + 1}.`)
  eq('G3 cues left untranslated on purpose are excluded, not flagged', only(untranslated, untranslated), 0)

  // ---- the floor, and the guards ----
  const tinySource = Array.from({ length: 25 }, (_, i) => `a reasonably long source sentence ${i}`)
  eq(
    'G3 a file under the 30-cue floor is never judged',
    only(tinySource, tinySource.map(() => FILLER)),
    0
  )
  eq('G3 empty input produces nothing rather than throwing', scanTranslatedOutput('', '').length, 0)
  eq('G3 unparseable input produces nothing', scanTranslatedOutput('not a subtitle', '{}').length, 0)
  eq(
    'G3 an output missing half its cues is skipped, not guessed at',
    scanTranslatedOutput(srt(bad.source), srt(bad.output.slice(0, 100))).length,
    0
  )

  // ---- ASS, because the app translates it too ----
  const ass = (cues: string[]): string =>
    '[Script Info]\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n' +
    cues
      .map((t) => `Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,${t.replace(/\n/g, '\\N')}`)
      .join('\n')
  const assPair = cleanPair(200)
  eq('G3 a clean ASS pair is silent', scanTranslatedOutput(ass(assPair.source), ass(assPair.output)).length, 0)
  const assBad = [...assPair.output]
  for (let i = 60; i < 160; i++) assBad[i] = FILLER
  check('G3 the same fault is caught in ASS', scanTranslatedOutput(ass(assPair.source), ass(assBad)).length === 1)
}

section('G3b — the token report names the user\u2019s files (REP-1)')
{
  const engineReport = JSON.stringify(
    {
      timestamp: '2026-08-19T21:42:36.023737',
      mode: 'translate',
      model: 'gemini-3.5-flash-lite',
      output_file: 'C:\\temp\\1787164913314.srt',
      duration_seconds: 40.54,
      tokens: { prompt: 10926, thoughts: 0, output: 16413, total: 27339 },
      input_file: 'C:\\temp\\1787164913314.utf8.srt',
      target_language: 'Hebrew'
    },
    null,
    2
  )

  const rewritten = retargetTokenReport(engineReport, 'D:\\Movies\\Show.eng.srt', 'D:\\Movies\\Show_he.srt')
  const parsed = JSON.parse(rewritten) as Record<string, unknown>
  eq('G3b the output path is the file the user saved', parsed.output_file, 'D:\\Movies\\Show_he.srt')
  eq('G3b the input path is the file the user chose', parsed.input_file, 'D:\\Movies\\Show.eng.srt')
  eq('G3b the token counts are untouched', parsed.tokens, {
    prompt: 10926,
    thoughts: 0,
    output: 16413,
    total: 27339
  })
  eq('G3b every other field survives', parsed.target_language, 'Hebrew')
  eq('G3b no temp path is left anywhere in the file', /1787164913314/.test(rewritten), false)

  const noInput = JSON.parse(retargetTokenReport(engineReport, '', 'D:\\out.srt')) as Record<string, unknown>
  eq(
    'G3b an unknown source leaves the original value rather than guessing',
    noInput.input_file,
    'C:\\temp\\1787164913314.utf8.srt'
  )

  eq('G3b an unparseable report is returned untouched', retargetTokenReport('{oops', 'a', 'b'), '{oops')
  eq('G3b a JSON array is not treated as a report', retargetTokenReport('[1,2]', 'a', 'b'), '[1,2]')
}

section('G3c — the scan can never strand a finished job')
{
  // This runs on the path that delivers the terminal event, so every one of these must return an
  // empty list rather than throw. A run that ends with no `done` event is worse than any warning.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'srt-gate-scan-'))
  const missing = path.join(dir, 'nope.srt')
  const empty = path.join(dir, 'empty.srt')
  const junk = path.join(dir, 'junk.srt')
  fs.writeFileSync(empty, '')
  fs.writeFileSync(junk, 'this is not a subtitle at all')

  eq('G3c no paths at all', scanOutputFiles('', ''), [])
  eq('G3c a missing source', scanOutputFiles(missing, junk), [])
  eq('G3c a missing output', scanOutputFiles(junk, missing), [])
  eq('G3c an empty output', scanOutputFiles(junk, empty), [])
  eq('G3c an unparseable pair', scanOutputFiles(junk, junk), [])
  eq('G3c a directory where a file was expected', scanOutputFiles(dir, junk), [])
}

// ── G4: the run panel (REP-2/3/12, MAN-1/6/8) ──────────────────────────────────

section('G4 — collapsing a repeated block, and never hiding a line')
{
  /** What the panel actually shows, top to bottom. */
  const shown = (rows: LogRow[]): string[] => {
    const out: string[] = []
    for (const r of rows) {
      if (r.kind === 'block') out.push(...r.lines)
      else out.push(`<${r.hiddenLines} hidden>`)
    }
    return out
  }
  /**
   * The invariant the whole feature stands on: collapsing may only ever remove text that is
   * still on screen somewhere. An error folded away into a counter is worse than repetition.
   */
  const nothingHidden = (name: string, stream: string[], rows: LogRow[]): void => {
    const visible = new Set(shown(rows))
    const missing = [...new Set(stream)].filter((l) => !visible.has(l))
    check(
      `G4 ${name} — every distinct line still visible`,
      missing.length === 0,
      `missing: ${missing.slice(0, 3).join(' | ')}`
    )
  }

  // 1. the two cases the plan's first revision got wrong
  {
    const abab = ['A', 'B', 'A', 'B']
    const rows = feedLog(abab)
    eq('G4 A B A B collapses to one two-line block', shown(rows), ['A', 'B'])
    eq('G4 A B A B counts two', rows.length === 1 && rows[0].kind === 'block' ? rows[0].count : -1, 2)
    nothingHidden('A B A B', abab, rows)

    const abac = ['A', 'B', 'A', 'C']
    const rowsC = feedLog(abac)
    eq('G4 A B A C stays four rows', shown(rowsC), abac)
    nothingHidden('A B A C', abac, rowsC)
  }

  // 2. a progress line whose number moves must never collapse: if it does, progress is hidden
  {
    const stream = Array.from({ length: 40 }, (_, i) => `Translating batch 1: ${i + 1}/300 lines`)
    const rows = feedLog(stream)
    eq('G4 a changing progress line never collapses', shown(rows), stream)
    check(
      'G4 no counter appears on distinct lines',
      rows.every((r) => r.kind === 'block' && r.count === 1)
    )
  }

  // 3. the measured flood: an 11-line frame redrawn 900 times (REP-12)
  {
    const frame = Array.from({ length: 11 }, (_, i) => `engine message ${i + 1}`)
    const stream: string[] = []
    for (let i = 0; i < 900; i++) stream.push(...frame)
    const rows = feedLog(stream)
    eq('G4 9,900 lines collapse to one block', rows.length, 1)
    eq('G4 the block is the 11 real messages', shown(rows), frame)
    eq('G4 the counter is exact', rows[0].kind === 'block' ? rows[0].count : -1, 900)
    nothingHidden('the 9,900-line flood', stream, rows)

    // and the proof that a one-line check could not have done this
    let naive = 0
    let previous = ''
    for (const l of stream) {
      if (l !== previous) naive++
      previous = l
    }
    eq('G4 a consecutive-duplicate check would have kept every line', naive, stream.length)
  }

  // 4. the shape the engine actually produces: a message history that GROWS and is redrawn
  {
    const msgs = Array.from({ length: 12 }, (_, i) => `history line ${i + 1}`)
    const draws = [2, 2, 2, 2, 3, 2, 2, 2, 2, 2, 2, 3]
    const stream: string[] = []
    draws.forEach((d, i) => {
      for (let k = 0; k < d; k++) stream.push(...msgs.slice(0, i + 1))
    })
    eq('G4 the growing-history fixture is 173 lines', stream.length, 173)
    const rows = feedLog(stream)
    eq('G4 173 lines render as the 12 distinct messages', shown(rows), msgs)
    check(
      'G4 the block carries a climbing counter',
      rows.length === 1 && rows[0].kind === 'block' && rows[0].count > 1
    )
    nothingHidden('the growing history', stream, rows)

    // A redraw that is still arriving shows as ordinary lines until it completes — deliberately,
    // because the alternative is holding lines back on the chance that they will repeat.
    const partial = feedLog([...stream, msgs[0], msgs[1]])
    eq('G4 an in-flight redraw is visible, not withheld', shown(partial).slice(-2), [msgs[0], msgs[1]])
  }

  // 5. a repeated message that recurs with different text between occurrences
  {
    const stream = ['X', 'X', 'X', 'Y', 'X', 'X', 'X']
    const rows = feedLog(stream)
    eq('G4 an interrupted repeat keeps both texts, in order', shown(rows), ['X', 'Y', 'X'])
    nothingHidden('X Y X', stream, rows)
  }

  // 6. REP-7 was declined: the AFC notice must survive
  {
    const afc = 'Direct use of automatic function calling (AFC) is not recommended'
    const frame = ['Validating token size...', 'Token size validated. Translating...']
    const stream = [afc]
    for (let i = 0; i < 50; i++) stream.push(...frame)
    const rows = feedLog(stream)
    check('G4 the AFC notice is still visible after a flood', shown(rows).includes(afc))
    eq('G4 the flood around it still collapses', shown(rows), [afc, ...frame])
  }
}

section('G4b — the cap keeps the start-up block and says what it hid')
{
  const stream = Array.from({ length: 3000 }, (_, i) => `distinct line ${i}`)
  const rows = feedLog(stream)
  const blocks = rows.filter((r) => r.kind === 'block') as LogBlock[]
  const gaps = rows.filter((r) => r.kind === 'gap') as LogGap[]

  eq('G4b exactly one gap marker', gaps.length, 1)
  eq('G4b the head is kept, oldest first', blocks[0].lines[0], 'distinct line 0')
  eq('G4b the newest line survives', blocks[blocks.length - 1].lines[0], 'distinct line 2999')
  eq('G4b retained lines are head + tail', blocks.length, HEAD_LINES + TAIL_LINES)
  eq('G4b the marker counts what went', gaps[0].hiddenLines, 3000 - HEAD_LINES - TAIL_LINES)

  // The gap keeps its identity as more is hidden, so the row under the cursor does not jump.
  let more = rows
  for (let i = 3000; i < 3010; i++) more = appendLogLine(more, `distinct line ${i}`)
  const gap2 = more.find((r) => r.kind === 'gap') as LogGap
  eq('G4b the gap keeps its React key', gap2.seq, gaps[0].seq)
  eq('G4b and grows', gap2.hiddenLines, 3010 - HEAD_LINES - TAIL_LINES)
  eq('G4b the head is still the head', (more[0] as LogBlock).lines[0], 'distinct line 0')

  // Row identity must be unique, or React reuses the wrong DOM node.
  eq('G4b every row has a distinct key', new Set(more.map((r) => r.seq)).size, more.length)
}

section('G4c — a retry is named, never counted from redrawn lines (MAN-8)')
{
  // Five real retries of one batch, each adding three messages to a history that is redrawn
  // twenty times per cycle — the measured shape, where two retries arrived as 1,521 lines.
  const history: string[] = ['Validating token size...', 'Token size validated. Translating...']
  const stream: string[] = []
  for (let retry = 1; retry <= 5; retry++) {
    history.push(
      'Consecutive error count: 1/3',
      'Expected 100 lines, got 50.',
      'Retrying batch for lines 301-400...'
    )
    for (let draw = 0; draw < 20; draw++) stream.push(...history)
  }
  const raw = stream.filter((l) => l.startsWith('Retrying batch')).length
  check('G4c the raw stream really is inflated', raw > 200, `raw retry lines: ${raw}`)

  const rows = feedLog(stream)
  eq('G4c the batch is named', readRetryState(rows), { from: 301, to: 400 })

  // No count is claimed, on purpose: the display cannot tell "the history accumulated five
  // retries" from "one history was redrawn five times", and inventing a number here is how a
  // recovered run gets reported as a catastrophe.
  eq('G4c nothing to say before a retry', retryIsCurrent(null, 0), false)
  eq('G4c speaks while the batch is unfinished', retryIsCurrent({ from: 301, to: 400 }, 300), true)
  eq('G4c goes quiet once the run reaches the end of that batch', retryIsCurrent({ from: 301, to: 400 }, 400), false)
  eq('G4c and stays quiet after it', retryIsCurrent({ from: 301, to: 400 }, 460), false)

  // The panel must not turn a five-retry history into sixty adjacent identical blocks.
  check('G4c the redrawn storm stays readable', rows.length <= 8, `rows: ${rows.length}`)
  eq('G4c row keys stay unique', new Set(rows.map((r) => r.seq)).size, rows.length)
  check(
    'G4c row keys stay in order',
    rows.every((r, i) => i === 0 || r.seq > rows[i - 1].seq)
  )
}

section('G4d — only a user Stop reads as Stopped (MAN-1)')
{
  eq('G4d a clean run', terminalState(0), { status: 'done', statusText: 'Completed' })
  eq('G4d an engine failure', terminalState(1), { status: 'error', statusText: 'Failed' })
  eq('G4d a killed run the user asked for', terminalState(1, 'user'), {
    status: 'stopped',
    statusText: 'Stopped'
  })
  eq('G4d a Stop that happened to exit 0', terminalState(0, 'user'), {
    status: 'stopped',
    statusText: 'Stopped'
  })
  // The two FP-7 reasons exist so a system termination can never borrow the user's label.
  eq('G4d a stalled run is a failure, not a Stop', terminalState(1, 'stalled'), {
    status: 'error',
    statusText: 'Failed'
  })
  eq('G4d a refused run is a failure, not a Stop', terminalState(-1, 'guard'), {
    status: 'error',
    statusText: 'Failed'
  })
  // FP3-01: a reason outranks the exit code both ways. A run the app killed is not a success
  // just because the process it killed happened to exit cleanly.
  eq('G4d a stalled run that exited 0 is still a failure', terminalState(0, 'stalled'), {
    status: 'error',
    statusText: 'Failed'
  })
  eq('G4d a refused run that exited 0 is still a failure', terminalState(0, 'guard'), {
    status: 'error',
    statusText: 'Failed'
  })
}

// ── G5: sampling parameters and the fields that hold them (REP-4/5/6) ──────────

section('G5b — where Google’s sampling deprecation begins')
{
  const accepts = (id: string): boolean => modelCapabilities(id).acceptsSamplingParams

  // Everything before the boundary is unaffected and must keep working exactly as it did.
  eq('G5b 2.0', accepts('gemini-2.0-flash'), true)
  eq('G5b 2.5', accepts('gemini-2.5-flash'), true)
  eq('G5b 2.5 Pro', accepts('gemini-2.5-pro'), true)
  eq('G5b 3.1 Flash-Lite', accepts('gemini-3.1-flash-lite'), true)
  eq('G5b 3.1 Pro', accepts('gemini-3.1-pro'), true)

  // The boundary runs THROUGH 3.5, which is why this cannot be a major-version test.
  eq('G5b 3.5 Flash is not named', accepts('gemini-3.5-flash'), true)
  eq('G5b 3.5 Flash with the API prefix is the same model', accepts('models/gemini-3.5-flash'), true)
  eq('G5b 3.5 Flash-Lite is named', accepts('gemini-3.5-flash-lite'), false)
  eq('G5b 3.6 Flash is named', accepts('gemini-3.6-flash'), false)
  eq('G5b 3.7 Flash came after it', accepts('gemini-3.7-flash'), false)

  // At the boundary the exemption is an allowlist, not "anything that is not Lite". Google
  // names Flash-Lite and omits Flash; it says nothing at all about any other 3.5 model, and
  // silence is not permission. 3.5 Pro is reachable today — it is in SUSPICIOUS_MODEL_IDS, so
  // a stored profile can still hold it, and M1 only flags such an id rather than replacing it.
  eq('G5b 3.5 Pro is not exempt just because it is not Lite', accepts('gemini-3.5-pro'), false)
  eq('G5b nor is a 3.5 family we have never seen', accepts('gemini-3.5-ultra'), false)
  eq('G5b nor a new variant of the exempt model', accepts('gemini-3.5-flash-preview-11-2026'), false)

  // Versions are compared as numbers. As text, "3.10" sorts beside "3.1" and a future model
  // would silently be handed parameters that fail the request.
  eq('G5b a future 3.10', accepts('gemini-3.10-flash'), false)
  eq('G5b a future 4.x', accepts('gemini-4.0-flash'), false)

  // Unknown means future, and future means rejected. Guessing this way round costs a control
  // that does nothing; guessing the other way costs every run.
  eq('G5b an alias that follows the model line forwards', accepts('gemini-flash-latest'), false)
  eq('G5b an unversioned id', accepts('gemini-exp-1206'), false)
  eq('G5b something that is not Gemini at all', accepts('gpt-4o'), false)
  eq('G5b nothing selected', accepts(''), false)

  // Adding this capability must not have disturbed the ones already there.
  eq('G5b thinking is unchanged for 2.5', modelCapabilities('gemini-2.5-pro').thinking, 'budget')
  eq('G5b thinking is unchanged for 3.x', modelCapabilities('gemini-3.6-flash').thinking, 'level')
  eq('G5b transcription is unchanged', modelCapabilities('gemini-3.6-flash').supportsTranscription, true)

  eq('G5b 3.x defaults', samplingDefaults('gemini-3.1-flash-lite'), { temperature: 1.0, topP: 0.95 })
  eq('G5b 2.x defaults', samplingDefaults('gemini-2.5-flash'), { temperature: 0.3, topP: 0.8 })
  eq('G5b a dated 2.5 preview is not a 3.x model', samplingDefaults('gemini-2.5-flash-preview-03-25'), {
    temperature: 0.3,
    topP: 0.8
  })
}

section('G5c — a number field can be typed into (REP-4)')
{
  const temp: NumberFieldRules = { min: 0.05, max: 2, step: 0.05 }
  const topK: NumberFieldRules = { min: 1, max: 100, allowEmpty: true }
  const budget: NumberFieldRules = { min: 128, max: 32768 }

  /** Every intermediate the browser reports while a string is typed left to right. */
  const typing = (text: string, rules: NumberFieldRules): (number | null)[] =>
    text.split('').map((_, i) => valueWhileTyping(text.slice(0, i + 1), rules))

  // The reported defect, as a sequence. `0` and `0.` are below the minimum and commit
  // nothing — correcting them is what ate the caret — while `0.8` is a real value on the way
  // to `0.85` and is committed as it passes, so nothing is lost if the field never blurs.
  eq('G5c typing 0.85 into a 0.05-minimum field', typing('0.85', temp), [null, null, 0.8, 0.85])
  eq('G5c typing 512 into a 128-minimum field', typing('512', budget), [null, null, 512])
  eq('G5c an in-range prefix commits as it goes', typing('40', topK), [4, 40])

  // A number input reports '' for a half-typed value it cannot parse — `0.` being the one
  // that matters. It must be held, never turned into a value.
  eq('G5c the unparseable intermediate commits nothing', valueWhileTyping('', temp), null)
  eq('G5c and neither does a bare minus', valueWhileTyping('-', temp), null)
  eq('G5c out of range is held, not clamped', valueWhileTyping('9', temp), null)
  eq('G5c above the maximum is held too', valueWhileTyping('150', topK), null)

  // Correction happens once, on the way out.
  eq('G5c blur clamps to the maximum', valueOnBlur('9', temp, 1), 2)
  eq('G5c blur clamps to the minimum', valueOnBlur('0.01', temp, 1), 0.05)
  eq('G5c blur keeps a good value', valueOnBlur('0.85', temp, 1), 0.85)
  eq('G5c blur rounds a decimal field to two places', valueOnBlur('0.8549', temp, 1), 0.85)
  eq('G5c blur rounds an integer field rather than truncating', valueOnBlur('2.6', topK, 1), 3)

  // Clearing a field: allowed for Top-K, and otherwise a no-op rather than a silent edit.
  // The old field wrote `min` here, so clearing Thinking Budget on 2.5 Pro to retype it and
  // then clicking away changed the setting to 128 without anyone choosing that.
  eq('G5c an empty optional field means no value', valueOnBlur('', topK, 40), null)
  eq('G5c an empty required field keeps what it had', valueOnBlur('', budget, 512), 512)
  eq('G5c text that is not a number keeps what it had', valueOnBlur('abc', temp, 0.7), 0.7)
  eq('G5c whitespace is not a value', valueOnBlur('   ', budget, 512), 512)

  // Regression: the three fields that always worked must keep working, including the
  // integer ones that have no step at all.
  eq('G5c batch size still commits while typing', typing('100', { min: 1, max: 1000 }), [1, 10, 100])
  eq('G5c resume context accepts zero', valueWhileTyping('0', { min: 0, max: 1000 }), 0)
  eq('G5c and blur leaves it alone', valueOnBlur('0', { min: 0, max: 1000 }, 50), 0)
}

// ── result ─────────────────────────────────────────────────────────────────────

console.log(`\n${passes} passed, ${failures} failed`)
if (failures > 0) {
  console.log('\nGATE FAILED — do not proceed to the next step until this is green.')
  process.exit(1)
}
console.log('\nALL GATES PASSED')
