/**
 * REP-17 / FP-1b: prove a model fetch cannot hang the app.
 *
 * The engine's `cmd_list_models` registers `--skip-upgrade` but never assigns it, so it runs the
 * upgrade check regardless and asks "upgrade? (y/n)" through a blocking read whenever PyPI is ahead
 * of the pinned version. `refreshModels()` now answers that prompt AND bounds the wait. The answer
 * is proven by the live harness (L1 gets past the prompt against the real engine); this probe proves
 * the other half — that a child which never answers and never exits is abandoned rather than waited
 * on forever.
 *
 * The stub is a copy of the running Node binary named `gst`, plus a script called `list-models`, so
 * the real `refreshModels()` resolves and spawns it exactly as it would the engine: `resolveGstBin()`
 * returns a bare `gst` outside a packaged build, and `envWithFfmpeg()` *appends* the bundled bin dir
 * to PATH rather than prepending it, so a prepended stub dir wins. Nothing about the fetch is
 * simulated except the child.
 *
 * Takes about a minute, because it waits out the real production timeout rather than a shortened
 * test-only one — a knob that existed only for tests would not be proving the shipped behaviour.
 */
import fs from 'fs'
import os from 'os'
import path from 'path'
import { refreshModels } from '../../electron/main/modelsList'

const EXE = process.platform === 'win32' ? '.exe' : ''

/** Prints the engine's prompt, then ignores stdin and never exits. */
const STUB = `
process.stdout.write('There is a new version of gemini-srt-translator available: 3.7.1.\\n')
process.stdout.write('Do you want to upgrade gemini-srt-translator from version 3.7.0 to 3.7.1? (y/n): ')
setInterval(() => {}, 1 << 30)
`

function pass(label: string, detail = ''): void {
  console.log(`  PASS  ${label}${detail ? `\n        ${detail}` : ''}`)
}

function fail(label: string, detail: string): never {
  console.log(`  FAIL  ${label}\n        ${detail}`)
  process.exit(1)
}

async function main(): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'srt-fetch-timeout-'))
  const stubBin = path.join(dir, 'gst' + EXE)

  // A copy of node, not a shim script: Node refuses to spawn .bat/.cmd without a shell, and the
  // app spawns without one.
  fs.copyFileSync(process.execPath, stubBin)
  if (process.platform !== 'win32') fs.chmodSync(stubBin, 0o755)
  // `gst list-models ...` becomes `node list-models ...`, resolved against the working directory.
  fs.writeFileSync(path.join(dir, 'list-models'), STUB, 'utf-8')

  const originalPath = process.env.PATH
  const originalCwd = process.cwd()
  process.env.PATH = dir + path.delimiter + (originalPath ?? '')
  process.chdir(dir)

  console.log(`Stub engine: ${stubBin}`)
  console.log('It prints the upgrade prompt, ignores stdin, and never exits.\n')
  console.log('Waiting out the real 60s production timeout...\n')

  const started = Date.now()
  let result: Awaited<ReturnType<typeof refreshModels>>
  try {
    result = await refreshModels('placeholder-key-never-used')
  } finally {
    process.chdir(originalCwd)
    process.env.PATH = originalPath
  }
  const elapsedMs = Date.now() - started
  const elapsed = Math.round(elapsedMs / 1000)

  if (result.keyValid) fail('a fetch that never answered must not be reported valid', String(result.ids))
  pass('the fetch ended by itself instead of hanging', `after ${elapsed}s`)

  if (!/gave up after 60 seconds/i.test(result.error)) {
    fail('the message names the timeout', `got: ${result.error}`)
  }
  pass('the message names the timeout', result.error)

  if (!/does not mean the key is invalid/i.test(result.error)) {
    fail('the message does not blame the key', `got: ${result.error}`)
  }
  pass('the message does not blame the key')

  // Bounds, not an exact value: the child still has to be spawned and killed around the budget.
  if (elapsedMs < 50_000) fail('it waited the budget rather than giving up early', `${elapsed}s`)
  if (elapsedMs > 100_000) fail('it gave up near the budget rather than long after', `${elapsed}s`)
  pass('it waited the configured budget, and no longer', `${elapsed}s, budget 60s`)

  // Deleting the stub doubles as the kill assertion. Windows holds a lock on a running image, so
  // the copy of node can only be removed once the child is actually gone — and the kill is fired
  // without being awaited, so the lock outlives the resolved promise by a moment.
  let removed = false
  for (let attempt = 0; attempt < 40 && !removed; attempt++) {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
      removed = true
    } catch {
      await new Promise((r) => setTimeout(r, 250))
    }
  }
  if (!removed) {
    fail(
      'the abandoned child was killed, not left running',
      `${stubBin} is still locked 10s after the fetch gave up, so the process survived the timeout`
    )
  }
  pass('the abandoned child was killed, not left running')

  console.log('\nPASS  a model fetch cannot hang the app')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
