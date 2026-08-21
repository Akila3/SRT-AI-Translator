/**
 * REP-2 — does a transcription with a bad key actually END now?
 *
 * This is the acceptance row no gate can reach. The gates prove the budget's arithmetic against
 * a fixture synthesised from REP-2's own log; they cannot prove that the real engine, spawned the
 * real way, still produces that shape — or that our two defences fire in the right order when it
 * does. The original measurement was six hours and forty minutes and 97 GB, ended by a full disk.
 *
 * FIDELITY. Everything runs through `startTranscribe`, so the preflight, the job lifecycle, the
 * stall budget and the masked command line are the shipped ones. The second probe deliberately
 * withholds the preflight to reach the loop it exists to catch — which is also the honest test of
 * the backstop, since the preflight cannot foresee a key revoked mid-run.
 *
 * COST. No valid API key, no quota, no network beyond one rejected request: the whole point is a
 * key that is *not* valid. It needs FFmpeg (bundled) to build a ten-second sine wave, and `gst`.
 *
 * TIME. Up to about two minutes. Tier 1 requires a full minute of no novelty by design — a cheaper
 * budget would kill slow but working runs — so the second probe cannot be quick.
 *
 * Run with `node scripts/verify/run-badkey.mjs`. Exits non-zero on failure.
 */
import { spawn } from 'child_process'
import fs from 'fs'
import path from 'path'
import { refreshModels } from '../../electron/main/modelsList'
import {
  describeEngine,
  isRunning,
  startTranscribe,
  type KeyPreflight
} from '../../electron/main/pythonBridge'
import type { TranscribeArgs } from '../../electron/shared/types'

const ROOT = process.cwd()
const EXE = process.platform === 'win32' ? '.exe' : ''
const BIN = path.join(ROOT, 'resources', 'bin')
const FFMPEG = path.join(BIN, `ffmpeg${EXE}`)
const WORK = path.join(ROOT, '.tmp-badkey-probe')

/**
 * Measure the engine that SHIPS, not whatever happens to be on this machine's PATH.
 *
 * A packaged build always runs `resources/bin/gst.exe`. A development run resolves the bare name
 * through PATH, and this probe found out the hard way why that matters: a pip-installed
 * `gst.exe` in the user's Python Scripts directory won here, and it is an older build whose
 * `list-models` does not even accept `--skip-upgrade` — so the rejected key produced an argument
 * parser error rather than the API's answer, and the preflight could conclude nothing.
 *
 * That is exactly the confusion MAN-5's engine line exists to expose, and it is a real property
 * of this machine rather than a defect in the app. The probe pins the binary so its assertions
 * describe the release; `logResolvedGstBin()` and Settings > Advanced are what describe the
 * machine.
 */
process.env.PATH = `${BIN}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH ?? ''}`

/**
 * A key that is syntactically plausible and certainly not valid.
 *
 * Shaped like a real one so the API rejects it on authentication rather than on parsing, which
 * is the failure REP-2 recorded.
 */
const BAD_KEY = 'AIzaSyB0000000000000000000000000000000x'

/** Long enough for the engine to start work, short enough not to waste anyone's minute. */
const CLIP_SECONDS = 10

/** Ceiling on how long the backstop probe will wait before declaring the run unbounded. */
const PATIENCE_MS = 150_000

let failures = 0
let passes = 0

