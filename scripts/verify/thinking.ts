/**
 * REP-1 claim 3 probe — does the thoughts log ever get content, and at which setting?
 *
 * Investigation tooling, not a product change. It exists because a user reported an empty
 * thoughts log and the static answer ("Google returned no thoughts") is a claim about a
 * remote service that only a real call can settle.
 *
 * It builds its command line with the app's OWN `buildTranslateArgs`, so what is measured is
 * what the app sends — a probe that assembled its own argv would prove nothing about the
 * shipped product. Everything else mirrors `live.ts`: same key file, same spawn environment,
 * same masking discipline.
 *
 * COST: one small API call per scenario, on a 12-cue fixture.
 */
import { spawn, __setSpawnScenario, __setSpawnSecret } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { buildTranslateArgs, isRunning } from '../../electron/main/pythonBridge'
import { envWithFfmpeg } from '../../electron/main/ffmpeg'
import { setSettings } from '../../electron/main/store'
import { registerIpc } from '../../electron/main/ipc'
import { __invokeIpc } from '../gates/stubs/electron'
import type { TranslateArgs } from '../../electron/shared/types'

const ROOT = process.cwd()
const GST = path.join(ROOT, 'resources', 'bin', process.platform === 'win32' ? 'gst.exe' : 'gst')
const KEY_FILE = path.join(ROOT, '.secrets', 'gemini-key.txt')
const SOURCE_SRT = path.join(ROOT, '.secrets', 'SRT', 'Fleabag', 'Fleabag.S01E01.eng.srt')
const TIMEOUT_MS = 300_000
const CUES = 12

let secret = ''
const mask = (t: string): string => (secret ? t.split(secret).join('***KEY***') : t)

/**
 * The probe's evidence trail. Written to stderr so the findings stay with the run that
 * produced them and survive redirection of stdout; nothing here leaves the machine.
 */
function debugLog(
  hypothesisId: string,
  location: string,
  message: string,
  data: Record<string, unknown>
): void {
  console.error(`[probe ${hypothesisId}] ${location} — ${message}`)
  console.error(`  ${mask(JSON.stringify(data))}`)
}

