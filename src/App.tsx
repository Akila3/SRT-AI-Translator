import React, { useEffect, useState } from 'react'
import { useStore } from './store/useStore'
import TranslatePage from './pages/TranslatePage'
import TranscribePage from './pages/TranscribePage'
import SettingsPage from './pages/SettingsPage'

type Tab = 'translate' | 'transcribe' | 'settings'

const TABS: { id: Tab; label: string }[] = [
  { id: 'translate', label: 'Translate' },
  { id: 'transcribe', label: 'Transcribe' },
  { id: 'settings', label: 'Settings' }
]

function applyTheme(theme: string): void {
  const root = document.documentElement
  const sysDark = window.matchMedia('(prefers-color-scheme: dark)').matches
  const dark = theme === 'dark' || (theme === 'auto' && sysDark)
  root.classList.toggle('dark', dark)
}

export default function App(): React.JSX.Element {
  const load = useStore((s) => s.load)
  const loaded = useStore((s) => s.loaded)
  const setModels = useStore((s) => s.setModels)
  const theme = useStore((s) => s.settings?.theme ?? 'auto')
  const [tab, setTab] = useState<Tab>('translate')

  useEffect(() => {
    void load().then(async () => {
      const cached = await window.api.getCachedModels()
      if (cached.models?.length) setModels(cached.models, cached.updatedAt)
    })
  }, [load, setModels])

  useEffect(() => {
    applyTheme(theme)
    if (theme !== 'auto') return
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const handler = (): void => applyTheme('auto')
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
  }, [theme])

  return (
    <div className="flex h-full flex-col bg-gray-50 dark:bg-gray-900">
      {/* Header */}
      <header className="flex items-center justify-between border-b border-gray-200 bg-white px-6 py-3 dark:border-gray-700 dark:bg-gray-800">
        <div>
          <h1 className="text-lg font-bold text-gray-900 dark:text-gray-100">Gemini SRT Translator</h1>
          <p className="text-xs text-gray-500 dark:text-gray-400">Powered by Google Gemini AI</p>
        </div>
        <nav className="flex gap-1">
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`relative px-4 py-2 text-sm font-medium transition-colors ${
                tab === t.id
                  ? 'text-brand'
                  : 'text-gray-500 hover:text-gray-800 dark:text-gray-400 dark:hover:text-gray-200'
              }`}
            >
              {t.label}
              {tab === t.id && (
                <span className="absolute inset-x-2 -bottom-[13px] h-0.5 rounded-full bg-brand" />
              )}
            </button>
          ))}
        </nav>
      </header>

      {/* Body */}
      <main className="thin-scroll flex-1 overflow-y-auto p-6">
        {!loaded ? (
          <div className="text-sm text-gray-500 dark:text-gray-400">Loading…</div>
        ) : (
          // Keep every page mounted and just toggle visibility so each tab's
          // inputs (loaded SRT, TMDB selection, languages, etc.) persist when
          // the user switches tabs and comes back.
          <>
            <div className={tab === 'translate' ? '' : 'hidden'}>
              <TranslatePage />
            </div>
            <div className={tab === 'transcribe' ? '' : 'hidden'}>
              <TranscribePage />
            </div>
            <div className={tab === 'settings' ? '' : 'hidden'}>
              <SettingsPage />
            </div>
          </>
        )}
      </main>
    </div>
  )
}
