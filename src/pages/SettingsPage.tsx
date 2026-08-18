import React, { useState } from 'react'
import { useStore } from '../store/useStore'
import {
  Label,
  TextInput,
  NumberInput,
  Select,
  Toggle,
  ToggleRow,
  Button,
  Divider,
  Pill
} from '../components/ui'
import { SOURCE_LANGUAGES, TARGET_LANGUAGES } from '../data/languages'
import { THINKING_LEVELS, SERVICE_TIERS, paidQuotaTooltip, RATE_LIMITS_URL } from '../data/freeTier'
import {
  activeKeySlots,
  forgetSlotEvidence,
  keyRoles,
  orderKeySlots,
  reindexEvidenceAfterRemoval,
  type KeyRole,
  type KeySlot
} from '../../electron/shared/keyOrder'
import { effectiveThinkingLevel, modelCapabilities } from '../../electron/shared/modelCaps'
import {
  DEFAULT_RESUME_CONTEXT_SIZE,
  type AppSettings,
  type ModelInfo
} from '../../electron/shared/types'

const PRICING_URL = 'https://ai.google.dev/gemini-api/docs/pricing'

/**
 * Slot descriptors for the configured keys, in the shape `shared/keyOrder` ranks.
 * Indices only — no key material leaves this module.
 */
function keySlotsOf(settings: AppSettings): KeySlot[] {
  return (settings.apiKeys ?? [])
    .map((k, i) => ({ index: i, present: !!(k ?? '').trim() }))
    .filter((s) => s.present)
    .map(({ index }) => ({
      index,
      valid: settings.apiKeyValid?.[index] ?? null,
      tier: settings.apiKeyTiers?.[index] ?? 'free'
    }))
}

/**
 * The key a run will actually send as `-k`, and its tier.
 *
 * This must be derived from the ranking rather than from slot 0, because
 * `orderKeysByValidity` promotes a fallback when the configured first key is known-invalid
 * and then derives `--paid-quota` from whichever key it promoted. Reading slot 0 here would
 * let Settings report "Free" while the run emits `--paid-quota`, or the reverse.
 */
function effectivePrimary(settings: AppSettings): { slot: number | null; paid: boolean } {
  const primary = orderKeySlots(keySlotsOf(settings))[0]
  if (primary == null) return { slot: null, paid: false }
  return { slot: primary, paid: (settings.apiKeyTiers?.[primary] ?? 'free') === 'paid' }
}

const KEYS_TIP =
  "Your Gemini API key(s) from Google AI Studio, in priority order. A run passes the two highest-ranked keys to the engine as -k and -k2; any further keys are a reserve pool that is promoted only when a key above becomes invalid. Keys marked invalid by the last check are skipped entirely. Use the eye icon to reveal a key. Set each key's tier (Free / Paid) yourself — Google's API cannot report it — as the primary key's tier controls rate-limiting. Adding a second key is only worth doing if it comes from a DIFFERENT Google Cloud project: free-tier quota is counted per project, not per key, so extra keys from the same project share one pool and buy you no additional throughput — only a spare to fall back on if one key stops working. Get a free key at aistudio.google.com/apikey."

function Eye(): React.JSX.Element {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  )
}

function EyeOff(): React.JSX.Element {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9.9 4.24A9.1 9.1 0 0 1 12 4c6.5 0 10 7 10 7a13.2 13.2 0 0 1-1.67 2.68" />
      <path d="M6.6 6.6A13.5 13.5 0 0 0 2 11s3.5 7 10 7a9 9 0 0 0 5.4-1.6" />
      <path d="M3 3l18 18" />
    </svg>
  )
}

function KeyStatus({
  refreshing,
  state,
  error,
  hasKey
}: {
  refreshing: boolean
  state: boolean | null
  error: string
  hasKey: boolean
}): React.JSX.Element {
  let content: React.ReactNode = null
  let title = ''
  if (refreshing && hasKey) {
    content = <span className="text-gray-400">…</span>
    title = 'Checking…'
  } else if (state === true) {
    content = <span className="text-green-600 dark:text-green-400">✓</span>
    title = 'Valid key'
  } else if (state === false) {
    content = <span className="text-red-500 dark:text-red-400">✗</span>
    title = error || 'Invalid key'
  }
  return (
    <span className="flex h-9 w-5 flex-shrink-0 items-center justify-center text-sm font-bold" title={title}>
      {content}
    </span>
  )
}

const NAV = [
  { id: 'appearance', label: 'Appearance' },
  { id: 'languages', label: 'Default Languages' },
  { id: 'api-keys', label: 'Gemini API Keys' },
  { id: 'model', label: 'Model & Generation' },
  { id: 'service', label: 'Service' },
  { id: 'tmdb', label: 'TMDB' },
  { id: 'output', label: 'Output' },
  { id: 'advanced', label: 'Advanced' }
]

const THEME_OPTIONS = [
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
  { value: 'auto', label: 'Auto (match system)' }
]

