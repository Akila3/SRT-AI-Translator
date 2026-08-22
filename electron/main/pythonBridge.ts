import { spawn, ChildProcessWithoutNullStreams, type ChildProcess } from 'child_process'
import { app } from 'electron'
import path from 'path'
import fs from 'fs'
import { gstLanguageName } from '../shared/languages'
import { bundledBinDir, convertAudioToMp3, envWithFfmpeg } from './ffmpeg'
import { getSettings } from './store'
import { orderKeySlots, type KeySlot } from '../shared/keyOrder'
import { maskCommandLine } from '../shared/maskedCommand'
import { createConsoleLog, consoleLogPathFor, CONSOLE_LOG_SUFFIX } from '../shared/consoleLog'
import { openExclusive } from './exclusiveFile'
import { forceKillTree, hasExited, livePid, waitForChildExit } from './processExit'
import { createStallWatch } from '../shared/stallBudget'
import { effectiveThinkingLevel, modelCapabilities } from '../shared/modelCaps'
import {
  DEFAULT_RESUME_CONTEXT_SIZE,
  type EngineInfo,
  type FfmpegProgress,
  type TerminalReason,
  type TranslateArgs,
  type TranscribeArgs
} from '../shared/types'

/**
 * The one job the app runs at a time.
 *
 * This used to be a bare `ChildProcessWithoutNullStreams | null`, which was sufficient only
 * while "a job" and "a spawned process" were the same thing. Transcription now has a
 * preparation step (audio conversion) that runs BEFORE anything is spawned, and during that
 * window a process-shaped lock reports idle: Stop would find nothing to kill and the job
 * would carry on into the API, and a second job could start and later be refused with no
 * terminal event, leaving its page running forever.
 *
 * So the slot is reserved for the whole lifetime of a job, and every terminal path goes
 * through `finish()`, which fires `onDone` exactly once, releases the slot, and deletes the
 * scratch files the job created.
 */
interface Job {
  /** The gst child once spawned; null while preparing. */
  proc: ChildProcessWithoutNullStreams | null
  /** Aborts an in-flight preparation step. Null when nothing is being prepared. */
  prep: AbortController | null
  /**
   * Set when the APP ends the run rather than the engine, and carried through to the renderer
   * so it can say what happened. Non-null also means "this job has been told to stop", which is
   * what the paths below check before doing any more work.
   */
  endReason: TerminalReason | null
  /** Temp files this job created and owns. Deleted when it ends, whatever the outcome. */
  scratch: string[]
  /**
   * A preparation child this job started — the key preflight or an audio conversion.
   *
   * Set the moment that process exists, not when it outlives a kill. Shutdown and a second Stop
   * need a ChildProcess, not a pid: a pid is reusable and watching one can lock the slot onto a
   * stranger's process for the rest of the session (SOL-16). Cleared once the engine is spawned
   * or the preparation child has been fully handed to `ownOrphan()`.
   */
  prepChild: ChildProcess | null
  /**
   * This run's console, on disk. Deliberately NOT in `scratch`: scratch is deleted when the job
   * ends and the entire purpose of this file is to outlive the run. Null if it could not be
   * opened, which is never allowed to stop the run.
   */
  console: JobConsoleLog | null
  finished: boolean
  handlers: SpawnHandlers
  outputPath: string
}

interface JobConsoleLog {
  path: string
  write(line: string): void
  close(): void
}

/**
 * Open a console log without destroying one that is already there.
 *
 * `'w'` truncates, and for a TRANSCRIPTION the path is derived from the destination the user
 * picked — so choosing `episode.srt` in a folder that already holds `episode.console.log` used
 * to wipe that file the instant the slot was reserved, BEFORE the key preflight had decided
 * whether the run could even start. A run refused a second later had already destroyed the
 * record of the previous one. Translation never had this exposure: its output path is a
 * generated temp name, so nothing of the user's is ever at that location.
 *
 * `'wx'` fails rather than truncates, so an occupied name is stepped over instead of overwritten.
 * The suffix is what varies, never the extension: `findConsoleLog()` and the save dialog both
 * recognise the file by its `.console.log` ending, so `episode-2.console.log` is found by exactly
 * the same rules (validator finding SOL-08).
 *
 * The stepping is `openExclusive`'s, and it cannot run out. The first version of this fix stopped
 * after fifty numbered names and then returned null, which quietly traded a destructive overwrite
 * for a silently absent console log — reachable, because transcription's logs live at the user's
 * chosen destination and the temp sweep never touches them (SOL-13).
 */
function openFreshConsoleLog(preferred: string): { fd: number; path: string } | null {
  return openExclusive(preferred, CONSOLE_LOG_SUFFIX)
}

/**
 * Bind the capped writer to a real file beside the job's output.
 *
 * Written synchronously, one line at a time. An async stream would be cheaper per line and
 * would also mean the last thing a run said is sitting in a buffer at the moment the run ends —
 * which is the moment a crash, a Stop or a `taskkill` on a frozen engine is most likely to
 * arrive. The volume is bounded by the ceiling, so the cost of being sure is small.
 */
function openJobConsoleLog(outputPath: string): JobConsoleLog | null {
  if (!outputPath) return null
  let fd: number
  let logPath: string
  try {
    const opened = openFreshConsoleLog(consoleLogPathFor(outputPath))
    if (!opened) return null
    fd = opened.fd
    logPath = opened.path
  } catch {
    // A log we cannot write is not a reason to refuse a translation.
    return null
  }
  let broken = false
  const log = createConsoleLog((chunk) => {
    if (broken) return
    try {
      fs.writeSync(fd, chunk)
    } catch {
      // A full disk or a revoked handle: stop trying rather than throw once per line into a
      // path that is only observing.
      broken = true
    }
  })
  let closed = false
  return {
    path: logPath,
    write: (line) => {
      if (!closed) log.write(line)
    },
    close: () => {
      if (closed) return
      closed = true
      log.close()
      try {
        fs.closeSync(fd)
      } catch {
        /* best effort: the descriptor is going away with the job either way */
      }
    }
  }
}

let job: Job | null = null

/** Reserve the single job slot, or return null if one is already held. */
function beginJob(handlers: SpawnHandlers, outputPath: string): Job | null {
  if (job) return null
  const consoleLog = openJobConsoleLog(outputPath)
  job = {
    proc: null,
    prep: null,
    endReason: null,
    scratch: [],
    prepChild: null,
    console: consoleLog,
    finished: false,
    // Teed here rather than at each call site so the file gets what the panel gets, from every
    // path that reports anything: the masked command line, the preparation notices, the
    // engine's own two streams, the stall budget's verdict. A site that forgot to tee would be
    // a line the user can see but cannot send.
    handlers: consoleLog
      ? {
          ...handlers,
          onOutput: (stream, line) => {
            consoleLog.write(line)
            handlers.onOutput(stream, line)
          }
        }
      : handlers,
    outputPath
  }
  return job
}

/**
 * End a job exactly once: release the slot, remove its scratch files, emit the terminal
 * event. Idempotent, because several paths can race to end the same job (a Stop that kills
 * the child, and the child's own `close`).
 */
function finish(j: Job, code: number | null): void {
  if (j.finished) return
  j.finished = true
  if (job === j) job = null
  for (const file of j.scratch) {
    try {
      fs.unlinkSync(file)
    } catch {
      /* best effort: a temp file we cannot delete must not fail the job */
    }
  }
  j.scratch = []
  // How the run ended is the one fact the console never carries: the panel shows it as a
  // status, and a status is chrome a file does not have. Written here rather than through
  // `onOutput` so it does not become a second, redundant row on screen.
  j.console?.write(
    `[run ended: exit code ${code ?? 'none'}${j.endReason ? `, ended by the app: ${j.endReason}` : ''}]`
  )
  // Closed BEFORE the terminal event, so whatever the renderer does next — offer a Save that
  // copies this file, or open its folder — is looking at a complete one.
  j.console?.close()
  j.handlers.onDone(
    code,
    j.outputPath,
    j.endReason ?? undefined,
    j.console ? [j.console.path] : undefined
  )
}

function stillHasPrepChild(j: Job): boolean {
  return !!j.prepChild && !hasExited(j.prepChild)
}

/**
 * Take ownership of a preparation process that outlived its kill.
 *
 * The job stays open while it lives, for the reason every other survivor path gives: ending the run
 * releases the single slot, and a slot released while a process is alive is what puts two engines on
 * one API key. The watcher is the child's own `close` — not a pid poll. A pid is a reusable integer,
 * so observing "still alive" on it after the original process has gone can mean a long-lived
 * stranger now occupies that number, and the slot would then be held until that stranger exits
 * (SOL-16). `close` is a statement about THIS child and cannot be confused that way.
 *
 * The child is required. A helper that claims a survivor without handing over the handle has
 * nothing this can wait on; that used to release the slot (the undefined-pid branch), which is
 * the original defect. Helpers now pass the ChildProcess they already held.
 */
