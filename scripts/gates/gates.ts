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
 *   G1c  runtime sanitise of malformed settings (SOL-29/30), including typed overlay
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
import { spawn } from 'child_process'

import {
  CURRENT_SCHEMA_VERSION,
  migrateSettings,
  sanitizeSettingsView,
  type MigrationContext
} from '../../electron/main/migrations'
import { DEFAULT_MODELS, DEFAULT_MODEL_ID, DEFAULT_SETTINGS, store, setSettings, getSettings } from '../../electron/main/store'
import {
  buildModelList,
  classifyFetchFailure,
  compareVersions,
  guardModelForSpawn,
  keepProvenRejections,
  resolveDefaultModel,
  summarizeRefresh,
  type PriorVerdict
} from '../../electron/main/modelsList'
import {
  applyModelSelectionRules,
  keySnapshotChanged,
  retargetTokenReport,
  leftoverCanonicals,
  scanOutputFiles,
  sidecarDestination,
  singleKeyRefreshScope,
  isHttpsUrl
} from '../../electron/main/ipc'
import {
  CONSOLE_LOG_SUFFIX,
  CONSOLE_LOG_TRUNCATION_MARK,
  DEFAULT_CONSOLE_LOG_LIMITS,
  consoleLogPathFor,
  createConsoleLog,
  findConsoleLog
} from '../../electron/shared/consoleLog'
import { isBarFrame, parseTokenLine, stripAnsi, stripTerminalChrome } from '../../electron/shared/terminalNoise'
import { scanTranslatedOutput, sourceFragmentNote, explainTranslateAbort, fragmentNoteInLog } from '../../electron/shared/outputSanity'
import {
  durationFromProbe,
  parseTimestamp,
  percentOf,
  readProgressChunk
} from '../../electron/shared/ffmpegProgress'
import {
  buildTranscribeArgs,
  buildTranslateArgs,
  ensureUtf8Subtitle,
  orderKeysByValidity,
  survivorsIn
} from '../../electron/main/pythonBridge'
import {
  activeKeySlots,
  forgetSlotEvidence,
  keyRoles,
  orderKeySlots,
  reindexEvidenceAfterRemoval
} from '../../electron/shared/keyOrder'
import {
  RATE_LIMITS_URL,
  THINKING_LEVELS,
  lookupFreeTier,
  paidQuotaTooltip,
  thinkingLevelsForModel
} from '../../src/data/freeTier'
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
import {
  createSerialPatchQueue,
  resolveTranscribeSettings,
  seedTranscribeOverride,
  transcribeRefusalMessage,
  transcribeEngineWarning
} from '../../electron/shared/transcribeSettings'
import { valueOnBlur, valueWhileTyping, type NumberFieldRules } from '../../src/lib/numberField'
import { companionName, extractedTrackName } from '../../src/lib/outputName'
import {
  countKeyStates,
  keyHeadline,
  keyStateOf,
  listKeyNumbers,
  uncheckedNote
} from '../../src/lib/keyStatus'
import { maskCommandLine } from '../../electron/shared/maskedCommand'
import { copyExclusive, displaceExclusive, nthCandidate, writeExclusive } from '../../electron/main/exclusiveFile'
import {
  forceKillTree,
  hasExited,
  livePid,
  pidIsAlive,
  waitForChildExit
} from '../../electron/main/processExit'
import {
  TIER1_LINES,
  TIER1_QUIET_MS,
  createStallWatch
} from '../../electron/shared/stallBudget'
import type {
  AppSettings,
  KeyCheck,
  ModelInfo,
  SlotFetchResult,
  SubtitleTrack,
  TranslateArgs
} from '../../electron/shared/types'

// ── harness ────────────────────────────────────────────────────────────────────

let failures = 0
let passes = 0
let group = ''
const sectionsRun: string[] = []

/** Empty suites must not print ALL GATES PASSED (SOL-46). Floors are conservative on purpose. */
const MIN_GATE_SECTIONS = 35
const MIN_GATE_PASSES = 500

