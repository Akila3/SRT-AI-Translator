/**
 * Minimal `electron` stand-in for the gate suite.
 *
 * The gates exercise the REAL modules (`migrations`, `modelsList`, `pythonBridge`, `ipc`)
 * rather than copies of them, so nothing can pass here while the shipped code differs.
 * Those modules import `electron` for a handful of paths and for `ipcMain.handle`, none of
 * which is reachable from the pure functions under test — so a stub is enough, and it
 * keeps the suite runnable under plain `node`.
 */
import fs from 'fs'
import os from 'os'
import path from 'path'

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'srt-gate-'))

export const app = {
  isPackaged: false,
  getPath: (_name: string): string => userData,
  getAppPath: (): string => process.cwd(),
  whenReady: (): Promise<void> => Promise.resolve(),
  on: (): void => {},
  quit: (): void => {}
}

export const ipcMain = {
  handle: (): void => {},
  on: (): void => {}
}

export const dialog = {
  showOpenDialog: async (): Promise<{ canceled: boolean; filePaths: string[] }> => ({
    canceled: true,
    filePaths: []
  }),
  showSaveDialog: async (): Promise<{ canceled: boolean; filePath: string }> => ({
    canceled: true,
    filePath: ''
  })
}

export const shell = {
  showItemInFolder: (): void => {},
  openExternal: async (): Promise<void> => {}
}

export class BrowserWindow {
  static getAllWindows(): BrowserWindow[] {
    return []
  }
}

export default { app, ipcMain, dialog, shell, BrowserWindow }
