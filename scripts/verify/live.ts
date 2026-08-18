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
  ensureUtf8Subtitle
} from '../../electron/main/pythonBridge'
import { envWithFfmpeg, extractTrack, probeTracks } from '../../electron/main/ffmpeg'
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
  const line = fs
    .readFileSync(KEY_FILE, 'utf8')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l && !l.startsWith('#'))
  if (!line) {
    console.error(`\n${KEY_FILE} contains no key line.\n`)
    process.exit(1)
  }
  return line
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

function run(args: string[], env?: NodeJS.ProcessEnv): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(GST, args, { windowsHide: true, env: env ?? appEnv() })
    let stdout = ''
    let stderr = ''
    let timedOut = false
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
  return buildTranslateArgs(base, outputPath)
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
  console.log('Key:       loaded (never printed)')
  console.log(
    `ffmpeg:    ${FFMPEG_PATH ?? 'bundled/default (set SRT_VERIFY_FFMPEG_PATH to verify an override)'}`
  )

  // ── B1 / C19 — the frozen binary reaches Google and the model list is honest ──
  section('L1 — list-models against a real key (B1, C19)')
  const list = await run(['list-models', '-k', secret, '--skip-upgrade'])
  const listOut = mask(list.stdout + list.stderr)
  const ids = Array.from(listOut.matchAll(/\b(gemini-[a-z0-9.\-]+)/gi)).map((m) => m[1])
  const unique = Array.from(new Set(ids))

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

  const model = cheapestModel(unique)
  if (!model) {
    console.error('\nNo usable model returned; cannot run the translation probes.\n')
    process.exit(1)
  }
  console.log(`        Using ${model} for the translation probes`)

  // Selection self-checks. These settle the cases a normal account never exercises — a key
  // with a capable pro model but no capable flash — without waiting for such a key to exist.
  const capable = (id: string): boolean => modelCapabilities(id).supportsTranscription
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
  const noFfmpeg = await run(['list-models', '-k', secret, '--skip-upgrade'], strippedEnv)
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
    const source = media[0]
    const label = path.basename(source)
    if (txModel !== model) {
      console.log(`        Using ${txModel} — the cheapest transcription-capable model this key exposes`)
    }
    const outTx = path.join(work, 'transcribed.srt')
    const txArgs = buildTranscribeArgs(
      {
        mediaFile: source,
        outputFile: outTx,
        targetLang: 'en',
        model: txModel,
        apiKeys: [secret],
        thinkingLevel: 'low',
        thinkingBudget: 512,
        customGenerationParams: false,
        temperature: 1,
        topP: 0.95,
        topK: null
      } satisfies TranscribeArgs,
      outTx
    )
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

  console.log(`\n${passes} passed, ${failures} failed${skipped ? `, ${skipped} skipped` : ''}`)
  if (failures) {
    console.log('\nFailed checks:')
    for (const f of failed) console.log(`  - ${f}`)
    console.log(`\nArtifacts kept for inspection: ${work}`)
    process.exit(1)
  }
  console.log(
    skipped
      ? `\nALL RUNNABLE PROBES PASSED (${skipped} skipped — drop fixtures in ${FIXTURE_DIR} to run stage 2)`
      : '\nALL LIVE PROBES PASSED'
  )
  console.log(`Artifacts: ${work}`)
  console.log('Remember to revoke the verification key when you are done.')
}

void main()