export default function SettingsPage(): React.JSX.Element {
  const settings = useStore((s) => s.settings)
  const patch = useStore((s) => s.patch)
  const [sec, setSec] = useState('languages')

  if (!settings) return <div className="p-6 text-sm text-gray-500 dark:text-gray-400">Loading settings…</div>

  function set<K extends keyof AppSettings>(key: K, value: AppSettings[K]): void {
    void patch({ [key]: value } as Partial<AppSettings>)
  }

  return (
    <div className="flex gap-6">
      <nav className="w-52 flex-shrink-0">
        <h1 className="mb-4 text-2xl font-bold text-gray-900 dark:text-gray-100">Settings</h1>
        <ul className="space-y-0.5">
          {NAV.map((n) => (
            <li key={n.id}>
              <button
                onClick={() => setSec(n.id)}
                className={`w-full rounded-md px-3 py-2 text-left text-sm transition-colors ${
                  sec === n.id
                    ? 'bg-gray-100 font-semibold text-gray-900 dark:bg-gray-700 dark:text-gray-100'
                    : 'text-gray-600 hover:bg-gray-50 dark:text-gray-400 dark:hover:bg-gray-800'
                }`}
              >
                {n.label}
              </button>
            </li>
          ))}
        </ul>
      </nav>

      <div className="min-w-0 flex-1 pt-1">
        {sec === 'appearance' && <SectionAppearance settings={settings} set={set} />}
        {sec === 'languages' && <SectionLanguages settings={settings} set={set} />}
        {sec === 'api-keys' && <SectionApiKeys settings={settings} set={set} />}
        {sec === 'model' && <SectionModel settings={settings} set={set} />}
        {sec === 'service' && <SectionService settings={settings} set={set} />}
        {sec === 'tmdb' && <SectionTmdb settings={settings} set={set} />}
        {sec === 'output' && <SectionOutput settings={settings} set={set} />}
        {sec === 'advanced' && <SectionAdvanced settings={settings} set={set} />}
      </div>
    </div>
  )
}

interface SectionProps {
  settings: AppSettings
  set: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => void
}

