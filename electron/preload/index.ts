import { contextBridge, ipcRenderer } from 'electron'
import type {
  AppSettings,
  ModelInfo,
  SubtitleTrack,
  TranslateArgs,
  TranscribeArgs,
  TmdbResult,
  TmdbDetails,
  ProcOutput,
  ProcDone,
  FfmpegProgress,
  KeyCheck,
  SlotFetchResult,
  RefreshOutcome
} from '../shared/types'

/**
 * What `models:checkKeys` resolves to. Wider than the old shape because the renderer now
 * needs the per-slot evidence to label keys and explain a partial refresh, instead of
 * being handed a single boolean and left to guess.
 */
export interface CheckKeysResponse {
  results: KeyCheck[]
  slots: SlotFetchResult[]
  models: ModelInfo[]
  unionIds: string[]
  runnableIds: string[]
  activeSlots: number[]
  refreshOutcome: RefreshOutcome
  /** The selection after the Step 4a rules ran; may differ from what was stored. */
  model: string
  /** Human-readable explanation when a rule fired or the refresh was incomplete. */
  notice: string
  updatedAt: string
  anyValid: boolean
}

const api = {
  // settings
  getSettings: (): Promise<AppSettings> => ipcRenderer.invoke('settings:get'),
  setSettings: (patch: Partial<AppSettings>): Promise<AppSettings> =>
    ipcRenderer.invoke('settings:set', patch),

  // models
  getCachedModels: (): Promise<{ models: ModelInfo[]; updatedAt: string | null }> =>
    ipcRenderer.invoke('models:getCached'),
  refreshModels: (
    apiKey: string
  ): Promise<{
    models: ModelInfo[]
    updatedAt: string
    keyValid: boolean
    error: string
    notice: string
  }> => ipcRenderer.invoke('models:refresh', apiKey),
  checkApiKeys: (keys: string[]): Promise<CheckKeysResponse> =>
    ipcRenderer.invoke('models:checkKeys', keys),

  // dialogs
  openFile: (filters?: Electron.FileFilter[]): Promise<string> =>
    ipcRenderer.invoke('dialog:openFile', { filters }),
  openFolder: (): Promise<string> => ipcRenderer.invoke('dialog:openFolder'),
  saveFile: (args: {
    srcPath?: string
    defaultName: string
    defaultDir?: string
    logPaths?: string[]
    /** The file the user chose to translate, so the token report can name it instead of a temp path. */
    inputPath?: string
  }): Promise<string> => ipcRenderer.invoke('dialog:saveFile', args),

  // shell
  showItemInFolder: (p: string): Promise<void> => ipcRenderer.invoke('shell:showItem', p),
  openExternal: (url: string): Promise<void> => ipcRenderer.invoke('shell:openExternal', url),

  // video
  probeTracks: (filePath: string): Promise<SubtitleTrack[]> =>
    ipcRenderer.invoke('video:probeTracks', filePath),
  extractTrack: (args: {
    filePath: string
    subtitleIndex: number
    isImage: boolean
    defaultName: string
  }): Promise<{ ok: boolean; error?: string; canceled?: boolean; path?: string }> =>
    ipcRenderer.invoke('video:extractTrack', args),
  extractToTemp: (args: {
    filePath: string
    subtitleIndex: number
  }): Promise<{ ok: boolean; error?: string; path?: string }> =>
    ipcRenderer.invoke('video:extractToTemp', args),

  // tmdb
  tmdbSearch: (query: string, type: 'all' | 'movie' | 'tv'): Promise<TmdbResult[]> =>
    ipcRenderer.invoke('tmdb:search', { query, type }),
  tmdbCast: (tmdbId: string, mediaType: 'movie' | 'tv'): Promise<TmdbDetails> =>
    ipcRenderer.invoke('tmdb:cast', { tmdbId, mediaType }),

  // translate / transcribe
  startTranslate: (args: TranslateArgs): Promise<string> =>
    ipcRenderer.invoke('translate:start', args),
  startTranscribe: (args: TranscribeArgs): Promise<string> =>
    ipcRenderer.invoke('transcribe:start', args),
  stop: (): Promise<boolean> => ipcRenderer.invoke('translate:stop'),
  isRunning: (): Promise<boolean> => ipcRenderer.invoke('translate:isRunning'),

  // streaming events
  onOutput: (cb: (o: ProcOutput) => void): (() => void) => {
    const listener = (_e: unknown, payload: ProcOutput): void => cb(payload)
    ipcRenderer.on('translate:output', listener)
    return () => ipcRenderer.removeListener('translate:output', listener)
  },
  onDone: (cb: (d: ProcDone) => void): (() => void) => {
    const listener = (_e: unknown, payload: ProcDone): void => cb(payload)
    ipcRenderer.on('translate:done', listener)
    return () => ipcRenderer.removeListener('translate:done', listener)
  },
  /**
   * How far an ffmpeg task has got — a channel of its own, separate from the engine's output
   * stream, so that a tick every half second never lands in the log panel.
   *
   * Every page receives every task, because a transcription's audio conversion and a track
   * export can genuinely overlap; the `kind` field is what lets a page recognise its own.
   */
  onFfmpegProgress: (cb: (p: FfmpegProgress) => void): (() => void) => {
    const listener = (_e: unknown, payload: FfmpegProgress): void => cb(payload)
    ipcRenderer.on('ffmpeg:progress', listener)
    return () => ipcRenderer.removeListener('ffmpeg:progress', listener)
  }
}

contextBridge.exposeInMainWorld('api', api)

export type Api = typeof api
