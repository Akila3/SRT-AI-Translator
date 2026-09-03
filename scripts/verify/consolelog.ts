/**
 * FP-8 — is the run's console actually on disk, complete, capped, and closed?
 *
 * The gates prove the policy: where the file is named, how the cut is made, that the four
 * sidecars land on four different names. None of them can prove the thing the feature IS — that
 * a real job, through the real lifecycle, leaves a real file behind. The seams that could break
 * it are all in the lifecycle rather than in the policy: the tee sits on the handlers the job
 * carries, the close sits in `finish()`, and `finish()` is reached from a spawn that threw, an
 * engine that exited, and a Stop that killed a process tree.
 *
 * FIDELITY. Everything below runs through the shipped `startTranslate` / `startTranscribe` /
 * `stopCurrent`. Only the process on the far end of the pipe is scripted, because the engine's
 * output is the input to this feature and a real engine cannot be asked for ten megabytes, or
 * for a failure at a chosen moment, without a key and a lot of quota.
 *
 * COST. No API key, no network, no quota, no ffmpeg. About ten seconds, most of it the flood.
 *
 * Run with `node scripts/verify/run-consolelog.mjs`. Exits non-zero on failure.
 */
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  isRunning,
  startTranscribe,
  startTranslate,
  stopCurrent,
  type SpawnHandlers
} from '../../electron/main/pythonBridge'
import {
  CONSOLE_LOG_TRUNCATION_MARK,
  DEFAULT_CONSOLE_LOG_LIMITS,
  consoleLogPathFor,
  findConsoleLog
} from '../../electron/shared/consoleLog'
import {
  FAKE_PID,
  __failNextKill,
  __killArgv,
  __useEnginePid,
  __useScriptedEngine,
  type ScriptedEngine
} from './stubs/engine_child_process'
// The real one, deliberately: only `child_process` is aliased to the stub, so a scenario that needs
// a process the operating system will actually confirm can still start one.
import { spawn as realSpawn } from 'node:child_process'
import type { TranscribeArgs, TranslateArgs } from '../../electron/shared/types'

const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'srt-consolelog-probe-'))

/**
 * Everything this probe left outside its own working directory.
 *
 * Translation writes to `tempOutputPath()`, which is the OS temp directory rather than anywhere
 * the probe chose — that is the product's behaviour and the probe must not alter it — so the
 * flood scenario alone deposits nearly nine megabytes there per run. Deleting a temp file the
 * probe caused is not the same as deleting one a user's run caused, which is why this list is
 * built from what each scenario is handed back and not from a glob.
 */
const LITTER: string[] = []

/**
 * The real processes S9 needs, so that teardown owns them rather than their own timers.
 *
 * They exist to be un-killable *to the app*, which means a scenario that fails part-way through
 * would otherwise leave them running for as long as their timer says. A probe should not be able
 * to litter the machine with processes on its way to reporting a failure.
 */
const SURVIVORS: { kill(): void }[] = []

/**
 * Shaped like a real key, and never valid.
 *
 * It is here because this phase creates a NEW artefact that leaves the machine — the whole
 * point of the file is that a user can send it — and the command line is the one line in a run
 * that has ever held a credential. `run()` emits only the masked rendering and the tee copies
 * what `run()` emits, so asserting on the file asserts on the entire chain.
 *
 * Split for the same reason as `BAD_KEY` in `badkey.ts`: a whole key-shaped literal trips GitHub's
 * secret scanner. The runtime value is unchanged.
 */
const KEY = 'AIza' + 'SyB0000000000000000000000000000000x'

let failures = 0
let passes = 0

/**
 * An error nobody listened for is how a main process dies without saying anything.
 *
 * Node raises an unhandled `'error'` on a child as an uncaught exception, so a spawn the app
 * starts and forgets does not merely go unnoticed — it takes the whole application down. Without
 * this the probe would die mid-run with a stack trace that looks like a harness problem. With it,
 * the same event is a named failure pointing at the child that was dropped.
 */
