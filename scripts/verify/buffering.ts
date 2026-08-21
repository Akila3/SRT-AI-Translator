/**
 * REP-11a — does the frozen engine's output stream, or does it arrive in one late burst?
 *
 * The reported symptom was that transcription's log panel stays empty through the whole audio
 * extraction and then prints everything at once. A missing progress bar cannot withhold text
 * that was already printed, so the engine's output TIMING is measured here rather than argued
 * about. The defect and its fix both live in `scripts/gst_entry.py`, whose only observable
 * effect is inside the frozen binary — so this is the only way to see either.
 *
 * FIDELITY. The environment comes from the app's own `envWithFfmpeg` and the argv from the
 * app's own `buildTranscribeArgs`, so the engine resolves the same FFmpeg and receives the
 * same flags it would in production. The binary is addressed explicitly as
 * `resources/bin/gst[.exe]` because `resolveGstBin()` returns a bare `gst` when not packaged,
 * which in dev is a pip install — a different artifact from the one that ships.
 *
 * COST. None. The fixture is generated from FFmpeg's synthetic sources, the key is a dummy,
 * and the run is killed the moment audio extraction reports success — which is before the
 * engine's first API call, so nothing reaches the network and no quota is spent.
 *
 * Run with `node scripts/verify/run-buffering.mjs`. Exits non-zero if the steps do not stream.
 */
import { spawn } from 'child_process'
import fs from 'fs'
import path from 'path'
import { envWithFfmpeg } from '../../electron/main/ffmpeg'
import { buildTranscribeArgs } from '../../electron/main/pythonBridge'
import type { TranscribeArgs } from '../../electron/shared/types'

const ROOT = process.cwd()
const EXE = process.platform === 'win32' ? '.exe' : ''
const GST = path.join(ROOT, 'resources', 'bin', `gst${EXE}`)
const FFMPEG = path.join(ROOT, 'resources', 'bin', `ffmpeg${EXE}`)
const WORK = path.join(ROOT, '.tmp-buffer-probe')
const FIXTURE = path.join(WORK, 'probe-10min.mkv')
const FIXTURE_SECONDS = 600

/** Hard ceiling; the run normally ends far sooner, on the extraction-complete line. */
const KILL_AFTER_MS = 120_000

/**
 * Optional NDJSON sink for a debugging session. Off unless asked for: a verification script
 * that posts to a hard-coded localhost port on every run is a side effect nobody expects.
 */
const INGEST = process.env.SRT_DEBUG_INGEST ?? ''

interface Chunk {
  atMs: number
  stream: 'stdout' | 'stderr'
  lines: string[]
}

function report(message: string, data: Record<string, unknown>, runId: string): void {
  console.log(`[${runId}] ${message} ${JSON.stringify(data)}`)
  if (!INGEST) return
  void fetch(INGEST, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ runId, message, data, timestamp: Date.now() })
  }).catch(() => {})
}

function run(cmd: string, args: string[]): Promise<{ code: number | null; err: string }> {
  return new Promise((resolve) => {
    const p = spawn(cmd, args)
    let err = ''
    p.stderr.on('data', (d) => (err += String(d)))
    p.on('close', (code) => resolve({ code, err }))
    p.on('error', (e) => resolve({ code: -1, err: e.message }))
  })
}

async function makeFixture(): Promise<void> {
  if (fs.existsSync(FIXTURE) && fs.statSync(FIXTURE).size > 0) return
  fs.mkdirSync(WORK, { recursive: true })
  const r = await run(FFMPEG, [
    '-y',
    '-f', 'lavfi', '-i', `color=c=black:s=320x240:r=5:d=${FIXTURE_SECONDS}`,
    '-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=48000:duration=${FIXTURE_SECONDS}`,
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '128k', '-shortest',
    FIXTURE
  ])
  if (r.code !== 0) throw new Error(`fixture build failed: ${r.err.slice(-600)}`)
}

function probeArgs(outputFile: string): TranscribeArgs {
  return {
    mediaFile: FIXTURE,
    outputFile,
    targetLang: 'en',
    model: 'gemini-2.5-flash',
    // Never a real key: the run is killed before the engine would use it.
    apiKeys: ['DUMMY-KEY-NOT-REAL'],
    thinkingLevel: 'low',
    thinkingBudget: 512,
    customGenerationParams: false,
    temperature: 1,
    topP: 0.95,
    topK: null
  }
}