function ownOrphan(j: Job, child: ChildProcess | undefined): void {
  if (j.finished) return
  if (!child) {
    j.handlers.onOutput(
      'stderr',
      'A process from this run may still be going, but it did not leave a handle to wait on. ' +
        'This run stays open; end that process from Task Manager, or restart the app, before starting another.'
    )
    return
  }
  j.prepChild = child
  const onClose = (): void => {
    if (j.finished) return
    j.handlers.onOutput('stdout', 'The process that would not stop has exited; ending the run.')
    finish(j, -1)
  }
  child.once('close', onClose)
  // waitForChildExit reports a survivor only while close has not fired, so this subscribe is
  // the ordinary path. If the child has already been reaped in the gap, close is coming or has
  // just fired; the listener plus this tick covers both without polling a pid.
  if (hasExited(child)) {
    setImmediate(() => {
      if (!j.finished) onClose()
    })
  }
}

/** Refuse a start request without leaving the caller's page spinning forever. */
function refuseStart(handlers: SpawnHandlers, outputPath: string): void {
  handlers.onOutput('stderr', 'A process is already running.')
  handlers.onDone(-1, outputPath)
}

/**
 * Kill the job's child process, whoever asked.
 *
 * One code path for a user's Stop and for the app's own termination, because the two differ
 * only in the reason recorded — and a second copy of this would eventually diverge on the part
 * that matters: the tree kill. A frozen PyInstaller build is a bootloader that spawns the real
 * interpreter as a child, so killing the pid we hold leaves the engine running, still talking to
 * the API and still writing output nobody is reading.
 *
 * The caller sets `endReason` BEFORE calling this: `close` fires asynchronously and reads it.
 */
function killJob(j: Job): void {
  const proc = j.proc
  if (!proc) {
    // A preparation process that outlived its kill is still work to interrupt. With a ChildProcess
    // we can escalate without the SOL-14 bare-pid hazard: forceKillTree refuses a reaped child, so
    // a second Stop cannot hit whatever inherited the number. The close listener in `ownOrphan()`
    // is what actually ends the run.
    const prep = j.prepChild
    if (prep && !hasExited(prep)) {
      forceKillTree(prep)
      j.handlers.onOutput(
        'stderr',
        `Trying again to end the process that would not stop (pid ${prep.pid ?? 'unknown'}). ` +
          'This run stays open until it exits.'
      )
      return
    }
    // Nothing spawned yet. A preparation step in flight owns the terminal event; with none,
    // end the job here so the slot is not held by a job that has no work to interrupt.
    if (!j.prep) finish(j, -1)
    return
  }
  // `close` is what finishes the job; `exit` is what reaps the pid. Stop can still run between
  // the two, and a copied `proc.pid` is then a stranger (SOL-19). Descendants that outlived the
  // root stay REP-21 — not worth a recycled identifier.
  const pid = livePid(proc)
  if (pid === undefined) return
  try {
    if (process.platform === 'win32') {
      treeKill(j, proc)
    } else {
      // The GROUP, not the process. `SIGTERM` to the tracked pid alone reaches the PyInstaller
      // bootloader and — if it forwards signals — the interpreter, but an `ffmpeg` the interpreter
      // started is not covered by either, so it could outlive the job while the app treated the
      // tracked process's `close` as the end of it (validator finding SOL-10). The engine is spawned
      // `detached` on POSIX precisely so it leads its own group and this negative pid is meaningful.
      // Windows is untouched: it has no process groups and `taskkill /t` already walks the tree.
      try {
        process.kill(-pid, 'SIGTERM')
      } catch {
        // No group — a spawn that did not become a leader. The single process is still better than
        // nothing, and is exactly what this did before.
        proc.kill('SIGTERM')
      }
      // SIGTERM is a REQUEST. Escalation stays inside `waitForChildExit(proc)` → `forceKillTree`,
      // which SIGKILLs the group only while that ChildProcess has not been reaped (SOL-14). Round 5
      // scheduled a 3s SIGKILL of a *copied PGID* so members could still be hit after the root
      // died; a PGID is a reusable integer, so that timer could SIGKILL a stranger's whole group
      // (SOL-18, High). Descendants after the root reaps remain REP-21. Killing a recycled id is
      // worse.
      void waitForChildExit(proc, { graceMs: 3_000, attempts: 3 }).then((gone) => {
        if (!gone) failedTermination(j, 'the process group ignored both SIGTERM and SIGKILL')
      })
    }
  } catch {
    // This used to end the job outright, reasoning that a failed kill means no `close` is
    // coming. True, and the wrong conclusion: if the kill failed the engine is still RUNNING,
    // and releasing the slot then is not a recovery, it is a second engine.
    //
    // Note how little this branch actually catches: `spawn()` reports almost every real failure
    // asynchronously, so this is the rare synchronous-argument case and NOT where a blocked or
    // missing `taskkill` arrives. That is `treeKill()`'s business.
    failedTermination(j, 'the termination could not be attempted')
  }
}

/**
 * Kill the engine's whole process tree on Windows — and find out whether that worked.
 *
 * The child used to be spawned and dropped on the floor, which is wrong twice over. A `taskkill`
 * that cannot START reports it through an **`error` event**, and an `error` on a child with no
 * listener is an uncaught exception: it does not merely go unnoticed, it takes the Electron main
 * process down. A `taskkill` that runs and **fails** — "Access is denied" is the ordinary case —
 * reports it by exiting non-zero, which nothing was reading. Both left the engine alive with the
 * UI stuck on Stopping… forever, because the only event that ends this run is a `close` from a
 * process that was never killed.
 *
 * Only failure is acted on. A successful tree kill exits 0 and the engine's own `close` ends the
 * run, which is the single path every other ending already goes through.
 *
 * Takes the ChildProcess, not a number: SOL-19. A pid copied earlier can already belong to
 * someone else by the time `taskkill` starts.
 */
function treeKill(j: Job, child: ChildProcess): void {
  const pid = livePid(child)
  if (pid === undefined) return
  const killer = spawn('taskkill', ['/pid', String(pid), '/f', '/t'])
  // `taskkill` says why in one line, and that line is the difference between "run it as
  // administrator" and "the anti-virus is holding it". Still bounded — this is a diagnostic, not a
  // feed — but far more generously than the 400 characters it started with: `/t` reports one line
  // PER process it could not kill, and those lines are now READ for their pids, so a cap that
  // truncated them would discard the survivors it is there to find (SOL-05, round 2).
  let why = ''
  killer.stderr?.on('data', (d: Buffer) => {
    if (why.length < 8_000) why += String(d)
  })
  killer.on('error', (e) => failedTermination(j, `taskkill could not run: ${e.message}`))
  killer.on('close', (code) => {
    if (code === 0) return
    // Both lines, joined: `taskkill` names the process on the first and gives the REASON on the
    // second, and the reason is the half the user can act on.
    const said = why
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
      .join(' ')
    failedTermination(j, `taskkill exited ${code}${said ? ` — ${said}` : ''}`, survivorsIn(why))
  })
}

/**
 * The pids `taskkill` said it could not kill.
 *
 * `/t` walks the tree, so a partial failure is the interesting case and it is invisible from the
 * root alone: the bootloader of a frozen one-file build can be killed while the interpreter it
 * spawned survives, and a liveness check on the pid we happen to hold would then report the whole
 * tree gone. `taskkill` names each casualty it could not take —
 *
 *   ERROR: The process with PID 4711 (child process of PID 4096) could not be terminated.
 *
 * — so the descendants are not unknowable, merely unread. Both pids on that line are collected:
 * either can be the survivor, and checking one too many costs nothing while missing one is the
 * defect (validator finding SOL-05).
 */
export function survivorsIn(taskkillStderr: string): number[] {
  const pids = new Set<number>()
  for (const m of taskkillStderr.matchAll(/PID[:\s]+(\d+)/gi)) {
    const pid = Number(m[1])
    if (Number.isInteger(pid) && pid > 0) pids.add(pid)
  }
  return [...pids]
}

