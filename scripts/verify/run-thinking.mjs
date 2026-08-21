/**
 * Bundle and run the REP-1 thinking probe.
 *
 * Same mechanism as `run.mjs`: the probe imports the real main-process modules with only
 * `electron` and `electron-store` aliased to the gate stubs, so the argv it sends is the
 * argv the app sends.
 */
import { build } from 'esbuild'
import { fileURLToPath, pathToFileURL } from 'url'
import path from 'path'
import fs from 'fs'
import os from 'os'

const here = path.dirname(fileURLToPath(import.meta.url))
const stubs = path.join(here, '..', 'gates', 'stubs')
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'srt-thinking-build-'))
const outfile = path.join(outDir, 'thinking.mjs')

await build({
  entryPoints: [path.join(here, 'thinking.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node18',
  outfile,
  logLevel: 'warning',
  alias: {
    electron: path.join(stubs, 'electron.ts'),
    'electron-store': path.join(stubs, 'electron-store.ts'),
    // Records the argv of every command the real modules launch. The argv built inside
    // `startTranslate` is returned to nobody, so watching the spawn is the only way to see
    // what the IPC path sends — and doing it here keeps product files untouched.
    child_process: path.join(here, 'stubs', 'child_process.ts')
  }
})

await import(pathToFileURL(outfile).href)
