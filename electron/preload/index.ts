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
  EngineInfo,
  FfmpegProgress,
  KeyCheck,
  SlotFetchResult,
  RefreshOutcome,
  SaveResult
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
  /**
   * True when the keys changed while they were being checked, so NOTHING from this result
   * was applied. Separate from `refreshOutcome`, which describes how complete the fetch
   * was — a discarded result can be perfectly complete and still describe keys that are no
   * longer there. Treat every other field as informational when this is set.
   */
  discarded: boolean
  /** The selection after the Step 4a rules ran; may differ from what was stored. */
  model: string
  /** Human-readable explanation when a rule fired or the refresh was incomplete. */
  notice: string
  updatedAt: string
  anyValid: boolean
}

/**
 * What the save dialog resolves to.
 *
 * It used to be the subtitle's path alone, and the renderer DERIVED the console log's name from it.
 * That stopped being safe once sidecars are written exclusively: an occupied name is stepped, so
 * the destination is no longer predictable and has to be reported (SOL-12). `path` is `''` when the
 * user cancelled, exactly as the bare string was.
 */
/**
 * Re-exported so existing importers keep working. The declaration itself now lives in
 * `shared/types.ts`, where the MAIN process can see it too — it was declared here alone, so the
 * handler that produces it was unchecked against it, and one branch had gone on returning the bare
 * string this replaced (SOL-15).
 */
export type { SaveResult }

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
  }): Promise<SaveResult> => ipcRenderer.invoke('dialog:saveFile', args),

  // engine
  /** Which gst binary a run will use — the answer to "am I running the packaged engine?". */
  getEngineInfo: (): Promise<EngineInfo> => ipcRenderer.invoke('engine:info'),

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