/**
 * A termination attempt failed. End the job only if the engine turns out to be gone anyway.
 *
 * The `finished` guard matters more than it looks: these handlers fire asynchronously, so this
 * one can arrive after the engine's own `close` has already ended the run — and by then the slot
 * may belong to a DIFFERENT job, whose panel would receive a stop failure that has nothing to do
 * with it. Reporting is left to `engineOutlivedItsKill()` for the same reason in miniature: a Stop
 * pressed just as the engine exits on its own makes `taskkill` report "process not found", and
 * announcing a failed termination for a process that is already gone is a false alarm.
 */
function failedTermination(j: Job, detail: string, alsoCheck: number[] = []): void {
  if (j.finished) return
  if (engineOutlivedItsKill(j, detail, alsoCheck)) return
  // Nothing we can NAME is still alive, and the kill nonetheless reported a failure. The pids in that
  // report are read out of English diagnostic text, so a localised Windows, a truncated message or a
  // wording we do not match leaves a real survivor unnamed and indistinguishable from a clean exit.
  // This used to end the run here, which is the one thing it must not do: releasing the slot on a
  // guess is how a second engine starts against the same key (SOL-05, round 3).
  //
  // It does not have to guess. If the tracked process really is gone, Node reaps it and `close`
  // arrives on its own — the ordinary ending, through the ordinary path. If a descendant survived
  // holding the inherited pipes, `close` is DELAYED until that descendant exits, which is precisely
  // the behaviour the invariant wants. So: wait, and let whichever it is happen.
  //
  // The wait is not a timeout that then finishes anyway. Finishing after twenty seconds was the
  // previous round's remaining hole: an inconclusive kill plus a deadline is still releasing the
  // slot on a guess (SOL-05, round 4). The slot stays held until `close` — the user can end the
  // leftover from Task Manager, which is what produces that close. A warning is not a substitute
  // for the invariant.
  const warnAfterMs = 1_500
  const startedAt = Date.now()
  let warned = false
  const watch = setInterval(() => {
    if (j.finished) {
      clearInterval(watch)
      return
    }
    if (warned || Date.now() - startedAt < warnAfterMs) return
    warned = true
    j.handlers.onOutput(
      'stderr',
      `Termination reported a failure (${detail}) and no process we can identify is still running. ` +
        'This run stays open until the engine closes; if it appears to keep working, end it from Task Manager.'
    )
  }, 250)
  void watch
}

/**
 * Is that process still out there?
 *
 * Signal 0 runs the existence and permission checks without delivering anything, which is the only
 * way to tell apart the two things a failed termination can mean. EPERM counts as ALIVE: a process
 * we are not allowed to signal is the worst version of this, not an absent one.
 */
function childIsAlive(pid: number | undefined): boolean {
  if (pid === undefined) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * A termination attempt failed — did the engine survive it?
 *
 * If it did, the job must NOT end. This is the harder half of the invariant to see: an ending
 * releases the single slot, so declaring a run over while its engine is alive lets a SECOND engine
 * start against the same API, and the survivor keeps pushing lines through the shared output
 * channel into the new run's panel. A slot held by a process that genuinely still exists is
 * accurate; a slot released for one that does is a lie the rest of the app then acts on.
 *
 * So the run stays open and waits for the `close` that arrives whenever the engine does exit. If
 * it never exits, that is said plainly rather than hidden behind a spinner — and pressing Stop
 * again re-enters `killJob()`, so the sentence is advice the user can act on twice.
 */
function engineOutlivedItsKill(j: Job, detail = '', alsoCheck: number[] = []): boolean {
  const pid = j.proc?.pid
  // The root pid is only the first candidate. A frozen one-file build is a bootloader that spawns
  // the interpreter doing the work, so "the pid we hold is gone" is not the same statement as "the
  // engine is gone" — and it is the second one the single-job slot depends on.
  const alive = [pid, ...alsoCheck].filter((p) => childIsAlive(p))
  if (alive.length === 0) return false
  const survivors = alive.join(', ')
  j.handlers.onOutput(
    'stderr',
    `${j.endReason ? 'The engine did not stop' : 'The engine is still running'} (pid ${survivors})` +
      `${detail ? ` — ${detail}` : ''}. ` +
      'This run stays open until it exits, because starting another one now would put two engines ' +
      'on the same API key. Press Stop again to retry, or end that process yourself.'
  )
  return true
}

/**
 * Which `gst` to run — as an ABSOLUTE path whenever one can be found.
 *
 * It used to return a bare `gst` in development and let PATH decide, and that one detail forced a
 * bad trade everywhere else: because the bundled directory holds `gst.exe` AND `ffmpeg.exe`, the
 * only way to keep a developer's pip-installed engine was to APPEND that directory to PATH — which
 * meant any system ffmpeg earlier on PATH beat both the bundled copy and the user's explicit
 * Settings override, quietly contradicting the priority this app documents (SOL-06).
 *
 * Resolving the engine here instead removes the trade rather than balancing it: once `spawn` is
 * given an absolute path, PATH cannot influence which engine runs, so the ffmpeg directories are
 * free to go FIRST where they belong.
 *
 * The development search reads the user's OWN PATH, in their own order, and honours it. That is
 * load-bearing in both directions: a pip install still wins exactly as it always did, and a
 * developer — or the bad-key probe, which does precisely this — can still pin the shipped engine by
 * putting `resources/bin` first. An earlier version of this excluded the bundled directory from the
 * search, on the theory that it might have been put there by this app. That was wrong, and it broke
 * the probe: `envWithFfmpeg()` builds a new environment for a CHILD and never mutates
 * `process.env`, so anything on THIS process's PATH was put there deliberately by somebody who
 * meant it.
 */
export function resolveGstBin(): string {
  const name = process.platform === 'win32' ? 'gst.exe' : 'gst'
  if (app.isPackaged) {
    const bundled = path.join(process.resourcesPath, 'bin', name)
    return fs.existsSync(bundled) ? bundled : 'gst'
  }
  const onPath = resolveOnPath('gst')
  if (onPath) return onPath
  // Nothing on PATH: the bundled copy is the only engine there is, and running it beats failing.
  // This also preserves what the old appended-PATH arrangement ended up doing in the same case.
  const bundled = path.join(bundledBinDir(), name)
  return fs.existsSync(bundled) ? bundled : 'gst'
}

/**
 * Resolve a bare executable name against the user's PATH.
 *
 * The RAW `process.env.PATH`, not the augmented one a child receives: the augmented copy is where
 * this app inserts its own bundled directory, and searching that would make the answer depend on
 * the very insertion the caller is trying to be independent of.
 */
function resolveOnPath(name: string): string | null {
  const sep = process.platform === 'win32' ? ';' : ':'
  const exts =
    process.platform === 'win32'
      ? (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
      : ['']
  for (const dir of (process.env.PATH ?? process.env.Path ?? '').split(sep)) {
    if (!dir) continue
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext)
      try {
        if (!fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) continue
        // The name as the FILESYSTEM spells it, not as `PATHEXT` spelled it. `PATHEXT` is uppercase
        // on Windows, so this used to hand back `gst.EXE` — and a frozen one-file build re-launches
        // itself and then validates that its parent's executable matches its own, a comparison that
        // a case difference fails outright: `[PYI] Security validation failure: parent process has
        // different executable!`. It never surfaced while this was only feeding a log line; it
        // became load-bearing the moment `resolveGstBin()` started returning it to `spawn`.
        if (process.platform !== 'win32') return candidate
        try {
          return fs.realpathSync.native(candidate)
        } catch {
          return candidate
        }
      } catch {
        /* unreadable PATH entry */
      }
    }
  }
  return null
}

/**
 * Which `gst` binary this process will actually run, as a fact the UI can show.
 *
 * The question is permanent: in development a globally pip-installed engine wins over the bundled
 * one, which would otherwise make every dev-run measurement describe a different binary from the
 * one that ships.
 *
 * MAN-5 is why this returns a value rather than only printing one. The answer was a `console.log`,
 * and a packaged Electron app on Windows is a GUI-subsystem binary with no console attached, so
 * the single most useful diagnostic in the app was readable everywhere except where it mattered.
 * That left release-gate check D1 — "the packaged app runs the packaged engine" — impossible for
 * the person holding the checklist. The payload lives in `shared/types` so the preload can type
 * it without importing main-process code.
 *
 * This now simply reports what `resolveGstBin()` decided, because that function resolves the engine
 * absolutely in both modes (SOL-06). It used to declare ANY absolute answer `bundled: true`, which
 * was accurate only for as long as the packaged build was the only one that produced an absolute
 * path — what makes a binary bundled is where it lives, never how it was found.
 */
export function describeEngine(): EngineInfo {
  const bin = resolveGstBin()
  if (!path.isAbsolute(bin)) return { path: bin, bundled: false, found: false }
  return {
    path: bin,
    bundled: bin.toLowerCase().includes(`${path.sep}resources${path.sep}bin${path.sep}`),
    found: fs.existsSync(bin)
  }
}