function loadKey(): string {
  const fromEnv = process.env.GEMINI_API_KEY?.trim()
  if (fromEnv) return fromEnv
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

/** First N cues of a real subtitle — real dialogue is likelier to provoke reasoning than a toy fixture. */
function fixture(): string {
  const raw = fs.readFileSync(SOURCE_SRT, 'utf8').replace(/^\uFEFF/, '')
  const blocks = raw.split(/\r?\n\r?\n/).filter((b) => b.trim())
  return blocks.slice(0, CUES).join('\n\n') + '\n'
}

interface RunResult {
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
}

function spawnGst(args: string[]): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(GST, args, {
      windowsHide: true,
      env: envWithFfmpeg(undefined, {
        PYTHONUNBUFFERED: '1',
        PYTHONUTF8: '1',
        PYTHONIOENCODING: 'utf-8'
      })
    })
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

interface Scenario {
  id: string
  hypothesis: string
  label: string
  model: string
  thinkingLevel: string
  disableStreaming: boolean
}

const SCENARIOS: Scenario[] = [
  {
    id: 'A',
    hypothesis: 'H1',
    label: 'control — level low, streaming (the reported configuration)',
    model: 'gemini-3.5-flash-lite',
    thinkingLevel: 'low',
    disableStreaming: false
  },
  {
    id: 'B',
    hypothesis: 'H1/H2/H3',
    label: 'level high, streaming',
    model: 'gemini-3.5-flash-lite',
    thinkingLevel: 'high',
    disableStreaming: false
  },
  {
    id: 'C',
    hypothesis: 'H4',
    label: 'level high, streaming DISABLED — isolates the engine streaming flush',
    model: 'gemini-3.5-flash-lite',
    thinkingLevel: 'high',
    disableStreaming: true
  },
  {
    id: 'D',
    hypothesis: 'H5',
    label: 'level high, streaming, full Flash instead of Flash-Lite',
    model: 'gemini-3.5-flash',
    thinkingLevel: 'high',
    disableStreaming: false
  }
]

/**
 * Scenario E — the same question asked through the REAL `translate:start` handler.
 *
 * Scenarios A-D prove what the engine does with a given argv. This proves the layer above:
 * that the three log toggles come from SETTINGS (the args deliberately say `false`, so a
 * sidecar appearing can only have come from the settings override in `ipc.ts`), that the
 * thinking level survives the handler, and that the sidecars land where the save handler
 * later looks for them. The only link left uncovered after this is the React line that
 * copies `settings.thinkingLevel` into the args.
 */
async function ipcScenario(
  work: string,
  body: string,
  summary: Array<Record<string, unknown>>
): Promise<void> {
  const dir = path.join(work, 'E')
  fs.mkdirSync(dir)
  const input = path.join(dir, 'fixture.srt')
  fs.writeFileSync(input, body, 'utf8')

  setSettings({ writeTokenReport: true, progressLog: true, thoughtsLog: true })
  registerIpc()
  __setSpawnScenario('E')

  const startedAt = Date.now()
  const args: TranslateArgs = {
    inputFile: input,
    sourceLang: 'en',
    targetLang: 'he',
    model: 'gemini-3.5-flash-lite',
    apiKeys: [secret],
    batchSize: 100,
    batchContext: true,
    customGenerationParams: false,
    temperature: 1,
    topP: 0.95,
    topK: null,
    thinkingLevel: 'high',
    thinkingBudget: 512,
    serviceTier: 'standard',
    paidQuota: false,
    disableStreaming: false,
    // Deliberately false: if sidecars appear anyway, they came from Settings.
    writeTokenReport: false,
    progressLog: false,
    thoughtsLog: false
  }

  console.log('=== E — through the real translate:start IPC handler (toggles from Settings) ===')
  const outputPath = String(__invokeIpc('translate:start', args) ?? '')
  const tokensPath = outputPath.replace(/\.[^.]+$/, '.tokens.json')

  const deadline = Date.now() + TIMEOUT_MS
  while (isRunning() && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500))
  }

  const tempDir = outputPath ? path.dirname(outputPath) : ''
  const freshSidecars = (suffix: string): string[] =>
    [tempDir, dir]
      .filter((d) => d && fs.existsSync(d))
      .flatMap((d) =>
        fs
          .readdirSync(d)
          .filter((f) => f.endsWith(suffix))
          .map((f) => path.join(d, f))
      )
      .filter((p) => fs.statSync(p).mtimeMs >= startedAt)

  const readIf = (p: string): string => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '')
  const thoughtsFiles = freshSidecars('.thoughts.log')
  const progressFiles = freshSidecars('.progress.log')
  const thoughtsRaw = thoughtsFiles.map(readIf).join('')
  const thoughtsContent = thoughtsRaw
    .split(/\r?\n/)
    .filter((l) => l.trim() && !/^=+$/.test(l.trim()) && !/^Batch \d+(\.\d+)? thoughts:/.test(l.trim()))
    .join('\n')

  let thoughtsTokens: number | null = null
  try {
    thoughtsTokens = JSON.parse(readIf(tokensPath))?.tokens?.thoughts ?? null
  } catch {
    /* absent or unparseable — recorded as null */
  }

  const row = {
    scenario: 'E',
    label: 'via IPC handler, toggles from Settings, level high',
    exit: readIf(outputPath).length > 0 ? 0 : -1,
    timedOut: isRunning(),
    model: 'gemini-3.5-flash-lite',
    thoughtsTokens,
    thoughtsFileBytes: thoughtsRaw.length,
    thoughtsContentChars: thoughtsContent.length,
    outputWritten: readIf(outputPath).length > 0,
    progressFileBytes: progressFiles.map(readIf).join('').length
  }
  summary.push(row)

  console.log(
    `  tokenReport=${fs.existsSync(tokensPath) ? 'written' : 'MISSING'} ` +
      `thoughtsFiles=${thoughtsFiles.length} progressFiles=${progressFiles.length} ` +
      `thinkingTokens=${thoughtsTokens} content=${thoughtsContent.length} chars`
  )
  debugLog('H6', 'scripts/verify/thinking.ts:ipc', 'settings-driven run through translate:start', {
    ...row,
    tokenReportWritten: fs.existsSync(tokensPath),
    thoughtsFileCount: thoughtsFiles.length,
    progressFileCount: progressFiles.length,
    argsToggledOff: true
  })
  console.log('')
}

/**
 * Scenario F — is the sporadic zero caused by repeating an identical prompt?
 *
 * Scenario E returned 0 thinking tokens once and 1746 the next time on an identical command,
 * so `high` does not guarantee thinking. Every scenario until now sent the SAME 12-cue
 * fixture, which is exactly the shape Gemini's implicit caching targets — and a cache hit
 * would plausibly skip the thinking stage.
 *
 * This sends a fixture that has never been submitted before, then repeats it byte-for-byte.
 * Thoughts on the first run and none on a repeat implicates repetition; thoughts every time
 * means the earlier zero was ordinary model nondeterminism.
 */
