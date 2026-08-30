import fs from 'fs'
import Store from 'electron-store'
import { DEFAULT_RESUME_CONTEXT_SIZE, type AppSettings, type ModelInfo } from '../shared/types'
import { CURRENT_SCHEMA_VERSION, migrateSettings, sanitizeSettingsView, readVersion } from './migrations'

/**
 * Static seed model list.
 *
 * Two properties matter and are easy to break:
 *
 * 1. It is ALIAS-FREE. Earlier builds injected invented `-latest` ids that Google does
 *    not publish, which the engine rejects with a hard `exit(1)` (main.py:645) and which
 *    additionally defeat its thinking-config substring match (main.py:207-243).
 * 2. It is DISPLAY-ONLY and explicitly `source: 'seed'` — never evidence that a model is
 *    runnable. Only a live fetch against the user's own key proves that.
 *
 * Ids are taken from the engine's pricing.json intersected with what this app supports.
 */
export const DEFAULT_MODELS: ModelInfo[] = [
  { id: 'gemini-3.5-flash', label: 'Gemini Flash 3.5', source: 'seed', availableOn: [] },
  { id: 'gemini-3.1-flash-lite', label: 'Gemini Flash Lite 3.1', source: 'seed', availableOn: [] },
  { id: 'gemini-3.1-pro', label: 'Gemini Pro 3.1', source: 'seed', availableOn: [] },
  { id: 'gemini-2.5-flash', label: 'Gemini Flash 2.5', source: 'seed', availableOn: [] },
  { id: 'gemini-2.5-flash-lite', label: 'Gemini Flash Lite 2.5', source: 'seed', availableOn: [] },
  { id: 'gemini-2.5-pro', label: 'Gemini Pro 2.5', source: 'seed', availableOn: [] }
]

/**
 * Static fallback only — the newest flash-lite in the seed list. The live rule
 * (`resolveDefaultModel` over the runnable set) supersedes it on the first successful
 * refresh.
 *
 * This constant MUST stay alias-free: migration M3 remaps stored aliases to it and then
 * bumps the schema version, and migrations never re-run. An alias here would strand
 * every migrated profile on an unrunnable id, permanently.
 */
export const DEFAULT_MODEL_ID = 'gemini-3.1-flash-lite'

const defaults: AppSettings = {
  // MUST be 0: electron-store returns the default for absent keys, so any other value
  // makes every legacy profile claim it is already migrated.
  schemaVersion: 0,
  sourceLang: 'auto',
  targetLang: '',
  apiKeys: [''],
  apiKeyTiers: ['free'],
  apiKeyValid: [null],
  apiKeyError: [''],
  theme: 'auto',
  model: DEFAULT_MODEL_ID,
  modelNeedsVerification: false,
  batchSize: 100,
  batchContext: false,
  customGenerationParams: false,
  temperature: 1.0,
  topP: 0.95,
  topK: null,
  thinkingLevel: 'low',
  thinkingBudget: 512,
  transcribeOverride: false,
  transcribeModel: '',
  transcribeThinkingLevel: '',
  transcribeThinkingBudget: 0,
  serviceTier: 'standard',
  paidQuota: false,
  disableStreaming: false,
  resumeContextSize: DEFAULT_RESUME_CONTEXT_SIZE,
  tmdbApiKey: 'a07324c669cac4d96789197134ce272b',
  outputFolder: '',
  ffmpegPath: '',
  systemPrompt: '',
  showTokenStats: true,
  writeTokenReport: false,
  progressLog: false,
  thoughtsLog: false,
  cachedModels: DEFAULT_MODELS,
  modelsUpdatedAt: null
}

/** This build's AppSettings. Runtime-view fallback only — never Conf constructor defaults. */
export const DEFAULT_SETTINGS: AppSettings = defaults

export const store = new Store<AppSettings>({
  // Empty on purpose. Conf writes `defaults ∪ file` at construction whenever they differ,
  // which would dump this build's schema into a newer-build profile before migrations
  // even run (SOL-35). This build's defaults are applied by sanitizeSettingsView.
  defaults: {} as AppSettings
})

/**
 * Run the migration chain once, at module load, and write the result in a SINGLE call.
 *
 * The previous code applied several unconditional, un-versioned edits on every start —
 * including a full `cachedModels` reset — which is one of the two candidate causes of
 * the "fetched models do not persist" bug.
 */
function runMigrations(): void {
  const result = migrateSettings(store.store as unknown as Record<string, unknown>, {
    defaultModelId: DEFAULT_MODEL_ID,
    defaults: {
      customGenerationParams: defaults.customGenerationParams,
      resumeContextSize: defaults.resumeContextSize,
      modelNeedsVerification: defaults.modelNeedsVerification
    }
  })

  for (const note of result.notes) console.log(`[settings-migration] ${note}`)
  if (result.downgrade) return

  // Shape repair is a separate pass from the versioned steps: M4/M6 leave a non-array cache
  // untouched so a bad field cannot loop, but consumers iterate it as ModelInfo[]. A current
  // version with the same damage skips the chain entirely. Neither case may reach the UI.
  const sanitized = sanitizeSettingsView(result.settings, DEFAULT_SETTINGS)
  for (const note of sanitized.notes) console.log(`[settings-sanitize] ${note}`)
  if (!result.changed && !sanitized.changed) return

  // One tiny backup before the first migrated write turns a migration bug from
  // unrecoverable into a support instruction.
  try {
    const backup = store.path.replace(/config\.json$/i, `config.pre-v${CURRENT_SCHEMA_VERSION}.bak`)
    if (fs.existsSync(store.path) && !fs.existsSync(backup)) {
      fs.copyFileSync(store.path, backup)
      console.log(`[settings-migration] backed up config.json to ${backup}`)
    }
  } catch (err) {
    console.warn(`[settings-migration] could not write the pre-migration backup: ${String(err)}`)
  }

  store.set(sanitized.persist as unknown as Partial<AppSettings>)
  if (result.changed) {
    console.log(
      `[settings-migration] migrated settings from schemaVersion ${result.fromVersion} to ${result.toVersion}`
    )
  }
}

runMigrations()

export function getSettings(): AppSettings {
  const { settings } = sanitizeSettingsView(
    store.store as unknown as Record<string, unknown>,
    DEFAULT_SETTINGS
  )
  return settings as unknown as AppSettings
}

export function setSettings(patch: Partial<AppSettings>): AppSettings {
  const rest = { ...patch }
  delete rest.schemaVersion
  const file = store.store as unknown as Record<string, unknown>
  if (readVersion(file) > CURRENT_SCHEMA_VERSION) {
    // Patch keys only. Spreading store.store would write this build's defaults (and Conf
    // already merges them into the getter) into a profile this build does not own (SOL-35).
    store.set(rest as unknown as Partial<AppSettings>)
    return getSettings()
  }
  const merged = { ...file, ...rest }
  const { persist } = sanitizeSettingsView(merged, DEFAULT_SETTINGS)
  store.set(persist as unknown as Partial<AppSettings>)
  return getSettings()
}