/** The same answer on the console at startup, which is still the right place in dev. */
export function logResolvedGstBin(): void {
  const info = describeEngine()
  console.log(
    `[gst] resolveGstBin() -> ${info.path}` +
      (info.bundled ? ' (bundled)' : info.found ? ' (resolved via PATH)' : ' (NOT FOUND ON PATH)')
  )
  if (info.found && !info.bundled) {
    console.warn(
      '[gst] WARNING: the resolved binary is not the bundled resources/bin copy. ' +
        'Dev runs are exercising a different engine build than the one that ships.'
    )
  }
}

export function tempOutputPath(suffix = '.srt'): string {
  const dir = tempDir()
  fs.mkdirSync(dir, { recursive: true })
  return path.join(dir, `${Date.now()}${suffix}`)
}

function tempDir(): string {
  return path.join(app.getPath('userData'), 'temp')
}

/** Nothing in the scratch directory is worth keeping for longer than this. */
const TEMP_TTL_MS = 7 * 24 * 60 * 60 * 1000

/**
 * Delete last week's scratch files, once, at startup.
 *
 * Everything a translation produces lands in this directory and then deliberately OUTLIVES the
 * run: `finish()` unlinks only `Job.scratch`, because the output, the normalised input copy, the
 * engine's sidecars and the console log all have to still be there when the user decides to
 * save them — the Save dialog COPIES rather than moves, and New only clears React state. Nothing
 * therefore ever removed them, and a console alone can approach nine megabytes, so ordinary use
 * grew this directory without limit and left translated subtitles sitting in it indefinitely
 * (validator finding SOL-07).
 *
 * Startup and an age test, rather than deletion at the moment of saving: at startup nothing is on
 * screen, so there is no result to pull out from under the user, and age is the one signal that
 * cannot mistake a file the user is still looking at for rubbish. Confined to our own scratch
 * directory — never the user's chosen output folder, where transcription writes and where the
 * subtitle beside their video lives.
 */
export function sweepTempDir(now = Date.now(), ttlMs = TEMP_TTL_MS): number {
  const dir = tempDir()
  let removed = 0
  let entries: string[]
  try {
    entries = fs.readdirSync(dir)
  } catch {
    // No scratch directory yet, which is the ordinary state of a fresh install.
    return 0
  }
  for (const name of entries) {
    const file = path.join(dir, name)
    try {
      const stat = fs.statSync(file)
      if (!stat.isFile() || now - stat.mtimeMs < ttlMs) continue
      fs.unlinkSync(file)
      removed++
    } catch {
      /* best effort: a file we cannot inspect or delete is not worth failing startup over */
    }
  }
  return removed
}

export type SubtitleNormalizeResult = { ok: true; path: string } | { ok: false; error: string }

/** Subtitle formats the engine accepts for `-i` (cli.py:114). */
const SUBTITLE_EXTS = ['.srt', '.ass']

/**
 * Normalize a subtitle file to plain UTF-8 (no BOM) before handing it to `gst`, which
 * opens its input with `encoding="utf-8"`. Guards two failure modes: a UTF-16/legacy
 * encoded file making gst raise UnicodeDecodeError, and a BOM leaking into the first cue.
 *
 * Invariants:
 *  - The user's original file is NEVER modified. This returns either the input path
 *    untouched or the path of a separate temp copy.
 *  - The input's EXTENSION is preserved. The previous version hardcoded `.utf8.srt`, so
 *    a converted `.ass` reached gst with an `.srt` name — gst then parses ASS content as
 *    SRT and names the output `.srt` instead of `_translated.ass` (main.py:141-142 keys
 *    off the extension). Corrupt output, no error.
 *  - An ambiguous encoding is NOT guessed for `.ass`. The windows-1252/latin1 fallback
 *    stays for `.srt` (preserving today's behaviour for the format it was written for),
 *    but silently transcoding a styled format with a guessed code page mangles dialogue
 *    AND non-ASCII style names with no signal, so ASS is refused with an actionable error.
 */
export function ensureUtf8Subtitle(inputPath: string): SubtitleNormalizeResult {
  let buf: Buffer
  try {
    buf = fs.readFileSync(inputPath)
  } catch {
    return { ok: true, path: inputPath }
  }

  const ext = (path.extname(inputPath) || '.srt').toLowerCase()
  const suffix = SUBTITLE_EXTS.includes(ext) ? ext : '.srt'

  let text: string
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    text = buf.subarray(3).toString('utf-8') // UTF-8 with BOM → strip BOM
  } else if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    text = new TextDecoder('utf-16le').decode(buf.subarray(2))
  } else if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    text = new TextDecoder('utf-16be').decode(buf.subarray(2))
  } else {
    try {
      // Already valid, BOM-less UTF-8 — feed it straight through.
      new TextDecoder('utf-8', { fatal: true }).decode(buf)
      return { ok: true, path: inputPath }
    } catch {
      if (suffix === '.ass') {
        return {
          ok: false,
          error:
            'This .ass file is not UTF-8. Re-save it as UTF-8 (most subtitle editors offer ' +
            '"Save as UTF-8") and try again. It was left untouched — guessing a legacy code page ' +
            'would corrupt styled text and style names.'
        }
      }
      // Not UTF-8: assume a legacy Windows code page (covers most Latin SRTs).
      try {
        text = new TextDecoder('windows-1252').decode(buf)
      } catch {
        text = buf.toString('latin1')
      }
    }
  }

  try {
    const outPath = tempOutputPath(`.utf8${suffix}`)
    fs.writeFileSync(outPath, text, 'utf-8')
    return { ok: true, path: outPath }
  } catch {
    return { ok: true, path: inputPath }
  }
}

/**
 * Thinking flags for the chosen model, derived from the ONE shared capability helper.
 *
 * This used to be implemented twice — here and inline in SettingsPage — with different
 * logic, which is exactly how the `-latest` bug survived: the UI offered a control the
 * engine then ignored.
 */
function thinkingArgs(level: string, budget: number, model: string): string[] {
  const caps = modelCapabilities(model)
  if (level === 'disabled' && caps.canDisableThinking) return ['--no-thinking']
  if (caps.thinking === 'level') {
    return ['--thinking-level', effectiveThinkingLevel(model, level)]
  }
  if (caps.thinking === 'budget') {
    const clamped = Math.min(caps.thinkingBudgetMax, Math.max(caps.thinkingBudgetMin, budget))
    return ['--thinking-budget', String(clamped)]
  }
  return []
}

/**
 * Emit --temperature / --top-p / --top-k only when the user has opted into custom
 * generation parameters; otherwise omit them entirely so the model's own defaults apply
 * (all three default to None in the engine and flow into GenerateContentConfig unchanged
 * — main.py:100-112, 245-251).
 *
 * The zero trap: `cli.py` tests these with plain truthiness (lines 153-158), so a literal
 * 0 is silently dropped. The UI clamps above zero; this skips-and-logs as a second line
 * of defence rather than letting a user believe a 0 was applied.
 *
 * The model check is NOT a duplicate of the disabled fields in Settings, and must stay even
 * though the UI already prevents the combination. Settings can only reason about the model
 * selected right now; a saved configuration outlives the model it was made with, and the
 * model list is fetched live, so a stored `customGenerationParams: true` will eventually
 * meet a model that rejects these outright. This is the last point before the process is
 * spawned, and it is the one that has to hold.
 *
 * Withholding the flags genuinely removes the fields from the API request rather than
 * merely leaving them to the engine's defaults — the engine's are `None` and the Google SDK
 * omits `None`, which is confirmed in captured traffic (REP-6: a payload whose
 * `generationConfig` contains temperature and topP but no topK, because no --top-k was
 * passed).
 */
function generationParamArgs(a: {
  model: string
  customGenerationParams: boolean
  temperature: number
  topP: number
  topK: number | null
}): string[] {
  if (!a.customGenerationParams) return []
  if (!modelCapabilities(a.model).acceptsSamplingParams) {
    console.warn(
      `[gst] withholding --temperature/--top-p/--top-k: ${a.model} ignores them today and ` +
        'newer models reject the request outright'
    )
    return []
  }
  const args: string[] = []
  const push = (flag: string, value: number): void => {
    if (!value) {
      console.warn(`[gst] skipping ${flag} ${value}: the engine silently ignores a zero value`)
      return
    }
    args.push(flag, String(value))
  }
  push('--temperature', a.temperature)
  push('--top-p', a.topP)
  if (a.topK != null) push('--top-k', a.topK)
  return args
}