async function repeatScenario(
  work: string,
  summary: Array<Record<string, unknown>>
): Promise<void> {
  const source = path.join(ROOT, '.secrets', 'SRT', 'Marriage Story', 'Marriage.Story.eng.srt')
  if (!fs.existsSync(source)) {
    console.log(`=== F — SKIPPED, no fresh fixture at ${source} ===\n`)
    return
  }
  const raw = fs.readFileSync(source, 'utf8').replace(/^\uFEFF/, '')
  const body = raw.split(/\r?\n\r?\n/).filter((b) => b.trim()).slice(0, CUES).join('\n\n') + '\n'

  console.log('=== F — identical prompt sent three times, level high ===')
  for (let attempt = 1; attempt <= 3; attempt++) {
    const id = `F${attempt}`
    const dir = path.join(work, id)
    fs.mkdirSync(dir)
    const input = path.join(dir, 'fixture.srt')
    const output = path.join(dir, 'fixture_he.srt')
    fs.writeFileSync(input, body, 'utf8')

    __setSpawnScenario(id)
    const argv = buildTranslateArgs(
      {
        inputFile: input,
        sourceLang: 'en',
        targetLang: 'he',
        model: 'gemini-3.5-flash-lite',
        apiKeys: [secret],
        batchSize: 100,
        batchContext: true,
        customGenerationParams: false,
        temperature: 1,
        topP: 0.95,
        topK: null,
        thinkingLevel: 'high',
        thinkingBudget: 512,
        serviceTier: 'standard',
        paidQuota: false,
        disableStreaming: false,
        writeTokenReport: true,
        progressLog: true,
        thoughtsLog: true
      },
      output
    )
    const res = await spawnGst(argv)

    const readIf = (p: string): string => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '')
    const tokensRaw = readIf(output.replace(/\.[^.]+$/, '.tokens.json'))
    const thoughtsRaw = readIf(`${input.replace(/\.[^.]+$/, '')}.thoughts.log`)
    const thoughtsContent = thoughtsRaw
      .split(/\r?\n/)
      .filter((l) => l.trim() && !/^=+$/.test(l.trim()) && !/^Batch \d+(\.\d+)? thoughts:/.test(l.trim()))
      .join('\n')

    let thoughtsTokens: number | null = null
    let promptTokens: number | null = null
    try {
      const parsed = JSON.parse(tokensRaw)
      thoughtsTokens = parsed?.tokens?.thoughts ?? null
      promptTokens = parsed?.tokens?.prompt ?? null
    } catch {
      /* absent or unparseable */
    }

    const row = {
      scenario: id,
      label: `identical prompt, attempt ${attempt} of 3`,
      exit: res.code,
      timedOut: res.timedOut,
      model: 'gemini-3.5-flash-lite',
      thoughtsTokens,
      thoughtsFileBytes: thoughtsRaw.length,
      thoughtsContentChars: thoughtsContent.length,
      outputWritten: readIf(output).length > 0,
      progressFileBytes: readIf(`${input.replace(/\.[^.]+$/, '')}.progress.log`).length
    }
    summary.push(row)
    console.log(
      `  attempt ${attempt}: promptTokens=${promptTokens} thinkingTokens=${thoughtsTokens} ` +
        `content=${thoughtsContent.length} chars`
    )
    debugLog('H7', 'scripts/verify/thinking.ts:repeat', 'identical-prompt repeat', {
      ...row,
      attempt,
      promptTokens
    })  }
  console.log('')
}

