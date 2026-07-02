import { ipcMain, dialog, shell, BrowserWindow } from 'electron'
import fs from 'fs'
import path from 'path'
import { getSettings, setSettings, store } from './store'
import { probeTracks, extractTrack } from './ffmpeg'
import { tmdbSearch, tmdbCast } from './tmdb'
import { refreshModels, buildModelList, checkApiKeys } from './modelsList'
import {
  startTranslate,
  startTranscribe,
  stopCurrent,
  isRunning,
  tempOutputPath
} from './pythonBridge'
import type {
  TranslateArgs,
  TranscribeArgs,
  AppSettings
} from '../shared/types'

let win: BrowserWindow | null = null
export function setMainWindow(w: BrowserWindow): void {
  win = w
}

function send(channel: string, payload: unknown): void {
  win?.webContents.send(channel, payload)
}

export function registerIpc(): void {
  // ---- Settings ----
  ipcMain.handle('settings:get', () => getSettings())
  ipcMain.handle('settings:set', (_e, patch: Partial<AppSettings>) => setSettings(patch))

  // ---- Models ----
  ipcMain.handle('models:getCached', () => {
    // Re-curate cached ids through the current rules so older caches get the
    // corrected friendly names / filtering without forcing a re-fetch.
    const cached = (store.get('cachedModels') as { id: string }[]) || []
    const models = buildModelList(cached.map((m) => m.id))
    return { models, updatedAt: store.get('modelsUpdatedAt') }
  })
  ipcMain.handle('models:refresh', async (_e, apiKey: string) => {
    const { models, keyValid, error } = await refreshModels(apiKey)
    const updatedAt = new Date().toISOString()
    if (keyValid) setSettings({ cachedModels: models, modelsUpdatedAt: updatedAt })
    return { models, updatedAt, keyValid, error }
  })

  // Validate every provided key individually; model list comes from the first valid one.
  ipcMain.handle('models:checkKeys', async (_e, keys: string[]) => {
    const { results, models, anyValid } = await checkApiKeys(keys)
    const updatedAt = new Date().toISOString()
    setSettings({
      apiKeyValid: results.map((r) => r.valid),
      apiKeyError: results.map((r) => r.error)
    })
    if (anyValid) setSettings({ cachedModels: models, modelsUpdatedAt: updatedAt })
    return { results, models, updatedAt, anyValid }
  })

  // ---- File dialogs ----
  ipcMain.handle(
    'dialog:openFile',
    async (_e, opts: { filters?: Electron.FileFilter[] }) => {
      if (!win) return ''
      const res = await dialog.showOpenDialog(win, {
        properties: ['openFile'],
        filters: opts?.filters
      })
      return res.canceled ? '' : res.filePaths[0]
    }
  )

  ipcMain.handle('dialog:openFolder', async () => {
    if (!win) return ''
    const res = await dialog.showOpenDialog(win, { properties: ['openDirectory'] })
    return res.canceled ? '' : res.filePaths[0]
  })

  ipcMain.handle(
    'dialog:saveFile',
    async (
      _e,
      args: { srcPath?: string; defaultName: string; defaultDir?: string; logPaths?: string[] }
    ) => {
      if (!win) return ''
      const defaultPath = args.defaultDir
        ? path.join(args.defaultDir, args.defaultName)
        : args.defaultName
      const res = await dialog.showSaveDialog(win, {
        defaultPath,
        filters: [
          { name: 'Subtitles', extensions: ['srt', 'sup', 'ass'] },
          { name: 'All Files', extensions: ['*'] }
        ]
      })
      if (res.canceled || !res.filePath) return ''
      if (args.srcPath && fs.existsSync(args.srcPath)) {
        fs.copyFileSync(args.srcPath, res.filePath)
      }
      // Copy any log/report files (token report, progress, thoughts) next to the saved SRT.
      // Each temp log path shares the same base as the temp SRT; we re-derive the dest
      // path using the same extension so they land alongside the user-chosen file.
      if (args.logPaths?.length) {
        const destBase = res.filePath.replace(/\.[^.]+$/, '')
        // Preserve the full compound suffix (e.g. ".tokens.json", ".progress.log")
        // rather than just path.extname() — otherwise ".tokens.json" would become
        // ".json" and ".progress.log"/".thoughts.log" would collide on ".log".
        const KNOWN_SUFFIXES = ['.tokens.json', '.progress.log', '.thoughts.log']
        for (const logPath of args.logPaths) {
          if (fs.existsSync(logPath)) {
            const suffix = KNOWN_SUFFIXES.find((s) => logPath.endsWith(s)) ?? path.extname(logPath)
            try {
              fs.copyFileSync(logPath, `${destBase}${suffix}`)
            } catch {
              // Non-fatal: log file copy failure should not block the SRT save.
            }
          }
        }
      }
      return res.filePath
    }
  )

  // ---- Shell helpers ----
  ipcMain.handle('shell:showItem', (_e, p: string) => {
    if (p) shell.showItemInFolder(p)
  })
  ipcMain.handle('shell:openExternal', (_e, url: string) => shell.openExternal(url))

  // ---- Video tracks ----
  ipcMain.handle('video:probeTracks', async (_e, filePath: string) => {
    const { ffmpegPath } = getSettings()
    return probeTracks(filePath, ffmpegPath)
  })

  // Silent extraction to a temp .srt (used as translation input for a chosen track)
  ipcMain.handle(
    'video:extractToTemp',
    async (_e, args: { filePath: string; subtitleIndex: number }) => {
      const { ffmpegPath } = getSettings()
      const out = tempOutputPath('.srt')
      const res = await extractTrack(args.filePath, args.subtitleIndex, out, false, ffmpegPath)
      return res.ok ? { ok: true, path: out } : { ok: false, error: res.error }
    }
  )

  ipcMain.handle(
    'video:extractTrack',
    async (
      _e,
      args: { filePath: string; subtitleIndex: number; isImage: boolean; defaultName: string }
    ) => {
      if (!win) return { ok: false, error: 'no window' }
      const { ffmpegPath, outputFolder } = getSettings()
      const defaultPath = outputFolder
        ? path.join(outputFolder, args.defaultName)
        : args.defaultName
      const res = await dialog.showSaveDialog(win, { defaultPath })
      if (res.canceled || !res.filePath) return { ok: false, canceled: true }
      const out = await extractTrack(
        args.filePath,
        args.subtitleIndex,
        res.filePath,
        args.isImage,
        ffmpegPath
      )
      return { ...out, path: res.filePath }
    }
  )

  // ---- TMDB ----
  ipcMain.handle(
    'tmdb:search',
    async (_e, args: { query: string; type: 'all' | 'movie' | 'tv' }) => {
      const { tmdbApiKey } = getSettings()
      return tmdbSearch(tmdbApiKey, args.query, args.type)
    }
  )
  ipcMain.handle(
    'tmdb:cast',
    async (_e, args: { tmdbId: string; mediaType: 'movie' | 'tv' }) => {
      const { tmdbApiKey } = getSettings()
      return tmdbCast(tmdbApiKey, args.tmdbId, args.mediaType)
    }
  )

  // ---- Translate / Transcribe ----
  ipcMain.handle('translate:start', (_e, args: TranslateArgs) => {
    const { writeTokenReport, progressLog, thoughtsLog } = getSettings()
    const fullArgs: TranslateArgs = { ...args, writeTokenReport, progressLog, thoughtsLog }
    const { outputPath, logPaths } = startTranslate(fullArgs, {
      onOutput: (stream, line) => send('translate:output', { stream, line }),
      onDone: (code, op) => send('translate:done', { code, outputPath: op, logPaths })
    })
    return outputPath
  })

  ipcMain.handle('transcribe:start', (_e, args: TranscribeArgs) => {
    return startTranscribe(args, {
      onOutput: (stream, line) => send('translate:output', { stream, line }),
      onDone: (code, outputPath) => send('translate:done', { code, outputPath })
    })
  })

  ipcMain.handle('translate:stop', () => {
    stopCurrent()
    return true
  })
  ipcMain.handle('translate:isRunning', () => isRunning())
}