/**
 * What a key preflight can conclude, and what to tell the user.
 *
 * Asymmetric on purpose, exactly like `guardModelForSpawn`: only `rejected` stops a run.
 * "I could not reach Google" is not evidence against the key, and refusing to start because the
 * network blinked would be a worse failure than letting the engine report the truth.
 */
export interface KeyPreflight {
  verdict: 'valid' | 'rejected' | 'unchecked'
  message: string
  /**
   * The preflight's own process was killed and is STILL RUNNING.
   *
   * Nothing to do with the key. It says the job slot must NOT be released, for the same reason
   * `engineOutlivedItsKill()` refuses to release it: an ending frees the slot, and a slot freed
   * while a process is alive is what allows a second engine onto the same key (SOL-02).
   */
  orphaned?: boolean
  orphanPid?: number
  /** The surviving child itself — required for ownership. A pid is not enough (SOL-16). */
  orphan?: ChildProcess
}

export interface SpawnHandlers {
  onOutput: (stream: 'stdout' | 'stderr', line: string) => void
  /**
   * `logPaths` names the sidecars THIS FILE owns — today, the console log — and is optional for
   * the same reason `onProgress` is: it is additional information, not a new meaning for the
   * existing arguments, so every caller that declares fewer parameters stays valid. It is the
   * bridge that reports it because the bridge is the only thing that knows whether the file was
   * opened at all; a caller deriving the name for itself would happily name a previous run's
   * log after a start that was refused.
   */
  onDone: (
    code: number | null,
    outputPath: string,
    reason?: TerminalReason,
    logPaths?: string[]
  ) => void
  /**
   * How far the job's ffmpeg preparation has got. Optional: it is a second channel, not a
   * second meaning for the first, so every existing caller — including the verification
   * probes, which have no window to send to — stays valid by simply not listening.
   */
  onProgress?: (p: FfmpegProgress) => void
}

/**
 * Describe each non-empty key slot with the validity/tier metadata stored for it.
 *
 * THE single place slot metadata is assembled in the main process. `modelsList` ranks
 * the same descriptors to decide which keys are "active", and that answer must match the
 * pair this file actually spawns with — if the two drifted, a model could be offered
 * because a reserve key can see it and then 404 at spawn time.
 *
 * `apiKeyValid`/`apiKeyTiers` are index-aligned with `apiKeys`, so slot i is read
 * directly; the indexOf fallback covers a caller passing a re-ordered/partial array.
 */
export function keySlotsFor(apiKeys: string[]): KeySlot[] {
  const s = getSettings()
  const slots: KeySlot[] = []
  apiKeys.forEach((raw, i) => {
    const k = typeof raw === 'string' ? raw.trim() : ''
    if (!k) return
    const stored = s.apiKeys ?? []
    const idx =
      typeof stored[i] === 'string' && stored[i].trim() === k
        ? i
        : stored.findIndex((x) => typeof x === 'string' && x.trim() === k)
    slots.push({
      index: i,
      valid: idx >= 0 ? s.apiKeyValid?.[idx] ?? null : null,
      tier: idx >= 0 ? s.apiKeyTiers?.[idx] ?? 'free' : 'free'
    })
  })
  return slots
}

/**
 * What to tell the user when ranking produced no spawnable key.
 *
 * Empty configured slots and an all-rejected set are different situations; both refuse
 * the start (SOL-30) and both must say what to do next rather than spawning without `-k`.
 */
export function noUsableApiKeyMessage(slots: readonly KeySlot[]): string {
  if (slots.length === 0) {
    return 'No API key is configured. Open Settings > Gemini API Keys and enter a key before starting.'
  }
  return (
    'Every configured API key was rejected by Google. Open Settings > Gemini API Keys, ' +
    'fix or replace a key, and run “Fetch Models & Check API Keys” before starting again.'
  )
}

/**
 * Order the provided keys so a known-valid key is always used as the primary
 * (-k), with valid keys first, unknown-status keys next, and known-invalid keys
 * dropped. An all-rejected set is empty. Also reports the effective primary key's
 * tier so rate-limiting matches the key actually used.
 *
 * The ranking itself lives in `shared/keyOrder` so the Settings UI can label the exact
 * same slots "primary / fallback / reserve" without re-deriving (and mis-deriving) it.
 *
 * `slots` is optional so a long-running transcription can rank against the validity
 * captured when the job was accepted, not whatever Settings holds at spawn (SOL-31).
 */
export function orderKeysByValidity(
  apiKeys: string[],
  slots: readonly KeySlot[] = keySlotsFor(apiKeys)
): { keys: string[]; paid: boolean } {
  const ordered = orderKeySlots(slots)
  const tierOf = new Map(slots.map((s) => [s.index, s.tier]))
  return {
    keys: ordered.map((i) => apiKeys[i].trim()),
    paid: (tierOf.get(ordered[0]) ?? 'free') === 'paid'
  }
}

export function buildTranslateArgs(a: TranslateArgs, outputPath: string): string[] {
  const args: string[] = ['translate', '-i', a.inputFile, '-o', outputPath]

  const langName = gstLanguageName(a.targetLang)
  if (langName) args.push('-l', langName)

  const { keys, paid } = orderKeysByValidity(a.apiKeys)
  if (keys[0]) args.push('-k', keys[0])
  if (keys[1]) args.push('-k2', keys[1])

  if (a.audioFile) args.push('-a', a.audioFile)

  args.push('-m', a.model)
  args.push('-b', String(a.batchSize))
  args.push(...generationParamArgs(a))

  args.push(...thinkingArgs(a.thinkingLevel, a.thinkingBudget, a.model))

  if (a.serviceTier && a.serviceTier !== 'standard') {
    args.push('--service-tier', a.serviceTier)
  }
  // Use the effective primary key's tier (it may differ if the configured
  // primary was invalid and a fallback got promoted).
  if (paid) args.push('--paid-quota')
  if (!a.batchContext) args.push('--no-context')
  if (a.disableStreaming) args.push('--no-streaming')

  // Source language has no dedicated flag — fold it into the description.
  let description = a.description?.trim() ?? ''
  if (a.sourceLang && a.sourceLang !== 'auto') {
    const srcName = gstLanguageName(a.sourceLang)
    if (srcName) description = `Source language: ${srcName}.${description ? ' ' + description : ''}`
  }
  if (description) args.push('-d', description)

  if (a.resumeFrom && a.resumeFrom > 0) {
    args.push('-s', String(a.resumeFrom), '--resume')
  } else {
    // Exactly one of --resume/--no-resume must always be present: without either, the
    // engine falls back to an interactive stdin prompt, which would hang the UI (C22b).
    args.push('--no-resume')
  }

  // Ships DORMANT: the engine consults resume_context_size only when start_line > 1
  // (main.py:718-719), i.e. on a resumed run. Emitted only when it differs from the
  // engine default so argv stays clean for everyone who never touches it.
  const resumeContext = a.resumeContextSize ?? DEFAULT_RESUME_CONTEXT_SIZE
  if (resumeContext !== DEFAULT_RESUME_CONTEXT_SIZE) {
    args.push('--resume-context-size', String(resumeContext))
  }

  args.push('--token-stats', '--skip-upgrade', '--no-colors')

  if (a.progressLog) args.push('--progress-log')
  if (a.thoughtsLog) args.push('--thoughts-log')
  // --token-report takes an explicit path; gst derives progress/thoughts paths
  // from the output path automatically (replaces extension).
  if (a.writeTokenReport) {
    const reportPath = outputPath.replace(/\.[^.]+$/, '.tokens.json')
    args.push('--token-report', reportPath)
  }

  return args
}

/** Containers the engine treats as video, i.e. `-v` rather than `-a`. */
const VIDEO_MEDIA_RE = /\.(mp4|mkv|mov|avi|webm|m4v|ts|wmv|flv)$/i

export function isVideoMedia(mediaFile: string): boolean {
  return VIDEO_MEDIA_RE.test(mediaFile)
}

/**
 * Audio containers the frozen engine can actually read. Verified against gst 3.7.0 on
 * 2026-08-19 with a dummy key, so the result is local and precedes any API call: `.mp3`
 * and `.wav` pass pydub's conversion step; `.m4a`, `.aac` and `.flac` do not.
 */
const ENGINE_AUDIO_EXTS = ['.mp3', '.wav']

export function needsAudioConversion(mediaFile: string): boolean {
  if (isVideoMedia(mediaFile)) return false
  return !ENGINE_AUDIO_EXTS.includes(path.extname(mediaFile).toLowerCase())
}