function SectionTitle({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <div className="mb-5 text-lg font-bold text-gray-900 dark:text-gray-100">{children}</div>
}

function SectionAppearance({ settings, set }: SectionProps): React.JSX.Element {
  return (
    <div className="max-w-xl space-y-5">
      <SectionTitle>Appearance</SectionTitle>
      <div>
        <Label tip="Choose the app's colour theme. Light and Dark force that theme; Auto follows your operating system's appearance setting and switches automatically when the OS does.">
          Theme
        </Label>
        <Select
          value={settings.theme}
          onChange={(v) => set('theme', v)}
          options={THEME_OPTIONS}
          className="w-72"
        />
        <p className="mt-1.5 text-xs text-gray-500 dark:text-gray-400">
          Applies instantly across the whole app.
        </p>
      </div>
    </div>
  )
}

function SectionLanguages({ settings, set }: SectionProps): React.JSX.Element {
  return (
    <div className="max-w-xl space-y-5">
      <SectionTitle>Default Languages</SectionTitle>
      <div>
        <Label tip="The default source language pre-filled on the Translate and Transcribe pages when the app starts. 'Auto Detect' works reliably for most common languages and is the recommended default.">
          Default Source Language
        </Label>
        <Select
          value={settings.sourceLang}
          onChange={(v) => set('sourceLang', v)}
          options={SOURCE_LANGUAGES}
          className="w-72"
        />
      </div>
      <div>
        <Label tip="The default target language pre-filled on the Translate page. Leave empty to force yourself to choose each time. Whatever you set here loads automatically on startup.">
          Default Target Language
        </Label>
        <Select
          value={settings.targetLang || ''}
          onChange={(v) => set('targetLang', v)}
          options={[{ value: '', label: '— none —' }, ...TARGET_LANGUAGES]}
          className="w-72"
        />
      </div>
    </div>
  )
}

const ROLE_LABEL: Record<KeyRole, string> = {
  primary: 'Primary (-k)',
  fallback: 'Fallback (-k2)',
  reserve: 'Reserve'
}

function RoleBadge({ role }: { role: KeyRole | undefined }): React.JSX.Element | null {
  if (!role) return null
  const tone =
    role === 'primary'
      ? 'bg-brand/10 text-brand'
      : role === 'fallback'
        ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300'
        : 'bg-gray-100 text-gray-500 dark:bg-gray-700 dark:text-gray-400'
  return (
    <span
      className={`w-24 flex-shrink-0 rounded-full px-2 py-0.5 text-center text-[11px] font-semibold ${tone}`}
      title={
        role === 'reserve'
          ? 'Held in reserve. Each run passes only two keys to the engine, so this one is used only if a key above it becomes invalid.'
          : 'This key will be passed to the engine on the next run.'
      }
    >
      {ROLE_LABEL[role]}
    </span>
  )
}

function SectionApiKeys({ settings, set }: SectionProps): React.JSX.Element {
  const reload = useStore((s) => s.load)
  const updatedAt = useStore((s) => s.modelsUpdatedAt)
  const [refreshing, setRefreshing] = useState(false)
  const [modelCount, setModelCount] = useState<number | null>(null)
  const [notice, setNotice] = useState('')
  const [failedSlots, setFailedSlots] = useState<number[]>([])
  const [revealed, setRevealed] = useState<Record<number, boolean>>({})
  const keys = settings.apiKeys.length ? settings.apiKeys : ['']
  const tiers = keys.map((_, i) => settings.apiKeyTiers?.[i] ?? 'free')
  const valids = keys.map((_, i) => settings.apiKeyValid?.[i] ?? null)
  const errs = keys.map((_, i) => settings.apiKeyError?.[i] ?? '')

  // Same ranking the main process uses to choose -k / -k2, so the labels below cannot
  // disagree with what a run actually does. Operates on slot indices only — no key
  // material leaves this component.
  const slots: KeySlot[] = keySlotsOf(settings)
  const roles = keyRoles(slots)
  const active = activeKeySlots(slots)

  function toggleReveal(i: number): void {
    setRevealed((r) => ({ ...r, [i]: !r[i] }))
  }

  function updateKey(i: number, val: string): void {
    if (keys[i] === val) return
    const next = [...keys]
    next[i] = val
    set('apiKeys', next)
    // Editing a key invalidates only that key's previously checked status.
    const nv = [...valids]
    nv[i] = null
    set('apiKeyValid', nv)
    const ne = [...errs]
    ne[i] = ''
    set('apiKeyError', ne)
    // ...and everything slot i previously proved about model availability, because that
    // evidence came from a different key. Left alone, the pre-spawn guard would keep
    // treating it as positive proof for a key it has never seen.
    set('cachedModels', forgetSlotEvidence(settings.cachedModels ?? [], i))
    setModelCount(null)
  }
  function setTier(i: number, val: string): void {
    const next = [...tiers]
    next[i] = val
    set('apiKeyTiers', next)
  }
  function addKey(): void {
    if (keys.length >= 5) return
    set('apiKeys', [...keys, ''])
    set('apiKeyTiers', [...tiers, 'free'])
    set('apiKeyValid', [...valids, null])
    set('apiKeyError', [...errs, ''])
  }
  function removeKey(i: number): void {
    const drop = <T,>(arr: T[], fallback: T): T[] => {
      const r = arr.filter((_, idx) => idx !== i)
      return r.length ? r : [fallback]
    }
    set('apiKeys', drop(keys, ''))
    set('apiKeyTiers', drop(tiers, 'free'))
    set('apiKeyValid', drop(valids, null))
    set('apiKeyError', drop(errs, ''))
    // Removing a slot renumbers every slot above it, so stored availability evidence has
    // to follow the keys it came from or it starts describing the wrong ones.
    set('cachedModels', reindexEvidenceAfterRemoval(settings.cachedModels ?? [], i))
  }

  async function refresh(): Promise<void> {
    if (!keys.some((k) => k.trim())) return
    setRefreshing(true)
    setModelCount(null)
    setNotice('')
    try {
      const res = await window.api.checkApiKeys(keys)
      // The main process has already persisted validity, the model cache and any model
      // change the Step 4a rules made. Re-read rather than writing the same values back:
      // a second write here would race the rules and could resurrect the old selection.
      await reload()
      // Report a count only for a refresh that was actually persisted. An incomplete
      // refresh keeps the previous list, so quoting the number it happened to return
      // would claim a fetch succeeded when the picker did not change.
      const persisted = res.refreshOutcome === 'allComplete' || res.refreshOutcome === 'activeComplete'
      setModelCount(persisted ? res.models.length : null)
      setFailedSlots(res.slots.filter((s) => s.queried && !s.ok).map((s) => s.slot))
      setNotice(res.notice)
    } finally {
      setRefreshing(false)
    }
  }

  const nonEmptyCount = keys.filter((k) => k.trim()).length
  const validCount = valids.filter((v) => v === true).length
  // Only keys explicitly checked and rejected count as invalid — a freshly added
  // (or edited) key has status `null` (unchecked) and must not be reported as bad.
  const invalidCount = valids.filter((v, i) => v === false && keys[i].trim()).length
  const checkedAny = valids.some((v) => v !== null)
  // Read from the ranking, not from slot 0: an invalid first key is skipped at spawn time
  // and the promoted key's tier is what decides `--paid-quota`.
  const { slot: primarySlot, paid: primaryPaid } = effectivePrimary(settings)
  const tierLabel = primaryPaid ? 'Paid' : 'Free'

  return (
    <div className="max-w-xl space-y-5">
      <SectionTitle>Gemini API Keys</SectionTitle>
      <div>
        <Label tip={KEYS_TIP}>API Keys (up to 5)</Label>
        <p className="mb-2 text-xs text-gray-500 dark:text-gray-400">
          Each run passes exactly <strong>two</strong> keys to the engine — a primary
          (&#8209;k) and one fallback (&#8209;k2) it switches to when the primary hits its
          quota. Extra keys are a <strong>reserve pool</strong>: they are not used during a
          run, but are promoted automatically when a key above them turns out to be
          invalid. Keys are ranked below in the order they will actually be used.
        </p>
        <div className="space-y-2">
          {keys.map((k, i) => (
            <div key={i} className="flex items-center gap-2">
              <div className="relative flex-1">
                <TextInput
                  type={revealed[i] ? 'text' : 'password'}
                  value={k}
                  placeholder={i === 0 ? 'Primary API key' : `Fallback key ${i}`}
                  onChange={(e) => updateKey(i, e.target.value)}
                  className="w-full pr-9"
                />
                <button
                  type="button"
                  onClick={() => toggleReveal(i)}
                  title={revealed[i] ? 'Hide key' : 'Show key'}
                  className="absolute right-1.5 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded text-gray-400 hover:bg-gray-100 hover:text-gray-700 dark:hover:bg-gray-600 dark:hover:text-gray-200"
                >
                  {revealed[i] ? <EyeOff /> : <Eye />}
                </button>
              </div>
              <KeyStatus refreshing={refreshing} state={valids[i]} error={errs[i]} hasKey={!!keys[i].trim()} />
              <RoleBadge role={roles.get(i)} />
              <Select
                value={tiers[i]}
                onChange={(v) => setTier(i, v)}
                options={[
                  { value: 'free', label: 'Free' },
                  { value: 'paid', label: 'Paid' }
                ]}
                className="w-24"
              />
              {keys.length > 1 && (
                <button
                  onClick={() => removeKey(i)}
                  className="flex h-9 w-9 items-center justify-center rounded-md border border-gray-300 text-gray-500 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-400 dark:hover:bg-gray-700"
                  title="Remove key"
                >
                  ✕
                </button>
              )}
            </div>
          ))}
        </div>
        {keys.length < 5 && (
          <button onClick={addKey} className="mt-2 text-sm font-medium text-brand hover:underline">
            + Add another key
          </button>
        )}
      </div>

      <Divider />

      <div>
        <Label tip="Validates every saved API key individually (each gets a ✓ or ✗ next to it) and retrieves the model list from EVERY valid key, not just the first. The Model dropdown offers the combined list; a model that only some of your keys can see is marked, because a run may switch between your two active keys. New models Google releases show up here automatically, and the list is cached so it loads instantly next time. Run this after entering your keys. (Tier is set per key above — Google's API can't report it automatically.)">
          Fetch Models &amp; Check API Keys
        </Label>
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="secondary" onClick={refresh} disabled={refreshing || !keys.some((k) => k.trim())}>
            {refreshing ? 'Checking…' : 'Fetch Models & Check API Keys'}
          </Button>
          <span
            className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${
              primaryPaid
                ? 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300'
                : 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300'
            }`}
            title="Tier of the key this run will actually use as -k, which is not always Key 1 — a known-invalid key is skipped and the next one is promoted. Google's API does not expose a key's billing tier, so set it manually per key above. This is what drives rate-limiting (Paid Quota)."
          >
            {primarySlot == null
              ? 'Primary key tier: —'
              : `Primary key tier (Key ${primarySlot + 1}): ${tierLabel}`}
          </span>
          <button
            type="button"
            onClick={() => void window.api.openExternal(RATE_LIMITS_URL)}
            className="text-xs font-medium text-brand hover:underline"
            title="Google's live rate-limit table — the authoritative source. Any figure shown in this app is a rounded approximation and can go out of date."
          >
            View current rate limits ↗
          </button>
          {updatedAt && (
            <span className="text-xs text-gray-500 dark:text-gray-400">
              Last updated: {new Date(updatedAt).toLocaleString()}
            </span>
          )}
        </div>

        {checkedAny && (
          <div className="mt-2 space-y-0.5 text-xs">
            {validCount > 0 ? (
              <p className="font-medium text-green-700 dark:text-green-400">
                ✓ {validCount} of {nonEmptyCount} key{nonEmptyCount > 1 ? 's' : ''} valid
                {modelCount !== null ? ` — ${modelCount} models available.` : '.'}
              </p>
            ) : (
              <p className="text-red-600 dark:text-red-400">
                ✗ No valid keys — check the key(s) marked ✗ above.
              </p>
            )}
            {invalidCount > 0 && (
              <p className="text-amber-600 dark:text-amber-400">
                {invalidCount} key{invalidCount > 1 ? 's' : ''} invalid
                (marked ✗ — hover for details).
              </p>
            )}
            {valids[0] === false && validCount > 0 && (
              <p className="text-brand">
                Your first key is invalid — translations will automatically use your first valid
                key instead.
              </p>
            )}
            {failedSlots.length > 0 && (
              <p className="text-amber-600 dark:text-amber-400">
                Key {failedSlots.map((i) => i + 1).join(', ')} could not be checked
                {failedSlots.every((i) => !active.includes(i))
                  ? ' — it is a reserve key, so this does not affect runs.'
                  : ' — it is one of the two keys a run would use.'}
              </p>
            )}
            {notice && <p className="text-brand">{notice}</p>}
            {active.length > 0 && (
              <p className="text-gray-500 dark:text-gray-400">
                Next run will use key{active.length > 1 ? 's' : ''}{' '}
                {active.map((i) => i + 1).join(' and ')}.
              </p>
            )}
          </div>
        )}

        {!keys.some((k) => k.trim()) && (
          <p className="mt-2 text-xs text-gray-400 dark:text-gray-500">Enter an API key above to enable this.</p>
        )}
      </div>
    </div>
  )
}

function SectionModel({ settings, set }: SectionProps): React.JSX.Element {
  const caps = modelCapabilities(settings.model)
  const cached = settings.cachedModels
  const verifiedAny = cached.some((m) => m.source === 'live')
  const selected = cached.find((m) => m.id === settings.model)

  // The active set is what a run will actually pass as -k/-k2, so "available on every
  // active key" is the honest bar for an unqualified entry.
  const activeSlots = activeKeySlots(
    settings.apiKeys
      .map((k, i) => ({
        index: i,
        valid: settings.apiKeyValid?.[i] ?? null,
        tier: settings.apiKeyTiers?.[i] ?? 'free',
        present: !!k.trim()
      }))
      .filter((s) => s.present)
      .map(({ index, valid, tier }) => ({ index, valid, tier }))
  )
  const availableOnAllActive = (m: ModelInfo): boolean =>
    m.source === 'live' && activeSlots.every((slot) => m.availableOn.includes(slot))

  const models = cached.map((m) => ({
    value: m.id,
    label:
      m.source !== 'live'
        ? `${m.label} (unverified)`
        : availableOnAllActive(m)
          ? m.label
          : `${m.label} (some keys only)`
  }))
  // The stored id may not be in the list yet (never fetched, or fetched on another
  // profile). A Select whose value is absent from its options renders BLANK, which reads
  // as "no model selected" — so keep it visible as an explicit entry.
  if (settings.model && !cached.some((m) => m.id === settings.model)) {
    models.unshift({ value: settings.model, label: `${settings.model} (not in fetched list)` })
  }

  function handleModel(v: string): void {
    set('model', v)
    // Sampling defaults differ by generation. Only meaningful while custom parameters are
    // on; still applied so switching the toggle on later shows sensible values.
    const gen3 = /(^|-)3(\.|-)/.test(v)
    set('temperature', gen3 ? 1.0 : 0.3)
    set('topP', gen3 ? 0.95 : 0.8)
  }

  return (
    <div className="space-y-5">
      <SectionTitle>Model &amp; Generation</SectionTitle>

      <div>
        <Label tip="The Gemini model used for translation and transcription. The list comes from your own API keys, so newly released models appear automatically once you press 'Fetch Models & Check API Keys'. Guidance: a flash-lite model is fastest and cheapest and is what the app defaults to (it moves to the newest flash-lite by itself); flash trades speed for quality; pro is the most capable and by far the slowest and most expensive. Preview models are offered but never selected automatically.">
          Model
        </Label>
        <Select value={settings.model} onChange={handleModel} options={models} className="w-80" />
        <div className="mt-1.5 space-y-1 text-xs">
          <p className="text-gray-500 dark:text-gray-400">
            Cost varies enormously by tier — a pro model can cost more than ten times a
            flash-lite one for the same file, and a newer model is not automatically
            cheaper.{' '}
            <button
              type="button"
              onClick={() => void window.api.openExternal(PRICING_URL)}
              className="font-medium text-brand hover:underline"
            >
              Current pricing ↗
            </button>
          </p>
          {!verifiedAny && (
            <p className="text-amber-600 dark:text-amber-400">
              These models have not been verified against your API key yet — open Gemini API
              Keys and press “Fetch Models &amp; Check API Keys”.
            </p>
          )}
          {settings.modelNeedsVerification && (
            <p className="text-amber-600 dark:text-amber-400">
              Your saved model has not been confirmed against your key yet. It has been kept
              as-is; fetch models to verify it.
            </p>
          )}
          {verifiedAny && selected && !availableOnAllActive(selected) && (
            <p className="text-amber-600 dark:text-amber-400">
              This model was not reported by every key a run may use. If the engine switches
              to the fallback key mid-run, it may fail.
            </p>
          )}
        </div>
      </div>

      <div className="grid grid-cols-2 items-start gap-x-10 gap-y-5">
        <div>
          <Label tip="Number of subtitle lines sent to Gemini in a single API request. Default: 100. Lower values give the model less context per request — translation may feel choppy across scenes. Higher values give more context and consistency but use more tokens. Only lower this if you hit token limit errors.">
            Batch Size
          </Label>
          <NumberInput
            value={settings.batchSize}
            min={1}
            max={1000}
            onChange={(v) => set('batchSize', v ?? 100)}
            className="w-28"
          />
        </div>
        <div>
          <ToggleRow
            label="Cross-Batch Context"
            desc="Resend the whole previous batch (originals + translations) with each request. Default: OFF."
            checked={settings.batchContext}
            onChange={(v) => set('batchContext', v)}
            tip={
              'OFF (default): each batch is translated independently (sends --no-context). Lowest cost.\n\n' +
              'ON: every request after the first also carries the ENTIRE previous batch — both its original lines AND their translations — as conversation history. The amount is fixed at exactly one prior batch and is not adjustable.\n\n' +
              'Cost ramification: that resent context is billed as fresh input every time (Gemini does NOT cache it here), so each line is effectively paid for ~2× as input plus its translation once. In real terms this can roughly TRIPLE your input tokens on a long file — e.g. a recent ~530-line run went from ~14k prompt tokens (OFF) to ~43k (ON), with no quality-changing benefit to the lines themselves.\n\n' +
              'Quality ramification: the only upside is cross-batch consistency — character names, tone, and phrasing are less likely to drift at batch boundaries. If your Description/TMDB context already lists the characters (which anchors names and genders), the benefit of turning this ON is small. Turn it ON mainly for narrative-heavy content where wording must stay perfectly consistent across the whole file and cost is not a concern.'
            }
          />
        </div>
      </div>

      <Divider />

      <div className="grid grid-cols-2 items-start gap-x-10 gap-y-5">
        {/* Left: thinking */}
        <div className="space-y-5">
          <div>
            <Label tip="Gemini 3.x only. Controls how much internal reasoning the model does before output. Order: Minimal (fastest) → Low (default, recommended) → Medium → High (most thorough, slowest). Low is sufficient for most subtitle jobs. Thinking cannot be switched off entirely on 3.x models — the engine raises 'Disabled' to the lowest level the model accepts. Gemini 3 Pro does not accept 'Minimal' and treats it as 'Low'. For 2.5 models use Thinking Budget instead.">
              Thinking Level
            </Label>
            {caps.thinking === 'level' ? (
              <>
                <Select
                  value={settings.thinkingLevel}
                  onChange={(v) => set('thinkingLevel', v)}
                  options={THINKING_LEVELS.filter(
                    (o) => !(caps.rejectsMinimalLevel && o.value === 'minimal')
                  )}
                  className="w-52"
                />
                {effectiveThinkingLevel(settings.model, settings.thinkingLevel) !==
                  settings.thinkingLevel && (
                  <p className="mt-1 text-xs text-amber-600 dark:text-amber-400">
                    This model does not support “{settings.thinkingLevel}” — it will run at “
                    {effectiveThinkingLevel(settings.model, settings.thinkingLevel)}”.
                  </p>
                )}
              </>
            ) : (
              <>
                <Select value="" onChange={() => {}} disabled options={[{ value: '', label: '3.x models only' }]} className="w-52" />
                <p className="mt-1 text-xs text-gray-400 dark:text-gray-500">Select a Gemini 3.x model to enable.</p>
              </>
            )}
          </div>
          <div>
            <Label tip="Gemini 2.5 only. Maximum tokens the model may use for internal reasoning. Default: 512. On non-Pro 2.5 models, 0 disables thinking (faster, cheaper) and the maximum is 24,576. Gemini 2.5 Pro cannot disable thinking: its range is 128 – 32,768. Increase to 2048–8192 for complex content. For 3.x models use Thinking Level instead.">
              Thinking Budget
            </Label>
            {caps.thinking === 'budget' ? (
              <>
                <NumberInput
                  value={settings.thinkingBudget}
                  min={caps.thinkingBudgetMin}
                  max={caps.thinkingBudgetMax}
                  onChange={(v) => set('thinkingBudget', v ?? 512)}
                  className="w-28"
                />
                <p className="mt-1 text-xs text-gray-400 dark:text-gray-500">
                  Range for this model: {caps.thinkingBudgetMin} – {caps.thinkingBudgetMax.toLocaleString()}
                  {caps.canDisableThinking ? ' (0 disables thinking)' : ' (cannot be disabled)'}.
                </p>
              </>
            ) : (
              <>
                <TextInput disabled value="—" className="w-28" />
                <p className="mt-1 text-xs text-gray-400 dark:text-gray-500">Select a Gemini 2.5 model to enable.</p>
              </>
            )}
          </div>
        </div>

        {/* Right: sampling */}
        <div className="space-y-5">
          <ToggleRow
            label="Custom Generation Parameters"
            desc="Override the model's own temperature / top-p / top-k defaults"
            checked={settings.customGenerationParams}
            onChange={(v) => set('customGenerationParams', v)}
            tip={
              'OFF (default, recommended): temperature, top-p and top-k are not sent at all, so each model uses the values Google tuned for it. This is what you want unless you have a specific reason.\n\n' +
              'ON: the three values below are sent with every request. They apply to ALL models, including ones released after these defaults were chosen — a value that suits one generation can degrade another.\n\n' +
              'Note: a value of exactly 0 cannot be sent (the engine treats it as "not set"), which is why the minimums below are above zero.'
            }
          />
          <div className={settings.customGenerationParams ? '' : 'pointer-events-none opacity-50'}>
            <div className="space-y-5">
              <div>
                <Label tip="Controls randomness (creativity). Lower = more literal. Higher = more natural-sounding. Range: 0.05 – 2.0. Typical: 1.0 for Gemini 3.x, 0.3 for 2.x. Lower it if translations feel too creative; raise it if too robotic. Exactly 0 cannot be sent — the engine would ignore it and silently use the model default.">
                  Temperature
                </Label>
                <NumberInput
                  value={settings.temperature}
                  min={0.05}
                  max={2}
                  step={0.05}
                  disabled={!settings.customGenerationParams}
                  onChange={(v) => set('temperature', v ?? 1)}
                  className="w-28"
                />
              </div>
              <div>
                <Label tip="Nucleus sampling — limits token candidates to the top P% by probability. Range: 0.05 – 1.0. Typical: 0.95 for Gemini 3.x, 0.80 for 2.x. Works with Temperature. Exactly 0 cannot be sent — the engine would ignore it and silently use the model default.">
                  Top-P
                </Label>
                <NumberInput
                  value={settings.topP}
                  min={0.05}
                  max={1}
                  step={0.05}
                  disabled={!settings.customGenerationParams}
                  onChange={(v) => set('topP', v ?? 0.95)}
                  className="w-28"
                />
              </div>
              <div>
                <Label tip="Limits candidate tokens considered at each step. Range: 1 – 100. Leave empty to use the model's built-in default. Rarely needs changing for subtitle translation.">
                  Top-K
                </Label>
                <NumberInput
                  value={settings.topK}
                  min={1}
                  max={100}
                  allowEmpty
                  disabled={!settings.customGenerationParams}
                  onChange={(v) => set('topK', v)}
                  placeholder="— model default —"
                  className="w-40"
                />
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

function SectionService({ settings, set }: SectionProps): React.JSX.Element {
  const modelLabel =
    settings.cachedModels.find((m) => m.id === settings.model)?.label ?? settings.model
  const { slot: primarySlot, paid } = effectivePrimary(settings)
  return (
    <div className="max-w-xl space-y-5">
      <SectionTitle>Service</SectionTitle>
      <div>
        <Label tip="The Google AI Studio request tier. Standard (default): available to all accounts, best for regular use. Flex: lower-priority queue, cheaper for large batches — may be slower at peak times. Priority: highest-priority, minimal latency — requires a paid plan. Standard works well for most subtitle jobs.">
          Service Tier
        </Label>
        <Select value={settings.serviceTier} onChange={(v) => set('serviceTier', v)} options={SERVICE_TIERS} className="w-52" />
      </div>
      <div>
        <Label tip={paidQuotaTooltip(settings.model, modelLabel)}>Paid Quota</Label>
        <div className="flex items-center gap-3">
          <span
            className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${
              paid
                ? 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300'
                : 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300'
            }`}
          >
            {paid ? 'ON — free-tier rate limiting disabled' : 'OFF — free-tier rate limiting applied'}
          </span>
        </div>
        <p className="mt-1.5 text-xs text-gray-500 dark:text-gray-400">
          {primarySlot == null
            ? 'Add an API key to see which tier a run will use.'
            : `Follows the tier set on Key ${primarySlot + 1}, the key this run sends as -k. `}
          {primarySlot != null && (
            <>
              Change it in{' '}
              <strong>Gemini API Keys</strong>. It is shown here rather than toggled, because the
              engine is told which quota to assume by the key that is actually promoted — a
              separate switch could only ever disagree with the run.
            </>
          )}
        </p>
      </div>
      <ToggleRow
        label="Disable Streaming"
        desc="Wait for the full batch response before saving"
        checked={settings.disableStreaming}
        onChange={(v) => set('disableStreaming', v)}
        tip="By default, translations stream in as they're generated. Disable streaming to wait for the complete batch response before writing — useful if batches come back garbled on unstable connections. Slightly slower feedback but can be more reliable."
      />
    </div>
  )
}

function SectionTmdb({ settings, set }: SectionProps): React.JSX.Element {
  return (
    <div className="max-w-xl space-y-5">
      <SectionTitle>TMDB</SectionTitle>
      <div>
        <Label tip="The Movie Database (TMDB) API key, used to look up movie/TV metadata and cast genders for better translation context. A shared public key is pre-filled and works out of the box. Replace it with your own (free at themoviedb.org) for higher rate limits.">
          TMDB API Key
        </Label>
        <TextInput value={settings.tmdbApiKey} onChange={(e) => set('tmdbApiKey', e.target.value)} className="w-full" />
        <p className="mt-1.5 text-xs text-gray-500 dark:text-gray-400">
          A shared public key is pre-filled. <Pill>optional</Pill> use your own for higher limits.
        </p>
      </div>
    </div>
  )
}

function SectionOutput({ settings, set }: SectionProps): React.JSX.Element {
  async function pickFolder(): Promise<void> {
    const dir = await window.api.openFolder()
    if (dir) set('outputFolder', dir)
  }
  return (
    <div className="max-w-xl space-y-5">
      <SectionTitle>Output</SectionTitle>
      <div>
        <Label tip="Default folder where translated subtitles are saved. If left empty, the Save dialog opens at the source file's directory instead. You can always change the location at save time.">
          Default Output Folder
        </Label>
        <div className="flex items-center gap-2">
          <TextInput readOnly value={settings.outputFolder} placeholder="— source file's folder —" className="flex-1" />
          <Button variant="secondary" onClick={pickFolder}>
            Browse
          </Button>
          {settings.outputFolder && (
              <button onClick={() => set('outputFolder', '')} className="flex h-9 w-9 items-center justify-center rounded-md border border-gray-300 text-gray-500 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-400 dark:hover:bg-gray-700" title="Clear">
              ✕
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

function SectionAdvanced({ settings, set }: SectionProps): React.JSX.Element {
  async function pickFfmpeg(): Promise<void> {
    const p = await window.api.openFile([{ name: 'Executable', extensions: ['exe', '*'] }])
    if (p) set('ffmpegPath', p)
  }
  return (
    <div className="max-w-2xl space-y-5">
      <SectionTitle>Advanced</SectionTitle>
      <div>
        <Label tip="Path to the FFmpeg executable. Only needed for video/audio features: the Transcribe tab, the Video File field, and the Audio File field on the Translate tab. Not required for plain subtitle translation.

Leave empty (recommended) to use the FFmpeg bundled inside this app — no separate install required. If for some reason the bundled copy is missing, it then falls back to FFmpeg on your system PATH. Only set a path here to override the bundled copy with your own FFmpeg build (e.g. one with extra codecs or hardware acceleration); when set, that path is used directly.

Since engine 3.7.0, a missing FFmpeg no longer aborts operations that do not need it — fetching models and translating a subtitle file keep working, and only the audio/video features report the problem.">
          FFmpeg Path
        </Label>
        <div className="flex items-center gap-2">
          <TextInput readOnly value={settings.ffmpegPath} placeholder="— use bundled FFmpeg (no install needed) —" className="flex-1" />
          <Button variant="secondary" onClick={pickFfmpeg}>
            Browse
          </Button>
          {settings.ffmpegPath && (
            <button onClick={() => set('ffmpegPath', '')} className="flex h-9 w-9 items-center justify-center rounded-md border border-gray-300 text-gray-500 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-400 dark:hover:bg-gray-700" title="Clear">
              ✕
            </button>
          )}
        </div>
      </div>
      <div>
        <Label tip="Optional custom system prompt that overrides the built-in translation instructions. Advanced use only — leave empty unless you know exactly how you want to steer the model's behaviour. An empty value uses the tool's well-tuned default prompt.">
          System Prompt Override
        </Label>
        <textarea
          value={settings.systemPrompt}
          onChange={(e) => set('systemPrompt', e.target.value)}
          rows={3}
          placeholder="— use built-in default prompt —"
          className="w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 outline-none focus:border-brand focus:ring-1 focus:ring-brand dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 dark:placeholder:text-gray-500"
        />
      </div>
      <Divider />
      <div>
        <Label tip={`Lines of already-translated context replayed to the model when a job is RESUMED from a specific line. Default: ${DEFAULT_RESUME_CONTEXT_SIZE}. 0 sends no prior context. More context keeps names and tone consistent across the break, at the cost of extra input tokens on the first resumed batch.

This setting has NO effect on a normal run — it applies only when a translation is resumed part-way through.`}>
          Resume Context Size
        </Label>
        <NumberInput
          value={settings.resumeContextSize}
          min={0}
          max={500}
          onChange={(v) => set('resumeContextSize', v ?? DEFAULT_RESUME_CONTEXT_SIZE)}
          className="w-28"
        />
        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
          Only takes effect when resuming an interrupted job.
        </p>
      </div>
      <Divider />
      <ToggleRow
        label="Show Token Usage"
        desc="Display prompt/output token counts after each run"
        checked={settings.showTokenStats}
        onChange={(v) => set('showTokenStats', v)}
        tip="After a translation completes, show how many tokens were used (prompt, thoughts, output, total). Useful for tracking your quota consumption. On by default."
      />
      <ToggleRow
        label="Write Token Report"
        desc="Save a per-run token usage JSON file"
        checked={settings.writeTokenReport}
        onChange={(v) => set('writeTokenReport', v)}
        tip="Write a JSON file next to each output recording detailed token usage for that run. Useful for auditing costs across many files. Off by default."
      />
      <ToggleRow
        label="Progress Log"
        desc="Write detailed progress logging"
        checked={settings.progressLog}
        onChange={(v) => set('progressLog', v)}
        tip="Enable verbose progress logging from the translator. Helpful for debugging stalled translations. Off by default."
      />
      <ToggleRow
        label="Thoughts Log"
        desc="Log the model's internal reasoning (large files)"
        checked={settings.thoughtsLog}
        onChange={(v) => set('thoughtsLog', v)}
        tip="Log the model's internal 'thinking' output. Warning: this can create very large log files. Only enable when diagnosing translation quality issues. Off by default."
      />
    </div>
  )
}
