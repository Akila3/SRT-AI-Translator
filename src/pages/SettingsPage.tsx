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
import { THINKING_LEVELS, SERVICE_TIERS, paidQuotaTooltip } from '../data/freeTier'
import type { AppSettings } from '../../electron/shared/types'

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

function SectionApiKeys({ settings, set }: SectionProps): React.JSX.Element {
  const setModels = useStore((s) => s.setModels)
  const updatedAt = useStore((s) => s.modelsUpdatedAt)
  const [refreshing, setRefreshing] = useState(false)
  const [modelCount, setModelCount] = useState<number | null>(null)
  const [revealed, setRevealed] = useState<Record<number, boolean>>({})
  const keys = settings.apiKeys.length ? settings.apiKeys : ['']
  const tiers = keys.map((_, i) => settings.apiKeyTiers?.[i] ?? 'free')
  const valids = keys.map((_, i) => settings.apiKeyValid?.[i] ?? null)
  const errs = keys.map((_, i) => settings.apiKeyError?.[i] ?? '')

  function toggleReveal(i: number): void {
    setRevealed((r) => ({ ...r, [i]: !r[i] }))
  }

  function updateKey(i: number, val: string): void {
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
    setModelCount(null)
  }
  function setTier(i: number, val: string): void {
    const next = [...tiers]
    next[i] = val
    set('apiKeyTiers', next)
    // The primary key's tier is what the translator actually uses for rate limiting.
    if (i === 0) set('paidQuota', val === 'paid')
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
  }

  async function refresh(): Promise<void> {
    if (!keys.some((k) => k.trim())) return
    setRefreshing(true)
    setModelCount(null)
    try {
      const res = await window.api.checkApiKeys(keys)
      if (res.anyValid) setModels(res.models, res.updatedAt)
      // Mirror the per-key status into the live store so it sticks across tabs.
      set('apiKeyValid', res.results.map((r) => r.valid))
      set('apiKeyError', res.results.map((r) => r.error))
      setModelCount(res.models.length)
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
  const primaryPaid = tiers[0] === 'paid'
  const tierLabel = primaryPaid ? 'Paid' : 'Free'

  return (
    <div className="max-w-xl space-y-5">
      <SectionTitle>Gemini API Keys</SectionTitle>
      <div>
        <Label tip="Your Gemini API key(s) from Google AI Studio. The first key is used by default; additional keys are passed as fallback quota (-k2) so the tool can keep going if the first key hits its limit. Add up to 5 keys. Use the eye icon to reveal a key. Set each key's tier (Free / Paid) — Google's API can't report this automatically, so mark it yourself; the primary key's tier controls rate-limiting (Paid Quota). Get a free key at aistudio.google.com/apikey.">
          API Keys (up to 5)
        </Label>
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
        <Label tip="Validates every saved API key individually (each gets a ✓ or ✗ next to it) and retrieves the list of Gemini models from the first valid key — which determines what appears in the Model dropdown. New models Google releases (e.g. a future Flash 4.0) show up here automatically. The list is cached so it loads instantly next time. Run this after entering your keys. (Tier is set per key above — Google's API can't report it automatically.)">
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
            title="Primary key's tier (set per key above). Google's API does not expose a key's billing tier, so set it manually. This drives rate-limiting (Paid Quota)."
          >
            Primary key tier: {tierLabel}
          </span>
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
  const models = settings.cachedModels.map((m) => ({
    value: m.id,
    label: m.available ? m.label : `${m.label} (unavailable)`
  }))
  const is3x = settings.model.startsWith('gemini-3') || settings.model.endsWith('-latest')
  const is25 = settings.model.startsWith('gemini-2.5')

  function handleModel(v: string): void {
    set('model', v)
    if (v.startsWith('gemini-3') || v.endsWith('-latest')) {
      set('temperature', 1.0)
      set('topP', 0.95)
    } else {
      set('temperature', 0.3)
      set('topP', 0.8)
    }
  }

  return (
    <div className="space-y-5">
      <SectionTitle>Model &amp; Generation</SectionTitle>

      <div>
        <Label tip="The Gemini model used for translation. Recommendation: Gemini Flash Lite Latest — best for free-tier users, fastest, very good quality (the default). Gemini Flash Latest — higher quality, slower, uses more quota. Gemini Pro Latest — highest quality, much slower, for difficult content. The '… Latest' options always track Google's newest model in each tier (the resolved version is shown in parentheses). Use 'Fetch Models & Check API Key' to refresh the list.">
          Model
        </Label>
        <Select value={settings.model} onChange={handleModel} options={models} className="w-80" />
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
            <Label tip="Gemini 3.x only. Controls how much internal reasoning the model does before output. Order: Disabled (none, fastest) → Minimal → Low (default, recommended) → Medium → High (most thorough, slowest). Low is sufficient for most subtitle jobs. Greyed out for 2.x — use Thinking Budget instead.">
              Thinking Level
            </Label>
            {is3x ? (
              <Select
                value={settings.thinkingLevel}
                onChange={(v) => set('thinkingLevel', v)}
                options={THINKING_LEVELS}
                className="w-52"
              />
            ) : (
              <>
                <Select value="" onChange={() => {}} disabled options={[{ value: '', label: '3.x models only' }]} className="w-52" />
                <p className="mt-1 text-xs text-gray-400 dark:text-gray-500">Select a Gemini 3.x model to enable.</p>
              </>
            )}
          </div>
          <div>
            <Label tip="Gemini 2.5 only. Maximum tokens the model may use for internal reasoning. Default: 512. Set to 0 to disable thinking (faster, cheaper). Increase to 2048–8192 for complex content. Maximum: 32,768. Greyed out for 3.x — use Thinking Level instead.">
              Thinking Budget
            </Label>
            {is25 ? (
              <NumberInput
                value={settings.thinkingBudget}
                min={0}
                max={32768}
                onChange={(v) => set('thinkingBudget', v ?? 512)}
                className="w-28"
              />
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
          <div>
            <Label tip={`Controls randomness (creativity). Lower = more literal. Higher = more natural-sounding. Range: 0.0 – 2.0. Default for ${is3x ? 'Gemini 3.x' : 'Gemini 2.x'}: ${is3x ? '1.0' : '0.3'}. Lower it if translations feel too creative; raise it if too robotic.`}>
              Temperature
            </Label>
            <NumberInput value={settings.temperature} min={0} max={2} step={0.05} onChange={(v) => set('temperature', v ?? 1)} className="w-28" />
          </div>
          <div>
            <Label tip={`Nucleus sampling — limits token candidates to the top P% by probability. Range: 0.0 – 1.0. Default for ${is3x ? 'Gemini 3.x' : 'Gemini 2.x'}: ${is3x ? '0.95' : '0.80'}. Works with Temperature. Leave at default unless you have a specific reason.`}>
              Top-P
            </Label>
            <NumberInput value={settings.topP} min={0} max={1} step={0.05} onChange={(v) => set('topP', v ?? 0.95)} className="w-28" />
          </div>
          <div>
            <Label tip="Limits candidate tokens considered at each step. Range: 1 – 100. Optional — leave empty to use the model's built-in default. Rarely needs changing for subtitle translation.">
              Top-K
            </Label>
            <NumberInput value={settings.topK} min={1} max={100} allowEmpty onChange={(v) => set('topK', v)} placeholder="— model default —" className="w-40" />
          </div>
        </div>
      </div>
    </div>
  )
}

function SectionService({ settings, set }: SectionProps): React.JSX.Element {
  const modelLabel =
    settings.cachedModels.find((m) => m.id === settings.model)?.label ?? settings.model
  return (
    <div className="max-w-xl space-y-5">
      <SectionTitle>Service</SectionTitle>
      <div>
        <Label tip="The Google AI Studio request tier. Standard (default): available to all accounts, best for regular use. Flex: lower-priority queue, cheaper for large batches — may be slower at peak times. Priority: highest-priority, minimal latency — requires a paid plan. Standard works well for most subtitle jobs.">
          Service Tier
        </Label>
        <Select value={settings.serviceTier} onChange={(v) => set('serviceTier', v)} options={SERVICE_TIERS} className="w-52" />
      </div>
      <ToggleRow
        label="Paid Quota"
        desc="Disable free-tier rate limiting (paid plans only)"
        checked={settings.paidQuota}
        onChange={(v) => set('paidQuota', v)}
        tip={paidQuotaTooltip(settings.model, modelLabel)}
      />
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
        <Label tip="Path to the FFmpeg executable. Only needed for video/audio features: the Transcribe tab, the Video File field, and the Audio File field on the Translate tab. Not required for plain SRT translation.

Leave empty (recommended) to use the FFmpeg bundled inside this app — no separate install required. If for some reason the bundled copy is missing, it then falls back to FFmpeg on your system PATH. Only set a path here to override the bundled copy with your own FFmpeg build (e.g. one with extra codecs or hardware acceleration); when set, that path is used directly.">
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