export type AudioNormalizeResult =
  | { ok: true; path: string; converted: boolean }
  /** `orphaned` means the ffmpeg that was cancelled is still running — do not release the slot. */
  | { ok: false; error: string; orphaned?: boolean; orphanPid?: number; orphan?: ChildProcess }

/**
 * Give the engine an audio file it can read, converting only when it must.
 *
 * Same contract as `ensureUtf8Subtitle`, for the same class of reason: the user's original
 * file is NEVER modified, and this returns either the input path untouched or the path of a
 * separate temp copy. Video is passed straight through — the engine extracts and compresses
 * its audio itself, which is why video never hit this defect.
 */
export async function ensureEngineReadableAudio(
  mediaFile: string,
  ffmpegPath?: string,
  signal?: AbortSignal,
  onProgress?: (pct: number | null, elapsedMs: number) => void,
  onChild?: (child: ChildProcess) => void
): Promise<AudioNormalizeResult> {
  if (!needsAudioConversion(mediaFile)) return { ok: true, path: mediaFile, converted: false }

  const outPath = tempOutputPath('.mp3')
  let res: {
    ok: boolean
    error?: string
    orphaned?: boolean
    orphanPid?: number
    orphan?: ChildProcess
  }
  try {
    res = await convertAudioToMp3(mediaFile, outPath, ffmpegPath, signal, onProgress, onChild)
  } catch (err) {
    // The path is allocated before the await, so a THROW leaves a file nobody has been told about:
    // it is not the returned value and it was never registered as job scratch, so neither `finish()`
    // nor the caller can ever remove it. `convertAudioToMp3` already cleans up when it *returns* a
    // failure — this is the other exit (validator finding SOL-03, round 2).
    try {
      if (fs.existsSync(outPath)) fs.unlinkSync(outPath)
    } catch {
      /* best effort */
    }
    throw err
  }
  if (!res.ok) {
    return {
      ok: false,
      orphaned: res.orphaned,
      orphanPid: res.orphanPid,
      orphan: res.orphan,
      error:
        `Could not prepare "${path.basename(mediaFile)}" for transcription: ${res.error}\n` +
        'Convert it to MP3 or WAV and try again. Your original file was not modified.'
    }
  }
  return { ok: true, path: outPath, converted: true }
}

export function buildTranscribeArgs(
  a: TranscribeArgs,
  outputPath: string,
  keySlots?: readonly KeySlot[]
): string[] {
  const args: string[] = ['transcribe', '-o', outputPath]

  // transcribe requires -v (video) or -a (audio)
  args.push(isVideoMedia(a.mediaFile) ? '-v' : '-a', a.mediaFile)

  const { keys } = orderKeysByValidity(a.apiKeys, keySlots)
  if (keys[0]) args.push('-k', keys[0])

  args.push('-m', a.model)
  args.push(...generationParamArgs(a))
  args.push(...thinkingArgs(a.thinkingLevel, a.thinkingBudget, a.model))
  if (a.description?.trim()) args.push('-d', a.description.trim())

  args.push('--token-stats', '--skip-upgrade', '--no-colors')
  return args
}

/** Spawn gst for a job whose slot the caller has already reserved. */
function run(j: Job, args: string[], extraSecrets: readonly string[] = []): void {
  const { handlers, outputPath } = j
  if (j.finished) return
  // A Stop during preparation must not be followed by a spawn: the window between the two
  // is exactly where a cancelled job would otherwise still reach the API and spend quota.
  if (j.endReason) {
    handlers.onOutput('stderr', 'Stopped before the engine started.')
    finish(j, -1)
    return
  }
  const bin = resolveGstBin()
  const env = envWithFfmpeg(getSettings().ffmpegPath, {
    PYTHONUNBUFFERED: '1',
    // Force full UTF-8 mode so non-Latin output (Hebrew, etc.) doesn't crash on
    // Windows' legacy cp1252 ("charmap") console/locale encoding.
    PYTHONUTF8: '1',
    PYTHONIOENCODING: 'utf-8'
  })
  // What this run actually is, in one line, before it can fail to start (MAN-7). It names the
  // binary — which answers "is the packaged app running the packaged engine" from the log as
  // well as from Settings — and every flag, so `--paid-quota`, the model and the thinking
  // budget are observable instead of inferred. `maskCommandLine` is the ONLY thing permitted
  // to turn an argv into text; nothing else may hand this array to a log, a file or a console.
  // Extra secrets are the run's own key snapshot, not `getSettings()` at spawn time:
  // transcription can sit in preparation for minutes, and a reserve removed from Settings
  // in that window would otherwise print from `-d` (SOL-20).
  handlers.onOutput(
    'stdout',
    `$ ${maskCommandLine(describeEngine().path, args, extraSecrets)}`
  )

  let proc: ChildProcessWithoutNullStreams
  try {
    // `detached` on POSIX only, and it is what makes the engine its own process-group leader so that
    // Stop can signal the GROUP — see `killJob()` (SOL-10). It is NOT `unref`'d: the child stays
    // attached to this process's event loop, so stdio, `close` and every lifecycle guarantee are
    // unchanged. On Windows `detached` means something else entirely (a new console window), which
    // is why it is set per platform rather than unconditionally.
    proc = spawn(bin, args, { env, detached: process.platform !== 'win32' })
  } catch (err) {
    handlers.onOutput('stderr', `Failed to start gst: ${(err as Error).message}`)
    finish(j, -1)
    return
  }
  j.proc = proc
  // The gap between this spawn and the engine's first line is not nothing: a frozen build
  // unpacks itself into a temp directory before it runs any of our code, which on a cold
  // start is seconds of a window that says absolutely nothing. One line, once, at the only
  // moment the app knows something the engine cannot yet report about itself.
  handlers.onOutput('stdout', 'Starting engine…')

  let stdoutBuf = ''
  let stderrBuf = ''

  /**
   * End a run the engine will not end itself (REP-2).
   *
   * Only the engine's own output is measured. The lines this file emits — the command line
   * above, `Starting engine…`, and this message itself — are the app talking to the user and
   * would otherwise be counted as the engine making progress.
   *
   * The message is emitted BEFORE the kill so it precedes the terminal event, and the reason
   * is `stalled` rather than `user`: FP-3 renders `user` as "Stopped", and reporting an auth
   * failure as though the user had pressed the button would bury the cause this exists to give
   * them.
   */
  const stall = createStallWatch()
  const observe = (line: string): void => {
    if (j.finished || j.endReason) return
    const verdict = stall.observe(line, Date.now())
    if (!verdict) return
    j.endReason = 'stalled'
    handlers.onOutput('stderr', verdict.message)
    killJob(j)
  }

  proc.stdout.setEncoding('utf-8')
  proc.stderr.setEncoding('utf-8')

  proc.stdout.on('data', (chunk: string) => {
    stdoutBuf += chunk
    const lines = stdoutBuf.split(/\r?\n/)
    stdoutBuf = lines.pop() ?? ''
    for (const l of lines) {
      handlers.onOutput('stdout', l)
      observe(l)
    }
  })
  proc.stderr.on('data', (chunk: string) => {
    stderrBuf += chunk
    const lines = stderrBuf.split(/\r?\n/)
    stderrBuf = lines.pop() ?? ''
    for (const l of lines) {
      handlers.onOutput('stderr', l)
      observe(l)
    }
  })
  /** Whatever the two streams were still holding when the run ended, in order. */
  const flush = (): void => {
    if (stdoutBuf) handlers.onOutput('stdout', stdoutBuf)
    if (stderrBuf) handlers.onOutput('stderr', stderrBuf)
    stdoutBuf = ''
    stderrBuf = ''
  }
  proc.on('error', (err) => {
    handlers.onOutput('stderr', `Process error: ${err.message}`)
    // This used to report and stop there, on the assumption that `close` would follow and end
    // the job. Node does not promise that — "the exit event may or may not fire after an error"
    // — and one of the documented causes is a kill that FAILED, where the child is still alive
    // and no close is coming by definition. `killJob()` cannot cover it either: it catches a
    // synchronous throw, and `proc.kill()` reports EPERM through this event instead.
    //
    // The cost of getting it wrong is the whole application: the job slot stays held, so every
    // later run of either kind is refused for the life of the process, with no terminal event to
    // release the page that asked. Ending here is safe in the ordinary case too, because
    // `finish()` is idempotent and the close that usually does follow finds the job already done.
    //
    // But NOT unconditionally, because the failed-kill case is exactly the one where the child is
    // still alive: ending then would release the slot to a second engine while the first is still
    // running and still writing into the shared output channel. The child is asked directly.
    if (engineOutlivedItsKill(j)) return
    flush()
    finish(j, -1)
  })
  proc.on('close', (code) => {
    flush()
    finish(j, code)
  })
}