async function main(): Promise<void> {
  secret = loadKey()
  __setSpawnSecret(secret)
  setSettings({ apiKeys: [secret], apiKeyValid: [true], apiKeyTiers: ['free'] })

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'srt-thinking-'))
  const body = fixture()
  console.log(`\nFixture: ${CUES} cues from ${path.basename(SOURCE_SRT)}`)
  console.log(`Work dir: ${work}\n`)

  // Each scenario spends real quota, so allow re-running just one: SRT_THINKING_ONLY=E
  const only = process.env.SRT_THINKING_ONLY?.split(',')
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean)
  const wanted = (id: string): boolean => !only?.length || only.includes(id)

  const summary: Array<Record<string, unknown>> = []

  for (const s of SCENARIOS.filter((s) => wanted(s.id))) {
    const dir = path.join(work, s.id)
    fs.mkdirSync(dir)
    const input = path.join(dir, 'fixture.srt')
    const output = path.join(dir, 'fixture_he.srt')
    fs.writeFileSync(input, body, 'utf8')

    const args: TranslateArgs = {
      inputFile: input,
      sourceLang: 'en',
      targetLang: 'he',
      model: s.model,
      apiKeys: [secret],
      batchSize: 100,
      batchContext: true,
      customGenerationParams: false,
      temperature: 1,
      topP: 0.95,
      topK: null,
      thinkingLevel: s.thinkingLevel,
      thinkingBudget: 512,
      serviceTier: 'standard',
      paidQuota: false,
      disableStreaming: s.disableStreaming,
      writeTokenReport: true,
      progressLog: true,
      thoughtsLog: true
    }

    __setSpawnScenario(s.id)
    const argv = buildTranslateArgs(args, output)
    console.log(`=== ${s.id} — ${s.label} ===`)
    console.log(`  argv: ${mask(argv.join(' '))}`)
    debugLog(s.hypothesis, 'scripts/verify/thinking.ts:argv', 'argv built by the app', {
      scenario: s.id,
      model: s.model,
      thinkingLevel: s.thinkingLevel,
      disableStreaming: s.disableStreaming,
      thinkingFlags: argv.filter(
        (a, i) =>
          a.startsWith('--thinking') ||
          a === '--no-thinking' ||
          a === '--no-streaming' ||
          (i > 0 && argv[i - 1].startsWith('--thinking'))
      ),
      argv: mask(argv.join(' '))
    })
    const res = await spawnGst(argv)

    const tokensPath = output.replace(/\.[^.]+$/, '.tokens.json')
    const inBase = input.replace(/\.[^.]+$/, '')
    const thoughtsPath = `${inBase}.thoughts.log`
    const progressPath = `${inBase}.progress.log`

    const readIf = (p: string): string => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '')
    const tokensRaw = readIf(tokensPath)
    const thoughtsRaw = readIf(thoughtsPath)
    const outputRaw = readIf(output)

    let thoughtsTokens: number | null = null
    let reportedModel = ''
    try {
      const parsed = JSON.parse(tokensRaw)
      thoughtsTokens = parsed?.tokens?.thoughts ?? null
      reportedModel = parsed?.model ?? ''
    } catch {
      /* absent or unparseable — recorded as null below */
    }

    // Content = anything that is not a separator line or a "Batch N thoughts:" header.
    const thoughtsContent = thoughtsRaw
      .split(/\r?\n/)
      .filter((l) => l.trim() && !/^=+$/.test(l.trim()) && !/^Batch \d+(\.\d+)? thoughts:/.test(l.trim()))
      .join('\n')

    const row = {
      scenario: s.id,
      label: s.label,
      exit: res.code,
      timedOut: res.timedOut,
      model: reportedModel || s.model,
      thoughtsTokens,
      thoughtsFileBytes: thoughtsRaw.length,
      thoughtsContentChars: thoughtsContent.length,
      outputWritten: outputRaw.length > 0,
      progressFileBytes: readIf(progressPath).length
    }
    summary.push(row)

    console.log(
      `  exit=${res.code} thinkingTokens=${thoughtsTokens} ` +
        `thoughtsFile=${thoughtsRaw.length}B content=${thoughtsContent.length} chars ` +
        `output=${outputRaw.length > 0 ? 'written' : 'MISSING'}`
    )
    if (thoughtsContent.length) {
      console.log(`  first thought line: ${mask(thoughtsContent.split('\n')[0]).slice(0, 160)}`)
    }
    if (res.code !== 0) {
      console.log(`  stderr tail: ${mask(res.stderr).split('\n').slice(-6).join(' | ')}`)
    }
    debugLog(s.hypothesis, 'scripts/verify/thinking.ts:result', 'run artifacts', {
      ...row,
      firstThoughtLine: thoughtsContent ? mask(thoughtsContent.split('\n')[0]).slice(0, 200) : '',
      stderrTail: res.code === 0 ? '' : mask(res.stderr).split('\n').slice(-4).join(' | ')
    })
    console.log('')
  }

  if (wanted('E')) await ipcScenario(work, body, summary)
  if (wanted('F')) await repeatScenario(work, summary)

  console.log('=== summary ===')
  console.table(summary)
  debugLog('H1/H2/H3/H4/H5', 'scripts/verify/thinking.ts:summary', 'all scenarios complete', {
    summary
  })
  console.log(`\nArtifacts kept in: ${work}\n`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