process.on('uncaughtException', (e) => {
  failures++
  console.log(`  FAIL  the app let an error escape — this kills the real main process — ${e.message}`)
  cleanUp()
  console.log(`\n${passes} passed, ${failures} failed\n\nCONSOLE LOG PROBE FAILED`)
  process.exit(1)
})

function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    passes++
    console.log(`  PASS  ${name}`)
  } else {
    failures++
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

function section(name: string): void {
  console.log(`\n=== ${name} ===`)
}

/** A minimal, valid, UTF-8 subtitle: `startTranslate` normalises and reads the real file. */
function makeSubtitle(name: string): string {
  const p = path.join(WORK, name)
  fs.writeFileSync(p, '1\n00:00:01,000 --> 00:00:02,000\nHello\n\n', 'utf-8')
  return p
}

function translateArgs(input: string): TranslateArgs {
  return {
    inputFile: input,
    targetLang: 'he',
    model: 'gemini-2.5-flash',
    apiKeys: [KEY],
    batchSize: 30,
    streaming: true,
    thinking: false
  } as TranslateArgs
}

function transcribeArgs(media: string, out: string): TranscribeArgs {
  return {
    mediaFile: media,
    outputFile: out,
    targetLang: 'en',
    model: 'gemini-2.5-flash',
    apiKeys: [KEY],
    streaming: true,
    thinking: false
  } as TranscribeArgs
}

interface Ending {
  code: number | null
  outputPath: string
  reason?: string
  logPaths?: string[]
}

/**
 * Collect one run's terminal event, so each scenario can await its own ending.
 *
 * It counts as well as collects. Several paths now reach `finish()` for the same job — a close, a
 * kill, a stall, and (since FP8-01) a process error that may be followed by a close — and a page
 * that receives two endings is as broken as one that receives none: the second arrives after the
 * user has moved on. A promise cannot see the difference, so the count is kept separately.
 */
function ending(): { handlers: SpawnHandlers; done: Promise<Ending>; endings: () => number } {
  let settle: (e: Ending) => void = () => {}
  let calls = 0
  const done = new Promise<Ending>((r) => (settle = r))
  return {
    handlers: {
      onOutput: () => {},
      onDone: (code, outputPath, reason, logPaths) => {
        calls++
        settle({ code, outputPath, reason, logPaths })
      }
    },
    done,
    endings: () => calls
  }
}

/** Give any late, duplicate terminal event time to arrive before the count is believed. */
const settleFor = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * Wait for a run to end — and fail loudly if it never does.
 *
 * A stranded job is otherwise INVISIBLE here. Nothing is left pending when a run is lost, so Node
 * drains its event loop and exits 0 part-way through a scenario, and a probe that stopped early
 * reads almost exactly like a probe that passed. This timer is the only thing keeping the process
 * alive long enough to say what happened.
 *
 * It gives up on the whole probe rather than the scenario, because there is one job slot: a run
 * that never ended holds it, so everything after this point would be refused for reasons that
 * have nothing to do with what it was testing.
 */
async function endsWithin(done: Promise<Ending>, ms: number, label: string): Promise<Ending> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const expired = new Promise<null>((r) => {
    timer = setTimeout(() => r(null), ms)
  })
  const result = await Promise.race([done, expired])
  clearTimeout(timer)
  if (result === null) {
    check(label, false, `no terminal event within ${ms}ms — the job slot is stranded`)
    cleanUp()
    console.log(`\n${passes} passed, ${failures} failed\n\nCONSOLE LOG PROBE FAILED`)
    process.exit(1)
  }
  return result
}

/** Everything this probe brought into the world, on every way out of it. */
function cleanUp(): void {
  for (const p of SURVIVORS) {
    try {
      p.kill()
    } catch {
      /* already gone */
    }
  }
  for (const file of [WORK, ...LITTER]) {
    try {
      fs.rmSync(file, { recursive: true, force: true })
    } catch {
      /* the OS reclaims its own temp directory either way */
    }
  }
}

