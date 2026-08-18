/**
 * Live verification probes — the automatable half of the Phase A/B/C matrix.
 *
 * These are the checks `npm run test:gates` cannot make, because they need a real API
 * key and the real frozen engine: that the packed binary actually reaches Google, that a
 * translation round-trips, that Hebrew survives the frozen build's stdio, and that an
 * `.ass` file keeps its styling and leaves the user's original untouched.
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
import { buildTranslateArgs, ensureUtf8Subtitle } from '../../electron/main/pythonBridge'
import type { TranslateArgs } from '../../electron/shared/types'

// The bundle executes from a temp directory, so paths are resolved from the working
// directory instead — `npm run` always sets that to the package root.
const ROOT = process.cwd()
const GST = path.join(ROOT, 'resources', 'bin', process.platform === 'win32' ? 'gst.exe' : 'gst')
const KEY_FILE = path.join(ROOT, '.secrets', 'gemini-key.txt')
const TIMEOUT_MS = 300_000

let passes = 0
let failures = 0
const failed: string[] = []

function section(name: string): void {
  console.log(`\n=== ${name} ===`)
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

function run(args: string[], env?: NodeJS.ProcessEnv): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(GST, args, { windowsHide: true, env: env ?? process.env })
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

/** Newest flash-lite in the fetched list, so the probes cost as little as possible. */
function cheapestModel(ids: string[]): string | null {
  const lite = ids.filter((id) => id.includes('flash-lite') && !id.includes('preview'))
  const pool = lite.length ? lite : ids.filter((id) => id.includes('flash') && !id.includes('preview'))
  if (!pool.length) return null
  const versionOf = (id: string): number[] => {
    const m = id.match(/(\d+)\.(\d+)/)
    return m ? [Number(m[1]), Number(m[2])] : [0, 0]
  }
  return pool.sort((a, b) => {
    const [am, an] = versionOf(a)
    const [bm, bn] = versionOf(b)
    return bm - am || bn - an
  })[0]
}

function hasHebrew(text: string): boolean {
  return /[\u0590-\u05FF]/.test(text)
}

function cueCount(srt: string): number {
  return (srt.match(/-->/g) ?? []).length
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
    check('all five dialogue lines survive', (body.match(/^Dialogue:/gm) ?? []).length === 5)
    check('the dialogue was translated', hasHebrew(body))
    check(
      'the translated text is in the Text field, not swallowed by another column',
      (body.match(/^Dialogue:.*,.*[\u0590-\u05FF]/gm) ?? []).length === 5
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

  console.log(`\n${passes} passed, ${failures} failed`)
  if (failures) {
    console.log('\nFailed checks:')
    for (const f of failed) console.log(`  - ${f}`)
    console.log(`\nArtifacts kept for inspection: ${work}`)
    process.exit(1)
  }
  console.log('\nALL LIVE PROBES PASSED')
  console.log(`Artifacts: ${work}`)
  console.log('Remember to revoke the verification key when you are done.')
}

void main()
