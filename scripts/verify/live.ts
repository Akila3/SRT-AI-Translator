/**
 * Live verification probes — the automatable half of the Phase A/B/C matrix.
 *
 * These are the checks `npm run test:gates` cannot make, because they need a real API
 * key and the real frozen engine: that the packed binary actually reaches Google, that a
 * translation round-trips, that Hebrew survives the frozen build's stdio, that an `.ass`
 * file keeps its styling and leaves the user's original untouched, that an embedded
 * subtitle track can be probed, extracted and translated, and that transcription works.
 *
 * STAGE 1 runs on a key alone (L1-L5). STAGE 2 (L6-L7) needs media fixtures in
 * `.secrets/fixtures/`; without them those probes report SKIP rather than failing, so a
 * machine with no fixtures still gets a meaningful stage-1 result.
 *
 * WHAT THIS DOES NOT COVER. D1/D2 (the packaged build and its authoritative charmap
 * result) are deliberately out of scope: they only reproduce in a packaged app, so a dev
 * pass cannot substitute. Anything driven through the Electron UI — the regression sweep,
 * the A6 startup log, key-tier promotion in Settings — also stays manual.
 *
 * COST. Every run makes real API calls. The fixtures are five cues each and the model is
 * the cheapest flash-lite the key exposes, so a full pass is a handful of requests, but it
 * is not free and it consumes free-tier quota.
 *
 * SECRECY. The key is read from a git-ignored file and never printed: all engine output is
 * passed through `mask()` before it can reach the console. Treat the key as disposable and
 * revoke it when verification is done.
 */
import { spawn } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  buildTranscribeArgs,
  buildTranslateArgs,
  ensureEngineReadableAudio,
  ensureUtf8Subtitle,
  isRunning,
  needsAudioConversion,
  startTranscribe,
  startTranslate,
  stopCurrent,
  tempOutputPath
} from '../../electron/main/pythonBridge'
import { envWithFfmpeg, extractTrack, probeTracks } from '../../electron/main/ffmpeg'
import { getSettings, setSettings } from '../../electron/main/store'
import { registerIpc } from '../../electron/main/ipc'
import { __invokeIpc } from '../gates/stubs/electron'
import { modelCapabilities } from '../../electron/shared/modelCaps'
import type { TranscribeArgs, TranslateArgs } from '../../electron/shared/types'

// The bundle executes from a temp directory, so paths are resolved from the working
// directory instead — `npm run` always sets that to the package root.
const ROOT = process.cwd()
const GST = path.join(ROOT, 'resources', 'bin', process.platform === 'win32' ? 'gst.exe' : 'gst')
const KEY_FILE = path.join(ROOT, '.secrets', 'gemini-key.txt')
const FIXTURE_DIR = path.join(ROOT, '.secrets', 'fixtures')
const TIMEOUT_MS = 300_000

/**
 * Which ffmpeg the probes use.
 *
 * Production reads `getSettings().ffmpegPath`, which these probes cannot: they run outside
 * Electron against stubbed settings. Undefined therefore means the bundled binaries, and
 * these probes verify the DEFAULT environment only. Set `SRT_VERIFY_FFMPEG_PATH` to the
 * value you configured in Settings to verify an override instead — it is then applied
 * consistently to the spawn environment, `probeTracks` and `extractTrack`, because
 * checking one of the three with an override and the others without would be worse than
 * not checking at all.
 */
const FFMPEG_PATH = process.env.SRT_VERIFY_FFMPEG_PATH?.trim() || undefined

let passes = 0
let failures = 0
let skipped = 0
const failed: string[] = []

function section(name: string): void {
  console.log(`\n=== ${name} ===`)
}

function skip(label: string, why: string): void {
  skipped++
  console.log(`  SKIP  ${label} — ${why}`)
}