function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    passes++
    console.log(`  PASS  ${name}`)
  } else {
    failures++
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

function skip(name: string, why: string): void {
  console.log(`  SKIP  ${name} — ${why}`)
}

function run(cmd: string, args: string[]): Promise<number | null> {
  return new Promise((resolve) => {
    const p = spawn(cmd, args)
    p.on('error', () => resolve(-1))
    p.on('close', (code) => resolve(code))
  })
}

function transcribeArgs(media: string, out: string): TranscribeArgs {
  return {
    mediaFile: media,
    outputFile: out,
    targetLang: 'en',
    model: 'gemini-2.5-flash-lite',
    apiKeys: [BAD_KEY],
    thinkingLevel: 'default',
    thinkingBudget: 0,
    customGenerationParams: false,
    temperature: 0.7,
    topP: 0.95,
    topK: null
  }
}

/** What one run produced: its lines, and every terminal event it delivered. */
interface Outcome {
  lines: string[]
  done: Array<{ code: number | null; reason?: string }>
  ms: number
  /** Set when `startTranscribe` REJECTED rather than reporting through `onDone`. */
  threw: string | null
  /** Whether the single job slot was still held once the run had ended. */
  runningAfter: boolean
}

function transcribe(
  media: string,
  out: string,
  preflight?: (key: string, signal: AbortSignal) => Promise<KeyPreflight>
): Promise<Outcome> {
  return new Promise((resolve) => {
    const lines: string[] = []
    const done: Array<{ code: number | null; reason?: string }> = []
    const startedAt = Date.now()
    let threw: string | null = null
    let settled = false
    const finish = (): void => {
      if (settled) return
      settled = true
      // A short grace period before resolving: a SECOND terminal event would arrive after the
      // first, and "exactly one" is an assertion that cannot be made by returning immediately.
      setTimeout(
        () => resolve({ lines, done, ms: Date.now() - startedAt, threw, runningAfter: isRunning() }),
        750
      )
    }
    const guard = setTimeout(finish, PATIENCE_MS)
    startTranscribe(
      transcribeArgs(media, out),
      {
        onOutput: (_stream, line) => lines.push(line),
        onDone: (code, _path, reason) => {
          done.push({ code, reason })
          clearTimeout(guard)
          finish()
        }
      },
      preflight
    ).catch((err: unknown) => {
      // Recorded rather than thrown, so a rejection that escapes the bridge fails a named
      // assertion in seconds instead of hanging until the patience timer gives up.
      threw = err instanceof Error ? err.message : String(err)
      clearTimeout(guard)
      finish()
    })
  })
}

async function main(): Promise<void> {
  console.log('\n=== REP-2 — a transcription with a rejected key has to end ===\n')

  if (!fs.existsSync(FFMPEG)) {
    console.log(`FFmpeg not found at ${FFMPEG}. Run \`npm run check:bin\` first.`)
    process.exit(1)
  }
  fs.rmSync(WORK, { recursive: true, force: true })
  fs.mkdirSync(WORK, { recursive: true })

  const engine = describeEngine()
  console.log(`  engine: ${engine.path}${engine.bundled ? ' (bundled)' : ' (NOT the bundled copy)'}\n`)
  check('the probe is measuring the engine that ships', engine.bundled, engine.path)

  const clip = path.join(WORK, 'clip.mp3')
  const built = await run(FFMPEG, [
    '-y', '-f', 'lavfi', '-i', `sine=frequency=440:duration=${CLIP_SECONDS}`,
    '-c:a', 'libmp3lame', '-b:a', '64k', clip
  ])
  if (built !== 0 || !fs.existsSync(clip)) {
    console.log('  FAIL  ffmpeg could not build the audio fixture')
    process.exit(1)
  }

  // ── B1 — the classification, which is what makes the refusal safe ───────────
  console.log('  (asking the API about the bad key — one round trip)')
  const verdict = await refreshModels(BAD_KEY)
  check('a rejected key is classified as rejected, not merely "failed"', verdict.verdict === 'rejected', `${verdict.verdict}: ${verdict.error}`)
  if (verdict.verdict === 'unchecked') {
    console.log('        (no network? every assertion below assumes the API is reachable)')
  }

  // ── B2 — the preflight: the run must not start at all ───────────────────────
  const preflight = async (apiKey: string, signal: AbortSignal): Promise<KeyPreflight> => {
    const res = await refreshModels(apiKey, signal)
    if (res.verdict === 'valid') return { verdict: 'valid', message: '' }
    if (res.verdict === 'rejected') {
      return { verdict: 'rejected', message: `The API rejected this key: ${res.error}` }
    }
    return { verdict: 'unchecked', message: `Could not check the key: ${res.error}` }
  }

  const guarded = await transcribe(clip, path.join(WORK, 'guarded.srt'), preflight)
  check('the preflight ends the run', guarded.done.length > 0, 'no terminal event at all')
  check('exactly one terminal event', guarded.done.length === 1, `${guarded.done.length}`)
  check('reported as a failure, not as success', guarded.done[0]?.code !== 0, String(guarded.done[0]?.code))
  // `guard` and not `user`: FP-3 renders `user` as "Stopped", and telling someone they pressed
  // a button they did not press would bury the cause this whole phase exists to deliver.
  check("carrying the reason 'guard'", guarded.done[0]?.reason === 'guard', String(guarded.done[0]?.reason))
  check('and it says the key was rejected', guarded.lines.some((l) => /rejected/i.test(l)), guarded.lines.slice(-2).join(' | '))
  check('the engine was never spawned', !guarded.lines.some((l) => /Starting engine/.test(l)))
  check('so the log stayed tiny', guarded.lines.length < 20, `${guarded.lines.length} lines`)
  check('and it took seconds, not hours', guarded.ms < 90_000, `${Math.round(guarded.ms / 1000)}s`)
  check('and the job slot was released', !guarded.runningAfter)

  // ── B2a — a preflight that THROWS must not take the app down with it (FP7-V02) ──
  // The check is injected, so a fault inside it is a fault the bridge has to survive: an
  // escaping rejection would leave the slot reserved with `finish()` never called, and
  // `isRunning()` true for the life of the process — every later run, of either kind,
  // refused with "A process is already running." until a restart.
  //
  // A missing `.m4a` keeps this to about a second: the run proceeds past the failed check,
  // as it should, and then ends on the conversion it cannot perform.
  console.log('\n  (a preflight that throws — the run must survive it, and end)')
  const broken = await transcribe(
    path.join(WORK, 'nonexistent.m4a'),
    path.join(WORK, 'broken.srt'),
    async () => {
      throw new Error('preflight exploded')
    }
  )
  check('the rejection does not escape startTranscribe', broken.threw === null, String(broken.threw))
  check('the run still reports exactly one terminal event', broken.done.length === 1, `${broken.done.length}`)
  check('and the job slot is free afterwards', !broken.runningAfter)
  // Treated as `unchecked`, not as a refusal: a fault in the check must not be able to make
  // transcription impossible, and the stall budget covers the runaway either way.
  check(
    'the failure is reported as a check that did not happen',
    broken.lines.some((l) => /Could not check the API key/i.test(l)),
    broken.lines.join(' | ')
  )
  check(
    'and it was not mistaken for a rejection',
    broken.done[0]?.reason !== 'guard',
    String(broken.done[0]?.reason)
  )

  // ── B3 — the backstop: the loop itself, ended by the budget ─────────────────
  // Without the preflight this is REP-2 exactly: the credential reaches the per-segment retry
  // loop, which has no ceiling and answers a permanent 400 with `Retrying immediately...`.
  console.log('\n  (now without the preflight — this is the storm, and it needs about a minute)')
  const storm = await transcribe(clip, path.join(WORK, 'storm.srt'))
  const ended = storm.done.length > 0 && storm.ms < PATIENCE_MS
  check('the run ends by itself', ended, `${Math.round(storm.ms / 1000)}s, ${storm.lines.length} lines`)
  check('exactly one terminal event here too', storm.done.length === 1, `${storm.done.length}`)
  check('and it is not reported as a success', storm.done[0]?.code !== 0, String(storm.done[0]?.code))
  if (storm.done[0]?.reason === 'stalled') {
    console.log(`        the app's budget ended it after ${Math.round(storm.ms / 1000)}s and ${storm.lines.length} lines`)
    check(
      'the reason names what happened',
      storm.lines.some((l) => /Ended by the app/.test(l)),
      storm.lines.slice(-3).join(' | ')
    )
  } else {
    // FP-1 restored `exit` in the frozen build, so some paths now terminate on their own. That
    // is a better outcome than being killed, and it must be recorded rather than failed.
    console.log(`        the engine ended it on its own (reason: ${storm.done[0]?.reason ?? 'none'})`)
  }
  check('the log did not grow without bound', storm.lines.length < 20_000, `${storm.lines.length} lines`)

  // ── B4 — the masked command line, from real emitted output ─────────────────
  // The gate proves the renderer. This proves the only thing that finally matters: that the key
  // does not appear in what the app actually emitted, from a real spawn, with a real argv.
  const allLines = [...guarded.lines, ...storm.lines]
  const commandLines = allLines.filter((l) => l.startsWith('$ '))
  check('the run printed its command line', commandLines.length > 0)
  check('and no line anywhere contains the key', !allLines.some((l) => l.includes(BAD_KEY)))
  check(
    'the key position is masked',
    commandLines.every((l) => !l.includes(BAD_KEY) && /-k \*\*\*/.test(l)),
    commandLines[0]
  )

  console.log(`\n${passes} passed, ${failures} failed`)
  fs.rmSync(WORK, { recursive: true, force: true })
  if (failures > 0) {
    console.log('\nPROBE FAILED — a bad key can still run away with a transcription.')
    process.exit(1)
  }
  console.log('\nALL BAD-KEY PROBES PASSED')
}

void main()
