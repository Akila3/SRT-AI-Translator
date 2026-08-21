/**
 * Bundle and run the release-preflight probe.
 *
 * No stub aliases here, unlike the other runners: this probe imports nothing from the app. It
 * runs `scripts/check-bin.mjs` as a child process, so the thing under test is the script a
 * packaging run actually executes rather than a re-implementation of it.
 */
import { build } from 'esbuild'
import { fileURLToPath, pathToFileURL } from 'url'
import path from 'path'
import fs from 'fs'
import os from 'os'

const here = path.dirname(fileURLToPath(import.meta.url))
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'srt-buildstamp-build-'))
const outfile = path.join(outDir, 'buildstamp.mjs')

await build({
  entryPoints: [path.join(here, 'buildstamp.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node18',
  outfile,
  logLevel: 'warning'
})

await import(pathToFileURL(outfile).href)
