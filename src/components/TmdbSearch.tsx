import React, { useEffect, useRef, useState } from 'react'
import { Button, Select, TextInput, Pill, Label } from './ui'
import { openExternalLink } from '../lib/openExternal'
import type { TmdbResult, TmdbDetails } from '../../electron/shared/types'

function yearRange(d: TmdbDetails): string {
  if (!d.yearStart) return ''
  if (d.yearEnd && d.yearEnd !== d.yearStart) return `${d.yearStart}\u2013${d.yearEnd}`
  return d.yearStart
}

function metaLine(d: TmdbDetails): string {
  const parts = [d.typeLabel.trim(), yearRange(d)].filter(Boolean)
  if (d.seasons > 0) parts.push(`${d.seasons} season${d.seasons > 1 ? 's' : ''}`)
  return parts.join(' \u00b7 ')
}

const tmdbUrl = (mediaType: 'movie' | 'tv', id: string): string =>
  `https://www.themoviedb.org/${mediaType}/${id}`
const imdbUrl = (id: string): string => `https://www.imdb.com/title/${id}/`

export function TmdbSearch({
  description,
  onDescription
}: {
  description: string
  onDescription: (desc: string) => void
}): React.JSX.Element {
  const [open, setOpen] = useState(true)
  const [query, setQuery] = useState('')
  const [type, setType] = useState<'all' | 'movie' | 'tv'>('all')
  const [results, setResults] = useState<TmdbResult[]>([])
  const [suggestions, setSuggestions] = useState<TmdbResult[]>([])
  const [showSuggest, setShowSuggest] = useState(false)
  const [selected, setSelected] = useState<TmdbResult | null>(null)
  const [detail, setDetail] = useState<TmdbDetails | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  /** Launch failures from TMDB/IMDb badges — not search/detail errors (SOL-28). */
  const [linkError, setLinkError] = useState('')
  const blurTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Debounced autocomplete as the user types.
  useEffect(() => {
    if (selected) return
    const q = query.trim()
    if (q.length < 2) {
      setSuggestions([])
      return
    }
    const t = setTimeout(async () => {
      try {
        const res = await window.api.tmdbSearch(q, type)
        setSuggestions(res.slice(0, 8))
        setShowSuggest(true)
      } catch {
        setSuggestions([])
      }
    }, 300)
    return () => clearTimeout(t)
  }, [query, type, selected])

  async function search(): Promise<void> {
    if (!query.trim()) return
    setLoading(true)
    setError('')
    setLinkError('')
    setResults([])
    setShowSuggest(false)
    try {
      const res = await window.api.tmdbSearch(query.trim(), type)
      setResults(res.slice(0, 12))
      if (res.length === 0) setError('No results found.')
    } catch {
      setError('TMDB search failed. Check your API key in Settings.')
    } finally {
      setLoading(false)
    }
  }

  async function pick(r: TmdbResult): Promise<void> {
    setSelected(r)
    setResults([])
    setSuggestions([])
    setShowSuggest(false)
    setLoading(true)
    setError('')
    setLinkError('')
    try {
      const d = await window.api.tmdbCast(r.id, r.mediaType)
      setDetail(d)
      const castStr = d.cast
        .filter((m) => m.character)
        .map((m) => `${m.character} (${m.gender.toLowerCase()})`)
        .join(', ')
      const kind = r.type === 'TV Show' ? 'TV series' : 'Film'
      const desc = `${kind}: ${d.title || r.title} (${d.yearStart || r.year}).${
        d.genres ? ' Genre: ' + d.genres + '.' : ''
      }${castStr ? ' Characters: ' + castStr + '.' : ''}`
      onDescription(desc)
    } catch {
      setError('Failed to fetch details.')
    } finally {
      setLoading(false)
    }
  }

  function clearSelection(): void {
    setSelected(null)
    setDetail(null)
    setQuery('')
    setLinkError('')
  }

  const headerYear = detail?.yearStart || selected?.year
  return (
    <div>
      <button
        onClick={() => setOpen((o) => !o)}
        className="mb-3 flex w-full items-center gap-2 text-left"
      >
        <span className="text-gray-400 dark:text-gray-500">{open ? '\u25be' : '\u25b8'}</span>
        <span className="text-[15px] font-semibold text-gray-900 dark:text-gray-100">TMDB Context</span>
        {selected && (
          <span className="ml-auto">
            <Pill>
              {selected.title}
              {headerYear ? ` (${headerYear})` : ''}
            </Pill>
          </span>
        )}
      </button>

      {open && (
        <div className="space-y-3">
          {!selected && (
            <div className="flex items-end gap-2">
              <div className="relative flex-1">
                <Label tip="Search The Movie Database by title, IMDb ID (e.g. tt0903747), or TMDB ID (e.g. 1396). Suggestions appear as you type. Selecting a result auto-generates a context description (cast names + genders) that helps Gemini pick correct gendered language and consistent character names.">
                  Search by Name, IMDb ID, or TMDB ID
                </Label>
                <TextInput
                  value={query}
                  onChange={(e) => {
                    setQuery(e.target.value)
                    setShowSuggest(true)
                  }}
                  onFocus={() => suggestions.length > 0 && setShowSuggest(true)}
                  onBlur={() => {
                    blurTimer.current = setTimeout(() => setShowSuggest(false), 150)
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      if (showSuggest && suggestions.length > 0) pick(suggestions[0])
                      else search()
                    } else if (e.key === 'Escape') {
                      setShowSuggest(false)
                    }
                  }}
                  placeholder="e.g. Breaking Bad · tt0903747 · 1396"
                  className="w-full"
                />
                {showSuggest && suggestions.length > 0 && (
                  <div className="absolute left-0 right-0 top-full z-50 mt-1 max-h-72 overflow-y-auto rounded-md border border-gray-200 bg-white shadow-lg dark:border-gray-700 dark:bg-gray-800">
                    {suggestions.map((s) => (
                      <button
                        key={s.id + s.mediaType}
                        onMouseDown={(e) => {
                          e.preventDefault()
                          if (blurTimer.current) clearTimeout(blurTimer.current)
                          pick(s)
                        }}
                        className="flex w-full items-center gap-2.5 px-3 py-2 text-left hover:bg-blue-50 dark:hover:bg-blue-900/30"
                      >
                        <Poster src={s.poster} />
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-sm font-medium text-gray-900 dark:text-gray-100">{s.title}</div>
                          <div className="text-xs text-gray-500 dark:text-gray-400">
                            {s.type} · {s.year}
                          </div>
                        </div>
                        <span className="text-[10px] text-gray-400 dark:text-gray-500">#{s.id}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <Select
                value={type}
                onChange={(v) => setType(v as 'all' | 'movie' | 'tv')}
                options={[
                  { value: 'all', label: 'All' },
                  { value: 'movie', label: 'Movie' },
                  { value: 'tv', label: 'TV Show' }
                ]}
                className="w-32"
              />
              <Button onClick={search} disabled={loading}>
                {loading ? '…' : 'Search'}
              </Button>
            </div>
          )}

          {error && <p className="text-xs text-red-500 dark:text-red-400">{error}</p>}
          {linkError && <p className="text-xs text-red-500 dark:text-red-400">{linkError}</p>}

          {/* Full results list (from the Search button) */}
          {!selected && results.length > 0 && (
            <div className="divide-y divide-gray-200 overflow-hidden rounded-md border border-gray-200 dark:divide-gray-700 dark:border-gray-700">
              {results.map((r) => (
                <button
                  key={r.id + r.mediaType}
                  onClick={() => pick(r)}
                  className="flex w-full items-center gap-3 px-3 py-2.5 text-left hover:bg-blue-50 dark:hover:bg-blue-900/30"
                >
                  <Poster src={r.poster} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-semibold text-gray-900 dark:text-gray-100">{r.title}</div>
                    <div className="text-xs text-gray-500 dark:text-gray-400">
                      {r.type} · {r.year}
                    </div>
                    <div className="mt-1">
                      <Badge href={tmdbUrl(r.mediaType, r.id)} onLink={setLinkError}>
                        TMDB #{r.id}
                      </Badge>
                    </div>
                  </div>
                </button>
              ))}
            </div>
          )}

          {/* Selected rich card (matches reference) */}
          {selected && (
            <div className="flex items-start gap-3 rounded-md border border-gray-200 px-3 py-3 dark:border-gray-700">
              <Poster src={selected.poster} large />
              <div className="min-w-0 flex-1">
                <div className="text-sm font-semibold text-gray-900 dark:text-gray-100">{selected.title}</div>
                <div className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
                  {loading && !detail
                    ? 'Loading details…'
                    : detail
                      ? metaLine(detail)
                      : `${selected.type} · ${selected.year}`}
                </div>
                <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                  <Badge
                    href={tmdbUrl(detail?.mediaType ?? selected.mediaType, detail?.tmdbId || selected.id)}
                    onLink={setLinkError}
                  >
                    TMDB #{detail?.tmdbId || selected.id}
                  </Badge>
                  {detail?.imdbId && (
                    <Badge href={imdbUrl(detail.imdbId)} onLink={setLinkError}>
                      IMDb {detail.imdbId}
                    </Badge>
                  )}
                </div>
              </div>
              <button
                onClick={clearSelection}
                className="flex-shrink-0 text-sm font-medium text-brand hover:underline"
              >
                Clear
              </button>
            </div>
          )}

          {/* Cast (drives the generated description) */}
          {selected && detail && detail.cast.length > 0 && (
            <div className="rounded-md border border-gray-200 p-3 dark:border-gray-700">
              <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">Cast</div>
              <div className="grid grid-cols-2 gap-x-4 gap-y-1 md:grid-cols-3">
                {detail.cast.map((m, i) => (
                  <div key={i} className="flex items-center justify-between text-xs">
                    <span className="truncate text-gray-700 dark:text-gray-300">{m.character || m.name}</span>
                    <span
                      className={`ml-2 rounded px-1.5 py-0.5 text-[10px] ${
                        m.gender === 'Female'
                          ? 'bg-pink-100 text-pink-700 dark:bg-pink-900/40 dark:text-pink-300'
                          : m.gender === 'Male'
                            ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300'
                            : 'bg-gray-100 text-gray-500 dark:bg-gray-700 dark:text-gray-300'
                      }`}
                    >
                      {m.gender}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div>
            <Label tip="The context description passed to Gemini (--description). Auto-filled when you pick a TMDB result, but fully editable. Good context improves name consistency and gendered language. You can also write your own without searching.">
              Description / Context
            </Label>
            <textarea
              value={description}
              onChange={(e) => onDescription(e.target.value)}
              rows={3}
              placeholder="Optional context to guide the translation…"
              className="w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 outline-none focus:border-brand focus:ring-1 focus:ring-brand dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 dark:placeholder:text-gray-500"
            />
          </div>
        </div>
      )}
    </div>
  )
}

function Poster({ src, large }: { src: string | null; large?: boolean }): React.JSX.Element {
  const size = large ? 'h-16 w-11' : 'h-12 w-8'
  if (src) {
    return <img src={src} alt="" className={`${size} flex-shrink-0 rounded object-cover`} />
  }
  return (
    <div
      className={`${size} flex flex-shrink-0 items-center justify-center rounded bg-gray-100 text-[9px] font-medium text-gray-400 dark:bg-gray-700 dark:text-gray-500`}
    >
      IMG
    </div>
  )
}

function Badge({
  children,
  href,
  onLink
}: {
  children: React.ReactNode
  href?: string
  onLink?: (msg: string) => void
}): React.JSX.Element {
  const cls =
    'rounded bg-gray-100 px-1.5 py-0.5 text-[10px] font-medium text-gray-600 dark:bg-gray-700 dark:text-gray-300'
  if (href) {
    return (
      <a
        href={href}
        onClick={(e) => {
          e.preventDefault()
          e.stopPropagation()
          void openExternalLink(href).then((err) => {
            onLink?.(err)
          })
        }}
        className={`${cls} hover:bg-gray-200 hover:text-brand hover:underline dark:hover:bg-gray-600`}
      >
        {children}
      </a>
    )
  }
  return <span className={cls}>{children}</span>
}