export interface StartTranslateResult {
  outputPath: string
  /** Paths of any log/report files gst will write alongside outputPath (may be empty). */
  logPaths: string[]
  /**
   * The subtitle path the engine actually read.
   *
   * After UTF-8 normalisation this is a temp copy, not `TranslateArgs.inputFile`. Output
   * sanity must compare against this file or it judges different text from the translation
   * (SOL-21).
   */
  sourcePath: string
}

export function startTranslate(a: TranslateArgs, handlers: SpawnHandlers): StartTranslateResult {
  // The output must keep the input's format. gst decides how to WRITE the result from the
  // output path's extension (main.py:141-142), so handing it a `.srt` name for an `.ass`
  // job silently downgrades a styled subtitle to plain SRT.
  const inExt = path.extname(a.inputFile).toLowerCase()
  const outputPath = tempOutputPath(SUBTITLE_EXTS.includes(inExt) ? inExt : '.srt')

  const j = beginJob(handlers, outputPath)
  if (!j) {
    refuseStart(handlers, outputPath)
    return { outputPath, logPaths: [], sourcePath: a.inputFile }
  }
  // Everything from here on speaks through the JOB's handlers, which tee into its console log.
  // Rebinding the parameter rather than changing each call site is deliberate: the alternative
  // relies on every future message remembering to use `j.handlers`, and a message that forgets
  // is a line the user can read on screen and cannot send to anyone.
  handlers = j.handlers

  const keySnapshot = keySlotsFor(a.apiKeys)
  if (orderKeySlots(keySnapshot).length === 0) {
    handlers.onOutput('stderr', noUsableApiKeyMessage(keySnapshot))
    j.endReason = 'guard'
    finish(j, -1)
    return { outputPath, logPaths: [], sourcePath: a.inputFile }
  }

  const norm = ensureUtf8Subtitle(a.inputFile)
  if (!norm.ok) {
    handlers.onOutput('stderr', norm.error)
    finish(j, -1)
    return { outputPath, logPaths: [], sourcePath: a.inputFile }
  }
  const normalized: TranslateArgs = { ...a, inputFile: norm.path }
  // The normalized subtitle is deliberately NOT scratch: gst names the progress and thoughts
  // logs from this path, and TranslatePage copies those sidecars after the job ends.
  run(j, buildTranslateArgs(normalized, outputPath), normalized.apiKeys)

  const logPaths: string[] = []
  // The token report is written to the explicit --token-report path we pass
  // (derived from the OUTPUT file). Progress/thoughts logs, however, are named
  // by gst from the INPUT file's basename/dir (see gemini_srt_translator main.py),
  // so they must be derived from the normalized input path, not the output.
  const outBase = outputPath.replace(/\.[^.]+$/, '')
  const inBase = normalized.inputFile.replace(/\.[^.]+$/, '')
  if (a.writeTokenReport) logPaths.push(`${outBase}.tokens.json`)
  if (a.progressLog)      logPaths.push(`${inBase}.progress.log`)
  if (a.thoughtsLog)      logPaths.push(`${inBase}.thoughts.log`)

  return { outputPath, logPaths, sourcePath: normalized.inputFile }
}

export async function startTranscribe(
  a: TranscribeArgs,
  handlers: SpawnHandlers,
  /**
   * Ask the API whether the key is any good, before a transcription commits to it.
   *
   * Injected rather than imported: `modelsList` already imports this file for `resolveGstBin`,
   * so calling it from here would close an import cycle. `ipc` sits above both and supplies it.
   *
   * It runs INSIDE the job, with the job's abort signal, for the reason FP6-01 taught: work
   * placed in front of cancellable work inherits its cancellation, or Stop does nothing while
   * it runs and the single job slot stays held.
   */
  preflight?: (
    apiKey: string,
    signal: AbortSignal,
    adopt?: (child: ChildProcess) => void
  ) => Promise<KeyPreflight>
): Promise<string> {
  // The slot is taken BEFORE the conversion, not after it. Otherwise the app reports idle
  // for the length of the conversion, and a second job started in that window would later
  // be refused by a `run()` that had no way to tell this page it had ended.
  const j = beginJob(handlers, a.outputFile)
  if (!j) {
    refuseStart(handlers, a.outputFile)
    return a.outputFile
  }
  // As in `startTranslate`, and for the same reason. This path has more to say before the engine
  // exists than any other — the key preflight and the audio conversion both report here — so it
  // is the one that would lose the most.
  handlers = j.handlers

  // Rank once against the store as it stood when the slot was taken. Transcription can sit
  // in conversion for minutes; a later live reread would let Settings promote a key that
  // was neither preflighted nor covered by the model guard (SOL-31). An all-rejected set
  // is empty and refuses here rather than resurrecting a proven-dead credential (SOL-30).
  const keySnapshot = keySlotsFor(a.apiKeys)
  const primaryKey = orderKeysByValidity(a.apiKeys, keySnapshot).keys[0] ?? ''
  if (!primaryKey) {
    handlers.onOutput('stderr', noUsableApiKeyMessage(keySnapshot))
    j.endReason = 'guard'
    finish(j, -1)
    return a.outputFile
  }
  // REP-2's cheaper half. Translation gets this free — the engine's own `ListModels` call
  // rejects a bad key and exits 1 — while transcription hands the same credential straight to
  // the per-segment retry loop, which has no ceiling and answers a permanent 400 with
  // `Retrying immediately...` for as long as it is left alone. The measured result was 97 GB.
  if (preflight) {
    handlers.onOutput('stdout', 'Checking the API key…')
    j.prep = new AbortController()
    const adopt = (child: ChildProcess): void => {
      if (!j.finished) j.prepChild = child
    }
    let verdict: KeyPreflight
    try {
      verdict = await preflight(primaryKey, j.prep.signal, adopt)
    } catch (err) {
      // A preflight that THROWS has learned nothing about the key, so it is treated as
      // exactly that and the run continues. Two reasons this is the safe direction:
      //
      //  - Refusing here would let a fault in the check make transcription impossible,
      //    which is a worse outcome than the runaway it guards against — and that runaway
      //    is already covered by the stall budget in `run()`, which needs no cooperation
      //    from this path.
      //  - Letting it propagate is worse still, and is what this guard exists for: the
      //    rejection would escape `startTranscribe` with the job slot reserved and
      //    `finish()` never called, so `isRunning()` would stay true for the life of the
      //    process and every later run — of either kind — would be refused.
      verdict = {
        verdict: 'unchecked',
        message: `Could not check the API key: ${err instanceof Error ? err.message : String(err)}`
      }
    } finally {
      // In `finally` so a throw cannot leave a used controller behind. Stop would then abort
      // a signal nobody is listening to and conclude a preparation step was still running.
      j.prep = null
    }
    if (j.finished) return a.outputFile
    // A preflight process that survived its kill holds the slot open, and it must, for exactly the
    // reason `engineOutlivedItsKill()` gives: ending the run frees the slot, and freeing it while
    // that process is alive is what puts two engines on one key. Checked BEFORE the Stop branch
    // below, because a Stop is the ordinary way to reach this state (SOL-02).
    if (verdict.orphaned || (j.endReason && stillHasPrepChild(j))) {
      handlers.onOutput(
        'stderr',
        `The API key check did not stop (pid ${verdict.orphanPid ?? j.prepChild?.pid ?? 'unknown'}). This run stays ` +
          'open until it exits, because starting another one now would put two engines on the same ' +
          'API key. It will end by itself when that process goes.'
      )
      ownOrphan(j, verdict.orphan ?? j.prepChild ?? undefined)
      return a.outputFile
    }
    if (j.endReason) {
      handlers.onOutput('stderr', 'Stopped while checking the API key.')
      finish(j, -1)
      return a.outputFile
    }
    j.prepChild = null
    if (verdict.verdict === 'rejected') {
      handlers.onOutput('stderr', verdict.message)
      j.endReason = 'guard'
      finish(j, -1)
      return a.outputFile
    }
    // Unreachable is a warning, never a refusal: the run may well succeed, and the stall
    // budget in `run()` is what catches a key that turns out to be bad after all.
    if (verdict.verdict === 'unchecked' && verdict.message) {
      handlers.onOutput('stderr', verdict.message)
    }
  }

  let mediaFile = a.mediaFile
  if (needsAudioConversion(a.mediaFile)) {
    // Announced before the work starts, because on a long file this is a visible pause and
    // the user is otherwise looking at a window that appears to be doing nothing.
    handlers.onOutput(
      'stdout',
      `Preparing ${path.basename(a.mediaFile)} — converting to MP3, which is the format the engine reads…`
    )
    j.prep = new AbortController()
    const adopt = (child: ChildProcess): void => {
      if (!j.finished) j.prepChild = child
    }
    const startedAt = Date.now()
    let prepared: AudioNormalizeResult
    try {
      prepared = await ensureEngineReadableAudio(
        a.mediaFile,
        getSettings().ffmpegPath,
        j.prep.signal,
        (pct, elapsedMs) => handlers.onProgress?.({ kind: 'convert', pct, elapsedMs }),
        adopt
      )
    } catch (err) {
      // The same guard the key preflight above already carries, and it was missing here — which
      // was worse, not better, because this half has no `verdict` to fall back on. A throw
      // escaping `startTranscribe` leaves `j.prep` set and `finish()` uncalled, so the slot is
      // held for the life of the process: `killJob()` sees no `proc` but a non-null `prep`,
      // concludes a preparation step still owns the terminal event, and returns without ending
      // anything. Stop cannot recover it and every later run of either kind is refused.
      // `tempOutputPath()` is the reachable case — it calls `mkdirSync`, which throws on a
      // read-only or occupied userData/temp — but the point is that ANY rejection is now a
      // failed conversion rather than an escape (validator finding SOL-03).
      prepared = {
        ok: false,
        error:
          `Could not prepare "${path.basename(a.mediaFile)}" for transcription: ` +
          `${err instanceof Error ? err.message : String(err)}\n` +
          'Your original file was not modified.'
      }
    } finally {
      // In `finally` for the reason the preflight documents: a used controller left behind
      // makes a later Stop abort a signal nobody is listening to, and conclude that a
      // preparation step is still running.
      j.prep = null
    }
    // Emitted on EVERY outcome, including an abort and a failure: the page showing this
    // conversion has no promise of its own to wait on, so this event is the only thing that
    // can tell it the conversion is over. It is sent before any terminal event below, so a
    // stopped run never leaves a bar behind.
    handlers.onProgress?.({
      kind: 'convert',
      pct: null,
      elapsedMs: Date.now() - startedAt,
      done: true
    })

    // A Stop that landed in the gap after the conversion finished has already ended the
    // job; saying anything more here would follow a terminal event with stray output.
    if (j.finished) return a.outputFile
    // An ffmpeg that outlived its cancellation holds this run open, before either the Stop message
    // or the failure message below: both of those end the job, and ending it would release the slot
    // while that process is still converting (SOL-02, round 3). Same rule as the preflight above.
    if ((!prepared.ok && prepared.orphaned) || (j.endReason && stillHasPrepChild(j))) {
      handlers.onOutput(
        'stderr',
        'The audio conversion did not stop. This run stays open until that process exits, because ' +
          'starting another one now would run two conversions over the same files.'
      )
      ownOrphan(j, (!prepared.ok ? prepared.orphan : undefined) ?? j.prepChild ?? undefined)
      return a.outputFile
    }
    // Cancellation is checked first: an aborted conversion also reports failure, and
    // "Could not prepare…" would be a confusing thing to say to someone who pressed Stop.
    if (j.endReason) {
      handlers.onOutput('stderr', 'Stopped while preparing the audio.')
      finish(j, -1)
      return a.outputFile
    }
    if (!prepared.ok) {
      handlers.onOutput('stderr', prepared.error)
      finish(j, -1)
      return a.outputFile
    }
    if (prepared.converted) j.scratch.push(prepared.path)
    mediaFile = prepared.path
    j.prepChild = null
  }

  run(j, buildTranscribeArgs({ ...a, mediaFile }, a.outputFile, keySnapshot), a.apiKeys)
  return a.outputFile
}

