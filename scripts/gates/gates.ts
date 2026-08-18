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
import { applyModelSelectionRules, singleKeyRefreshScope } from '../../electron/main/ipc'
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
import { effectiveThinkingLevel, modelCapabilities } from '../../electron/shared/modelCaps'
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

// ── result ─────────────────────────────────────────────────────────────────────

console.log(`\n${passes} passed, ${failures} failed`)
if (failures > 0) {
  console.log('\nGATE FAILED — do not proceed to the next step until this is green.')
  process.exit(1)
}
console.log('\nALL GATES PASSED')