function check(label: string, ok: boolean, detail = ''): boolean {
  if (ok) {
    passes++
    console.log(`  PASS  ${label}`)
  } else {
    failures++
    failed.push(label)
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`)
  }
  return ok
}

/** Redact the key from anything on its way to the console. */
let secret = ''
function mask(text: string): string {
  if (!secret) return text
  return text.split(secret).join('***KEY***')
}

function loadKey(): string {
  const fromEnv = process.env.GEMINI_API_KEY?.trim()
  if (fromEnv) return fromEnv
  if (!fs.existsSync(KEY_FILE)) {
    console.error(
      `\nNo API key found.\n` +
        `  Put one line containing the key in: ${KEY_FILE}\n` +
        `  (or set GEMINI_API_KEY in the environment)\n` +
        `  .secrets/ is git-ignored. Use a disposable key and revoke it afterwards.\n`
    )
    process.exit(1)
  }
  const lines = fs
    .readFileSync(KEY_FILE, 'utf8')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
  if (lines.length === 0) {
    console.error(`\n${KEY_FILE} contains no key line.\n`)
    process.exit(1)
  }
  // A file a human maintains gets labels — this one holds a free key and a paid one, written
  // as "Free: …" and "Paid: …". Taking the line whole sent the label to Google as part of the
  // credential and the run died at L1 on "API key not valid", which is an expensive-looking way
  // to report a parsing problem, and one that reads as a revoked key rather than a bad parse.
  //
  // Three attempts, narrowing: a Google-shaped token anywhere in the line; failing that, the
  // line with a short leading label stripped; failing that, the line verbatim, which is what
  // every previous run relied on. Nothing here prints the file.
  for (const line of lines) {
    const shaped = /AIza[A-Za-z0-9_-]{20,}/.exec(line)?.[0]
    if (shaped) return shaped
  }
  const first = lines[0]
  const unlabelled = /^[A-Za-z][A-Za-z ]{0,20}[:=]\s*(\S+)/.exec(first)?.[1]
  return unlabelled ?? first
}

interface RunResult {
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
}

/**
 * The environment the app really spawns with.
 *
 * `pythonBridge.run()` puts the bundled binaries on PATH and forces Python into UTF-8 mode
 * so non-Latin output does not hit Windows' legacy charmap codec. A probe that spawned with
 * a bare `process.env` would be testing a configuration the app never uses — and would be
 * at its least trustworthy on exactly the check that matters most, the Hebrew one.
 */
function appEnv(): NodeJS.ProcessEnv {
  return envWithFfmpeg(FFMPEG_PATH, {
    PYTHONUNBUFFERED: '1',
    PYTHONUTF8: '1',
    PYTHONIOENCODING: 'utf-8'
  })
}

/**
 * @param answerUpgradePrompt Answer the engine's "upgrade? (y/n)" question and close stdin.
 *
 * Opt-in, and only `list-models` may opt in. `cmd_list_models` never honours `--skip-upgrade`, so
 * the engine asks whenever PyPI is ahead of the pin — that unanswered question is what made L1 hang
 * for the full timeout — while `cmd_translate` and `cmd_transcribe` do honour the flag and are never
 * asked. Every other probe must keep the stdin **production** gives the engine: `pythonBridge.run()`
 * writes nothing and leaves the pipe open. That is not a detail. The engine falls back to an
 * interactive stdin read when `--resume`/`--no-resume` is missing (see `pythonBridge.ts` and gate
 * C22b), so a translate probe running on a closed stdin would turn that hang into a tidy EOF error
 * and hide the very regression C22b exists to catch.
 */
function run(
  args: string[],
  env?: NodeJS.ProcessEnv,
  { answerUpgradePrompt = false }: { answerUpgradePrompt?: boolean } = {}
): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(GST, args, { windowsHide: true, env: env ?? appEnv() })
    let stdout = ''
    let stderr = ''
    let timedOut = false

    if (answerUpgradePrompt) {
      // Exactly what `refreshModels()` does, including the error handler — writing to a child that
      // has already exited emits on the stream, and an unhandled 'error' there ends the process.
      child.stdin.on('error', () => {})
      try {
        child.stdin.write('n\n')
        child.stdin.end()
      } catch {
        // The timeout below still bounds the run.
      }
    }

    const timer = setTimeout(() => {
      timedOut = true
      child.kill()
    }, TIMEOUT_MS)
    child.stdout.on('data', (d) => (stdout += d.toString()))
    child.stderr.on('data', (d) => (stderr += d.toString()))
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, stdout, stderr, timedOut })
    })
  })
}

const SRT_FIXTURE = [
  '1\n00:00:01,000 --> 00:00:03,000\nGood morning.\n',
  '2\n00:00:04,000 --> 00:00:06,000\nHow are you today?\n',
  '3\n00:00:07,000 --> 00:00:09,000\nI am fine, thank you.\n',
  '4\n00:00:10,000 --> 00:00:12,000\nWhere is the train station?\n',
  '5\n00:00:13,000 --> 00:00:15,000\nIt is on the left.\n'
].join('\n')

// The full ten-field event format, because that is what real files use — and because a
// shortened `Format:` line is parsed positionally by pysubs2, which silently lands the
// dialogue in the Name field and leaves Text empty. `Émphase` is deliberately non-ASCII:
// gate G2 requires style names to survive the round trip intact.
const ASS_FIXTURE = `[Script Info]
Title: Verification fixture
ScriptType: v4.00+

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,20,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,2,2,10,10,10,1
Style: Émphase,Arial,24,&H0000FFFF,&H000000FF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,2,2,2,10,10,10,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,Good morning.
Dialogue: 0,0:00:04.00,0:00:06.00,Émphase,,0,0,0,,How are you today?
Dialogue: 0,0:00:07.00,0:00:09.00,Default,,0,0,0,,I am fine, thank you.
Dialogue: 0,0:00:10.00,0:00:12.00,Default,,0,0,0,,Where is the train station?
Dialogue: 0,0:00:13.00,0:00:15.00,Émphase,,0,0,0,,It is on the left.
`

function translateArgs(over: Partial<TranslateArgs>, outputPath: string): string[] {
  return buildTranslateArgs(translateFixtureArgs(over), outputPath)
}

function translateFixtureArgs(over: Partial<TranslateArgs> = {}): TranslateArgs {
  const base: TranslateArgs = {
    inputFile: '',
    sourceLang: 'en',
    targetLang: 'es',
    model: '',
    apiKeys: [secret],
    batchSize: 100,
    batchContext: true,
    customGenerationParams: false,
    temperature: 1,
    topP: 0.95,
    topK: null,
    thinkingLevel: 'low',
    thinkingBudget: 512,
    serviceTier: 'standard',
    paidQuota: false,
    disableStreaming: false,
    writeTokenReport: false,
    progressLog: false,
    thoughtsLog: false,
    ...over
  }
  return base
}

function transcribeArgs(mediaFile: string, model: string, outputFile: string): TranscribeArgs {
  return {
    mediaFile,
    outputFile,
    targetLang: 'en',
    model,
    apiKeys: [secret],
    thinkingLevel: 'low',
    thinkingBudget: 512,
    customGenerationParams: false,
    temperature: 1,
    topP: 0.95,
    topK: null
  }
}

/**
 * Newest flash-lite in the fetched list, so the probes cost as little as possible.
 *
 * `eligible` exists because not every cheap model can do every job: transcription needs a
 * 2.5 or 3.x model, and spawning a 2.0 model would produce an engine error the UI would
 * never allow — a probe failure that says nothing about the app.
 *
 * `fallbackToAnyEligible` decides what "none of the cheap tiers qualify" means. For the
 * translation probes it means stop: they are cost-driven and a `pro` model is not a
 * silent substitute for one. For transcription it means widen, because a key exposing a
 * capable `pro` model but no capable flash really does support the feature, and skipping
 * it would report missing coverage that is not missing.
 */
function cheapestModel(
  ids: string[],
  eligible: (id: string) => boolean = () => true,
  { fallbackToAnyEligible = false } = {}
): string | null {
  const usable = ids.filter(eligible)
  const stable = (id: string): boolean => !id.includes('preview')
  const versionOf = (id: string): number[] => {
    const m = id.match(/(\d+)\.(\d+)/)
    return m ? [Number(m[1]), Number(m[2])] : [0, 0]
  }
  const newest = (pool: string[]): string | null =>
    pool.length
      ? [...pool].sort((a, b) => {
          const [am, an] = versionOf(a)
          const [bm, bn] = versionOf(b)
          return bm - am || bn - an
        })[0]
      : null

  return (
    newest(usable.filter((id) => id.includes('flash-lite') && stable(id))) ??
    newest(usable.filter((id) => id.includes('flash') && stable(id))) ??
    (fallbackToAnyEligible ? (newest(usable.filter(stable)) ?? newest(usable)) : null)
  )
}

/**
 * Independent expectations for L6's classification check, written from what the formats ARE
 * rather than from `ffmpeg.ts`'s own list — an oracle copied from the code under test cannot
 * disagree with it. `dvb_subtitle` is deliberately included: it is a bitmap format, so if a
 * fixture carries one and this check fails, that is a real gap in the app's `IMAGE_CODECS`,
 * not a bad expectation.
 */
const IMAGE_SUBTITLE_CODECS = new Set([
  'hdmv_pgs_subtitle',
  'pgssub',
  'dvd_subtitle',
  'dvdsub',
  'dvb_subtitle',
  'dvbsub',
  'xsub'
])
const TEXT_SUBTITLE_CODECS = new Set([
  'subrip',
  'srt',
  'ass',
  'ssa',
  'mov_text',
  'webvtt',
  'text',
  'subviewer',
  'microdvd'
])

function hasHebrew(text: string): boolean {
  return /[\u0590-\u05FF]/.test(text)
}

function cueCount(srt: string): number {
  return (srt.match(/-->/g) ?? []).length
}

/** First N cues of an SRT, so a stage-2 translation stays cheap. */
function firstCues(srt: string, n: number): string {
  const blocks = srt.split(/\r?\n\r?\n/).filter((b) => b.includes('-->'))
  return blocks.slice(0, n).join('\n\n') + '\n'
}

const CLIP_SECONDS = 30
/**
 * A copied video clip can be large without being expensive: for video input the engine
 * extracts and compresses the audio itself and uploads only that. This ceiling exists to
 * catch a clip that failed to trim, not to control upload size.
 */
const CLIP_MAX_BYTES = 200_000_000

function ffmpegBinary(): string {
  const exe = process.platform === 'win32' ? '.exe' : ''
  if (FFMPEG_PATH) return path.join(path.dirname(FFMPEG_PATH), `ffmpeg${exe}`)
  const bundled = path.join(ROOT, 'resources', 'bin', `ffmpeg${exe}`)
  return fs.existsSync(bundled) ? bundled : 'ffmpeg'
}

function ffmpegRun(args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    let proc
    try {
      proc = spawn(ffmpegBinary(), args, { windowsHide: true })
    } catch {
      resolve(false)
      return
    }
    proc.on('error', () => resolve(false))
    proc.on('close', (code) => resolve(code === 0))
  })
}

/**
 * A short stream-copied clip of a fixture, or null if ffmpeg cannot produce one.
 *
 * Video is preferred, and stream-copied rather than re-encoded, because that is the path a
 * user actually takes: the engine extracts and compresses the audio itself, so what it
 * receives is the fixture's own bytes and a failure implicates the app rather than a
 * transcoding step the app never performs.
 *
 * The audio fallback is deliberately **MP3, mono**, not m4a. The engine loads audio through
 * pydub, which hands the file to ffmpeg with a forced format; an AAC/MP4 clip is decoded as
 * mp3float, yields no packets, and fails with "Conversion failed!". MP3 is also exactly what
 * the engine's own `extract_audio_from_video` produces, so the fallback stays inside the
 * range of inputs the engine is built to read.
 */
async function makeClip(source: string, work: string): Promise<string | null> {
  const clip = path.join(work, `clip${path.extname(source).toLowerCase()}`)
  // `-t` goes AFTER `-i`: as an input option it limits how much is *read*, which a
  // stream copy of an mkv can ignore — the first attempt at this produced a "clip" the
  // size of the whole film.
  const copied = await ffmpegRun([
    '-y', '-i', source, '-t', String(CLIP_SECONDS),
    '-map', '0:v:0?', '-map', '0:a:0?', '-c', 'copy', clip
  ])
  if (copied && fs.existsSync(clip) && fs.statSync(clip).size <= CLIP_MAX_BYTES) return clip

  const audio = path.join(work, 'clip.mp3')
  const extracted = await ffmpegRun([
    '-y', '-i', source, '-t', String(CLIP_SECONDS),
    '-vn', '-sn', '-dn', '-map', '0:a:0', '-map_metadata', '-1',
    '-ac', '1', '-ar', '22050', '-c:a', 'libmp3lame', '-b:a', '48k', audio
  ])
  if (extracted && fs.existsSync(audio)) {
    console.log('        note: no usable video clip, so this runs the audio (-a) path')
    return audio
  }
  console.log('        note: could not clip the fixture; transcribing it whole (this will be slow)')
  return null
}

/** Stage-2 fixtures the user drops in; absent means the probe skips, never fails. */
function fixtures(exts: string[]): string[] {
  if (!fs.existsSync(FIXTURE_DIR)) return []
  return fs
    .readdirSync(FIXTURE_DIR)
    .filter((f) => exts.includes(path.extname(f).toLowerCase()))
    .map((f) => path.join(FIXTURE_DIR, f))
    .sort()
}

interface AssEvent {
  fields: Map<string, string>
  text: string
}

/**
 * Split an ASS record into exactly `count` fields, keeping everything after the last
 * separator as one field. Text is the final column *because* it may legally contain commas
 * and override tags such as `{\i1}`, so a plain `split(',')` would shred it.
 */
function splitRecord(record: string, count: number): string[] {
  const out: string[] = []
  let rest = record
  for (let i = 0; i < count - 1; i++) {
    const comma = rest.indexOf(',')
    if (comma === -1) break
    out.push(rest.slice(0, comma))
    rest = rest.slice(comma + 1)
  }
  out.push(rest)
  return out
}

/**
 * Parse `[Events]` rows using the file's OWN `Format:` line rather than assuming a layout.
 *
 * This exists to make the positional-field regression detectable. Matching Hebrew anywhere
 * in a `Dialogue:` row cannot tell "translated dialogue in the Text column" apart from
 * "dialogue shifted into the Name column with Text left empty" — which is precisely the
 * failure the ASS fixture correction was written to catch.
 */
function parseAssEvents(body: string): { format: string[]; events: AssEvent[] } {
  let format: string[] = []
  const events: AssEvent[] = []
  let inEvents = false

  for (const line of body.split(/\r?\n/)) {
    if (/^\s*\[/.test(line)) {
      inEvents = /^\s*\[Events\]/i.test(line)
      continue
    }
    if (!inEvents) continue

    const fmt = line.match(/^Format:\s*(.+)$/i)
    if (fmt) {
      format = fmt[1].split(',').map((f) => f.trim())
      continue
    }
    const dialogue = line.match(/^Dialogue:\s*(.*)$/i)
    if (!dialogue || !format.length) continue

    const parts = splitRecord(dialogue[1], format.length)
    const fields = new Map<string, string>()
    format.forEach((name, i) => fields.set(name.toLowerCase(), (parts[i] ?? '').trim()))
    events.push({ fields, text: fields.get('text') ?? '' })
  }
  return { format, events }
}

async function main(): Promise<void> {
  if (!fs.existsSync(path.join(ROOT, 'package.json'))) {
    console.error(`\nRun this from the project root (via npm run verify:live). Saw: ${ROOT}\n`)
    process.exit(1)
  }
  if (!fs.existsSync(GST)) {
    console.error(`\nEngine not found at ${GST}. Run: npm run build:python\n`)
    process.exit(1)
  }
  secret = loadKey()

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'srt-verify-'))
  console.log(`Engine:    ${GST}`)
  console.log(`Workspace: ${work}`)
  // Length and shape only — never the key. Enough to tell a parsing failure apart from a
  // revoked credential without anyone having to open the file, which is the confusion that cost
  // this phase two live runs.
  console.log(
    `Key:       loaded, never printed (${secret.length} chars, ` +
      `${/^AIza[A-Za-z0-9_-]{20,}$/.test(secret) ? 'AIza-shaped' : 'not AIza-shaped'})`
  )
  console.log(
    `ffmpeg:    ${FFMPEG_PATH ?? 'bundled/default (set SRT_VERIFY_FFMPEG_PATH to verify an override)'}`
  )

  // An override has to reach the app the way a user's does — through the persisted setting —
  // or `startTranscribe` reads the stub's empty default and the end-to-end probes quietly run
  // on a different binary than the direct calls, which is worse than not offering the mode.
  if (FFMPEG_PATH) setSettings({ ffmpegPath: FFMPEG_PATH })

  // ── B1 / C19 — the frozen binary reaches Google and the model list is honest ──
  section('L1 — list-models against a real key (B1, C19)')
  const list = await run(['list-models', '-k', secret, '--skip-upgrade'], undefined, {
    answerUpgradePrompt: true
  })
  const listOut = mask(list.stdout + list.stderr)
  const ids = Array.from(listOut.matchAll(/\b(gemini-[a-z0-9.\-]+)/gi)).map((m) => m[1])
  const unique = Array.from(new Set(ids))
  const model = cheapestModel(unique)
  const capable = (id: string): boolean => modelCapabilities(id).supportsTranscription

  const listOk = check('list-models exits 0 with --skip-upgrade', list.code === 0, `exit ${list.code}`)
  if (!listOk) console.log(listOut.split('\n').slice(-12).join('\n'))
  check('the key returns at least one model', unique.length > 0, `${unique.length} ids`)
  const aliases = unique.filter((id) => id.endsWith('-latest'))
  console.log(`        ${unique.length} models; ${aliases.length} '-latest' alias id(s) returned by the API`)
  console.log(
    aliases.length
      ? "        (B1 confirmed: the API DOES return aliases, so the app's filtering is load-bearing)"
      : '        (B1: no aliases returned on this account)'
  )

  if (!model) {
    console.error('\nNo usable model returned; cannot run the translation probes.\n')
    process.exit(1)
  }
  console.log(`        Using ${model} for the translation probes`)

  // Selection self-checks. These settle the cases a normal account never exercises — a key
  // with a capable pro model but no capable flash — without waiting for such a key to exist.
  check(
    'transcription falls back to a capable pro model when no capable flash exists',
    cheapestModel(['gemini-2.0-flash', 'gemini-2.5-pro'], capable, { fallbackToAnyEligible: true }) ===
      'gemini-2.5-pro'
  )
  check(
    'the cost-driven translation probes still refuse to substitute a pro model',
    cheapestModel(['gemini-2.5-pro']) === null
  )
  check(
    'flash-lite still wins on cost whenever it qualifies',
    cheapestModel(['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.5-flash-lite'], capable, {
      fallbackToAnyEligible: true
    }) === 'gemini-2.5-flash-lite'
  )

  // ── A3 — a real translation round-trips through the frozen engine ──
  section('L2 — five-cue SRT translation (A3)')
  const srcSrt = path.join(work, 'sample.srt')
  fs.writeFileSync(srcSrt, SRT_FIXTURE, 'utf8')
  const outEs = path.join(work, 'sample_es.srt')
  const es = await run(translateArgs({ inputFile: srcSrt, targetLang: 'es', model }, outEs))
  check('translate exits 0', es.code === 0 && !es.timedOut, `exit ${es.code}${es.timedOut ? ' (timed out)' : ''}`)
  const esWritten = fs.existsSync(outEs)
  if (!check('an output file is written', esWritten)) {
    console.log(mask(es.stdout + es.stderr).split('\n').slice(-15).join('\n'))
  } else {
    const body = fs.readFileSync(outEs, 'utf8')
    check('all five cues survive', cueCount(body) === 5, `${cueCount(body)} cues`)
    check('timings are unchanged', body.includes('00:00:01,000 --> 00:00:03,000'))
    check('the text is not still English', !body.includes('Where is the train station?'))
  }

  // ── A4 — Hebrew through the frozen build's stdio (dev half; D2 is authoritative) ──
  section('L3 — Hebrew output (A4; D2 remains authoritative)')
  const outHe = path.join(work, 'sample_he.srt')
  const he = await run(translateArgs({ inputFile: srcSrt, targetLang: 'he', model }, outHe))
  check('translate exits 0', he.code === 0 && !he.timedOut, `exit ${he.code}`)
  if (check('an output file is written', fs.existsSync(outHe))) {
    const body = fs.readFileSync(outHe, 'utf8')
    check('the output contains Hebrew characters', hasHebrew(body))
    check('the file decodes as UTF-8 without replacement characters', !body.includes('\uFFFD'))
    check('all five cues survive', cueCount(body) === 5, `${cueCount(body)} cues`)
  }
  const logText = mask(he.stdout + he.stderr)
  check(
    'no charmap/encoding crash in the engine log',
    !/charmap|UnicodeEncodeError|UnicodeDecodeError/i.test(logText)
  )

  // ── C20 — ASS round trip, the runtime half of gate G2 ──
  section('L4 — ASS round trip (C20, G2 runtime half)')

  // The detector must be able to FAIL. This is the exact record shape the shortened-Format
  // bug produced — Hebrew in Name, Text empty — and it is what a "Hebrew anywhere in the
  // row" check happily accepted. If this ever reads as translated text, every assertion
  // below it is decorative.
  const shifted = parseAssEvents(
    '[Events]\n' +
      'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n' +
      'Dialogue: 0,0:00:01.00,0:00:03.00,Default,\u05e9\u05dc\u05d5\u05dd,0,0,0,,\n'
  ).events[0]
  check(
    'the Text-column detector rejects a field-shifted record',
    !!shifted && !hasHebrew(shifted.text) && hasHebrew(shifted.fields.get('name') ?? '')
  )
  const wellFormed = parseAssEvents(
    '[Events]\n' +
      'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n' +
      'Dialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,{\\i1}\u05e9\u05dc\u05d5\u05dd, \u05e2\u05d5\u05dc\u05dd\n'
  ).events[0]
  check(
    'the Text column survives commas and override tags intact',
    !!wellFormed && hasHebrew(wellFormed.text) && wellFormed.text.includes(',')
  )

  const srcAss = path.join(work, 'styled.ass')
  fs.writeFileSync(srcAss, ASS_FIXTURE, 'utf8')
  const originalBytes = fs.readFileSync(srcAss)
  const norm = ensureUtf8Subtitle(srcAss)
  const accepted = check('a UTF-8 .ass is accepted by the normaliser', norm.ok)
  const prepared = norm.ok ? norm.path : srcAss
  if (accepted) check('the prepared path keeps the .ass extension', path.extname(prepared) === '.ass')

  const outAss = path.join(work, 'styled_he.ass')
  const ass = await run(translateArgs({ inputFile: prepared, targetLang: 'he', model }, outAss))
  check('translate exits 0 on .ass input', ass.code === 0 && !ass.timedOut, `exit ${ass.code}`)
  if (check('an .ass output is written', fs.existsSync(outAss))) {
    const body = fs.readFileSync(outAss, 'utf8')
    check('the output keeps the .ass extension', path.extname(outAss) === '.ass')
    check('[Script Info] survives', body.includes('[Script Info]'))
    check('[V4+ Styles] survives', body.includes('[V4+ Styles]'))
    check('both style definitions survive', body.includes('Default') && body.includes('Émphase'))
    check('the non-ASCII style name is not mangled', body.includes('Émphase') && !body.includes('\uFFFD'))

    const { format, events } = parseAssEvents(body)
    check('the events still declare Text as the final column', format.at(-1)?.toLowerCase() === 'text')
    check('all five dialogue lines survive', events.length === 5, `${events.length} events`)
    check(
      'every line was translated IN THE TEXT COLUMN',
      events.length === 5 && events.every((e) => hasHebrew(e.text)),
      events.map((e) => `text="${e.text}"`).join(' | ')
    )
    check(
      'no dialogue leaked into the Name column',
      events.every((e) => !hasHebrew(e.fields.get('name') ?? '')),
      'dialogue in Name means the fields shifted'
    )
  } else {
    console.log(mask(ass.stdout + ass.stderr).split('\n').slice(-15).join('\n'))
  }
  check(
    "the user's original .ass is byte-identical afterwards",
    Buffer.compare(originalBytes, fs.readFileSync(srcAss)) === 0
  )

  // ── C23 — ffmpeg unreachable must not be fatal for work that does not need it ──
  section('L5 — ffmpeg unreachable (C23)')
  const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'srt-nopath-'))
  const strippedEnv = { ...process.env, PATH: emptyDir, Path: emptyDir }
  const noFfmpeg = await run(['list-models', '-k', secret, '--skip-upgrade'], strippedEnv, {
    answerUpgradePrompt: true
  })
  check(
    'the engine still completes an operation that does not need ffmpeg',
    noFfmpeg.code === 0,
    `exit ${noFfmpeg.code}`
  )
  check(
    'it does not hard-exit complaining about ffmpeg',
    !/ffmpeg.*(not found|required|install)/i.test(mask(noFfmpeg.stdout + noFfmpeg.stderr)) ||
      noFfmpeg.code === 0
  )

  // ── C21 — embedded subtitle track: probe, extract, translate (stage 2) ──
  section('L6 — embedded subtitle track (C21, stage 2)')
  const videos = fixtures(['.mkv', '.mp4', '.mov', '.webm', '.m4v'])
  if (!videos.length) {
    skip('embedded-track probe, extraction and translation', `no video in ${FIXTURE_DIR}`)
  } else {
    for (const video of videos) {
      const label = path.basename(video)
      const tracks = await probeTracks(video, FFMPEG_PATH)
      check(`${label}: ffprobe reports its subtitle tracks`, tracks.length > 0, `${tracks.length} tracks`)
      if (!tracks.length) continue

      console.log(
        `        tracks: ${tracks.map((t) => `${t.index}:${t.codec}${t.lang ? `/${t.lang}` : ''}`).join(', ')}`
      )
      const text = tracks.filter((t) => !t.isImage)

      // Judge the classification against the codec name, which is ground truth from ffprobe
      // and NOT derived from the app's own list — a check written from the code under test
      // can only ever agree with it. Getting this wrong is not cosmetic: `extractTrack`
      // remuxes an image track and transcodes a text one, so a bitmap stream misread as text
      // is handed to `-c:s srt` and fails.
      const knownImage = tracks.filter((t) => IMAGE_SUBTITLE_CODECS.has(t.codec.toLowerCase()))
      const knownText = tracks.filter((t) => TEXT_SUBTITLE_CODECS.has(t.codec.toLowerCase()))
      if (knownImage.length) {
        check(
          `${label}: bitmap tracks (${knownImage.map((t) => t.codec).join(', ')}) are marked as image`,
          knownImage.every((t) => t.isImage)
        )
      } else {
        skip(`${label}: image-track classification`, 'this file has no bitmap subtitle track')
      }
      if (knownText.length) {
        check(
          `${label}: text tracks (${knownText.map((t) => t.codec).join(', ')}) are NOT marked as image`,
          knownText.every((t) => !t.isImage)
        )
      }
      const unclassified = tracks.filter(
        (t) =>
          !IMAGE_SUBTITLE_CODECS.has(t.codec.toLowerCase()) &&
          !TEXT_SUBTITLE_CODECS.has(t.codec.toLowerCase())
      )
      if (unclassified.length) {
        console.log(
          `        note: ${unclassified.map((t) => t.codec).join(', ')} — codec not in the probe's ` +
            `reference sets, so its classification is unverified here`
        )
      }

      if (!text.length) {
        skip(`${label}: text-track extraction`, 'this file has only image/PGS tracks')
      } else {
        const track = text[0]
        const extracted = path.join(work, `${path.parse(video).name}_t${track.index}.srt`)
        const res = await extractTrack(video, track.index, extracted, false, FFMPEG_PATH)
        check(`${label}: the text track extracts to .srt`, res.ok, res.error ?? '')
        if (res.ok && check(`${label}: the extracted file exists`, fs.existsSync(extracted))) {
          const body = fs.readFileSync(extracted, 'utf8')
          check(`${label}: the extraction contains cues`, cueCount(body) > 0, `${cueCount(body)} cues`)

          // Translate only a trimmed copy: a full track would be slow and costly, and C21
          // is about the extract-then-translate path, not about volume.
          const trimmed = path.join(work, `${path.parse(video).name}_trimmed.srt`)
          fs.writeFileSync(trimmed, firstCues(body, 5), 'utf8')
          const outTrack = path.join(work, `${path.parse(video).name}_he.srt`)
          const tr = await run(translateArgs({ inputFile: trimmed, targetLang: 'he', model }, outTrack))
          check(`${label}: the extracted track translates`, tr.code === 0, `exit ${tr.code}`)
          if (fs.existsSync(outTrack)) {
            check(`${label}: the translation contains Hebrew`, hasHebrew(fs.readFileSync(outTrack, 'utf8')))
          }
        }
      }
    }
  }

  // ── Transcription — the third top-level feature, previously untested (stage 2) ──
  section('L7 — transcription (stage 2)')
  const media = fixtures(['.mp3', '.m4a', '.wav', '.flac', '.ogg', '.mkv', '.mp4', '.mov', '.webm'])
  // The translation model is chosen purely on cost and may be a 2.0 model, which cannot
  // transcribe. TranscribePage blocks that before spawning; the probe must apply the same
  // rule from the same source, or it reports an app failure the UI would never permit.
  const txModel = cheapestModel(unique, (id) => modelCapabilities(id).supportsTranscription, {
    fallbackToAnyEligible: true
  })
  if (!media.length) {
    skip('transcription end to end', `no audio or video in ${FIXTURE_DIR}`)
  } else if (!txModel) {
    skip(
      'transcription end to end',
      'this key exposes no transcription-capable model at any tier: coverage unavailable, not failing'
    )
  } else {
    // Real fixtures are feature-length. Transcribing 340 MB uploads 340 MB and buys no
    // coverage the first minute does not: L7 is about the transcribe path, exactly as L6
    // trims to five cues. The clip is a stream copy, so the bytes the engine sees are the
    // fixture's own — a re-encode would be testing ffmpeg, not the app.
    const smallest = [...media].sort((a, b) => fs.statSync(a).size - fs.statSync(b).size)[0]
    const source = (await makeClip(smallest, work)) ?? smallest
    const label = path.basename(source)
    console.log(
      `        ${path.basename(smallest)} -> ${label} (${(fs.statSync(source).size / 1e6).toFixed(1)} MB)`
    )
    if (txModel !== model) {
      console.log(`        Using ${txModel} — the cheapest transcription-capable model this key exposes`)
    }
    const outTx = path.join(work, 'transcribed.srt')
    const txArgs = buildTranscribeArgs(transcribeArgs(source, txModel, outTx), outTx)
    check(
      `${label}: the media flag matches the file type`,
      txArgs.includes(/\.(mp4|mkv|mov|avi|webm|m4v|ts|wmv|flv)$/i.test(source) ? '-v' : '-a')
    )
    const tx = await run(txArgs)
    check(`${label}: transcribe exits 0`, tx.code === 0 && !tx.timedOut, `exit ${tx.code}`)
    if (check(`${label}: an .srt is written`, fs.existsSync(outTx))) {
      const body = fs.readFileSync(outTx, 'utf8')
      check(`${label}: the transcript contains cues`, cueCount(body) > 0, `${cueCount(body)} cues`)
      check(`${label}: cues carry text, not just timestamps`, /-->.*\r?\n\s*\S+/.test(body))
      check(`${label}: no replacement characters`, !body.includes('\uFFFD'))
    } else {
      console.log(mask(tx.stdout + tx.stderr).split('\n').slice(-15).join('\n'))
    }
  }

  // ── ENG-1 — audio the engine cannot read is normalised before it is spawned ──
  section('L8 — unreadable audio is converted (ENG-1)')
  check('.m4a is recognised as needing conversion', needsAudioConversion('a.m4a'))
  check('.aac and .flac too', needsAudioConversion('a.aac') && needsAudioConversion('a.flac'))
  check(
    'the formats the engine reads are left alone',
    !needsAudioConversion('a.mp3') && !needsAudioConversion('a.wav')
  )
  check('video is left alone — it never had this problem', !needsAudioConversion('a.mkv'))

  if (!media.length) {
    skip('the ENG-1 round trip', `no media in ${FIXTURE_DIR} to build an .m4a from`)
  } else if (!txModel) {
    skip('the ENG-1 round trip', 'no transcription-capable model on this key')
  } else {
    const rawM4a = path.join(work, 'unreadable.m4a')
    const built = await ffmpegRun([
      '-y', '-i', [...media].sort((a, b) => fs.statSync(a).size - fs.statSync(b).size)[0],
      '-t', String(CLIP_SECONDS), '-vn', '-sn', '-dn', '-map', '0:a:0',
      '-c:a', 'aac', '-b:a', '96k', rawM4a
    ])
    if (!built || !fs.existsSync(rawM4a)) {
      skip('the ENG-1 round trip', 'ffmpeg could not build an .m4a fixture')
    } else {
      // The defect must still be demonstrable, or the conversion below proves nothing.
      // This costs no quota: the engine dies in its own ffmpeg step, before any API call.
      const rawOut = path.join(work, 'raw.srt')
      const raw = await run(buildTranscribeArgs(transcribeArgs(rawM4a, txModel, rawOut), rawOut))
      const rawLog = mask(raw.stdout + raw.stderr)
      // A bare non-zero exit is not evidence: a missing engine, a bad key, a timeout or any
      // unrelated crash would satisfy it just as well as the decoder defect, and the probe
      // would then certify the workaround while never having exercised what it works around.
      const decoderFailure = /Conversion failed/i.test(rawLog)
      const unrelated = /API[_ ]?KEY|api key|quota|ModuleNotFoundError|is not recognized|No such file/i.test(
        rawLog
      )
      check(
        'the raw .m4a still fails in the engine, in its pre-API decode step',
        !raw.timedOut && raw.code !== 0 && decoderFailure && !unrelated,
        `exit ${raw.code}${raw.timedOut ? ', timed out' : ''}` +
          (decoderFailure ? '' : ', no "Conversion failed" in the log') +
          (unrelated ? ', failed for an unrelated reason' : '') +
          ' — if the decode now succeeds, ENG-1 is fixed upstream and the workaround can be deleted'
      )

      const before = fs.readFileSync(rawM4a)
      // Same ffmpeg the app would use: production passes `getSettings().ffmpegPath`, so a
      // probe that silently used a different binary would certify a path nobody ships.
      const prepared = await ensureEngineReadableAudio(rawM4a, FFMPEG_PATH)
      if (check('the app converts it', prepared.ok && prepared.converted)) {
        const preparedPath = prepared.ok ? prepared.path : rawM4a
        check('the converted file is an .mp3', path.extname(preparedPath) === '.mp3')
        check(
          "the user's original .m4a is byte-identical afterwards",
          Buffer.compare(before, fs.readFileSync(rawM4a)) === 0
        )
        // This probe owns the file it just made; the app's own copy is what the round trip
        // below is about, and leaving this one behind would corrupt its cleanup baseline.
        try {
          fs.unlinkSync(preparedPath)
        } catch {
          /* best effort */
        }

        // The round trip goes through the PRODUCTION entry point, not a hand-built argv, so
        // it covers the conversion, the spawn and the scratch cleanup as one path.
        const tempDir = path.dirname(tempOutputPath('.mp3'))
        const mp3sBefore = fs.readdirSync(tempDir).filter((f) => f.endsWith('.mp3')).length
        const outFixed = path.join(work, 'converted.srt')
        const log: string[] = []
        const closed = new Promise<number | null>((resolve) => {
          void startTranscribe(transcribeArgs(rawM4a, txModel, outFixed), {
            onOutput: (_s, line) => log.push(line),
            onDone: (code) => resolve(code)
          })
        })
        const code = await closed
        check('the app transcribes the .m4a end to end', code === 0, `exit ${code}`)
        check(
          'it announces the conversion before the pause',
          log.some((l) => /Preparing .*converting to MP3/i.test(l))
        )
        if (check('an .srt is written for the converted audio', fs.existsSync(outFixed))) {
          const body = fs.readFileSync(outFixed, 'utf8')
          check('it contains cues with text', cueCount(body) > 0 && /-->.*\r?\n\s*\S+/.test(body))
        } else {
          console.log(mask(log.join('\n')).split('\n').slice(-15).join('\n'))
        }
        check(
          'the temporary MP3 is deleted once the job ends',
          fs.readdirSync(tempDir).filter((f) => f.endsWith('.mp3')).length === mp3sBefore,
          'a converted copy of the user\u2019s audio must not outlive the job'
        )

        // The round trip above only verifies the CONFIGURED ffmpeg if `startTranscribe` reads
        // the setting at all — and it would pass either way while a bundled binary is on hand.
        // Pointing the setting at a path that cannot exist settles it: the conversion must
        // fail. If it succeeds, Settings is being ignored and this probe's override mode is a
        // fiction.
        const configuredFfmpeg = getSettings().ffmpegPath
        setSettings({ ffmpegPath: path.join(work, 'no-such-ffmpeg.exe') })
        const bogusOut = path.join(work, 'bogus-ffmpeg.srt')
        const bogusLog: string[] = []
        const bogusCode = await new Promise<number | null>((resolve) => {
          void startTranscribe(transcribeArgs(rawM4a, txModel, bogusOut), {
            onOutput: (_s, line) => bogusLog.push(line),
            onDone: (c) => resolve(c)
          })
        })
        setSettings({ ffmpegPath: configuredFfmpeg })
        check(
          'the conversion uses the FFmpeg configured in Settings',
          bogusCode !== 0 && !fs.existsSync(bogusOut),
          `exit ${bogusCode} — a broken configured path must not silently fall back`
        )
        check(
          'and a broken one is reported as a conversion failure',
          bogusLog.some((l) => /convert/i.test(l)),
          mask(bogusLog.slice(-3).join(' | '))
        )
      }
    }
  }

  // ── The job lifecycle around that conversion (ENG-1, ENG-2, ENG-3) ──
  // Free: every assertion here is settled during the conversion, before gst is ever spawned.
  section('L9 — Stop and the single-job lock during preparation')
  const m4aForStop = path.join(work, 'lifecycle.m4a')
  if (!media.length) {
    skip('the preparation lifecycle', `no media in ${FIXTURE_DIR} to build an .m4a from`)
  } else if (
    !(await ffmpegRun([
      '-y', '-i', [...media].sort((a, b) => fs.statSync(a).size - fs.statSync(b).size)[0],
      '-t', String(CLIP_SECONDS), '-vn', '-sn', '-dn', '-map', '0:a:0',
      '-c:a', 'aac', '-b:a', '96k', m4aForStop
    ]))
  ) {
    skip('the preparation lifecycle', 'ffmpeg could not build an .m4a fixture')
  } else {
    const tempDir = path.dirname(tempOutputPath('.mp3'))
    const mp3sBefore = fs.readdirSync(tempDir).filter((f) => f.endsWith('.mp3')).length

    const done: Array<number | null> = []
    const stderrLines: string[] = []
    const outPath = path.join(work, 'lifecycle.srt')
    const pending = startTranscribe(transcribeArgs(m4aForStop, txModel ?? 'gemini-2.5-flash-lite', outPath), {
      onOutput: (stream, line) => {
        if (stream === 'stderr') stderrLines.push(line)
      },
      onDone: (code) => done.push(code)
    })

    // Synchronous, so this lands mid-conversion by construction.
    check('the job slot is held while the audio is being prepared', isRunning())

    const refusedDone: Array<number | null> = []
    startTranslate(translateFixtureArgs({ inputFile: srcSrt, model }), {
      onOutput: () => {},
      onDone: (code) => refusedDone.push(code)
    })
    check(
      'a second job started during preparation is refused',
      refusedDone.length === 1 && refusedDone[0] !== 0,
      `${refusedDone.length} terminal events — a refusal with none leaves that page running forever`
    )

    // Through the REAL IPC handler, not just the function it calls. The refusal fires
    // `onDone` synchronously, so the handler's closure runs before its own `const` bindings
    // exist — a defect that lives in the closure and is invisible to a direct call.
    registerIpc()
    let handlerError: string | null = null
    let handlerResult: unknown = undefined
    try {
      handlerResult = __invokeIpc('translate:start', translateFixtureArgs({ inputFile: srcSrt, model }))
    } catch (err) {
      handlerError = (err as Error).message
    }
    check(
      'the production translate:start survives a synchronous refusal',
      handlerError === null,
      handlerError ?? ''
    )
    // Without this the check above could pass vacuously: if the model guard rejected first,
    // the handler would return '' having never reached the refusal that fires `onDone`.
    check(
      'and it really did reach that refusal, rather than stopping at the model guard',
      typeof handlerResult === 'string' && handlerResult !== '',
      `returned ${JSON.stringify(handlerResult)}`
    )
    check('the refused translate did not take the slot', isRunning())

    stopCurrent()
    await pending
    await new Promise((r) => setTimeout(r, 250))

    check('Stop during preparation ends the job', done.length === 1, `${done.length} terminal events`)
    check('it does not report success', done[0] !== 0, `code ${done[0]}`)
    check('no transcript is produced after a Stop', !fs.existsSync(outPath))
    check('the slot is released', !isRunning())
    check(
      'the temporary MP3 is not left behind',
      fs.readdirSync(tempDir).filter((f) => f.endsWith('.mp3')).length === mp3sBefore
    )
    check(
      'the user is told why it stopped',
      stderrLines.some((l) => /stopped/i.test(l)),
      stderrLines.join(' | ')
    )
  }

  console.log(`\n${passes} passed, ${failures} failed${skipped ? `, ${skipped} skipped` : ''}`)
  if (failures) {
    console.log('\nFailed checks:')
    for (const f of failed) console.log(`  - ${f}`)
    console.log(`\nArtifacts kept for inspection: ${work}`)
    process.exit(1)
  }
  console.log(
    skipped
      ? `\nALL RUNNABLE PROBES PASSED (${skipped} skipped — see the SKIP lines above for why)`
      : '\nALL LIVE PROBES PASSED'
  )
  console.log(`Artifacts: ${work}`)
  console.log('Remember to revoke the verification key when you are done.')
}

void main()