async function main(): Promise<void> {
  // ── S1: a completed translation ───────────────────────────────────────────────
  section('S1 — a finished run leaves its whole console behind')
  {
    // Emitted five times on purpose. The panel collapses a repeated block into one row with a
    // counter, which is what stopped the freeze and is also what makes the panel unfit to
    // export: the file has to carry what actually happened.
    const REPEAT = 'Retrying immediately...'
    __useScriptedEngine((e: ScriptedEngine) => {
      e.stdout.write('Translating batch 1/3...\n')
      for (let i = 0; i < 5; i++) e.stdout.write(`${REPEAT}\n`)
      e.stdout.write('Translating batch 2/3...\n')
      e.stderr.write('a warning the engine printed to stderr\n')
      // No trailing newline: `run()` holds this in its partial-line buffer and flushes it when
      // the process closes, so it is also a test that the tee sees that flush.
      e.stdout.write('Translation completed')
      e.end(0)
    })

    const { handlers, done } = ending()
    const started = startTranslate(translateArgs(makeSubtitle('s1.srt')), handlers)
    const end = await endsWithin(done, 60_000, 'S1 the run reached an ending')
    LITTER.push(started.outputPath, ...(end.logPaths ?? []))

    const logPath = findConsoleLog(end.logPaths)
    check('S1 the ending reports a console log', logPath !== '', JSON.stringify(end.logPaths))
    check('S1 named after the run\u2019s output', logPath === consoleLogPathFor(started.outputPath))
    check('S1 the file exists', logPath !== '' && fs.existsSync(logPath))

    const text = logPath && fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf-8') : ''
    check('S1 it holds the command line', text.includes('$ ') && text.includes('translate -i '))
    // In full, not summarised: what a run actually was is the first question asked of any log.
    check('S1 with every flag visible', text.includes('-m gemini-2.5-flash') && text.includes('--no-resume'))
    check('S1 the key was passed to the engine', text.includes(' -k '))
    // The assertion this probe exists to carry for MAN-7: an exported file must not be a way
    // to hand someone a credential.
    check('S1 and it is not in the file', !text.includes(KEY), 'THE API KEY LEAKED INTO THE EXPORT')
    check('S1 it holds the app\u2019s own notices', text.includes('Starting engine…'))
    check('S1 it holds stdout', text.includes('Translating batch 1/3...'))
    check('S1 and stderr, in the same file', text.includes('a warning the engine printed to stderr'))
    check('S1 including the last line, which had no newline', text.includes('Translation completed'))
    // Acceptance 1 used to require the file to keep every redraw. REP-26 counts consecutive
    // identical lines instead; the distinct retry line must still be there, once.
    check('S1 a repeated line is still present', text.includes(REPEAT))
    check(
      'S1 consecutive redraws are counted, not duplicated',
      text.split(REPEAT).length - 1 === 1 && text.includes('[redrawn 4 times]'),
      `${text.split(REPEAT).length - 1} occurrences`
    )
    check('S1 and how the run ended is recorded', text.includes('[run ended: exit code 0]'))
    check('S1 the job slot is released', !isRunning())
  }

  // ── S10: multi-line engine frame after the real app preamble (SOL-57) ─────────
  section('S10 — a multi-line redraw after the app preamble is folded, not duplicated')
  {
    const frame = Array.from({ length: 11 }, (_, i) => `engine message ${i + 1}`)
    __useScriptedEngine((e: ScriptedEngine) => {
      for (let i = 0; i < 20; i++) {
        for (const l of frame) e.stdout.write(`${l}\n`)
      }
      e.end(0)
    })

    const { handlers, done } = ending()
    const started = startTranslate(translateArgs(makeSubtitle('s10.srt')), handlers)
    const end = await endsWithin(done, 60_000, 'S10 the run reached an ending')
    LITTER.push(started.outputPath, ...(end.logPaths ?? []))

    const logPath = findConsoleLog(end.logPaths)
    const text = logPath && fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf-8') : ''
    check('S10 the command line is in the file', text.includes('$ ') && text.includes('translate -i '))
    check('S10 and Starting engine is in the file', text.includes('Starting engine…'))
    check(
      'S10 each frame line lands once',
      text.split('engine message 1\n').length - 1 === 1,
      `${text.split('engine message 1\n').length - 1} copies`
    )
    check('S10 the other 19 draws are a counter', text.includes('[redrawn 19 times]'))
    check('S10 the ending is recorded', text.includes('[run ended: exit code 0]'))
    check('S10 the job slot is released', !isRunning())
  }

  // ── S2: transcription, which has no Save step ─────────────────────────────────
  section('S2 — a transcription\u2019s console lands beside the output it chose')
  {
    const out = path.join(WORK, 'episode.srt')
    __useScriptedEngine((e: ScriptedEngine) => {
      e.stdout.write('Transcribing...\n')
      e.end(0)
    })

    const { handlers, done } = ending()
    // `.mp3` so no conversion is attempted; no preflight, so no key is asked for.
    await startTranscribe(transcribeArgs(path.join(WORK, 'episode.mp3'), out), handlers)
    const end = await endsWithin(done, 60_000, 'S2 the run reached an ending')

    const logPath = findConsoleLog(end.logPaths)
    // Acceptance 2: beside the pre-chosen output, with no save dialog anywhere in the path.
    check('S2 it is beside the chosen output', logPath === path.join(WORK, 'episode.console.log'), logPath)
    check('S2 the file is there', logPath !== '' && fs.existsSync(logPath))
    check('S2 not in a temp directory of ours', !logPath.includes('srt-out'))
    const text = logPath && fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf-8') : ''
    check('S2 and it holds the run', text.includes('Transcribing...') && text.includes('[run ended: exit code 0]'))
    // The transcription argv is built by a different function, so it earns its own check.
    check('S2 with the key masked here too', text.includes(' -k ') && !text.includes(KEY))
  }

  // ── S3: a run the user stopped ────────────────────────────────────────────────
  section('S3 — a stopped run still leaves a readable, closed log')
  {
    let engine: ScriptedEngine | null = null
    __useScriptedEngine((e: ScriptedEngine) => {
      engine = e
      e.stdout.write('Translating batch 1/40...\n')
    })

    const { handlers, done } = ending()
    LITTER.push(startTranslate(translateArgs(makeSubtitle('s3.srt')), handlers).outputPath)
    // Let the scripted engine start and its first line arrive before stopping.
    await new Promise((r) => setTimeout(r, 50))
    check('S3 the run is running', isRunning() && engine !== null)

    stopCurrent()
    const end = await endsWithin(done, 60_000, 'S3 the run reached an ending')

    check('S3 it ended as a user stop', end.reason === 'user', String(end.reason))
    check('S3 by killing the process tree', __killArgv()?.includes(String(FAKE_PID)) === true, JSON.stringify(__killArgv()))

    const logPath = findConsoleLog(end.logPaths)
    check('S3 a stopped run still reports its log', logPath !== '')
    const text = logPath && fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf-8') : ''
    check('S3 which holds what the run managed to say', text.includes('Translating batch 1/40...'))
    check('S3 and says how it ended', text.includes('ended by the app: user'), text.slice(-120))

    // The strongest available proof that the descriptor was released: Windows refuses to unlink
    // a file whose handle is still open, so a successful delete is the close, observed.
    let deleted = false
    try {
      fs.unlinkSync(logPath)
      deleted = true
    } catch {
      deleted = false
    }
    check('S3 the file was closed, not merely written', deleted)
    check('S3 the job slot is released', !isRunning())
  }

  // ── S4: the ceiling, at its real size ─────────────────────────────────────────
  section('S4 — a run that will not stop talking cannot fill the disk')
  {
    const LINES = 120_000
    const LAST = `line ${LINES} — the last thing this run said`
    __useScriptedEngine((e: ScriptedEngine) => {
      // In blocks, because the engine writes in blocks and one 120,000-iteration write loop is
      // a different test. Every line is unique so the stall budget sees continuous novelty and
      // this measures the ceiling rather than REP-2's watchdog.
      let block = ''
      for (let i = 1; i < LINES; i++) {
        block += `line ${i} ${'x'.repeat(80)}\n`
        if (i % 1000 === 0) {
          e.stdout.write(block)
          block = ''
        }
      }
      e.stdout.write(`${block}${LAST}\n`)
      e.end(0)
    })

    const { handlers, done } = ending()
    LITTER.push(startTranslate(translateArgs(makeSubtitle('s4.srt')), handlers).outputPath)
    const end = await endsWithin(done, 60_000, 'S4 the run reached an ending')
    LITTER.push(...(end.logPaths ?? []))

    const logPath = findConsoleLog(end.logPaths)
    const size = fs.statSync(logPath).size
    const ceiling = DEFAULT_CONSOLE_LOG_LIMITS.headBytes + DEFAULT_CONSOLE_LOG_LIMITS.tailBytes
    // ~11 MB of output. Acceptance 3: it stops growing, and it says so.
    check('S4 the run overflowed the ceiling', LINES * 88 > DEFAULT_CONSOLE_LOG_LIMITS.headBytes)
    check(
      'S4 the file stopped growing',
      size <= ceiling + 4096,
      `${size} bytes against a ${ceiling} byte budget`
    )
    check('S4 it is not merely small', size > DEFAULT_CONSOLE_LOG_LIMITS.headBytes)

    const text = fs.readFileSync(logPath, 'utf-8')
    check('S4 the beginning is intact', text.includes('Starting engine…') && text.includes('line 1 '))
    check('S4 the cut is marked', text.includes(CONSOLE_LOG_TRUNCATION_MARK))
    // The reason the tail is kept at all: this is where a failure would be.
    check('S4 and the ending survived it', text.includes(LAST))
    check('S4 the ending is still the ending', text.includes('[run ended: exit code 0]'))
  }

  // ── S5: the lines the app says before the engine exists ───────────────────────
  section('S5 — a run that never spawned still explains itself')
  {
    // No engine is scripted at all: the preflight refuses the key, so nothing is ever spawned.
    // Everything in this file therefore comes from `startTranscribe` itself, which is the half
    // of the console that is easiest to lose — those messages are emitted through the handlers
    // the caller passed, not through the ones `run()` uses.
    const out = path.join(WORK, 'refused.srt')
    const { handlers, done } = ending()
    await startTranscribe(transcribeArgs(path.join(WORK, 'refused.mp3'), out), handlers, async () => ({
      verdict: 'rejected',
      message: 'The API rejected this key before the transcription started: bad key.'
    }))
    const end = await endsWithin(done, 60_000, 'S5 the run reached an ending')

    const logPath = findConsoleLog(end.logPaths)
    const text = logPath && fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf-8') : ''
    check('S5 a refused run still has a console', text !== '')
    check('S5 it holds what the app was doing', text.includes('Checking the API key…'))
    check('S5 and why it stopped', text.includes('The API rejected this key'))
    check('S5 recorded as ended by the app', text.includes('ended by the app: guard'), text.slice(-100))
    check('S5 the engine was never spawned', !text.includes('Starting engine…'))
    check('S5 the job slot is released', !isRunning())
  }

  // ── S6: a translation refused before the engine ───────────────────────────────
  section('S6 — an input the app refuses is refused in writing')
  {
    // A cp1252 `.ass`, which `ensureUtf8Subtitle` refuses rather than mangling. Same class as S5
    // from the other page: the refusal is the app's own line, on the path that returns early.
    const bad = path.join(WORK, 'latin1.ass')
    fs.writeFileSync(bad, Buffer.from([0x5b, 0x53, 0x63, 0x72, 0x69, 0x70, 0x74, 0x5d, 0x0a, 0xe9, 0xe8, 0x0a]))

    const { handlers, done } = ending()
    const started = startTranslate(translateArgs(bad), handlers)
    const end = await endsWithin(done, 60_000, 'S6 the run reached an ending')
    LITTER.push(started.outputPath, ...(end.logPaths ?? []))

    const logPath = findConsoleLog(end.logPaths)
    const text = logPath && fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf-8') : ''
    check('S6 the refusal was written down', text !== '' && !text.startsWith('[run ended'))
    check('S6 the run did not reach the engine', !text.includes('Starting engine…'))
    check('S6 and the ending is recorded', text.includes('[run ended: exit code -1]'), text.slice(-80))
    check('S6 the job slot is released', !isRunning())
  }

  // ── S7: the child that reports an error and never closes ──────────────────────
  section('S7 — a process error ends the run rather than stranding it')
  {
    // The case Node warns about and this app used to lose: "the exit event may or may not fire
    // after an error". A kill that failed is the clearest instance — the child is still alive, so
    // no close is coming by definition. The old handler wrote a line and returned, which left the
    // job slot held, the descriptor open, and every later run of EITHER kind refused.
    let engine: ScriptedEngine | null = null
    __useScriptedEngine((e: ScriptedEngine) => {
      engine = e
      e.stdout.write('Translating batch 1/9...\n')
      // Deliberately no newline: the flush the error path now performs is what carries it.
      e.stdout.write('the half-line the engine was mid-way through')
      setTimeout(() => e.fail('spawn ETXTBSY'), 30)
    })

    const { handlers, done, endings } = ending()
    const started = startTranslate(translateArgs(makeSubtitle('s7.srt')), handlers)
    const end = await endsWithin(done, 60_000, 'S7 the run reached an ending')
    LITTER.push(started.outputPath, ...(end.logPaths ?? []))

    check('S7 the run ended at all', end.code === -1, String(end.code))
    check('S7 and the slot it was holding is free', !isRunning())
    check('S7 the engine really never closed', engine !== null)

    const logPath = findConsoleLog(end.logPaths)
    const text = logPath && fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf-8') : ''
    check('S7 the console records the error', text.includes('Process error: spawn ETXTBSY'))
    check('S7 what the run had said is kept', text.includes('Translating batch 1/9...'))
    check('S7 including the line it was mid-way through', text.includes('the half-line the engine was mid-way through'))
    check('S7 and the ending is written', text.includes('[run ended: exit code -1]'), text.slice(-80))

    // Windows refuses to unlink an open file, so this is the closed descriptor, observed.
    let deleted = false
    try {
      fs.unlinkSync(logPath)
      deleted = true
    } catch {
      deleted = false
    }
    check('S7 the file was closed', deleted)

    // The other half of the same event: a spawn failure DOES usually close afterwards, and the
    // page must still be told exactly once.
    const second = ending()
    __useScriptedEngine((e: ScriptedEngine) => {
      e.fail('spawn ENOENT')
      setTimeout(() => e.end(1), 20)
    })
    const alsoStarted = startTranslate(translateArgs(makeSubtitle('s7b.srt')), second.handlers)
    const secondEnd = await endsWithin(second.done, 60_000, 'S7b the run reached an ending')
    LITTER.push(alsoStarted.outputPath, ...(secondEnd.logPaths ?? []))
    await settleFor(80)
    check('S7 an error followed by a close ends the run once', second.endings() === 1, `${second.endings()} endings`)
    check('S7 and the slot is free after that too', !isRunning())

    // A run that ends normally must not have acquired a second ending along the way either.
    const third = ending()
    __useScriptedEngine((e: ScriptedEngine) => {
      e.stdout.write('Translation completed\n')
      e.end(0)
    })
    const thirdStarted = startTranslate(translateArgs(makeSubtitle('s7c.srt')), third.handlers)
    const thirdEnd = await endsWithin(third.done, 60_000, 'S7c the run reached an ending')
    LITTER.push(thirdStarted.outputPath, ...(thirdEnd.logPaths ?? []))
    await settleFor(80)
    check('S7 and an ordinary run still ends exactly once', third.endings() === 1, `${third.endings()} endings`)
  }

  // ── S8: one line that is larger than the whole ceiling ────────────────────────
  section('S8 — a single enormous line cannot outgrow the file it is written to')
  {
    // `run()` splits on newlines and holds the remainder, so output with no newline in it becomes
    // exactly ONE line, flushed whole at close. Both the head and the tail decide whether to take
    // a line before seeing its size, so that one line used to be written at any size — the cap
    // was a cap on the number of lines, not on the bytes.
    const HUGE = 4 * 1024 * 1024
    __useScriptedEngine((e: ScriptedEngine) => {
      e.stdout.write('Translating batch 1/2...\n')
      e.stdout.write(`payload:${'x'.repeat(HUGE)}`)
      e.end(0)
    })

    const { handlers, done } = ending()
    const started = startTranslate(translateArgs(makeSubtitle('s8.srt')), handlers)
    const end = await endsWithin(done, 60_000, 'S8 the run reached an ending')
    LITTER.push(started.outputPath, ...(end.logPaths ?? []))

    const logPath = findConsoleLog(end.logPaths)
    const size = fs.existsSync(logPath) ? fs.statSync(logPath).size : -1
    check(
      'S8 the four megabyte line did not become a four megabyte file',
      size > 0 && size < DEFAULT_CONSOLE_LOG_LIMITS.lineBytes * 2,
      `${size} bytes from a ${HUGE} byte line`
    )
    const text = fs.readFileSync(logPath, 'utf-8')
    check('S8 what it was is still legible', text.includes('payload:xxx'))
    check('S8 the run around it is intact', text.includes('Translating batch 1/2...'))
    check('S8 the cut is admitted', text.includes(CONSOLE_LOG_TRUNCATION_MARK))
    check('S8 and the ending still arrives', text.includes('[run ended: exit code 0]'))
    check('S8 the job slot is released', !isRunning())
  }

  // ── S9: a kill that failed, with the engine still alive ───────────────────────
  section('S9 — a kill that failed does not hand the slot to a second engine')
  {
    /**
     * One failed Stop, from the press to the recovery, over a process that really exists.
     *
     * A REAL child is required rather than convenient: the app now asks the operating system
     * whether the engine survived, and an invented pid answers "gone" — which is S7's case, not
     * this one. It is written once and run three times because the three ways a termination can
     * fail are three different code paths in the app, and the one that is easiest to simulate is
     * the one that barely ever happens.
     */
    async function failedStop(
      mode: 'throw' | 'error' | 'exit',
      label: string,
      expected: string
    ): Promise<void> {
      const survivor = realSpawn(process.execPath, ['-e', 'setTimeout(() => {}, 120000)'], {
        stdio: 'ignore'
      })
      SURVIVORS.push(survivor)
      await settleFor(150)
      check(
        `${label} the stand-in engine really is running`,
        typeof survivor.pid === 'number' && survivor.exitCode === null
      )

      __useEnginePid(survivor.pid)
      let engine: ScriptedEngine | null = null
      __useScriptedEngine((e: ScriptedEngine) => {
        engine = e
        e.stdout.write('Translating batch 1/80...\n')
      })

      const { handlers, done, endings } = ending()
      const started = startTranslate(translateArgs(makeSubtitle(`s9-${mode}.srt`)), handlers)
      await settleFor(60)
      check(`${label} the run is under way`, isRunning() && engine !== null)

      __failNextKill(mode)
      stopCurrent()
      await settleFor(300)

      // The invariant. Ending the run here would be a lie the rest of the app then acts on: the
      // slot would go to a second engine while the first is still running against the same key,
      // and the survivor's lines would keep arriving on the shared output channel.
      check(`${label} no ending while the engine is alive`, endings() === 0, `${endings()} endings`)
      check(`${label} the slot is still held`, isRunning())

      const other = ending()
      const refused = startTranslate(translateArgs(makeSubtitle(`s9-${mode}-2.srt`)), other.handlers)
      LITTER.push(refused.outputPath)
      await settleFor(30)
      check(`${label} a second run is refused`, other.endings() === 1 && endings() === 0)

      // Said out loud rather than left as a spinner, because the user is the only one who can
      // finish this — and Stop is re-enterable, so the advice is actionable.
      const logPath = consoleLogPathFor(started.outputPath)
      const during = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf-8') : ''
      check(`${label} the user is told the engine did not stop`, during.includes('The engine did not stop'))
      check(`${label} and told why the app will not move on`, during.includes('two engines'))
      check(
        `${label} and told what actually went wrong`,
        during.includes(expected),
        during.split('\n').find((l) => l.includes('did not stop')) ?? '(no such line)'
      )
      check(`${label} the console is still open, not closed early`, !during.includes('[run ended'))

      // Now the survivor exits, and the run ends exactly once — the ordinary contract, resumed.
      __failNextKill(null)
      survivor.kill()
      engine?.end(null)
      const end = await endsWithin(done, 60_000, `${label} ends once the engine really exits`)
      LITTER.push(started.outputPath, ...(end.logPaths ?? []))
      await settleFor(80)

      check(`${label} exactly one ending, after the fact`, endings() === 1, `${endings()} endings`)
      check(`${label} still recorded as the user\u2019s Stop`, end.reason === 'user', String(end.reason))
      check(`${label} the slot is released`, !isRunning())
      const after = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf-8') : ''
      check(`${label} and the console is closed with the ending in it`, after.includes('ended by the app: user'))
    }

    // The ordinary Windows refusal: taskkill RAN and declined. Nothing was reading its exit code,
    // so this left the engine alive with the panel on Stopping… and no explanation at all.
    await failedStop('exit', 'S9a taskkill refused', 'Access is denied')

    // taskkill could not start. Reported through an asynchronous `error` event — which, with no
    // listener on that child, is an uncaught exception that takes the whole main process down.
    // The probe reaching the end of this call is itself the proof that it no longer does.
    await failedStop('error', 'S9b taskkill could not run', 'could not run')

    // The synchronous throw. Real, but rare — and the only one the first version of this scenario
    // modelled, which is exactly why the two above went unnoticed.
    await failedStop('throw', 'S9c the spawn itself threw', 'could not be attempted')

    // A different door into the same mistake: the failure can arrive as an `error` event on the
    // ENGINE, which is how `proc.kill()` reports EPERM on the platforms that use it. S7 proved
    // an error with a dead child must end the run; this proves the same event with a LIVE one
    // must not.
    const alive = realSpawn(process.execPath, ['-e', 'setTimeout(() => {}, 120000)'], { stdio: 'ignore' })
    SURVIVORS.push(alive)
    await settleFor(150)
    __useEnginePid(alive.pid)
    let second: ScriptedEngine | null = null
    __useScriptedEngine((e: ScriptedEngine) => {
      second = e
      e.stdout.write('Translating batch 1/12...\n')
      setTimeout(() => e.fail('kill EPERM'), 30)
    })

    const late = ending()
    const lateStarted = startTranslate(translateArgs(makeSubtitle('s9d.srt')), late.handlers)
    await settleFor(250)
    check('S9d an error event with a live child ends nothing', late.endings() === 0, `${late.endings()} endings`)
    check('S9d that slot is held too', isRunning())

    alive.kill()
    second?.end(-1)
    const lateEnd = await endsWithin(late.done, 60_000, 'S9d the error-event run also ends when its child does')
    LITTER.push(lateStarted.outputPath, ...(lateEnd.logPaths ?? []))
    check('S9d and it too ends exactly once', late.endings() === 1, `${late.endings()} endings`)
    check('S9d the slot is free again', !isRunning())

    __useEnginePid(FAKE_PID)
  }

  console.log(`\n${passes} passed, ${failures} failed`)
  cleanUp()
  if (failures > 0) {
    console.log('\nCONSOLE LOG PROBE FAILED')
    process.exit(1)
  }
  console.log('\nCONSOLE LOG PROBE PASSED')
}

void main()
