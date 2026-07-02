import Store from 'electron-store'
import type { AppSettings } from '../shared/types'

/**
 * Always-present "latest" aliases. Google resolves these server-side to the
 * newest model in each tier, so they never go stale. Friendly labels get the
 * resolved version appended at refresh time, e.g. "Gemini Flash Lite Latest (3.1)".
 */
export const LATEST_ALIAS_IDS = ['gemini-flash-lite-latest', 'gemini-flash-latest', 'gemini-pro-latest']

/** Core versioned models we always keep available regardless of what a fetch returns. */
export const DEFAULT_MODELS = [
  { id: 'gemini-flash-lite-latest', label: 'Gemini Flash Lite Latest', available: true },
  { id: 'gemini-flash-latest', label: 'Gemini Flash Latest', available: true },
  { id: 'gemini-pro-latest', label: 'Gemini Pro Latest', available: true },
  { id: 'gemini-3.5-flash', label: 'Gemini Flash 3.5', available: true },
  { id: 'gemini-3.1-flash-lite', label: 'Gemini Flash Lite 3.1', available: true },
  { id: 'gemini-3.1-pro', label: 'Gemini Pro 3.1', available: true },
  { id: 'gemini-2.5-flash', label: 'Gemini Flash 2.5', available: true },
  { id: 'gemini-2.5-flash-lite', label: 'Gemini Flash Lite 2.5', available: true },
  { id: 'gemini-2.5-pro', label: 'Gemini Pro 2.5', available: true }
]

export const DEFAULT_MODEL_ID = 'gemini-flash-lite-latest'

const defaults: AppSettings = {
  sourceLang: 'auto',
  targetLang: '',
  apiKeys: [''],
  apiKeyTiers: ['free'],
  apiKeyValid: [null],
  apiKeyError: [''],
  theme: 'auto',
  model: DEFAULT_MODEL_ID,
  batchSize: 100,
  batchContext: false,
  temperature: 1.0,
  topP: 0.95,
  topK: null,
  thinkingLevel: 'low',
  thinkingBudget: 512,
  serviceTier: 'standard',
  paidQuota: false,
  disableStreaming: false,
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

export const store = new Store<AppSettings>({ defaults })

// One-time migration: older builds shipped a non-existent "gemini-3.5-flash-lite"
// model and a stale model list. Reset those so users land on a valid default.
const REMOVED_MODEL_IDS = ['gemini-3.5-flash-lite', 'gemini-3.5-pro', 'gemini-2.0-flash', 'gemini-2.0-flash-lite']
if (REMOVED_MODEL_IDS.includes(store.get('model') as string)) {
  store.set('model', DEFAULT_MODEL_ID)
}
{
  const cached = (store.get('cachedModels') as { id: string }[]) || []
  if (cached.some((m) => REMOVED_MODEL_IDS.includes(m.id))) {
    store.set('cachedModels', DEFAULT_MODELS)
  }
}
// apiKeyValid/apiKeyError became per-key arrays — coerce older scalar values.
if (!Array.isArray(store.get('apiKeyValid'))) {
  const v = store.get('apiKeyValid') as unknown as boolean | null
  store.set('apiKeyValid', [v ?? null])
}
if (!Array.isArray(store.get('apiKeyError'))) {
  const e = store.get('apiKeyError') as unknown as string
  store.set('apiKeyError', [e || ''])
}

export function getSettings(): AppSettings {
  return store.store
}

export function setSettings(patch: Partial<AppSettings>): AppSettings {
  for (const [key, value] of Object.entries(patch)) {
    store.set(key, value as never)
  }
  return store.store
}
