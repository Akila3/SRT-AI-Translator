import React, { useState } from 'react'
import type { SubtitleTrack } from '../../electron/shared/types'
import { langLabel } from '../data/languages'

type ExtractState = 'idle' | 'extracting' | 'saved' | 'error'

export function SubTrackPanel({
  videoFile,
  tracks,
  targetLang,
  selectedIndex,
  onSelect
}: {
  videoFile: string
  tracks: SubtitleTrack[]
  targetLang: string
  selectedIndex: number | null
  onSelect: (index: number) => void
}): React.JSX.Element | null {
  const [extractState, setExtractState] = useState<ExtractState>('idle')
  const [savedPath, setSavedPath] = useState('')
  const [error, setError] = useState('')

  if (!videoFile) return null

  if (tracks.length === 0) {
    return (
      <p className="text-sm text-gray-500 dark:text-gray-400">No subtitle tracks found in this file.</p>
    )
  }

  const textTracks = tracks.filter((t) => !t.isImage)
  const singleText = textTracks.length === 1 && tracks.length === 1
  const allPgs = tracks.every((t) => t.isImage)
  const matchTrack = targetLang ? tracks.find((t) => t.lang === targetLang) : undefined
  const matchIsImage = matchTrack?.isImage ?? false
  const tgtName = langLabel(targetLang)

  async function doExtract(track: SubtitleTrack): Promise<void> {
    setExtractState('extracting')
    setError('')
    const ext = track.isImage ? 'sup' : 'srt'
    const res = await window.api.extractTrack({
      filePath: videoFile,
      subtitleIndex: track.index,
      isImage: track.isImage,
      defaultName: `subtitle_${targetLang || 'track'}.${ext}`
    })
    if (res.canceled) {
      setExtractState('idle')
    } else if (res.ok) {
      setSavedPath(res.path ?? '')
      setExtractState('saved')
    } else {
      setError(res.error ?? 'Extraction failed')
      setExtractState('error')
    }
  }

  return (
    <div className="space-y-2.5">
      {allPgs && (
        <div className="rounded-md border border-yellow-300 bg-yellow-50 px-3.5 py-2.5 dark:border-yellow-700/60 dark:bg-yellow-900/25">
          <p className="text-sm font-semibold text-yellow-800 dark:text-yellow-200">
            ⚠ No SRT or ASS/SSA tracks found — cannot translate image-based (PGS) subtitles.
          </p>
          <p className="mt-0.5 text-sm text-yellow-800 dark:text-yellow-200">
            You can still extract a PGS track as a .sup file to play in VLC, Kodi, MPV, Plex, or MPC-HC.
          </p>
        </div>
      )}

      {singleText ? (
        <div className="flex items-center gap-2 rounded-md border border-gray-200 bg-gray-50 px-3 py-2 dark:border-gray-700 dark:bg-gray-800">
          <span className="text-sm">✓</span>
          <span className="text-sm text-gray-700 dark:text-gray-300">
            Auto-selected: Track {tracks[0].index} — {tracks[0].name} ({tracks[0].codec})
          </span>
        </div>
      ) : (
        <div className="overflow-hidden rounded-md border border-gray-200 dark:border-gray-700">
          {tracks.map((t, idx) => {
            const isSel = !t.isImage && selectedIndex === t.index
            const isMatch = targetLang && t.lang === targetLang
            return (
              <label
                key={idx}
                className={`flex cursor-pointer items-center gap-2.5 px-3 py-2 ${
                  idx > 0 ? 'border-t border-gray-200 dark:border-gray-700' : ''
                } ${
                  isMatch
                    ? 'bg-amber-50 dark:bg-amber-900/25'
                    : isSel
                      ? 'bg-blue-50 dark:bg-blue-900/30'
                      : ''
                } ${t.isImage ? 'cursor-not-allowed' : ''}`}
              >
                <input
                  type="radio"
                  name="subtrack"
                  disabled={t.isImage}
                  checked={isSel}
                  onChange={() => !t.isImage && onSelect(t.index)}
                  className="accent-brand"
                />
                <span className={`min-w-[150px] text-sm ${t.isImage ? 'text-gray-400 dark:text-gray-500' : 'text-gray-800 dark:text-gray-200'}`}>
                  {t.name}
                </span>
                <span className="min-w-[44px] text-xs uppercase text-gray-400 dark:text-gray-500">{t.lang || '—'}</span>
                <span className="flex-1 text-xs text-gray-400 dark:text-gray-500">{t.codec}</span>
                {t.isImage && (
                  <span className="rounded bg-gray-100 px-1.5 py-0.5 text-[10px] text-gray-500 dark:bg-gray-700 dark:text-gray-300">
                    Image-based
                  </span>
                )}
                {isMatch && (
                  <span className="rounded bg-amber-600 px-1.5 py-0.5 text-[10px] font-semibold text-white">
                    Matches target lang
                  </span>
                )}
              </label>
            )
          })}
        </div>
      )}

      {matchTrack && (
        <div className="rounded-md border border-amber-400 bg-amber-50 px-3.5 py-3 dark:border-amber-700/60 dark:bg-amber-900/25">
          <p className="text-sm font-semibold text-amber-900 dark:text-amber-200">
            ⚠ A {tgtName} subtitle track already exists in this video file.
          </p>
          <p className="mt-1 text-sm text-amber-900 dark:text-amber-200">
            {matchIsImage
              ? `This is an image-based (PGS) track — it cannot be translated directly. Extract it as a .sup to use in VLC, Kodi, MPV, Plex, or MPC-HC, or translate a different text track into ${tgtName}.`
              : `Consider extracting and using the built-in ${tgtName} subtitles instead of re-translating. You can also continue to get a fresh AI translation.`}
          </p>
          <div className="mt-2.5">
            {extractState === 'idle' && (
              <button
                onClick={() => doExtract(matchTrack)}
                className="rounded-md border border-gray-300 bg-white px-3.5 py-2 text-sm font-medium text-gray-800 hover:bg-gray-50 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 dark:hover:bg-gray-600"
              >
                {matchIsImage
                  ? `Extract as .sup (${tgtName})`
                  : `Extract ${tgtName} Subtitles as .srt`}
              </button>
            )}
            {extractState === 'extracting' && (
              <span className="text-sm text-gray-600 dark:text-gray-400">Extracting subtitle stream…</span>
            )}
            {extractState === 'saved' && (
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <span className="text-base">✅</span>
                  <span className="text-sm font-semibold text-green-700 dark:text-green-400">Saved → {savedPath}</span>
                  <button
                    onClick={() => window.api.showItemInFolder(savedPath)}
                    className="text-xs text-brand hover:underline"
                  >
                    Show in folder
                  </button>
                </div>
                {matchIsImage && (
                  <p className="pl-6 text-xs text-gray-500 dark:text-gray-400">
                    .sup plays in VLC, Kodi, MPV, Plex, and MPC-HC.
                  </p>
                )}
                <button
                  onClick={() => setExtractState('idle')}
                  className="pl-6 text-xs text-brand hover:underline"
                >
                  Extract again
                </button>
              </div>
            )}
            {extractState === 'error' && (
              <div className="space-y-1">
                <p className="text-sm text-red-600 dark:text-red-400">Extraction failed. Is FFmpeg installed?</p>
                {error && <pre className="whitespace-pre-wrap text-xs text-gray-500 dark:text-gray-400">{error}</pre>}
                <button
                  onClick={() => setExtractState('idle')}
                  className="text-xs text-brand hover:underline"
                >
                  Try again
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