/**
 * End the current job because the USER asked to.
 *
 * `user` is set here and nowhere else: it is what makes the panel say "Stopped" instead of
 * "Failed", so anything else that ends a run must carry its own reason rather than borrow this
 * one, or a failure the user did not cause would be reported as their own doing.
 */
export function stopCurrent(): void {
  const j = job
  if (!j) return
  j.endReason = 'user'

  // Cancel a conversion that has not finished. The awaiting `startTranscribe` sees the reason
  // and ends the job, so this path still produces exactly one terminal event.
  j.prep?.abort()
  killJob(j)
}

export function isRunning(): boolean {
  return job !== null
}

/**
 * End whatever is running because the APPLICATION is closing.
 *
 * Shutdown used to bypass all of this: `window-all-closed` called `app.quit()` and nothing asked
 * the bridge whether it was in the middle of something. On Windows a parent's exit does not take
 * its children with it, and no job object owns them — so a running `gst`, a preflight `gst`, an
 * ffmpeg or an ffprobe simply carried on after the window vanished: still spending the user's
 * quota, still writing to a file nobody would ever look at, with the temp media never deleted and
 * the console never closed. Every guarantee FP-8 established for Stop was absent from the one
 * ending that happens to every run eventually (validator finding SOL-04).
 *
 * Resolves when the job has ended, or when the grace period expires — bounded on purpose, because
 * an engine that will not die must not be able to stop the user closing the application. The
 * `reason` is deliberately NOT `user`: nobody pressed Stop, and FP-3 renders `user` as "Stopped".
 */
/**
 * Wait for a job to reach its own ending, up to a deadline.
 *
 * The wait a PREPARATION step needs. There is no child to watch — the preflight or the conversion
 * holds it — so the observable event is the job ending, which the awaiting `startTranscribe` does
 * once the abort reaches it. Resolves `false` on the deadline, which the caller reads as "still busy".
 */
function waitForJobToFinish(j: Job, deadline: number): Promise<boolean> {
  if (j.finished) return Promise.resolve(true)
  return new Promise<boolean>((resolve) => {
    const poll = setInterval(() => {
      if (j.finished) {
        clearInterval(poll)
        resolve(true)
        return
      }
      if (Date.now() < deadline) return
      clearInterval(poll)
      resolve(false)
    }, 100)
    void poll
  })
}

export async function shutdownJob(graceMs = 4_000): Promise<void> {
  const j = job
  if (!j) return
  j.endReason = 'guard'
  j.prep?.abort()
  const engine = j.proc
  const prep = j.prepChild
  killJob(j)
  if (j.finished && !childIsAlive(engine?.pid) && !(prep && !hasExited(prep))) return

  // The ordinary termination is a REQUEST, and the first version of this shutdown treated its own
  // four-second deadline as an ending: it closed the console and resolved, then the second
  // `app.quit()` exited while the child was still there — recreating the orphan it was written to
  // prevent, only less predictably (validator finding SOL-04, round 2). So the deadline now
  // escalates to a forced tree kill instead of expiring into a shrug.
  const attemptGrace = Math.max(500, Math.floor(graceMs / 2))
  // Preparation used to be waited for by outcome alone, and that wait was shorter than the
  // helpers' own escalation windows (FFmpeg ~6s, preflight ~10s vs shutdown's 4s). Once the
  // deadline expired there was no ChildProcess to escalate against, so the app quit while the
  // conversion or fetch was still dying (SOL-04, round 4). The child is adopted at spawn, so
  // shutdown can wait on it the same way it waits on the engine.
  const target = engine ?? prep
  if (target) {
    const gone = await waitForChildExit(target, { graceMs: attemptGrace, attempts: 2 })
    if (!gone) {
      forceKillTree(target)
      const confirmed = await waitForChildExit(target, { graceMs: 500, attempts: 1 })
      if (!confirmed) {
        const note = `[shutdown] pid ${target.pid ?? 'unknown'} survived a forced kill and may still be running`
        console.log(note)
        j.console?.write(note)
      }
    }
  } else {
    // The child has not been adopted yet — spawn has not returned. Wait long enough for the
    // helper's own waitForChildExit (preflight grace 5s × 2 attempts) plus a small buffer, then
    // take any child that appeared in the meantime.
    const prepDeadline = Date.now() + Math.max(graceMs, 12_000)
    await waitForJobToFinish(j, prepDeadline)
    if (!j.finished && j.prepChild) {
      forceKillTree(j.prepChild)
      await waitForChildExit(j.prepChild, { graceMs: 500, attempts: 1 })
    }
  }
  // The scratch files and the console are `finish()`'s job on every ordinary path; this is the path
  // where `finish()` may never come, so they are done here instead. Deleting the temp media matters
  // most: an abandoned conversion can be hundreds of megabytes.
  if (!j.finished) {
    for (const file of j.scratch) {
      try {
        fs.unlinkSync(file)
      } catch {
        /* best effort — a temp file we cannot delete must not stop the app closing */
      }
    }
    j.scratch = []
    j.console?.close()
  }
}