function section(name: string): void {
  group = name
  sectionsRun.push(name)
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

section('G1d — M7 thinkingLevel disabled → default (REP-28)')
{
  const fromV0 = migrateSettings({ ...pristineProfile(), thinkingLevel: 'disabled' }, CTX)
  eq('M7 a v0 Disabled profile becomes Default', fromV0.settings.thinkingLevel, 'default')
  eq('M7 schemaVersion reaches target', fromV0.settings.schemaVersion, CURRENT_SCHEMA_VERSION)
  const again = migrateSettings(fromV0.settings, CTX)
  eq('M7 second pass is a no-op', again.changed, false)
  eq('M7 second pass keeps Default', again.settings.thinkingLevel, 'default')

  const fromV4 = migrateSettings({ ...pristineProfile(), schemaVersion: 4, thinkingLevel: 'disabled' }, CTX)
  eq('M7 a v4 Disabled profile becomes Default', fromV4.settings.thinkingLevel, 'default')

  const kept = migrateSettings({ ...pristineProfile(), schemaVersion: 4, thinkingLevel: 'high' }, CTX)
  eq('M7 does not rewrite a real stored level', kept.settings.thinkingLevel, 'high')
}

section('G1e — transcribe override resolver (REP-27)')
{
  const globals = {
    transcribeOverride: false,
    transcribeModel: 'gemini-2.5-flash',
    transcribeThinkingLevel: 'high',
    transcribeThinkingBudget: 4096,
    model: 'gemini-3.1-flash-lite',
    thinkingLevel: 'low',
    thinkingBudget: 512
  }
  eq('G1e override off ignores stored transcribe fields', resolveTranscribeSettings(globals), {
    model: 'gemini-3.1-flash-lite',
    thinkingLevel: 'low',
    thinkingBudget: 512
  })
  eq(
    'G1e override on uses the stored transcribe fields',
    resolveTranscribeSettings({ ...globals, transcribeOverride: true }),
    { model: 'gemini-2.5-flash', thinkingLevel: 'high', thinkingBudget: 4096 }
  )
  eq(
    'G1e empty override fields fall back to global',
    resolveTranscribeSettings({
      transcribeOverride: true,
      transcribeModel: '',
      transcribeThinkingLevel: '',
      transcribeThinkingBudget: 0,
      model: 'gemini-3.1-flash-lite',
      thinkingLevel: 'medium',
      thinkingBudget: 512
    }),
    { model: 'gemini-3.1-flash-lite', thinkingLevel: 'medium', thinkingBudget: 512 }
  )

  const seeded = seedTranscribeOverride(globals)
  eq('G1e seed turns the override on', seeded.transcribeOverride, true)
  eq('G1e seed keeps a stored model rather than overwriting it', seeded.transcribeModel, 'gemini-2.5-flash')
  const firstOn = seedTranscribeOverride({
    ...globals,
    transcribeModel: '',
    transcribeThinkingLevel: '',
    transcribeThinkingBudget: 0
  })
  eq('G1e first-on seed copies the global model', firstOn.transcribeModel, 'gemini-3.1-flash-lite')
  eq('G1e first-on seed copies the global thinking level', firstOn.transcribeThinkingLevel, 'low')
  eq('G1e first-on seed copies the global budget', firstOn.transcribeThinkingBudget, 512)

  check(
    'G1e override-off refusal points at Settings',
    transcribeRefusalMessage('gemini-2.0-flash', false).includes('Settings → Model & Generation')
  )
  check(
    'G1e override-on refusal points at the local picker',
    transcribeRefusalMessage('gemini-2.0-flash', true).includes('above')
  )
  check(
    'G1e refusal names the model that would have run',
    transcribeRefusalMessage('gemini-2.0-flash', false).includes('gemini-2.0-flash')
  )
  const dedicatedWarn = transcribeEngineWarning('gemini-3.5-transcribe')
  check('G1e a dedicated transcribe model is warned, not refused', dedicatedWarn !== null)
  check(
    'G1e the warning names the system instruction',
    (dedicatedWarn ?? '').includes('system instruction')
  )
  check(
    'G1e and the JSON response schema',
    (dedicatedWarn ?? '').toLowerCase().includes('json') &&
      (dedicatedWarn ?? '').toLowerCase().includes('schema')
  )
  check(
    'G1e and names the model that would run',
    (dedicatedWarn ?? '').includes('gemini-3.5-transcribe')
  )
  eq('G1e an ordinary 3.x model is not warned', transcribeEngineWarning('gemini-3.1-flash-lite'), null)
  eq('G1e an audio-incapable model is not this warning', transcribeEngineWarning('gemini-2.0-flash'), null)
  eq(
    'G1e dedicated transcribe is still allowed by the capability test',
    modelCapabilities('gemini-3.5-transcribe').supportsTranscription,
    true
  )
  eq(
    'G1e a transcribe-looking 2.0 id cannot transcribe',
    modelCapabilities('gemini-2.0-transcribe').supportsTranscription,
    false
  )
  eq(
    'G1e so it does not get the warn-and-allow overlay (REP-33)',
    transcribeEngineWarning('gemini-2.0-transcribe'),
    null
  )
  check(
    'G1e warning and refusal stay mutually exclusive',
    transcribeEngineWarning('gemini-2.0-transcribe') === null &&
      transcribeRefusalMessage('gemini-2.0-transcribe', true).includes('cannot transcribe')
  )
  check(
    'G1e a startable dedicated id is warned, not refused',
    transcribeEngineWarning('gemini-3.5-transcribe') !== null &&
      modelCapabilities('gemini-3.5-transcribe').supportsTranscription
  )

  const absent = sanitizeSettingsView(
    { ...pristineProfile(), schemaVersion: CURRENT_SCHEMA_VERSION },
    DEFAULT_SETTINGS
  )
  eq('G1e a profile that predates the override defaults to off', absent.settings.transcribeOverride, false)
  eq('G1e empty model overlay', absent.settings.transcribeModel, '')
  eq('G1e budget 0 means unset', absent.settings.transcribeThinkingBudget, 0)
  eq('G1e the fields are not written by sanitise', 'transcribeOverride' in absent.persist, false)
  eq('G1e sanitise is not a persistable change', absent.changed, false)

  const migrated = migrateSettings({ ...pristineProfile(), schemaVersion: CURRENT_SCHEMA_VERSION }, CTX)
  eq('G1e current-version migration does not invent the override', migrated.changed, false)
  eq('G1e and does not bump the schema for it', migrated.settings.schemaVersion, CURRENT_SCHEMA_VERSION)

  {
    const order: number[] = []
    let releaseFirst!: () => void
    const firstHold = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const q = createSerialPatchQueue(async (id: number) => {
      if (id === 1) await firstHold
      order.push(id)
    })
    q.enqueue(1)
    q.enqueue(2)
    eq('G1e overlapping writes are pending together', q.pending(), 2)
    releaseFirst()
    await q.idle()
    eq('G1e writes land in enqueue order, not completion-race order', order, [1, 2])
    eq('G1e the queue is idle afterwards', q.pending(), 0)
  }
  {
    const order: number[] = []
    const q = createSerialPatchQueue(async (id: number) => {
      if (id === 1) throw new Error('persist failed')
      order.push(id)
    })
    q.enqueue(1)
    q.enqueue(2)
    const persistError = await q.idle()
    eq('G1e a failed write does not strand the next one', order, [2])
    eq('G1e pending returns to 0 after a failure', q.pending(), 0)
    eq(
      'G1e a later successful partial write does not hide an earlier failure',
      persistError,
      'persist failed'
    )
  }
  {
    const q = createSerialPatchQueue(async (id: number) => {
      if (id === 2) throw new Error('persist failed')
    })
    q.enqueue(1)
    q.enqueue(2)
    const persistError = await q.idle()
    eq('G1e a failed last write is reported to Start', persistError, 'persist failed')
    eq('G1e the reported failure is consumed, not sticky across later idles', await q.idle(), null)
  }
}

// ── G1c: runtime shape repair is separate from the versioned chain (SOL-29) ────

section('G1c — sanitizeSettingsView (typed view / lossless persist)')
{
  const malformed = { ...pristineProfile(), schemaVersion: CURRENT_SCHEMA_VERSION, cachedModels: {} }
  const migrated = migrateSettings(malformed, CTX)
  eq('G1c current-version migration does not rewrite a non-array cache', migrated.changed, false)
  eq('G1c and leaves the object in place', migrated.settings.cachedModels, {})

  const sanitized = sanitizeSettingsView(malformed, DEFAULT_SETTINGS)
  check('G1c runtime view is an array', Array.isArray(sanitized.settings.cachedModels))
  eq('G1c runtime view uses the seed list', (sanitized.settings.cachedModels as ModelInfo[]).length, DEFAULT_MODELS.length)
  eq('G1c schemaVersion is untouched', sanitized.settings.schemaVersion, CURRENT_SCHEMA_VERSION)
  const withMystery = sanitizeSettingsView({ ...malformed, mystery: 1 }, DEFAULT_SETTINGS)
  eq('G1c unknown fields stay on persist', withMystery.persist.mystery, 1)
  eq('G1c and do not appear on the typed view', withMystery.settings.mystery, undefined)
  eq('G1c a non-array cache stays on disk', sanitized.persist.cachedModels, {})
  eq('G1c and is not a persistable repair', sanitized.changed, false)

  const withNulls = {
    ...pristineProfile(),
    schemaVersion: CURRENT_SCHEMA_VERSION,
    cachedModels: [null, { id: 'gemini-3.1-flash-lite', label: 'Flash Lite 3.1' }, 12]
  }
  const dropped = sanitizeSettingsView(withNulls, DEFAULT_SETTINGS)
  const kept = dropped.settings.cachedModels as ModelInfo[]
  eq('G1c null and non-object entries are dropped', kept.length, 1)
  eq('G1c the real entry survives', kept[0].id, 'gemini-3.1-flash-lite')

  const liveBad = sanitizeSettingsView(
    {
      ...pristineProfile(),
      schemaVersion: CURRENT_SCHEMA_VERSION,
      cachedModels: [{ id: 'gemini-3.1-flash-lite', label: 'Flash Lite 3.1', source: 'live', availableOn: null }]
    },
    DEFAULT_SETTINGS
  )
  const liveEntry = (liveBad.settings.cachedModels as ModelInfo[])[0]
  eq('G1c live evidence without an availableOn array degrades to seed', liveEntry.source, 'seed')
  check('G1c and availableOn is an array', Array.isArray(liveEntry.availableOn))

  const scalarKey = sanitizeSettingsView(
    { ...pristineProfile(), schemaVersion: CURRENT_SCHEMA_VERSION, apiKeys: 'REAL_KEY' },
    DEFAULT_SETTINGS
  )
  eq('G1c a scalar API key is wrapped, not deleted', scalarKey.persist.apiKeys, ['REAL_KEY'])
  eq('G1c and the view matches', scalarKey.settings.apiKeys, ['REAL_KEY'])

  const scalarFalse = sanitizeSettingsView(
    {
      ...pristineProfile(),
      schemaVersion: CURRENT_SCHEMA_VERSION,
      apiKeys: ['REAL_KEY'],
      apiKeyValid: false
    },
    DEFAULT_SETTINGS
  )
  eq('G1c a scalar rejection is wrapped as [false]', scalarFalse.persist.apiKeyValid, [false])
  eq(
    'G1c and that credential stays out of the pool',
    orderKeySlots([{ index: 0, valid: (scalarFalse.settings.apiKeyValid as Array<boolean | null>)[0], tier: 'free' }]),
    []
  )

  const numericSlot = sanitizeSettingsView(
    { ...pristineProfile(), schemaVersion: CURRENT_SCHEMA_VERSION, apiKeys: [123] },
    DEFAULT_SETTINGS
  )
  eq('G1c a non-string key slot becomes an empty string', numericSlot.settings.apiKeys, [''])
  eq('G1c and that type repair is persistable', numericSlot.persist.apiKeys, [''])

  const unconvertible = sanitizeSettingsView(
    { ...pristineProfile(), schemaVersion: CURRENT_SCHEMA_VERSION, apiKeys: { not: 'an-array' } },
    DEFAULT_SETTINGS
  )
  eq('G1c an unconvertible key container stays on disk', unconvertible.persist.apiKeys, { not: 'an-array' })
  eq('G1c while the view is an empty slot', unconvertible.settings.apiKeys, [''])
  eq('G1c and changed is false so startup will not persist the empty slot', unconvertible.changed, false)

  const badModel = sanitizeSettingsView(
    { ...pristineProfile(), schemaVersion: CURRENT_SCHEMA_VERSION, model: 123 },
    DEFAULT_SETTINGS
  )
  eq('G1c a numeric model is a string in the view', typeof badModel.settings.model, 'string')
  eq('G1c and stays a number on disk', badModel.persist.model, 123)
  eq('G1c and is not a persistable repair', badModel.changed, false)

  const newer = { ...pristineProfile(), schemaVersion: 99, cachedModels: {}, futureField: true }
  const left = sanitizeSettingsView(newer, DEFAULT_SETTINGS)
  eq('G1c a newer-build profile is not rewritten', left.changed, false)
  eq('G1c including its malformed cache on disk', left.persist.cachedModels, {})
  check('G1c but the view is still iterable', Array.isArray(left.settings.cachedModels))
  eq('G1c and futureField stays on persist only', left.persist.futureField, true)
  eq('G1c not on the typed view', left.settings.futureField, undefined)

  const newerFalse = sanitizeSettingsView(
    { schemaVersion: 99, apiKeys: ['KEY'], apiKeyValid: false },
    DEFAULT_SETTINGS
  )
  eq('G1c newer-schema scalar false is [false] in the view', newerFalse.settings.apiKeyValid, [false])
  eq('G1c and the key string is kept in the view', newerFalse.settings.apiKeys, ['KEY'])
  eq('G1c and the scalar false stays on disk', newerFalse.persist.apiKeyValid, false)
  eq('G1c and changed is false so the wrap is not persisted', newerFalse.changed, false)
  eq(
    'G1c so that newer-schema rejected key is not in the pool',
    orderKeySlots([
      { index: 0, valid: (newerFalse.settings.apiKeyValid as Array<boolean | null>)[0], tier: 'free' }
    ]),
    []
  )

  store.set('cachedModels', {})
  check('G1c getSettings exposes an array even if the store holds an object', Array.isArray(getSettings().cachedModels))
  eq('G1c a read does not write the repair', store.get('cachedModels'), {})
  const beforeVersion = (store.store as { schemaVersion: number }).schemaVersion
  setSettings({ schemaVersion: 99, theme: 'dark' } as Partial<AppSettings>)
  eq('G1c setSettings cannot write schemaVersion', (store.store as { schemaVersion: number }).schemaVersion, beforeVersion)
  eq('G1c but still writes the rest of the patch', getSettings().theme, 'dark')
  eq('G1c and does not persist the seed over a non-array cache', store.get('cachedModels'), {})

  const fileBefore = { ...(store.store as Record<string, unknown>) }
  ;(store as unknown as { __replace: (n: Record<string, unknown>) => void }).__replace({
    schemaVersion: 99,
    mysteryField: 'from-the-future',
    theme: 'light'
  })
  setSettings({ theme: 'dark' })
  eq('G1c a downgrade write keeps the newer schemaVersion', store.get('schemaVersion'), 99)
  eq('G1c and keeps unknown fields', store.get('mysteryField'), 'from-the-future')
  eq('G1c and writes the patch', store.get('theme'), 'dark')
  eq('G1c and does not materialise this build\'s defaults', store.get('batchSize'), undefined)
  ;(store as unknown as { __replace: (n: Record<string, unknown>) => void }).__replace(fileBefore)
  setSettings({ theme: 'auto', cachedModels: DEFAULT_MODELS.map((m) => ({ ...m })) })

  const restoreAfterSparse = { ...(store.store as Record<string, unknown>) }
  ;(store as unknown as { __replace: (n: Record<string, unknown>) => void }).__replace({})
  eq('G1c a sparse profile reports modelsUpdatedAt as null', getSettings().modelsUpdatedAt, null)
  eq('G1c and model is a string', typeof getSettings().model, 'string')
  eq('G1c while the raw store has no timestamp', store.get('modelsUpdatedAt'), undefined)
  ;(store as unknown as { __replace: (n: Record<string, unknown>) => void }).__replace(restoreAfterSparse)
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

  const soleMissing = guardModelForSpawn('gemini-3.1-pro', [live('gemini-3.1-pro', [1])], [0])
  eq('absent from the only spawn slot is blocked', soleMissing.ok, false)
  check('and the refusal does not talk about switching', !(soleMissing.error ?? '').includes('may switch'))

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
  eq('a single invalid key is not resurrected', orderKeySlots(onlyInvalid), [])
  eq(
    'nor is an all-rejected pair',
    orderKeySlots([
      { index: 0, valid: false, tier: 'free' },
      { index: 1, valid: false, tier: 'paid' }
    ]),
    []
  )

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

  setSettings({ apiKeys: ['DEAD'], apiKeyValid: [false], apiKeyTiers: ['free'] })
  eq('C17 an all-rejected ranking is empty', orderKeysByValidity(['DEAD']).keys, [])
  const refused = buildTranslateArgs(baseArgs({ apiKeys: ['DEAD'] }), 'C:/out.srt')
  check('C17 and the argv does not resurrect it as -k', !refused.includes('DEAD'))

  setSettings({
    apiKeys: ['KEY-A', 'KEY-B'],
    apiKeyValid: [null, true],
    apiKeyTiers: ['free', 'free']
  })
  const accepted: { index: number; valid: boolean | null; tier: string }[] = [
    { index: 0, valid: true, tier: 'free' },
    { index: 1, valid: true, tier: 'free' }
  ]
  eq(
    'C17 a spawn snapshot keeps the accepted primary after Settings moved',
    orderKeysByValidity(['KEY-A', 'KEY-B'], accepted).keys[0],
    'KEY-A'
  )
  eq(
    'C17 live ranking would have promoted the remaining valid key',
    orderKeysByValidity(['KEY-A', 'KEY-B']).keys[0],
    'KEY-B'
  )
  setSettings({ apiKeys: ['KEY-A'], apiKeyValid: [true], apiKeyTiers: ['free'] })
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

  const default3x = buildTranslateArgs(baseArgs({ model: 'gemini-3.1-flash-lite', thinkingLevel: 'default' }), 'C:/o.srt')
  check('3.x Default omits --thinking-level', !default3x.includes('--thinking-level'))
  check('3.x Default omits --no-thinking', !default3x.includes('--no-thinking'))

  const disabled3x = buildTranslateArgs(baseArgs({ model: 'gemini-3.1-flash-lite', thinkingLevel: 'disabled' }), 'C:/o.srt')
  check('a leftover Disabled is treated as Default (omit)', !disabled3x.includes('--thinking-level'))
  check('3.x never receives --no-thinking', !disabled3x.includes('--no-thinking'))

  const pro3 = buildTranslateArgs(baseArgs({ model: 'gemini-3.1-pro', thinkingLevel: 'minimal' }), 'C:/o.srt')
  eq('3 Pro coerces minimal to low', flagValue(pro3, '--thinking-level'), 'low')

  const budget = buildTranslateArgs(baseArgs({ model: 'gemini-2.5-flash', thinkingBudget: 4096 }), 'C:/o.srt')
  eq('2.5 uses --thinking-budget', flagValue(budget, '--thinking-budget'), '4096')

  const disabled25 = buildTranslateArgs(baseArgs({ model: 'gemini-2.5-flash', thinkingLevel: 'disabled' }), 'C:/o.srt')
  check('2.5 never receives --no-thinking', !disabled25.includes('--no-thinking'))
  eq('2.5 still sends its budget when thinkingLevel is leftover Disabled', flagValue(disabled25, '--thinking-budget'), '512')

  const zeroBudget = buildTranslateArgs(baseArgs({ model: 'gemini-2.5-flash', thinkingBudget: 0 }), 'C:/o.srt')
  check('2.5 budget 0 is omitted, not sent as 0', !zeroBudget.includes('--thinking-budget'))

  const pro25 = buildTranslateArgs(baseArgs({ model: 'gemini-2.5-pro', thinkingBudget: 0 }), 'C:/o.srt')
  eq('2.5 Pro budget 0 is clamped to the floor, not omitted', flagValue(pro25, '--thinking-budget'), '128')
  eq(
    '2.5 Pro transcription clamps a stale 0 the same way',
    flagValue(
      buildTranscribeArgs(
        {
          mediaFile: 'C:/a.mp4',
          outputFile: 'C:/a.srt',
          targetLang: '',
          model: 'gemini-2.5-pro',
          apiKeys: ['KEY-A'],
          thinkingLevel: 'low',
          thinkingBudget: 0,
          customGenerationParams: false,
          temperature: 0.5,
          topP: 0.9,
          topK: null
        },
        'C:/a.srt'
      ),
      '--thinking-budget'
    ),
    '128'
  )

  const legacy = buildTranslateArgs(baseArgs({ model: 'gemini-2.0-flash' }), 'C:/o.srt')
  check('2.0 receives no thinking flags at all', !legacy.includes('--thinking-level') && !legacy.includes('--thinking-budget') && !legacy.includes('--no-thinking'))

  const proFloor = buildTranslateArgs(baseArgs({ model: 'gemini-2.5-pro', thinkingBudget: 50 }), 'C:/o.srt')
  eq('2.5 Pro budget below the floor is clamped to 128', flagValue(proFloor, '--thinking-budget'), '128')

  eq('2.5 Flash floor is 1, not 0', modelCapabilities('gemini-2.5-flash').thinkingBudgetMin, 1)
  eq('2.5 Pro floor is 128', modelCapabilities('gemini-2.5-pro').thinkingBudgetMin, 128)
  eq('thinking cannot be switched off on Flash either', modelCapabilities('gemini-2.5-flash').canDisableThinking, false)

  const dedicatedCaps = modelCapabilities('gemini-3.5-transcribe')
  eq('dedicated transcribe model has no thinking control', dedicatedCaps.thinking, 'none')
  eq('dedicated transcribe model can still be selected for transcription', dedicatedCaps.supportsTranscription, true)
  const dedicated = buildTranscribeArgs(
    {
      mediaFile: 'C:/a.mp4',
      outputFile: 'C:/a.srt',
      targetLang: '',
      model: 'gemini-3.5-transcribe',
      apiKeys: ['KEY-A'],
      thinkingLevel: 'minimal',
      thinkingBudget: 512,
      customGenerationParams: false,
      temperature: 0.5,
      topP: 0.9,
      topK: null
    },
    'C:/a.srt'
  )
  check(
    'dedicated transcribe model sends no thinking flags',
    !dedicated.includes('--thinking-level') &&
      !dedicated.includes('--thinking-budget') &&
      !dedicated.includes('--no-thinking')
  )

  const txResolved = resolveTranscribeSettings({
    transcribeOverride: true,
    transcribeModel: 'gemini-2.5-flash',
    transcribeThinkingLevel: 'high',
    transcribeThinkingBudget: 2048,
    model: 'gemini-3.1-flash-lite',
    thinkingLevel: 'low',
    thinkingBudget: 512
  })
  const txOverride = buildTranscribeArgs(
    {
      mediaFile: 'C:/a.mp4',
      outputFile: 'C:/a.srt',
      targetLang: '',
      model: txResolved.model,
      apiKeys: ['KEY-A'],
      thinkingLevel: txResolved.thinkingLevel,
      thinkingBudget: txResolved.thinkingBudget,
      customGenerationParams: false,
      temperature: 0.5,
      topP: 0.9,
      topK: null
    },
    'C:/a.srt'
  )
  eq('override model reaches -m, not the global 3.x id', flagValue(txOverride, '-m'), 'gemini-2.5-flash')
  eq('override budget is what 2.5 receives', flagValue(txOverride, '--thinking-budget'), '2048')
  check('override 2.5 does not receive a 3.x thinking level', !txOverride.includes('--thinking-level'))

  const flash37 = modelCapabilities('gemini-3.7-flash').acceptedThinkingLevels
  check('3.7 Flash offers Default', flash37.includes('default'))
  check('3.7 Flash does not offer Minimal', !flash37.includes('minimal'))
  check('3.7 Flash offers Low/Medium/High', flash37.includes('low') && flash37.includes('medium') && flash37.includes('high'))
  eq(
    '3.7 Flash coerces Minimal to Low',
    flagValue(buildTranslateArgs(baseArgs({ model: 'gemini-3.7-flash', thinkingLevel: 'minimal' }), 'C:/o.srt'), '--thinking-level'),
    'low'
  )

  const pro3id = modelCapabilities('gemini-3-pro').acceptedThinkingLevels
  check('3 Pro offers Default', pro3id.includes('default'))
  check('3 Pro does not offer Medium', !pro3id.includes('medium'))
  check('3 Pro does not offer Minimal', !pro3id.includes('minimal'))
  eq(
    '3 Pro coerces Medium to Low',
    flagValue(buildTranslateArgs(baseArgs({ model: 'gemini-3-pro', thinkingLevel: 'medium' }), 'C:/o.srt'), '--thinking-level'),
    'low'
  )

  eq(
    'unknown 3.x falls back to Default/Low/High',
    modelCapabilities('gemini-3.9-ultra').acceptedThinkingLevels,
    ['default', 'low', 'high']
  )
  eq(
    '3 Pro Image is Default + High',
    modelCapabilities('gemini-3-pro-image').acceptedThinkingLevels,
    ['default', 'high']
  )
  eq(
    '3 Pro Image with the API prefix is the same model',
    modelCapabilities('models/gemini-3-pro-image').acceptedThinkingLevels,
    ['default', 'high']
  )
  eq(
    '3 Pro Image preview keeps the documented set',
    modelCapabilities('gemini-3-pro-image-preview').acceptedThinkingLevels,
    ['default', 'high']
  )
  eq('3 Pro Image coerces an unsupported level to High', effectiveThinkingLevel('gemini-3-pro-image', 'medium'), 'high')
  eq(
    '3.1 Flash Image is Default + Minimal + High',
    modelCapabilities('gemini-3.1-flash-image').acceptedThinkingLevels,
    ['default', 'minimal', 'high']
  )
  eq(
    '3.1 Flash-Lite Image is the same pair',
    modelCapabilities('gemini-3.1-flash-lite-image').acceptedThinkingLevels,
    ['default', 'minimal', 'high']
  )
  eq(
    'an unknown flash-image id falls back rather than inheriting Minimal',
    modelCapabilities('gemini-3.9-flash-image').acceptedThinkingLevels,
    ['default', 'low', 'high']
  )
  eq(
    'an unknown pro-image id falls back rather than High-only',
    modelCapabilities('gemini-3.9-pro-image').acceptedThinkingLevels,
    ['default', 'low', 'high']
  )
  eq(
    'stored Low stays Low on an unknown image model',
    effectiveThinkingLevel('gemini-3.9-flash-image', 'low'),
    'low'
  )
  eq(
    'an image id does not inherit its text-model cousin’s full set',
    modelCapabilities('gemini-3.5-flash-image').acceptedThinkingLevels,
    ['default', 'low', 'high']
  )

  eq(
    '3.1 Pro does not offer Minimal',
    modelCapabilities('gemini-3.1-pro').acceptedThinkingLevels.includes('minimal'),
    false
  )
  eq(
    '3.5 Flash-Lite keeps all four discrete levels',
    modelCapabilities('gemini-3.5-flash-lite').acceptedThinkingLevels,
    ['default', 'minimal', 'low', 'medium', 'high']
  )
  eq(
    'undocumented 3.6 Flash-Lite falls back rather than inheriting 3.6 Flash',
    modelCapabilities('gemini-3.6-flash-lite').acceptedThinkingLevels,
    ['default', 'low', 'high']
  )

  check('THINKING_LEVELS has a Default entry', THINKING_LEVELS.some((o) => o.value === 'default' && o.label === 'Default'))
  check('THINKING_LEVELS has no Disabled entry', !THINKING_LEVELS.some((o) => o.value === 'disabled'))
  check('Low is not labelled as Default', !THINKING_LEVELS.some((o) => o.value === 'low' && /default/i.test(o.label)))
  eq(
    'dropdown hides unsupported levels',
    thinkingLevelsForModel(['default', 'low', 'high']).map((o) => o.value),
    ['default', 'low', 'high']
  )
  check(
    'dropdown keeps an orphan current value so the Select is not blank',
    thinkingLevelsForModel(['default', 'low', 'high'], 'medium').some((o) => o.value === 'medium')
  )

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
    check('G3 filler is not reported as a timing shift', !w.signals.includes('wrong timings'))
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

section('G3d — alignment, fragment-heavy sources, abort copy (REP-32)')
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

  /** Length-only pair: S1/S2/S3 stay quiet (distinct, proportional, one line). */
  function lengthPair(
    count: number,
    outLen: (i: number, srcLen: number) => number
  ): { source: string[]; output: string[] } {
    const source: string[] = []
    const output: string[] = []
    for (let i = 0; i < count; i++) {
      const sl = 12 + (i % 19) * 3
      source.push('S'.repeat(sl))
      output.push('T'.repeat(Math.max(1, outLen(i, sl))))
    }
    return { source, output }
  }

  const aligned = lengthPair(400, (_i, sl) => sl)
  eq(
    'G3d an aligned length pair is silent',
    scanTranslatedOutput(srt(aligned.source), srt(aligned.output)).length,
    0
  )

  const uniformSrc = Array.from({ length: 80 }, () => 'hello world')
  const uniformOut = Array.from({ length: 80 }, () => 'shalom olam!!')
  eq(
    'G3d uniform lengths (no variance) are treated as aligned',
    scanTranslatedOutput(srt(uniformSrc), srt(uniformOut)).length,
    0
  )

  const scramble = (i: number, sl: number): number => 12 + ((i * 7 + 3) % 19) * 3
  const late = lengthPair(400, (i, sl) => (i < 240 ? sl : scramble(i, sl)))
  const lateWarn = scanTranslatedOutput(srt(late.source), srt(late.output))
  check('G3d late drift warns', lateWarn.length >= 1, `got ${lateWarn.length}`)
  if (lateWarn.length >= 1) {
    const w = lateWarn[0]
    check('G3d late drift is a timing warning', w.signals.includes('wrong timings'))
    check('G3d late drift names wrong timings', /wrong timings/i.test(w.message))
    check('G3d late drift starts in the scrambled half', w.from >= 180, `from ${w.from}`)
    check('G3d late drift does not accuse the aligned prefix', w.from > 50, `from ${w.from}`)
  }

  const early = lengthPair(400, (i, sl) => (i < 40 ? sl : scramble(i, sl)))
  const earlyWarn = scanTranslatedOutput(srt(early.source), srt(early.output))
  check('G3d early drift warns', earlyWarn.length >= 1, `got ${earlyWarn.length}`)
  if (earlyWarn.length >= 1) {
    check('G3d early drift is a timing warning', earlyWarn[0].signals.includes('wrong timings'))
    check('G3d early drift starts before the late-stretch fixture', earlyWarn[0].from < 180, `from ${earlyWarn[0].from}`)
  }

  const weak = lengthPair(400, (i) => 20 + (i % 3))
  eq(
    'G3d weak length correlation without fragments stays silent (SOL-63)',
    scanTranslatedOutput(srt(weak.source), srt(weak.output)).length,
    0
  )

  function fragPad(i: number, n: number): string {
    const stem = i % 2 === 0 ? 'this fragment continues without a stop ' : 'and the next cue starts lower '
    if (n <= stem.length) return stem.slice(0, Math.max(1, n))
    return stem.repeat(Math.ceil(n / stem.length)).slice(0, n)
  }
  const wholeFragSrc = Array.from({ length: 400 }, (_, i) => fragPad(i, 12 + (i % 19) * 3))
  const wholeFragOut = Array.from({ length: 400 }, (_, i) => 'T'.repeat(Math.max(1, scramble(i, 12 + (i % 19) * 3))))
  const wholeFragWarn = scanTranslatedOutput(srt(wholeFragSrc), srt(wholeFragOut))
  check(
    'G3d a fully drifted fragment-heavy file still warns',
    wholeFragWarn.length >= 1,
    `got ${wholeFragWarn.length}`
  )
  if (wholeFragWarn.length >= 1) {
    check('G3d whole-file fragment drift is a timing warning', wholeFragWarn[0].signals.includes('wrong timings'))
  }

  const pro = Array.from({ length: 80 }, (_, i) => {
    if (i % 28 === 1) return 'on the next line we finish.'
    if (i % 28 === 0) return 'This sentence continues'
    return `A complete sentence number ${i}.`
  })
  eq('G3d a professionally punctuated source is silent', sourceFragmentNote(srt(pro)), null)

  const youtube = Array.from({ length: 80 }, (_, i) =>
    i % 2 === 0 ? `this fragment continues without a stop ${i}` : `and the next cue starts lower ${i}`
  )
  const ytNote = sourceFragmentNote(srt(youtube))
  check('G3d a fragment-heavy source produces a log note', ytNote !== null)
  if (ytNote) {
    check('G3d the note names mid-sentence breaks', /mid-sentence/i.test(ytNote))
    check('G3d the note tells them to re-segment', /re-segment/i.test(ytNote))
    check('G3d the note does not block by promising a model fix', !/try a stronger|use a stronger/i.test(ytNote))
    check('G3d the page can lift that note out of a log', fragmentNoteInLog(`Starting engine…\n${ytNote}\n`) === ytNote)
  }
  eq(
    'G3d a short fragment-heavy file is not judged',
    sourceFragmentNote(srt(youtube.slice(0, 10))),
    null
  )

  eq(
    'G3d three strikes alone is not a merge diagnosis (SOL-61)',
    explainTranslateAbort('Stopping script due to reaching 3 consecutive errors'),
    null
  )
  const abortShort = explainTranslateAbort(
    'Retrying immediately...\nExpected 300 lines, got 208\nStopping script due to reaching 3 consecutive errors'
  )
  check('G3d a short item count is reported', abortShort !== null)
  if (abortShort) {
    check('G3d short-count copy names the observed shortage', /fewer subtitle lines/i.test(abortShort))
    check('G3d short-count copy treats merging as possible, not confirmed', /possible cause/i.test(abortShort))
    check('G3d short-count copy does not prescribe re-segmenting', !/re-segment/i.test(abortShort))
    check(
      'G3d short-count copy does not offer a stronger model',
      !/try a stronger|use a stronger|pick a stronger/i.test(abortShort)
    )
  }
  const abortFrag = explainTranslateAbort(
    `${ytNote ?? 'This source file’s cues often break mid-sentence (about 53%).'}\nExpected 300 lines, got 208`
  )
  check('G3d a short count plus a fragment note is a merge diagnosis', abortFrag !== null)
  if (abortFrag) {
    check('G3d corroborated abort names merging as likely', /likely cause/i.test(abortFrag))
    check('G3d corroborated abort names re-segmenting as the fix', /re-segment/i.test(abortFrag))
    check('G3d corroborated abort names wrong timings', /wrong timings/i.test(abortFrag))
    check(
      'G3d corroborated abort does not offer a stronger model as a fix',
      /will not reliably/i.test(abortFrag) && !/try a stronger|use a stronger|pick a stronger/i.test(abortFrag)
    )
  }
  eq('G3d an unrelated error is not this abort', explainTranslateAbort('Failed to start gst: spawn ENOENT'), null)
  eq('G3d an empty log is not this abort', explainTranslateAbort(''), null)

  const evidenceRoots = [
    path.join(process.cwd(), '.secrets', 'Issues', '_Reported', 'Error translating'),
    path.join(process.cwd(), '.secrets', 'Issues', 'Error translating'),
    path.join(process.cwd(), '.secrets', 'Issues', 'Issues_round_02', '_Reported', 'Error translating')
  ]
  const evidence = evidenceRoots.find((p) => fs.existsSync(p))
  if (!evidence) {
    check('G3d evidence files optional — skipped', true)
  } else {
    const sistersSrc = path.join(evidence, '1', 'Bad.Sisters.S01E01.eng.srt')
    const sistersOut = path.join(evidence, '1', 'Bad.Sisters.S01E01.eng_he.srt')
    if (fs.existsSync(sistersSrc) && fs.existsSync(sistersOut)) {
      const sisters = scanTranslatedOutput(fs.readFileSync(sistersSrc, 'utf-8'), fs.readFileSync(sistersOut, 'utf-8'))
      eq('G3d Bad Sisters stays silent (the false-positive that matters)', sisters.length, 0)
      eq('G3d Bad Sisters is not flagged as fragment-heavy', sourceFragmentNote(fs.readFileSync(sistersSrc, 'utf-8')), null)
    }
    const dir2 = path.join(evidence, '2')
    if (fs.existsSync(dir2)) {
      const names = fs.readdirSync(dir2)
      const srcName = names.find((f) => f.endsWith('.srt') && !f.endsWith('_he.srt') && !f.includes('Flash'))
      const heName = names.find((f) => f.endsWith('_he.srt'))
      if (srcName && heName) {
        const srcText = fs.readFileSync(path.join(dir2, srcName), 'utf-8')
        const lite = scanTranslatedOutput(srcText, fs.readFileSync(path.join(dir2, heName), 'utf-8'))
        check(
          'G3d Boeing flash-lite is a timing warning',
          lite.some((w) => w.signals.includes('wrong timings')),
          lite.map((w) => `${w.from}-${w.to} ${w.signals.join('+')}`).join('; ') || 'nothing'
        )
        check('G3d Boeing source is fragment-heavy', sourceFragmentNote(srcText) !== null)
        const flash35 = path.join(dir2, 'Flash 3.5', '1788037983296.srt')
        if (fs.existsSync(flash35)) {
          const worse = scanTranslatedOutput(srcText, fs.readFileSync(flash35, 'utf-8'))
          check(
            'G3d Boeing flash 3.5 is a timing warning',
            worse.some((w) => w.signals.includes('wrong timings')),
            worse.map((w) => `${w.from}-${w.to} ${w.signals.join('+')}`).join('; ') || 'nothing'
          )
          if (lite.length >= 1 && worse.length >= 1) {
            check(
              'G3d flash 3.5 drift starts earlier than flash-lite',
              worse[0].from < lite[0].from,
              `3.5 from ${worse[0].from}, lite from ${lite[0].from}`
            )
          }
        }
      }
    }
  }
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
  // A live or hand-stored id can contain a version token without being a canonical Gemini
  // model id. Sampling's unknown default is withhold; substring matching must not override it.
  eq('G5b a noncanonical id with an embedded version is still unrecognised', accepts('gemini-experimental-2.5-flash'), false)
  eq(
    'G5b thinking still follows the engine substring for that id',
    modelCapabilities('gemini-experimental-2.5-flash').thinking,
    'budget'
  )

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

section('G6 — an extracted track is named after itself, not after the target (REP-8)')
{
  const track = (
    index: number,
    lang: string,
    isImage = false
  ): SubtitleTrack => ({ index, lang, name: `Track ${index}`, codec: isImage ? 'hdmv_pgs_subtitle' : 'subrip', isImage })

  const video = 'C:\\Media\\Lone.Survivor.2013.UHD.BluRay.REMUX.mkv'
  const stem = 'Lone.Survivor.2013.UHD.BluRay.REMUX'

  // The reported file: English and Spanish PGS, translating into Hebrew. Before per-track
  // extraction existed, the only reachable track was one whose language equalled the target,
  // which is the sole reason naming the file after the target ever looked right. Opening the
  // feature is what breaks that, so the two land together.
  const reported = [track(2, 'en', true), track(3, 'es', true)]
  eq('G6 an English PGS track is not named after Hebrew', extractedTrackName(video, reported[0], reported), `${stem}_en.sup`)
  eq('G6 the Spanish one carries its own language too', extractedTrackName(video, reported[1], reported), `${stem}_es.sup`)

  // Type is already encoded by the extension, so a text and an image track of the same
  // language do not collide and neither needs an index.
  const mixed = [track(0, 'en'), track(2, 'en', true)]
  eq('G6 a text track of the same language', extractedTrackName(video, mixed[0], mixed), `${stem}_en.srt`)
  eq('G6 does not collide with the image one', extractedTrackName(video, mixed[1], mixed), `${stem}_en.sup`)

  // The narrow real collision: two English PGS streams, full and SDH, as Blu-ray remuxes
  // commonly carry. The first keeps the plain name; later ones carry their index.
  const twoEnglish = [track(2, 'en', true), track(3, 'en', true)]
  eq('G6 the first of two alike tracks keeps the plain name', extractedTrackName(video, twoEnglish[0], twoEnglish), `${stem}_en.sup`)
  eq('G6 the second is distinguished by its index', extractedTrackName(video, twoEnglish[1], twoEnglish), `${stem}_en_3.sup`)

  // An untagged track shows '—' in the panel and would otherwise be saved as `..._.srt`.
  const untagged = [track(1, '')]
  eq('G6 an untagged track falls back to its index', extractedTrackName(video, untagged[0], untagged), `${stem}_track1.srt`)

  // Only the last extension is dropped, so a release name full of dots survives intact.
  eq('G6 a POSIX path keeps only the file name', extractedTrackName('/home/u/My Film (2019).mkv', reported[0], reported), 'My Film (2019)_en.sup')
  eq('G6 a bare file name needs no directory', extractedTrackName('clip.mkv', reported[0], reported), 'clip_en.sup')

  // The translated-subtitle save shares this convention — that is why it is one helper.
  eq('G6 the save path builds the same shape', companionName('C:\\Subs\\Pachinko.S01E01.eng.srt', 'he', '.srt'), 'Pachinko.S01E01.eng_he.srt')
  eq('G6 an ASS job keeps its format', companionName('/x/Show.ass', 'he', '.ass'), 'Show_he.ass')
  eq('G6 and a run with no source path still proposes something', companionName('', 'he', '.srt'), 'subtitle_he.srt')
}

section('G7 — ffmpeg progress is read, never invented (REP-11)')
{
  // The format is ffmpeg's `-progress` output: blocks of key=value ending in progress=continue,
  // or progress=end on the last one. A read has to survive several blocks arriving in one chunk,
  // because the process writes faster than the main process reads.
  const block = (t: string, state = 'continue'): string =>
    `frame=120\nfps=25\nbitrate=N/A\ntotal_size=4096\nout_time_us=${Math.round(
      parseFloat(t) * 1_000_000
    )}\nout_time_ms=${Math.round(parseFloat(t) * 1_000_000)}\nspeed=12x\nprogress=${state}\n`

  eq('G7 a single block reports its position', readProgressChunk(block('12.5')).outTimeSec, 12.5)
  eq('G7 and is not finished', readProgressChunk(block('12.5')).ended, false)
  // The LAST block in a chunk is the current one; the earlier ones are already stale.
  eq(
    'G7 several blocks at once report the newest',
    readProgressChunk(block('10') + block('20') + block('30')).outTimeSec,
    30
  )
  eq('G7 progress=end is recognised', readProgressChunk(block('60', 'end')).ended, true)
  eq('G7 a chunk with no timestamp reports none', readProgressChunk('frame=1\nfps=0\n').outTimeSec, null)
  eq('G7 an empty chunk is harmless', readProgressChunk('').outTimeSec, null)

  // out_time is the unambiguous spelling and wins when both are present. out_time_ms is
  // deliberately never read: it has carried MICROseconds for years, a bug kept for
  // compatibility, so trusting it would report a 90-minute film as finishing in 5 seconds.
  eq(
    'G7 the timestamp spelling is preferred',
    readProgressChunk('out_time_us=1000000\nout_time=00:01:00.000000\nprogress=continue').outTimeSec,
    60
  )
  eq(
    'G7 the millisecond spelling is ignored',
    readProgressChunk('out_time_ms=90000000\nprogress=continue').outTimeSec,
    null
  )

  // A pipe read can end anywhere, including mid-number. `execFfmpeg` carries the remainder
  // to the next chunk for exactly this reason: half of `out_time_us=10000000` parses as a
  // valid 1 second, which is not a missing report but a wrong one — and wrong in the only
  // direction a progress bar must never move. The reader below sees whole lines only.
  const twoBlocks = block('10') + block('30')
  const cut = twoBlocks.lastIndexOf('out_time_us=') + 16 // four digits into the second value
  eq(
    'G7 a chunk cut mid-number would report a time that never happened',
    readProgressChunk(twoBlocks.slice(0, cut)).outTimeSec,
    0.003
  )
  eq(
    'G7 …so trimming to the last line break reports the previous position instead',
    readProgressChunk(twoBlocks.slice(0, twoBlocks.lastIndexOf('\n', cut) + 1)).outTimeSec,
    10
  )

  eq('G7 timestamps carry hours', parseTimestamp('01:02:03.500000'), 3723.5)
  eq('G7 and fractions', parseTimestamp('00:00:00.250000'), 0.25)
  // N/A appears before ffmpeg has decoded anything. Reading it as zero would show a 0% bar
  // for a file that has not started, which is the very state this feature exists to disprove.
  eq('G7 N/A is not a time', parseTimestamp('N/A'), null)
  eq('G7 nor is nothing', parseTimestamp(''), null)
  eq('G7 nor is a bare number', parseTimestamp('12'), null)

  // Duration comes from ffprobe and is allowed to be missing: streams and some remuxes
  // genuinely will not say. That costs a percentage, never an error.
  eq('G7 a duration is read', durationFromProbe('5405.280000\n'), 5405.28)
  eq('G7 an unknown duration is null', durationFromProbe('N/A\n'), null)
  eq('G7 as is an empty answer', durationFromProbe(''), null)
  eq('G7 and a zero one', durationFromProbe('0.000000'), null)

  eq('G7 the percentage is whole', percentOf(2702.64, 5405.28), 50)
  eq('G7 it starts at zero', percentOf(0, 5405.28), 0)
  // Capped below 100 while the process is alive: ffmpeg routinely reports a position at or
  // past the nominal duration near the end, and a bar reading 100% for another minute is
  // exactly the "it is stuck" complaint in a different costume.
  eq('G7 it never reaches 100 while running', percentOf(5405.28, 5405.28), 99)
  eq('G7 nor beyond it', percentOf(9999, 5405.28), 99)
  eq('G7 no duration means no percentage', percentOf(120, null), null)
  eq('G7 a nonsense duration means the same', percentOf(120, 0), null)
}

section('G8a — the command line is shown, the keys are not (MAN-7)')
{
  const KEY = 'AIzaSyD-1234567890abcdefghijklmnopqrstu'
  const KEY2 = 'AIzaSyC-0987654321zyxwvutsrqponmlkjihg'

  const line = maskCommandLine('C:\\App\\resources\\bin\\gst.exe', [
    'translate', '-i', 'C:\\Subs\\My Show.srt', '-o', 'C:\\out.srt',
    '-k', KEY, '-k2', KEY2, '-m', 'gemini-3.7-flash', '--paid-quota', '--no-resume'
  ])
  check('G8a neither key appears anywhere in the line', !line.includes(KEY) && !line.includes(KEY2), line)
  check('G8a both are shown as masked', (line.match(/\*\*\*/g) ?? []).length === 2, line)
  check('G8a the flags themselves are still visible', line.includes('-k ***') && line.includes('-k2 ***'), line)
  // The whole point of the line: these are the questions three checklist rows ask and the app
  // has never been able to answer.
  check('G8a --paid-quota is observable', line.includes('--paid-quota'), line)
  check('G8a so is the model', line.includes('-m gemini-3.7-flash'), line)
  check('G8a and the engine that will run it', line.startsWith('C:\\App\\resources\\bin\\gst.exe'), line)
  check('G8a a path with spaces stays one argument', line.includes('"C:\\Subs\\My Show.srt"'), line)

  // Masking is POSITIONAL. A key of an unexpected shape — Google has changed key formats
  // before — must be masked because of where it sits, never because of what it looks like.
  const odd = maskCommandLine('gst', ['transcribe', '-k', 'not-a-key-at-all'])
  check('G8a a key that does not look like one is still masked', !odd.includes('not-a-key-at-all'), odd)

  // …and the converse: nothing is masked for merely resembling a key.
  const description = maskCommandLine('gst', ['translate', '-d', 'Set in AIzaSy, a fictional town'])
  check(
    'G8a an argument that merely resembles a key is left alone',
    description.includes('AIzaSy, a fictional town'),
    description
  )

  // The exact-match sweep: a user who pasted their key into the description would otherwise
  // have it printed back at them in full, positional masking notwithstanding.
  const pasted = maskCommandLine('gst', ['translate', '-k', KEY, '-d', `use ${KEY} please`])
  check('G8a a key repeated elsewhere is redacted there too', !pasted.includes(KEY), pasted)
  check('G8a and the rest of that argument survives', pasted.includes('use *** please'), pasted)

  // Short values are masked positionally but never swept, because blanket-replacing two
  // characters would corrupt unrelated arguments and protect nothing that could be a key.
  const shortKey = maskCommandLine('gst', ['translate', '-k', 'ab', '-m', 'gemini-flash-ab'])
  check('G8a a short key is still masked in place', !/-k ab\b/.test(shortKey), shortKey)
  check('G8a but an unrelated argument is not mangled', shortKey.includes('gemini-flash-ab'), shortKey)

  // Malformed argv must not consume what is not there: a trailing -k would otherwise swallow
  // the next flag and print the key that follows it.
  const trailing = maskCommandLine('gst', ['translate', '-k'])
  eq('G8a a flag with no value masks nothing', trailing, 'gst translate -k')
  const joined = maskCommandLine('gst', ['translate', `-k=${KEY}`])
  check('G8a the -k=value form is masked too', !joined.includes(KEY), joined)

  // The real argv, from the real builder, is the only fixture that proves the emitted line is
  // safe — a hand-written array cannot notice a future flag that carries a credential.
  setSettings({ apiKeys: [KEY, KEY2], apiKeyValid: [true, true], apiKeyTiers: ['paid', 'free'] })
  const realArgs = buildTranslateArgs(
    {
      inputFile: 'in.srt', sourceLang: 'auto', targetLang: 'he', model: 'gemini-2.5-flash',
      apiKeys: [KEY, KEY2], batchSize: 100, batchContext: true, customGenerationParams: false,
      temperature: 0.7, topP: 0.95, topK: 40, thinkingLevel: 'default', thinkingBudget: 0,
      serviceTier: 'standard', paidQuota: true, disableStreaming: false,
      writeTokenReport: false, progressLog: false, thoughtsLog: false
    } as TranslateArgs,
    'out.srt'
  )
  const realLine = maskCommandLine('gst', realArgs)
  check('G8a the real argv builder leaks no key either', !realLine.includes(KEY) && !realLine.includes(KEY2), realLine)
  check('G8a and its --paid-quota is visible', realLine.includes('--paid-quota'), realLine)

  // SOL-20. Transcription emits only `-k`. A reserve that appears in `-d` is not positional,
  // so it is only redacted when supplied as an extra secret (every configured key for the run).
  const RESERVE = 'AIzaSyReserveKeyForSOL20xxxx'
  const leaked = maskCommandLine('gst', ['transcribe', '-k', KEY, '-d', `use ${RESERVE} in the show`])
  check('G8a a reserve not on argv is visible without extra secrets', leaked.includes(RESERVE), leaked)
  const redacted = maskCommandLine(
    'gst',
    ['transcribe', '-k', KEY, '-d', `use ${RESERVE} in the show`],
    [KEY, RESERVE]
  )
  check('G8a and is gone once configured keys are supplied', !redacted.includes(RESERVE), redacted)
  check('G8a while the rest of the description survives', redacted.includes('use *** in the show'), redacted)

  setSettings({ apiKeys: [], apiKeyValid: [], apiKeyTiers: [] })
}

section('G8b — a run that stops getting anywhere is ended (REP-2)')
{
  /** The measured storm: an alternating block, in more than one wording, forever. */
  const STORM = [
    '\x1b[F\x1b[K\x1b[F\x1b[KTranscribing: |████| 0% (00:00:00,000/00:00:10,001) gemini-2.5-flash-lite',
    'Transcribing audio segment 00:00 to 00:10.',
    "An unexpected error occurred: 400 invalid_argument. {'error': {'code': 400, 'message': 'api key not valid. please pass a valid api key.', 'status': 'invalid_argument'}}. Retrying immediately...",
    'Transcribing: |████| 0% (00:00:00,000/00:00:10,001) gemini-2.5-flash-lite',
    "An unexpected error occurred: 401 UNAUTHENTICATED. {'error': {'code': 401, 'reason': 'ACCESS_TOKEN_TYPE_UNSUPPORTED'}}. Retrying immediately..."
  ]

  // The rule the first design got wrong, and the reason this is a gate rather than a manual
  // check: no two error lines are ever adjacent, so a consecutive-identical counter never
  // reaches 2 — let alone N — against this exact input.
  {
    let adjacent = 0
    for (let i = 1; i < 400; i++) if (STORM[i % STORM.length] === STORM[(i - 1) % STORM.length]) adjacent++
    eq('G8b no line in the storm ever repeats consecutively', adjacent, 0)
  }

  {
    const watch = createStallWatch()
    let verdict: ReturnType<typeof watch.observe> = null
    let at = 0
    // 25 lines per second, which is the measured rate. The loop has to outlast the QUIET
    // period rather than the line count — at this rate 500 lines is twenty seconds, so the
    // minute of silence is what decides, and a shorter loop reports a false failure.
    for (let i = 0; i < TIER1_LINES * 5 && !verdict; i++) {
      verdict = watch.observe(STORM[i % STORM.length], i * 40)
      if (verdict) at = i
    }
    check('G8b the recorded storm is caught', verdict !== null)
    eq('G8b by tier 1, because the cause is recognised', verdict?.tier, 1)
    check('G8b and the message names it', /invalid/i.test(verdict?.message ?? ''), verdict?.message)
    // Both conditions must hold: at 40 ms a line, 500 lines is 20 seconds, so the minute of
    // quiet is what decides. A cheaper budget would kill a slow but working run.
    check('G8b not before the quiet period has elapsed', at * 40 >= TIER1_QUIET_MS, `${at} lines`)
    check('G8b and only once', watch.observe(STORM[0], (at + 1) * 40) === null)
  }

  // Tier 1 needs a recognised marker. The same shape of loop without one survives to tier 2.
  {
    const watch = createStallWatch()
    const dull = ['Working…', 'Still working…', 'Working…']
    let verdict: ReturnType<typeof watch.observe> = null
    for (let i = 0; i < TIER1_LINES * 2 && !verdict; i++) verdict = watch.observe(dull[i % dull.length], i * 1000)
    check('G8b an unrecognised loop is not caught by tier 1', verdict === null)
  }
  {
    const watch = createStallWatch()
    const dull = ['Working…', 'Still working…']
    let verdict: ReturnType<typeof watch.observe> = null
    // Ten minutes at ten lines a second is 6,000 lines, which passes both tier-2 conditions.
    for (let i = 0; i < 7000 && !verdict; i++) verdict = watch.observe(dull[i % dull.length], i * 100)
    check('G8b but tier 2 catches it with no pattern at all', verdict !== null)
    eq('G8b as tier 2', verdict?.tier, 2)
  }

  // The false positives that would destroy a paid, half-finished run.
  {
    const watch = createStallWatch()
    let verdict: ReturnType<typeof watch.observe> = null
    // A healthy run: the same status block redrawn — including a historical 400 — with a
    // new segment each cycle. Display-line recurrence of that 400 is not a retry (SOL-56).
    for (let i = 0; i < 20_000 && !verdict; i++) {
      const cycle = i % 4
      const line =
        cycle === 3
          ? `Transcribing audio segment ${String(i).padStart(6, '0')}.`
          : STORM[cycle]
      verdict = watch.observe(line, i * 40)
    }
    check('G8b a run that keeps producing new lines is never ended', verdict === null)
  }
  {
    const watch = createStallWatch()
    // Silence: a long thinking pause or a slow API call produces NO lines, so no counter
    // advances. Both tiers require a high line count precisely so this is safe.
    const verdict = watch.observe('Waiting for the model…', 0)
    check('G8b a run that goes quiet for an hour is untouched', verdict === null)
    check('G8b even when the next line arrives an hour later', watch.observe('Waiting for the model…', 3_600_000) === null)
  }
  {
    const watch = createStallWatch()
    let verdict: ReturnType<typeof watch.observe> = null
    // An auth error followed by real work is a run that recovered — the marker must not
    // survive the novelty that follows it.
    for (let i = 0; i < 400; i++) verdict = watch.observe(STORM[i % STORM.length], i * 40) ?? verdict
    for (let i = 0; i < 400 && !verdict; i++) verdict = watch.observe(`Batch ${i} translated.`, 20_000 + i * 40)
    for (let i = 0; i < 400 && !verdict; i++) verdict = watch.observe(STORM[i % 2], 40_000 + i * 40)
    check('G8b a recovered run does not carry its old error into the budget', verdict === null)
  }
  {
    // REP-30: sixty distinct quota-wait ticks are one back-off, not sixty steps of progress.
    // Interleaved with the recorded 400 they used to reset the budget every second.
    const watch = createStallWatch()
    let verdict: ReturnType<typeof watch.observe> = null
    let at = 0
    const cycle = (i: number): string => {
      const step = i % 62
      if (step === 0) return STORM[2]
      if (step === 1) return 'Transcribing audio segment 00:00 to 05:00.'
      return `All API quotas exceeded, waiting ${62 - step} seconds...`
    }
    for (let i = 0; i < TIER1_LINES * 5 && !verdict; i++) {
      verdict = watch.observe(cycle(i), i * 40)
      if (verdict) at = i
    }
    check('G8b a quota countdown does not reset the novelty budget', verdict !== null)
    eq('G8b and the countdown storm is still tier 1', verdict?.tier, 1)
    check('G8b and it still waits out the quiet period', at * 40 >= TIER1_QUIET_MS, `${at} lines`)
  }
  {
    // REP-30: a 400 that is newly worded every time (request id, wrapping) is not progress.
    const watch = createStallWatch()
    let verdict: ReturnType<typeof watch.observe> = null
    let at = 0
    for (let i = 0; i < TIER1_LINES * 5 && !verdict; i++) {
      verdict = watch.observe(
        `An unexpected error occurred: 400 invalid_argument. request ${i}. Retrying immediately...`,
        i * 40
      )
      if (verdict) at = i
    }
    check('G8b a newly worded 400 is not treated as progress', verdict !== null)
    eq('G8b and unique wrapping still dies at tier 1', verdict?.tier, 1)
    check('G8b and unique wrapping still waits out the quiet period', at * 40 >= TIER1_QUIET_MS, `${at} lines`)
  }
  {
    // SOL-56: the engine redraws its message history, so one recovered 400 can reappear
    // every second while real batches continue. That is not 60 retry attempts.
    const watch = createStallWatch()
    let verdict: ReturnType<typeof watch.observe> = null
    for (let i = 0; i < 180 && !verdict; i++) {
      const t = i * 1_000
      watch.observe(`Batch ${i} translated.`, t)
      verdict = watch.observe(STORM[2], t + 1)
    }
    check('G8b a historical 400 redrawn beside new work does not end the run', verdict === null)
  }
  {
    // Digit-stripping the novelty key would collapse 18k healthy segment lines into one
    // key and let tier 2 kill a paid run. The quota-wait rule must not generalise.
    const watch = createStallWatch()
    let verdict: ReturnType<typeof watch.observe> = null
    for (let i = 0; i < 6_000 && !verdict; i++) {
      verdict = watch.observe(`Transcribing audio segment ${i} to ${i + 10}.`, i * 100)
    }
    check('G8b collapsing every digit would have killed this run', verdict === null)
  }
  {
    // Only `user` reads as Stopped. A budget termination has to read as a failure with a
    // cause, or the user is told they pressed a button they did not press.
    eq('G8b a stalled run is reported as failed', terminalState(-1, 'stalled').statusText, 'Failed')
    eq('G8b and a refused one too', terminalState(-1, 'guard').statusText, 'Failed')
    eq('G8b while a real Stop still reads as Stopped', terminalState(-1, 'user').statusText, 'Stopped')
  }
}

section('G8c — an unreachable key is not an invalid key (MAN-4)')
{
  // The persisted verdict is where MAN-4 began: every failure, including a DNS error, was
  // stored as `false` — the identical value a rejected key gets.
  eq('G8c a rejected key is rejected', classifyFetchFailure('400 api key not valid. please pass a valid api key.', false).verdict, 'rejected')
  eq('G8c so is a 401', classifyFetchFailure('401 UNAUTHENTICATED', false).verdict, 'rejected')
  eq('G8c and a 403', classifyFetchFailure('PERMISSION_DENIED: 403', false).verdict, 'rejected')
  eq('G8c a DNS failure proves nothing about the key', classifyFetchFailure('getaddrinfo ENOTFOUND generativelanguage.googleapis.com', false).verdict, 'unchecked')
  eq('G8c nor does a timeout', classifyFetchFailure('', true).verdict, 'unchecked')
  // A 429 means the key is real, working, and merely busy. Calling that invalid would demote
  // a perfectly good key in the spawn ranking.
  eq('G8c nor does exhausted quota', classifyFetchFailure('429 RESOURCE_EXHAUSTED: quota', false).verdict, 'unchecked')
  eq('G8c and an unrecognised failure defaults to proving nothing', classifyFetchFailure('something went sideways', false).verdict, 'unchecked')
  check(
    'G8c the offline message does not accuse the key',
    !/invalid/i.test(classifyFetchFailure('getaddrinfo ENOTFOUND', false).error),
    classifyFetchFailure('getaddrinfo ENOTFOUND', false).error
  )

  // The three keys of the report, offline: none rejected, none checked.
  const offline = ['unchecked', 'unchecked', 'unchecked'] as const
  const counts = countKeyStates([...offline])
  eq('G8c nothing is counted as invalid', counts.rejected, 0)
  const headline = keyHeadline(counts, null)
  check('G8c and the headline does not say "no valid keys"', !/no valid keys/i.test(headline.text), headline.text)
  check('G8c nor calls anything invalid', !/invalid/i.test(headline.text), headline.text)
  // Both spellings are natural English and both appear — "None of your keys could be checked"
  // in the plural, "This key could not be checked" in the singular. What is being asserted is
  // that the sentence is about the CHECK, which is the fact, rather than about the keys.
  check('G8c it says the check failed, not the keys', /be checked/i.test(headline.text), headline.text)
  // One key offline is the same fact in the singular, and the old copy got that wrong too.
  check(
    'G8c a single unreachable key reads in the singular',
    /^This key could not be checked/.test(keyHeadline(countKeyStates(['unchecked']), null).text),
    keyHeadline(countKeyStates(['unchecked']), null).text
  )

  // The sentence that was ungrammatical for a list and wrong for a reserve.
  eq(
    'G8c two active keys are described in the plural',
    uncheckedNote([0, 1], [0, 1]),
    'Keys 1 and 2 could not be checked, and a run would use them.'
  )
  eq(
    'G8c a lone reserve is described as a reserve',
    uncheckedNote([2], [0, 1]),
    'Key 3 could not be checked; it is a reserve, so runs are unaffected.'
  )
  check(
    'G8c a mixed list splits rather than mislabelling either',
    uncheckedNote([0, 2], [0, 1]) ===
      'Key 1 could not be checked, and a run would use it. Key 3 could not be checked; it is a reserve, so runs are unaffected.',
    uncheckedNote([0, 2], [0, 1])
  )
  eq('G8c the list grammar', listKeyNumbers([0, 1, 2]), '1, 2 and 3')

  // The ordinary cases still read as they did.
  eq('G8c a valid key still reports valid', keyStateOf(true, true), 'valid')
  eq('G8c a rejected one still earns its ✗', keyStateOf(true, false), 'rejected')
  eq('G8c an empty slot is not a state', keyStateOf(false, null), 'blank')
  check(
    'G8c a good check still reads as before',
    keyHeadline(countKeyStates(['valid', 'valid', 'rejected']), 12).text === '✓ 2 of 3 keys valid — 12 models available.',
    keyHeadline(countKeyStates(['valid', 'valid', 'rejected']), 12).text
  )
  eq('G8c and a genuinely rejected set still says so', keyHeadline(countKeyStates(['rejected']), null).tone, 'bad')
}

section('G8d — a check that proves nothing does not undo what was proven (FP7-V01)')
{
  const queried = (n: number): SlotFetchResult[] =>
    Array.from({ length: n }, (_, slot) => ({ slot, queried: true, ok: false, ids: [] }))
  const prior = (valid: boolean | null, error = '', sameKey = true): PriorVerdict => ({ valid, error, sameKey })
  const unchecked: KeyCheck = { valid: null, error: 'Could not reach Google. Check your internet connection and try again.' }

  // The defect: `false` is the one verdict that REMOVES a key from the pool, so erasing it
  // without contrary evidence changes what a run does. Asserted through the ranking rather
  // than through the field, because the ranking is what the defect was actually about.
  const rank = (valid: boolean | null): number[] =>
    orderKeySlots([{ index: 0, valid, tier: 'free' }, { index: 1, valid: null, tier: 'free' }])
  eq('G8d a proven-dead key is dropped from the pool', JSON.stringify(rank(false)), JSON.stringify([1]))
  eq('G8d and an unchecked one is not', JSON.stringify(rank(null)), JSON.stringify([0, 1]))

  const kept = keepProvenRejections([unchecked], queried(1), [prior(false, 'Invalid API key.')])
  eq('G8d so an offline check keeps the rejection', kept[0].valid, false)
  eq('G8d with the refusal, not the network error, beside it', kept[0].error, 'Invalid API key.')
  eq(
    'G8d and the key stays out of the pool',
    JSON.stringify(rank(kept[0].valid)),
    JSON.stringify([1])
  )

  // The asymmetry, and the reason for it: retaining `true` would answer a failed check with
  // "✓ N of N keys valid" — MAN-4's own report with the polarity flipped.
  const decayed = keepProvenRejections([unchecked], queried(1), [prior(true, '')])
  eq('G8d a valid verdict is allowed to decay to unchecked', decayed[0].valid, null)
  check(
    'G8d because retaining it would claim a check that did not happen',
    /be checked/i.test(keyHeadline(countKeyStates([keyStateOf(true, decayed[0].valid)]), null).text),
    keyHeadline(countKeyStates([keyStateOf(true, decayed[0].valid)]), null).text
  )
  eq(
    'G8d and it costs nothing operationally — both are usable',
    JSON.stringify(rank(decayed[0].valid)),
    JSON.stringify([0, 1])
  )

  // Evidence always wins, in both directions.
  eq(
    'G8d a fresh rejection overwrites a stored pass',
    keepProvenRejections([{ valid: false, error: 'Invalid API key.' }], queried(1), [prior(true)])[0].valid,
    false
  )
  eq(
    'G8d and a fresh pass clears a stored rejection',
    keepProvenRejections([{ valid: true, error: '' }], queried(1), [prior(false, 'Invalid API key.')])[0].valid,
    true
  )
  eq(
    'G8d with its error',
    keepProvenRejections([{ valid: true, error: '' }], queried(1), [prior(false, 'Invalid API key.')])[0].error,
    ''
  )

  // A retained verdict must never outlive the credential it was about.
  eq(
    'G8d an edited key does not inherit the old key\u2019s rejection',
    keepProvenRejections([unchecked], queried(1), [prior(false, 'Invalid API key.', false)])[0].valid,
    null
  )
  eq(
    'G8d and an emptied slot does not either',
    keepProvenRejections([{ valid: null, error: '' }], [{ slot: 0, queried: false, ok: false, ids: [] }], [
      prior(false, 'Invalid API key.')
    ])[0].valid,
    null
  )
  eq(
    'G8d a slot with nothing stored is unaffected',
    keepProvenRejections([unchecked], queried(1), [prior(null)])[0].valid,
    null
  )
  eq(
    'G8d as is one with no stored entry at all',
    keepProvenRejections([unchecked], queried(1), [])[0].valid,
    null
  )

  // MAN-4's actual report: three keys, all previously valid, one network outage. This is the
  // case the fix must not disturb, and the one that rules out merging every verdict.
  const outage = keepProvenRejections(
    [unchecked, unchecked, unchecked],
    queried(3),
    [prior(true), prior(true), prior(true)]
  )
  check('G8d MAN-4 unchanged: nothing is branded invalid', outage.every((r) => r.valid !== false))
  check('G8d MAN-4 unchanged: nothing claims to be valid either', outage.every((r) => r.valid === null))
  const outageStates = outage.map((r) => keyStateOf(true, r.valid))
  eq('G8d MAN-4 unchanged: the headline still reports on the check', keyHeadline(countKeyStates(outageStates), null).tone, 'warn')

  // The mixed list, which is where a blanket merge and this rule differ most visibly.
  const mixed = keepProvenRejections(
    [unchecked, unchecked],
    queried(2),
    [prior(true), prior(false, 'Invalid API key.')]
  )
  eq('G8d a mixed list keeps only the rejection', JSON.stringify(mixed.map((r) => r.valid)), JSON.stringify([null, false]))
  eq(
    'G8d so the good key leads and the dead one is gone',
    JSON.stringify(
      orderKeySlots([
        { index: 0, valid: mixed[0].valid, tier: 'free' },
        { index: 1, valid: mixed[1].valid, tier: 'free' }
      ])
    ),
    JSON.stringify([0])
  )
  eq(
    'G8d an all-rejected set is empty, not a last-resort pool',
    JSON.stringify(orderKeySlots([{ index: 0, valid: false, tier: 'free' }])),
    JSON.stringify([])
  )
}

section('G8e — a result may not be applied to keys it was not learned from (FP7-R01)')
{
  // Everything a check produces is addressed by SLOT INDEX and carries no trace of the key
  // it came from, so applying it to a changed key set writes one credential's verdict, error
  // and model evidence onto another.
  const asked = ['AIzaKEY-one', 'AIzaKEY-two', '']

  check('G8e an untouched snapshot is applied', !keySnapshotChanged(asked, [...asked]))
  check('G8e an edited key discards the result', keySnapshotChanged(asked, ['AIzaKEY-one', 'AIzaKEY-CHANGED', '']))
  check('G8e so does editing the one being checked first', keySnapshotChanged(asked, ['AIzaKEY-NEW', 'AIzaKEY-two', '']))
  check('G8e a cleared key discards it', keySnapshotChanged(asked, ['AIzaKEY-one', '', '']))
  check('G8e an added key discards it', keySnapshotChanged(asked, [...asked, 'AIzaKEY-three']))
  // Removal is the sharpest case: every slot above it renumbers, so a late write lands
  // wholesale on the wrong keys.
  check('G8e and a removed key discards it', keySnapshotChanged(asked, ['AIzaKEY-two', '']))
  // Reordering is not detectable by length, and it is exactly what "by slot index" breaks on.
  check('G8e reordering the same keys still discards', keySnapshotChanged(asked, ['AIzaKEY-two', 'AIzaKEY-one', '']))
  // Not over-eager: discarding a minute of checking needs a reason. A tier is not part of
  // what a check learns, is not persisted by it, and is not ranked on.
  check('G8e an empty configuration compares equal to itself', !keySnapshotChanged([], []))
  check('G8e and a whitespace difference is a real difference', keySnapshotChanged([' k'], ['k']))
}

section('G9a — the console log keeps both ends of a run it has to cut (REP-1/REP-3)')
{
  // Tiny limits so the cut is reached in a few lines. The policy is a function of the limits,
  // not of the defaults, which is the whole reason they are a parameter.
  const chunks: string[] = []
  const log = createConsoleLog((c) => chunks.push(c), { headBytes: 40, tailBytes: 40 })
  for (let i = 1; i <= 60; i++) log.write(`line ${i}`)
  log.close()
  const file = chunks.join('')

  // The head streams as it happens, so it is on disk even if nothing ever closes the file.
  check('G9a the run starts at the start', file.startsWith('line 1\nline 2\n'))
  check('G9a the cut is announced', file.includes(CONSOLE_LOG_TRUNCATION_MARK))
  // The point of the whole exercise: a run long enough to be cut is a run that went wrong, and
  // what went wrong is at the end.
  check('G9a the ending survives the cut', file.trimEnd().endsWith('line 60'))
  check('G9a and the middle is honestly reported missing', /\d+ line\(s\) from the middle/.test(file))
  // A ceiling that can be exceeded by ten thousand lines is not a ceiling. Head + tail + one
  // marker is the entire budget, whatever the run does.
  check(
    'G9a the file cannot grow with the run',
    file.length < 400,
    `${file.length} bytes for 60 lines`
  )
  // Nothing is invented and nothing is reordered — this file is the console, verbatim.
  check('G9a no line is rewritten', file.includes('line 1\n') && file.includes('line 60\n'))
  check('G9a and none is duplicated across the cut', file.split('line 60\n').length === 2)

  // A run that never reaches the ceiling gets no marker and no ceremony.
  const small: string[] = []
  const quiet = createConsoleLog((c) => small.push(c), { headBytes: 4096, tailBytes: 4096 })
  quiet.write('only line')
  quiet.close()
  check('G9a a short run is written whole', small.join('') === 'only line\n')

  // `close()` runs from `finish()`, which several racing paths can reach for the same job.
  const twice: string[] = []
  const closed = createConsoleLog((c) => twice.push(c), { headBytes: 8, tailBytes: 64 })
  closed.write('aaaaaaaaaaaaaaaa')
  closed.write('bbbb')
  closed.close()
  const after = twice.join('')
  closed.close()
  closed.write('cccc')
  check('G9a closing twice is closing once', twice.join('') === after)
  check('G9a and a line after the end is refused', !twice.join('').includes('cccc'))
}

section('G9d — one line cannot step over the ceiling the other lines respect')
{
  // The hole this closes: both the head and the tail decide whether to take a line BEFORE seeing
  // how big it is, so a single line arriving with budget left was written whole at any size —
  // and `run()` turns an entire newline-free chunk into exactly one line.
  const flood: string[] = []
  const log = createConsoleLog((c) => flood.push(c), { headBytes: 200, tailBytes: 200, lineBytes: 64 })
  log.write('a'.repeat(100_000))
  log.close()
  const file = flood.join('')

  check('G9d the long line is cut, not written', file.length < 300, `${file.length} bytes`)
  check('G9d it is cut to its own budget', file.split('\n')[0].startsWith('a'.repeat(64)))
  check('G9d not one byte further', !file.includes('a'.repeat(65)))
  check('G9d and the cut is admitted, with its size', /\[log truncated\] 99936 more character\(s\)/.test(file))

  // The ceiling is only a ceiling if it holds for a run made ENTIRELY of such lines.
  const many: string[] = []
  const flooded = createConsoleLog((c) => many.push(c), { headBytes: 200, tailBytes: 200, lineBytes: 64 })
  for (let i = 0; i < 500; i++) flooded.write('b'.repeat(50_000))
  flooded.close()
  check(
    'G9d five hundred of them still fit under it',
    many.join('').length < 1200,
    `${many.join('').length} bytes for 500 x 50 KB`
  )

  // Cutting at an arbitrary byte would put half a character — a replacement character — into a
  // file whose whole value is being a faithful record. 'é' is two bytes, so a 9-byte budget has
  // to stop at four of them and refuse the fifth rather than emit its first byte alone.
  const utf8: string[] = []
  const chars = createConsoleLog((c) => utf8.push(c), { headBytes: 4096, tailBytes: 4096, lineBytes: 9 })
  chars.write('é'.repeat(20))
  chars.close()
  const cut = utf8.join('').split(' [log truncated]')[0]
  check('G9d a multi-byte character is never split', !cut.includes('\uFFFD'), JSON.stringify(cut))
  check('G9d the cut lands on a character boundary', cut === 'é'.repeat(4), JSON.stringify(cut))

  // Surrogate pairs are the same hazard one level up: two code units, four bytes, and slicing
  // the string rather than the bytes would leave a lone surrogate behind.
  const astral: string[] = []
  const emoji = createConsoleLog((c) => astral.push(c), { headBytes: 4096, tailBytes: 4096, lineBytes: 10 })
  emoji.write('😀'.repeat(20))
  emoji.close()
  const emojiCut = astral.join('').split(' [log truncated]')[0]
  check('G9d a surrogate pair survives the cut whole', emojiCut === '😀'.repeat(2), JSON.stringify(emojiCut))

  // And the lines that actually occur are still the bytes the engine sent, unexamined.
  const plain: string[] = []
  const ordinary = createConsoleLog((c) => plain.push(c))
  ordinary.write('Translating batch 3 of 40…')
  ordinary.close()
  check('G9d an ordinary line is untouched', plain.join('') === 'Translating batch 3 of 40…\n')

  // A default-limits log has a stated ceiling; it is worth one assertion that it is a real number
  // and that the per-line limit is the small one of the three.
  check(
    'G9d the per-line budget is the smallest of them',
    DEFAULT_CONSOLE_LOG_LIMITS.lineBytes < DEFAULT_CONSOLE_LOG_LIMITS.tailBytes &&
      DEFAULT_CONSOLE_LOG_LIMITS.tailBytes < DEFAULT_CONSOLE_LOG_LIMITS.headBytes
  )
}

section('G9e — the console file drops terminal chrome and counts redraws (REP-26)')
{
  check('G9e ANSI cursor junk is stripped', stripAnsi('\x1b[F\x1b[Khello') === 'hello')
  check('G9e a transcribe bar is chrome', isBarFrame('Transcribing: |████░░░░| 50%'))
  check('G9e a translating bar is still chrome', isBarFrame('Translating: |--|'))
  check('G9e an empty bar gutter is still chrome', isBarFrame('Transcribing: |'))
  check('G9e a batch line is not chrome', !isBarFrame('Translating batch 3 of 40…'))
  check(
    'G9e a warning that happens to contain a block character is not chrome',
    !isBarFrame('WARNING: glyph █ in the filename')
  )
  check(
    'G9e a CR-overwritten bar is still a bar after chrome strip',
    isBarFrame(stripTerminalChrome('old text\rTranscribing: |████| 1%'))
  )
  check(
    'G9e a token tally parses',
    JSON.stringify(parseTokenLine('Prompt Tokens: 10 | Thoughts Tokens: 2 | Output Tokens: 3 | Total Tokens: 15')) ===
      JSON.stringify({ prompt: 10, thoughts: 2, output: 3, total: 15 })
  )
  check(
    'G9e carriage-return keeps the last overwrite',
    stripTerminalChrome('first\rsecond') === 'second'
  )

  const frame = Array.from({ length: 11 }, (_, i) => `engine message ${i + 1}`)
  const flood: string[] = []
  const folded = createConsoleLog((c) => flood.push(c), { headBytes: 4096, tailBytes: 4096 })
  for (let i = 0; i < 50; i++) for (const l of frame) folded.write(l)
  folded.close()
  const foldedFile = flood.join('')
  check('G9e an 11-line frame is written once', foldedFile.startsWith(frame.map((l) => `${l}\n`).join('')))
  check('G9e the other 49 draws are a counter', foldedFile.includes('[redrawn 49 times]'))
  eq('G9e each message still appears once', foldedFile.split('engine message 1\n').length - 1, 1)
  check('G9e a distinct-line flood is not this', !foldedFile.includes('engine message 12'))

  const preamble: string[] = []
  const afterApp = createConsoleLog((c) => preamble.push(c), { headBytes: 8192, tailBytes: 8192 })
  afterApp.write('$ gst translate -i episode.srt -k ***')
  afterApp.write('Starting engine…')
  for (let i = 0; i < 50; i++) for (const l of frame) afterApp.write(l)
  afterApp.close()
  const afterAppFile = preamble.join('')
  check(
    'G9e the app preamble survives a later engine flood',
    afterAppFile.startsWith('$ gst translate -i episode.srt -k ***\nStarting engine…\n')
  )
  check(
    'G9e an 11-line frame after that preamble is still written once',
    afterAppFile.split('engine message 1\n').length - 1 === 1
  )
  check(
    'G9e and the other 49 draws are still a counter (SOL-57)',
    afterAppFile.includes('[redrawn 49 times]')
  )
  eq('G9e the command line is not eaten by the fold', afterAppFile.split('$ gst translate').length - 1, 1)

  const distinct: string[] = []
  const unique = createConsoleLog((c) => distinct.push(c), { headBytes: 4096, tailBytes: 4096 })
  for (let i = 1; i <= 20; i++) unique.write(`line ${i} ${'x'.repeat(20)}`)
  unique.close()
  const uniqueFile = distinct.join('')
  check('G9e twenty distinct lines are twenty lines', uniqueFile.split('\n').filter(Boolean).length === 20)
  check('G9e and they are not counted as redraws', !uniqueFile.includes('[redrawn'))

  const esc = '\x1b[F\x1b[K'
  const ansi: string[] = []
  const growing = createConsoleLog((c) => ansi.push(c), { headBytes: 8192, tailBytes: 8192 })
  growing.write('$ gst transcribe -i episode.mp3')
  growing.write('Starting engine…')
  const history = Array.from({ length: 8 }, (_, i) => `history line ${i + 1}`)
  const draws = [2, 2, 2, 3, 2, 2, 2, 3]
  draws.forEach((d, i) => {
    for (let k = 0; k < d; k++) {
      for (const msg of history.slice(0, i + 1)) growing.write(`${esc}${msg}`)
      growing.write(`${esc}Transcribing: |${'█'.repeat(4)}${'░'.repeat(4)}| ${i + 1}0%`)
      growing.write(
        `${esc}Prompt Tokens: ${10 + i} | Thoughts Tokens: 1 | Output Tokens: 2 | Total Tokens: ${13 + i}`
      )
    }
  })
  growing.write('[run ended: exit code 0]')
  growing.close()
  const grown = ansi.join('')
  check('G9e growing ANSI frames leave no ESC bytes', !grown.includes('\x1b'))
  check('G9e growing still keeps the preamble', grown.startsWith('$ gst transcribe -i episode.mp3\nStarting engine…\n'))
  for (const msg of history) {
    check(`G9e ${msg} lands once`, grown.split(`${msg}\n`).length - 1 === 1)
  }
  check('G9e the bar never lands', !grown.includes('Transcribing: |'))
  check('G9e a redraw counter is present', grown.includes('[redrawn '))
  check(
    'G9e the last token tally survives, then the ending',
    /Prompt Tokens: 17 \| Thoughts Tokens: 1 \| Output Tokens: 2 \| Total Tokens: 20\n\[run ended: exit code 0\]\n$/.test(
      grown
    )
  )
  check('G9e earlier token tallies are not kept', !grown.includes('Prompt Tokens: 10 |'))

  const blanks: string[] = []
  const gap = createConsoleLog((c) => blanks.push(c), { headBytes: 4096, tailBytes: 4096 })
  gap.write('keep')
  gap.write('')
  gap.write('')
  gap.write('   ')
  gap.write('after')
  gap.close()
  check('G9e a run of blanks collapses to one', blanks.join('') === 'keep\n\nafter\n')

  const cr: string[] = []
  const overwrite = createConsoleLog((c) => cr.push(c), { headBytes: 4096, tailBytes: 4096 })
  overwrite.write('first\rsecond')
  overwrite.close()
  check('G9e an in-place CR overwrite keeps the last text', cr.join('') === 'second\n')

  const mismatch: string[] = []
  const retry = createConsoleLog((c) => mismatch.push(c), { headBytes: 4096, tailBytes: 4096 })
  retry.write('Retrying immediately...')
  retry.write('Batch 1 failed')
  retry.write('Retrying immediately...')
  retry.write('Batch 2 failed')
  retry.close()
  check(
    'G9e a repeated prefix with new context is not dropped (SOL-60)',
    mismatch.join('') ===
      'Retrying immediately...\nBatch 1 failed\nRetrying immediately...\nBatch 2 failed\n'
  )

  const mid: string[] = []
  const dangling = createConsoleLog((c) => mid.push(c), { headBytes: 4096, tailBytes: 4096 })
  dangling.write('A')
  dangling.write('B')
  dangling.write('A')
  dangling.close()
  check(
    'G9e a partial suffix at close is written, not swallowed',
    mid.join('') === 'A\nB\nA\n'
  )
}

section('G9b — no sidecar overwrites another, and the console log is one of them')
{
  const saved = String.raw`C:\Users\me\Movies\Pachinko.he.srt`
  const temp = String.raw`C:\Temp\srt-out-123`
  const sidecars = [
    `${temp}.tokens.json`,
    `${temp}.progress.log`,
    `${temp}.thoughts.log`,
    `${temp}${CONSOLE_LOG_SUFFIX}`
  ]
  const dests = sidecars.map((p) => sidecarDestination(p, saved))

  check('G9b every sidecar lands on its own name', new Set(dests).size === dests.length, dests.join(' '))
  check('G9b none of them lands on the subtitle', !dests.includes(saved))
  // The specific bug this phase was warned about: `path.extname()` sees only the last dot, so a
  // `.console.log` missing from the list becomes `.log` — a name the other two logs are one
  // small mistake away from as well.
  check(
    'G9b the console log keeps its compound suffix',
    dests[3] === String.raw`C:\Users\me\Movies\Pachinko.he.console.log`,
    dests[3]
  )
  check('G9b and the token report keeps both of its dots', dests[0].endsWith('.tokens.json'))
  // Every sidecar takes the name the user chose, not the temp name the engine was given.
  check('G9b all of them take the saved name', dests.every((d) => d.startsWith(String.raw`C:\Users\me\Movies\Pachinko.he.`)))

  // POSIX separators, since the same code runs on both.
  check(
    'G9b and it works with forward slashes',
    sidecarDestination('/tmp/out-9.console.log', '/home/me/ep1.he.srt') === '/home/me/ep1.he.console.log'
  )
}

section('G9c — a run\u2019s console is named after its output, and found again by name')
{
  check('G9c beside the output, sharing its name', consoleLogPathFor('/out/ep1.srt') === '/out/ep1.console.log')
  check('G9c an .ass output is no different', consoleLogPathFor('/out/ep1.ass') === '/out/ep1.console.log')
  check('G9c an extensionless output still gets one', consoleLogPathFor('/out/ep1') === '/out/ep1.console.log')
  // Windows paths have dots in directory names far more often than anyone expects.
  check(
    'G9c a dotted directory is not mistaken for an extension',
    consoleLogPathFor(String.raw`C:\My.Films\ep1.srt`) === String.raw`C:\My.Films\ep1.console.log`
  )

  // The panel picks it out of a list whose other members depend on settings, so position is
  // not something it may rely on.
  check('G9c found among the engine\u2019s own reports', findConsoleLog(['/a/x.progress.log', '/a/x.console.log']) === '/a/x.console.log')
  check('G9c found when it is the only one', findConsoleLog(['/a/x.console.log']) === '/a/x.console.log')
  check('G9c and absent means absent', findConsoleLog(['/a/x.progress.log', '/a/x.tokens.json']) === '')
  check('G9c an empty list is not an error', findConsoleLog([]) === '')
  check('G9c nor is no list at all', findConsoleLog(undefined) === '')
}

// ── G10 — the release audit's findings (round 1, GPT-5.6-Sol) ──────────────────

{
  section('G10a — one key that begins with another is still masked whole')
  // SOL-09. The sweep rewrites the text it searches, so replacing a SHORTER secret first eats the
  // opening characters of a longer one and leaves its tail standing in clear. Both values are
  // configured keys here; the long one is also pasted into the description, which is the case the
  // sweep exists for.
  const short = 'AIzaSHORTKEY'
  const long = `${short}-AND-MORE-SECRET`
  const line = maskCommandLine('gst', ['-k', short, '-k2', long, '-d', `see ${long} here`])
  check('G10a the positional values are gone', !line.includes(short) && !line.includes(long))
  check(
    'G10a and no tail of the longer key survives in the description',
    !line.includes('-AND-MORE-SECRET'),
    line
  )
  // The reverse order must be equally safe: the fix must not merely swap which case breaks.
  const reversed = maskCommandLine('gst', ['-k', long, '-k2', short, '-d', `see ${long} here`])
  check('G10a and the same holds when the longer key is declared first', !reversed.includes('-AND-MORE-SECRET'), reversed)
  // Nothing else may change: a value below the sweep floor is still masked positionally only.
  const tiny = maskCommandLine('gst', ['-k', 'ab', '-d', 'ab'])
  check('G10a a short value is still masked where it stands', tiny.includes('-k ***'))
  check('G10a but is not hunted through unrelated arguments', tiny.endsWith('-d ab'), tiny)

  section('G10b — a partial tree kill names its survivors')
  // SOL-05. `taskkill /t` can remove the bootloader and fail on the interpreter beneath it, so a
  // liveness check on the pid we hold would report the whole tree gone. The pids are in the text.
  const real =
    'ERROR: The process with PID 4711 (child process of PID 4096) could not be terminated.\r\n' +
    'Reason: Access is denied.'
  const found = survivorsIn(real)
  check('G10b both pids on the line are collected', found.includes(4711) && found.includes(4096), found.join(','))
  check('G10b a clean kill names nobody', survivorsIn('').length === 0)
  check(
    'G10b SUCCESS output contributes no survivors',
    survivorsIn('SUCCESS: The process with PID 4096 has been terminated.').length === 1,
    // One pid IS named here — checking a pid that has just died is harmless (it reads as gone),
    // whereas missing one is the defect. The asymmetry is deliberate.
    survivorsIn('SUCCESS: The process with PID 4096 has been terminated.').join(',')
  )
  check('G10b duplicates collapse', survivorsIn('PID 12 ... PID 12').length === 1)
  check('G10b and nonsense yields nothing', survivorsIn('Access is denied.').length === 0)
}

// ── G11 — the release audit's findings (round 2, GPT-5.6-Sol) ──────────────────

{
  section('G11a — a stepped name keeps its compound suffix, and never runs out')
  // SOL-13. The first collision fix stopped after fifty numbered names and then returned no logger
  // at all, trading a destructive overwrite for silently losing the feature. The counter must also
  // go BEFORE the compound suffix: `episode.console-2.log` no longer ends in `.console.log` and is
  // therefore invisible to `findConsoleLog()` and to the sidecar suffix table.
  const c = (n: number): string => nthCandidate('/out/episode.console.log', '.console.log', n)
  check('G11a the first candidate is the preferred name', c(1) === '/out/episode.console.log')
  check('G11a the second is numbered', c(2) === '/out/episode-2.console.log', c(2))
  check('G11a and every candidate still ends in the compound suffix', [1, 2, 3, 20, 21, 99].every((n) => c(n).endsWith('.console.log')))
  check('G11a the counter never lands inside the suffix', !c(2).includes('.console-'), c(2))
  // Past the numbered range it must still produce a name, and a DIFFERENT one each time.
  const overflow = [c(500), c(500), c(500)]
  check('G11a past the numbered range it still produces names', overflow.every(Boolean))
  check('G11a and they are distinct, so it cannot run out', new Set(overflow).size === 3, overflow.join(' '))
  // A path that does not carry the suffix must not be mangled into one that half does.
  const bare = nthCandidate('/out/episode', '.console.log', 2)
  check('G11a a name without the suffix gains it', bare === '/out/episode-2.console.log', bare)
  // The other three sidecars share this machinery.
  check(
    'G11a the token report keeps both of its dots',
    nthCandidate('/out/x.tokens.json', '.tokens.json', 2) === '/out/x-2.tokens.json'
  )

  section('G11b — every sidecar destination is exclusive except the subtitle')
  // SOL-12. The save dialog obtains consent for ONE file. These four names are derived from it, so
  // an existing one used to be overwritten silently. Proven against the real filesystem.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'g11-'))
  const src = path.join(dir, 'src.console.log')
  fs.writeFileSync(src, 'new run')
  const occupied = path.join(dir, 'episode.console.log')
  fs.writeFileSync(occupied, 'PRECIOUS')
  const landed = copyExclusive(src, occupied, '.console.log')
  check('G11b the existing sidecar is untouched', fs.readFileSync(occupied, 'utf-8') === 'PRECIOUS')
  check('G11b the copy went somewhere else', landed !== null && landed !== occupied, String(landed))
  check('G11b and it carries the new content', !!landed && fs.readFileSync(landed, 'utf-8') === 'new run')
  check('G11b the reported name is the one on disk', !!landed && fs.existsSync(landed))
  // A free name must be used as-is, or every ordinary save would start numbering.
  const free = path.join(dir, 'other.console.log')
  check('G11b a free name is taken unchanged', copyExclusive(src, free, '.console.log') === free)
  // The rewritten sidecar (the token report) takes the same route.
  const tokOccupied = path.join(dir, 'episode.tokens.json')
  fs.writeFileSync(tokOccupied, 'OLD REPORT')
  const tokLanded = writeExclusive('{"new":true}', tokOccupied, '.tokens.json')
  check('G11b the existing token report survives', fs.readFileSync(tokOccupied, 'utf-8') === 'OLD REPORT')
  check('G11b and the new one is beside it', !!tokLanded && tokLanded !== tokOccupied, String(tokLanded))
  fs.rmSync(dir, { recursive: true, force: true })

  section('G11c — waiting for an exit means waiting for the exit')
  // SOL-02. Nothing to wait for must resolve at once, rather than sitting out a grace period.
  const goneAt = Date.now()
  const goneResult = await waitForChildExit(undefined)
  check('G11c an absent process is gone immediately', goneResult === true)
  check('G11c and it does not wait to say so', Date.now() - goneAt < 100)
  check('G11c pidIsAlive agrees about this process', pidIsAlive(process.pid))
  check('G11c and an undefined pid is not alive', !pidIsAlive(undefined))

  // A child that exits on its own must be reported gone WITHOUT anything being killed. This is the
  // SOL-14 property stated as a test: the helper used to poll a bare pid on its own timer, so it
  // could still be watching — and still escalating — after the child it was hired to watch had been
  // reaped and its pid handed to something else. Counting kills is how that is observable.
  let kills = 0
  const countKill = (): void => {
    kills += 1
  }
  const quick = spawn(process.execPath, ['-e', 'setTimeout(()=>{},150)'])
  const quickGone = await waitForChildExit(quick, { graceMs: 3_000, attempts: 3, kill: countKill })
  check('G11c a child that exits on its own is reported gone', quickGone === true)
  check('G11c and nothing was killed to achieve it', kills === 0, `kills=${kills}`)
  // And after `close`, no poll may remain to act on that pid later.
  const killsAtClose = kills
  await new Promise((r) => setTimeout(r, 400))
  check('G11c nor is anything killed after it closes', kills === killsAtClose, `kills=${kills}`)

  // A child that will not leave must be escalated against, and reported honestly if it stays. It
  // ignores SIGTERM, so only the real forced kill ends it — which is the escalation being tested.
  kills = 0
  const stubborn = spawn(process.execPath, [
    '-e',
    "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"
  ])
  await new Promise((r) => setTimeout(r, 200))
  const stubbornGone = await waitForChildExit(stubborn, { graceMs: 200, attempts: 4 })
  check('G11c a process that ignores SIGTERM is escalated against until it goes', stubbornGone === true)
  check('G11c hasExited agrees once it has', hasExited(stubborn))
  // A reaped child is never signalled: its pid may belong to someone else by now.
  // SOL-44: the kill is injectable so "zero signals" is observed, not inferred from the
  // pid being gone. Prove the spy is wired on a live child first, or kills===0 is vacuous.
  kills = 0
  const live = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'])
  await new Promise((r) => setTimeout(r, 80))
  forceKillTree(live, countKill)
  check('G11c a live child is handed to the injected kill', kills === 1, `kills=${kills}`)
  live.kill()
  await new Promise<void>((r) => live.once('close', () => r()))
  kills = 0
  forceKillTree(stubborn, countKill)
  check('G11c a reaped child is not signalled again', kills === 0, `kills=${kills}`)

  section('G11d — a stepped sidecar is distinguishable from a canonical one')
  // SOL-15. The panel tells the user which reports could not take their usual name, and it decides by
  // asking whether the name begins with the subtitle's stem AND a dot. That is a CONTRACT between two
  // modules that never import each other: the stepping in `exclusiveFile.ts` and the predicate in
  // TranslatePage. If stepping ever produced `episode.2.tokens.json`, every stepped file would read
  // as canonical and the warning would silently stop appearing. Pinned here so it cannot drift.
  // 1 is the preferred name unchanged; stepping starts at 2, and past the numbered range the unique
  // fallback must still read as stepped rather than as canonical.
  const canonical = nthCandidate('/out/episode.tokens.json', '.tokens.json', 1)
  const stepped = nthCandidate('/out/episode.tokens.json', '.tokens.json', 2)
  const farStepped = nthCandidate('/out/episode.tokens.json', '.tokens.json', 500)
  const nameOf = (p: string): string => p.split(/[\\/]/).pop() ?? ''
  check('G11d the first candidate is the canonical name', nameOf(canonical) === 'episode.tokens.json')
  check('G11d and it reads as belonging to the subtitle', nameOf(canonical).startsWith('episode.'))
  check(
    'G11d a stepped name does NOT read as belonging to it',
    !nameOf(stepped).startsWith('episode.'),
    nameOf(stepped)
  )
  check('G11d and it keeps the compound suffix', nameOf(stepped).endsWith('.tokens.json'))
  check(
    'G11d the unique fallback reads as stepped too',
    !nameOf(farStepped).startsWith('episode.'),
    nameOf(farStepped)
  )

  section('G11e — displaceExclusive moves without destroying, and is not how save works')
  // The primitive is still the right answer to "move this file to a free name". The save handler
  // no longer uses it (SOL-17: Transcribe's picker-only call would have renamed four reports
  // nobody agreed to move). G11e pins the primitive; G11f pins what save actually does.
  const box = fs.mkdtempSync(path.join(os.tmpdir(), 'srt-g11e-'))
  const tokens = path.join(box, 'episode.tokens.json')
  const stranger = path.join(box, 'episode-2.tokens.json')
  fs.writeFileSync(tokens, 'OLD REPORT')
  fs.writeFileSync(stranger, 'SOMEONE ELSE')
  const moved = displaceExclusive(tokens, '.tokens.json')
  check('G11e the canonical name is now free', !fs.existsSync(tokens))
  check('G11e the stranger at -2 was not overwritten', fs.readFileSync(stranger, 'utf-8') === 'SOMEONE ELSE')
  check('G11e the old report still exists under a stepped name', !!moved && fs.existsSync(moved), String(moved))
  check('G11e and it still holds the old bytes', !!moved && fs.readFileSync(moved, 'utf-8') === 'OLD REPORT')
  check('G11e a missing file displaces nothing', displaceExclusive(path.join(box, 'absent.console.log'), '.console.log') === null)
  fs.rmSync(box, { recursive: true, force: true })

  section('G11f — leftover canonicals are reported, not renamed')
  // SOL-12 / SOL-15 / SOL-17. After a real translation save, names this run did not write that
  // still sit at the canonical path must be listed, and the files themselves must not move.
  const nest = fs.mkdtempSync(path.join(os.tmpdir(), 'srt-g11f-'))
  const saved = path.join(nest, 'episode.srt')
  const oldTokens = path.join(nest, 'episode.tokens.json')
  const newProgress = path.join(nest, 'episode.progress.log')
  const steppedThoughts = path.join(nest, 'episode-2.thoughts.log')
  fs.writeFileSync(oldTokens, 'OLD TOKENS')
  fs.writeFileSync(newProgress, 'THIS RUN')
  fs.writeFileSync(steppedThoughts, 'STEPPED')
  const leftover = leftoverCanonicals(saved, [newProgress, steppedThoughts])
  check(
    'G11f a type this run did not write is leftover',
    leftover.includes(oldTokens),
    leftover.join(' ')
  )
  check('G11f a canonical this run DID write is not leftover', !leftover.includes(newProgress))
  check('G11f a stepped path is not treated as a leftover canonical', !leftover.includes(steppedThoughts))
  check('G11f and the old file is still at its name', fs.readFileSync(oldTokens, 'utf-8') === 'OLD TOKENS')
  check(
    'G11f a missing type is not leftover',
    !leftoverCanonicals(saved, [newProgress]).some((p) => p.endsWith('.console.log'))
  )
  fs.rmSync(nest, { recursive: true, force: true })

  section('G11g — once the child we own has closed, nothing may kill its former number')
  // SOL-18. Round 5 kept a copy of the PGID and SIGKILLed it three seconds later, even after
  // `close`. That number is reusable. `waitForChildExit` of an already-reaped child must
  // resolve immediately and must not escalate — the same contract `forceKillTree` already
  // keeps by refusing `hasExited`. There is no delayed bare-PGID kill left to call.
  kills = 0
  const alreadyGone = spawn(process.execPath, ['-e', 'process.exit(0)'])
  await new Promise<void>((r) => alreadyGone.once('close', () => r()))
  const afterClose = Date.now()
  const afterGone = await waitForChildExit(alreadyGone, { graceMs: 3_000, attempts: 3, kill: countKill })
  check('G11g a reaped child is reported gone immediately', afterGone === true)
  check('G11g and it does not sit out a grace period', Date.now() - afterClose < 100)
  check('G11g and nothing is killed on the strength of its old pid', kills === 0, `kills=${kills}`)
  check('G11g hasExited is what keeps forceKillTree off that pid', hasExited(alreadyGone))

  section('G11h — a pid is not signalable once Node has reaped the child')
  // SOL-19. `close` can lag `exit` while stdio drains; the job is still Stop-able in that gap.
  // `livePid` must refuse as soon as `hasExited`, not wait for `close`.
  const held = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'])
  await new Promise((r) => setTimeout(r, 80))
  check('G11h a live child still has a signalable pid', livePid(held) === held.pid && livePid(held) !== undefined)
  let closeHadFired = false
  held.once('close', () => {
    closeHadFired = true
  })
  const atExit = await new Promise<{ live: number | undefined; closeHadFired: boolean }>((resolve) => {
    held.once('exit', () => resolve({ live: livePid(held), closeHadFired }))
    held.kill()
  })
  check('G11h livePid is gone on exit', atExit.live === undefined)
  check('G11h because hasExited, not because pid was cleared', hasExited(held) && held.pid !== undefined)
  // A handle that never declared exitCode is not reaped. `!== null` used to say it was, and Stop
  // then skipped the tree kill of a still-running engine (the console-log probe's FakeChild).
  const stub = { pid: 42 } as unknown as import('child_process').ChildProcess
  check('G11h a missing exitCode is not a reap', !hasExited(stub) && livePid(stub) === 42)
}

{
  section('G12 — HTTPS-only external open (SOL-24)')
  check('G12 https is approved', isHttpsUrl('https://aistudio.google.com/apikey'))
  check('G12 a trailing path is still https', isHttpsUrl('https://www.imdb.com/title/tt1/'))
  check('G12 http is not', !isHttpsUrl('http://example.com'))
  check('G12 file is not', !isHttpsUrl('file:///C:/secret.txt'))
  check('G12 a custom protocol is not', !isHttpsUrl('myapp:open'))
  check('G12 javascript is not', !isHttpsUrl('javascript:alert(1)'))
  check('G12 empty is not', !isHttpsUrl(''))
  check('G12 malformed is not', !isHttpsUrl('not a url'))
}

// ── result ─────────────────────────────────────────────────────────────────────

console.log(`\n${passes} passed, ${failures} failed`)
if (failures > 0) {
  console.log('\nGATE FAILED — do not proceed to the next step until this is green.')
  process.exit(1)
}
if (sectionsRun.length < MIN_GATE_SECTIONS || passes < MIN_GATE_PASSES) {
  console.log(
    `\nGATE FAILED — suite too small to count as a pass (${sectionsRun.length} sections, ${passes} passes; need >= ${MIN_GATE_SECTIONS} sections and >= ${MIN_GATE_PASSES} passes).`
  )
  process.exit(1)
}
console.log('\nALL GATES PASSED')
