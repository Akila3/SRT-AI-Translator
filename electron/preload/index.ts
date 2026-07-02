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
  ProcDone
} from '../shared/types'

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
  ): Promise<{ models: ModelInfo[]; updatedAt: string; keyValid: boolean; error: string }> =>
    ipcRenderer.invoke('models:refresh', apiKey),
  checkApiKeys: (
    keys: string[]
  ): Promise<{
    results: { valid: boolean | null; error: string }[]
    models: ModelInfo[]
    updatedAt: string
    anyValid: boolean
  }> => ipcRenderer.invoke('models:checkKeys', keys),

  // dialogs
  openFile: (filters?: Electron.FileFilter[]): Promise<string> =>
    ipcRenderer.invoke('dialog:openFile', { filters }),
  openFolder: (): Promise<string> => ipcRenderer.invoke('dialog:openFolder'),
  saveFile: (args: { srcPath?: string; defaultName: string; defaultDir?: string; logPaths?: string[] }): Promise<string> =>
    ipcRenderer.invoke('dialog:saveFile', args),

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
  }
}

contextBridge.exposeInMainWorld('api', api)

export type Api = typeof api