/** Spawn the shipped engine and timestamp every chunk until extraction reports success. */
function probe(runId: string): Promise<Chunk[]> {
  return new Promise((resolve) => {
    // The engine skips extraction when its output MP3 already exists, which would silently
    // turn the run into a no-op and hide the very phase under test.
    const stale = FIXTURE.replace(/\.mkv$/, '_extracted.mp3')
    if (fs.existsSync(stale)) fs.unlinkSync(stale)

    const outPath = path.join(WORK, `${runId}.srt`)
    const args = buildTranscribeArgs(probeArgs(outPath), outPath)
    const env = envWithFfmpeg(undefined, {
      PYTHONUNBUFFERED: '1',
      PYTHONUTF8: '1',
      PYTHONIOENCODING: 'utf-8'
    })

    const t0 = Date.now()
    const chunks: Chunk[] = []
    const p = spawn(GST, args, { env })
    p.stdout.setEncoding('utf-8')
    p.stderr.setEncoding('utf-8')

    let done = false
    const stop = (): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      try {
        if (process.platform === 'win32' && p.pid) spawn('taskkill', ['/pid', String(p.pid), '/f', '/t'])
        else p.kill('SIGTERM')
      } catch {
        /* the close handler still resolves */
      }
    }
    const timer = setTimeout(stop, KILL_AFTER_MS)

    const onChunk = (stream: 'stdout' | 'stderr') => (chunk: string): void => {
      const lines = chunk.split(/\r?\n/).filter((l) => l.trim() !== '')
      chunks.push({ atMs: Date.now() - t0, stream, lines })
      report('chunk', { n: chunks.length, stream, atMs: Date.now() - t0, lineCount: lines.length, lines: lines.slice(0, 8).map((l) => l.slice(0, 90)) }, runId)
      // Extraction is the phase under test and the last thing before the first API call.
      if (chunk.includes('Final file size')) stop()
    }
    p.stdout.on('data', onChunk('stdout'))
    p.stderr.on('data', onChunk('stderr'))
    p.on('error', () => stop())
    p.on('close', () => {
      clearTimeout(timer)
      resolve(chunks)
    })
  })
}

/** Which chunk index first contained a given marker, or -1. */
function chunkOf(chunks: Chunk[], marker: string): number {
  return chunks.findIndex((c) => c.lines.some((l) => l.includes(marker)))
}

async function main(): Promise<void> {
  for (const bin of [GST, FFMPEG]) {
    if (!fs.existsSync(bin)) throw new Error(`missing ${bin} — run npm run build:python / add FFmpeg`)
  }
  console.log('building synthetic fixture...')
  await makeFixture()

  const chunks = await probe('buffering')
  const steps = ['Step 1:', 'Step 2:', 'Step 3:'] as const
  const where = steps.map((s) => chunkOf(chunks, s))

  console.log('\n--- arrival ---')
  for (let i = 0; i < steps.length; i += 1) {
    const at = where[i] >= 0 ? `${chunks[where[i]].atMs} ms, chunk #${where[i] + 1}` : 'NEVER SEEN'
    console.log(`  ${steps[i].padEnd(9)} ${at}`)
  }

  const failures: string[] = []
  if (where.some((w) => w < 0)) {
    failures.push('the engine did not print all three extraction steps — the probe never reached the phase under test')
  } else if (new Set(where).size !== steps.length) {
    // The defect's exact signature: steps printed seconds apart, delivered together.
    failures.push(
      `Step 1/2/3 arrived in ${new Set(where).size} chunk(s) instead of 3 — output is buffered, ` +
        'so the UI stays blank through extraction. Rebuild after checking scripts/gst_entry.py sets line_buffering=True'
    )
  }

  if (failures.length) {
    console.error('\nFAIL')
    for (const f of failures) console.error(`  - ${f}`)
    process.exit(1)
  }
  console.log('\nPASS  each extraction step reached the app as it happened')
}

main().catch((e) => {
  console.error('PROBE FAILED:', (e as Error).message)
  process.exit(1)
})
