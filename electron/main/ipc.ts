import { ipcMain, dialog, shell, BrowserWindow } from 'electron'
import fs from 'fs'
import path from 'path'
import { getSettings, setSettings, store } from './store'
import { probeTracks, extractTrack } from './ffmpeg'
import { tmdbSearch, tmdbCast } from './tmdb'
import {
  refreshModels,
  buildModelList,
  checkApiKeys,
  guardModelForSpawn,
  resolveDefaultModel,
  resolveDefaultModelWithBasis,
  summarizeRefresh,
  type ModelAvailability
} from './modelsList'
import {
  startTranslate,
  startTranscribe,
  stopCurrent,
  isRunning,
  tempOutputPath,
  keySlotsFor
} from './pythonBridge'
import { activeKeySlots } from '../shared/keyOrder'
import { scanTranslatedOutput } from '../shared/outputSanity'
import type {
  TranslateArgs,
  TranscribeArgs,
  AppSettings,
  ModelInfo,
  RefreshOutcome,
  SlotFetchResult
} from '../shared/types'

let win: BrowserWindow | null = null
export function setMainWindow(w: BrowserWindow): void {
  win = w
}

function send(channel: string, payload: unknown): void {
  win?.webContents.send(channel, payload)
}

/**
 * Read a finished subtitle and compare it against its source (REP-16).
 *
 * Guarded to the point of paranoia on purpose: this runs on the path that delivers the terminal
 * event, so anything it threw would strand a finished job with no `done` at all — a worse failure
 * than the corruption it looks for. A missing, empty, unreadable or unparseable file simply
 * produces no warnings. It is the only *read* this path performs, and the files were written
 * moments earlier, so they are small and warm.
 */
export function scanOutputFiles(sourcePath: string, outputPath: string): string[] {
  try {
    if (!sourcePath || !outputPath) return []
    if (!fs.existsSync(sourcePath) || !fs.existsSync(outputPath)) return []
    if (!fs.statSync(sourcePath).isFile() || !fs.statSync(outputPath).isFile()) return []
    const source = fs.readFileSync(sourcePath, 'utf-8')
    const output = fs.readFileSync(outputPath, 'utf-8')
    return scanTranslatedOutput(source, output).map((w) => w.message)
  } catch {
    return []
  }
}

/**
 * Point a token report at the files the user can actually see (REP-1).
 *
 * The engine records the paths it was handed, which are ours: a temp `.srt` for the output and,
 * when the input needed re-encoding, a temp `.utf8.srt` for the input. Both are gone by the time
 * the user opens the report sitting next to their saved subtitle.
 *
 * Pure, and total. A report we cannot parse is returned untouched, which reproduces exactly what
 * the old copy did — the file is the engine's evidence, and mangling it would be worse than leaving
 * a stale path in it. `inputPath` is optional for the same reason: when the caller does not know
 * the user's source, the original value stays rather than being replaced by a guess.
 */
export function retargetTokenReport(json: string, inputPath: string, outputPath: string): string {
  try {
    const report = JSON.parse(json) as Record<string, unknown>
    if (report === null || typeof report !== 'object' || Array.isArray(report)) return json
    if (outputPath) report.output_file = outputPath
    if (inputPath) report.input_file = inputPath
    // Two-space indent matches what the engine writes, so a user diffing the two sees only paths.
    return JSON.stringify(report, null, 2)
  } catch {
    return json
  }
}

export interface SingleKeyRefreshScope {
  /** One entry per configured slot, so completeness is judged over the real key set. */
  slots: SlotFetchResult[]
  activeSlots: number[]
  /** False when the supplied key is not one of the configured slots — display only. */
  authoritative: boolean
}

/**
 * Describe a one-key refresh in terms of the user's CONFIGURED slots.
 *
 * The subtlety is the unknown-key case. Building a lone `slot 0` descriptor for a key the
 * user has not saved makes the summary read `allComplete`, which is the strongest evidence
 * bar in the system — the one that authorises deleting a model selection. Nothing about
 * asking a stranger's key justifies that, so the scope is marked non-authoritative and the
 * caller must not persist or apply anything from it.
 */
export function singleKeyRefreshScope(
  configured: string[],
  apiKey: string,
  ids: string[]
): SingleKeyRefreshScope {
  const slotIndex = configured.findIndex((k) => (k ?? '').trim() === apiKey.trim())
  if (slotIndex === -1) {
    return { slots: [{ slot: 0, queried: true, ok: true, ids }], activeSlots: [0], authoritative: false }
  }
  // Every OTHER configured key is recorded as queried-but-unanswered, because that is the
  // truth: this handler asked exactly one key. Claiming `allComplete` from a single answer
  // while other keys are configured would let one key's list authorise a destructive reset
  // of a model the untested keys can still see.
  return {
    slots: configured.map((k, i) => ({
      slot: i,
      queried: !!(k ?? '').trim(),
      ok: i === slotIndex,
      ids: i === slotIndex ? ids : []
    })),
    activeSlots: activeKeySlots(keySlotsFor(configured)),
    authoritative: true
  }
}

export interface ModelSelectionOutcome {
  /** The model the app should now have selected (unchanged unless a rule fired). */
  model: string
  /** Non-empty when the user must be told something about that selection. */
  notice: string
  /** True when a rule changed the stored selection. */
  changed: boolean
}

/**
 * The three — and ONLY three — situations in which a refresh may touch the stored model.
 * Everything else leaves the user's choice alone; a refresh otherwise only ADDS models.
 *
 * Each case is gated on a different refresh outcome because each carries a different
 * consequence. Reads as a single function so the evidence bar for the one destructive
 * case can be checked in one place rather than inferred from scattered conditions.
 */
export function applyModelSelectionRules(
  stored: string,
  prevCached: ModelInfo[],
  next: { models: ModelInfo[]; unionIds: string[]; runnableIds: string[]; outcome: RefreshOutcome }
): ModelSelectionOutcome {
  const runnable = next.models.filter((m) => next.runnableIds.includes(m.id))
  const newDefault = resolveDefaultModel(runnable)
  const verified = next.outcome === 'allComplete' || next.outcome === 'activeComplete'

  // 1. Nothing to protect.
  if (!stored) {
    return newDefault
      ? { model: newDefault, notice: '', changed: true }
      : { model: stored, notice: '', changed: false }
  }

  // 2. PROVEN absent — the only destructive case, so the bar is the strictest one:
  // every configured slot answered, and the id is in none of their lists. A non-empty
  // union is required because an "allComplete" refresh that returned nothing is a bug,
  // not evidence that every model was withdrawn.
  const provenAbsent =
    next.outcome === 'allComplete' &&
    next.unionIds.length > 0 &&
    !next.unionIds.includes(stored)
  if (provenAbsent && newDefault) {
    return {
      model: newDefault,
      notice: `"${stored}" is no longer offered by your API key(s); switched to the newest available model.`,
      changed: true
    }
  }

  // 3. Auto-advance. Gated on activeComplete, NOT allComplete: an unused reserve key going
  // stale is an expected steady state, and letting it veto this would permanently freeze
  // everyone on an old model.
  //
  // The `basis` check is what keeps this from eating a deliberate override: if the
  // previous list contained no flash-lite or flash at all, its "default" was just the
  // newest of whatever was there, and matching against it would prove nothing about
  // whether the user had chosen that model on purpose.
  const prevRunnable = prevCached.filter((m) => m.source === 'live')
  const prev = resolveDefaultModelWithBasis(prevRunnable.length ? prevRunnable : prevCached)
  const prevWasRealDefault = prev.basis === 'flash-lite' || prev.basis === 'flash'
  if (verified && newDefault && prevWasRealDefault && stored === prev.id && newDefault !== stored) {
    return {
      model: newDefault,
      notice: `A newer model is available — switched to ${newDefault}.`,
      changed: true
    }
  }

  // Present somewhere, but not on every key this run may use. The model demonstrably
  // exists, so this is a warning, never a reset.
  if (verified && next.unionIds.includes(stored) && !next.runnableIds.includes(stored)) {
    return {
      model: stored,
      notice: `"${stored}" is not available on every API key this run may use. If the engine switches keys mid-run, it may fail.`,
      changed: false
    }
  }

  if (next.outcome === 'partial' || next.outcome === 'failed') {
    return {
      model: stored,
      notice: 'Some API keys could not be checked — showing the last known model list.',
      changed: false
    }
  }

  return { model: stored, notice: '', changed: false }
}

export function registerIpc(): void {
  // ---- Settings ----
  ipcMain.handle('settings:get', () => getSettings())
  ipcMain.handle('settings:set', (_e, patch: Partial<AppSettings>) => setSettings(patch))

  // ---- Models ----
  ipcMain.handle('models:getCached', () => {
    // Re-curate cached ids through the current rules so older caches get the corrected
    // friendly names / filtering without forcing a re-fetch. Provenance is fed back in so
    // re-curation never upgrades a seed entry into a "live" one, nor forgets which key
    // slots reported a live one.
    const cached = (store.get('cachedModels') as ModelInfo[]) || []
    const availability: ModelAvailability = {}
    for (const m of cached) {
      if (m?.source === 'live' && Array.isArray(m.availableOn) && m.availableOn.length) {
        availability[m.id] = m.availableOn
      }
    }
    const models = buildModelList(cached.map((m) => m.id), availability)
    return { models, updatedAt: store.get('modelsUpdatedAt') }
  })

  // Single-key refresh (kept for callers that only have one key at hand). The list is
  // curated from that one key's ids, so everything it reports is available on that slot
  // and the runnable set is simply that list.
  ipcMain.handle('models:refresh', async (_e, apiKey: string) => {
    const { ids, keyValid, error } = await refreshModels(apiKey)
    const updatedAt = new Date().toISOString()
    if (!keyValid) return { models: [], updatedAt, keyValid, error, notice: '' }

    const s = getSettings()
    const prevCached = (s.cachedModels as ModelInfo[]) ?? []
    const configured = s.apiKeys ?? []
    const scope = singleKeyRefreshScope(configured, apiKey, ids)
    const summary = summarizeRefresh(scope.slots, scope.activeSlots)

    // A key that is not one of the configured slots speaks for nobody: none of the user's
    // own keys were asked, so this list is display material only. Persisting it — or
    // letting it run the selection rules — would let an arbitrary caller-supplied key
    // authorise a "proven absent" reset of a model every configured key can still see.
    if (!scope.authoritative) {
      return { models: summary.models, updatedAt, keyValid, error, notice: '' }
    }

    const sel = applyModelSelectionRules(s.model, prevCached, {
      models: summary.models,
      unionIds: summary.unionIds,
      runnableIds: summary.runnableIds,
      outcome: summary.refreshOutcome
    })
    const verified =
      summary.refreshOutcome === 'allComplete' || summary.refreshOutcome === 'activeComplete'

    const patch: Partial<AppSettings> = {}
    if (verified && summary.models.length > 0) {
      patch.cachedModels = summary.models
      patch.modelsUpdatedAt = updatedAt
    }
    if (sel.changed) patch.model = sel.model
    if (verified && summary.unionIds.includes(sel.model)) patch.modelNeedsVerification = false
    setSettings(patch)

    return { models: summary.models, updatedAt, keyValid, error, notice: sel.notice }
  })

  // Validate EVERY provided key and keep each one's answer. The model list is the union,
  // annotated with which slots reported each id; `runnableIds` is the subset available on
  // every active-set key, which is what the picker may safely default to.
  ipcMain.handle('models:checkKeys', async (_e, keys: string[]) => {
    const res = await checkApiKeys(keys)
    const updatedAt = new Date().toISOString()

    // Per-slot fetch diagnostics for the B3 persistence probe. Debug-gated rather than
    // deleted: it is the only way to see which key answered when a refresh comes back
    // partial, but it is per-key detail that should not run in production. Enable with
    // SRT_DEBUG_MODELS=1. Prints slot INDICES and counts only — never key material.
    if (process.env.SRT_DEBUG_MODELS) {
      for (const s of res.slots) {
        console.log(`[models] slot ${s.slot}: queried=${s.queried} ok=${s.ok} ids=${s.ids.length}`)
      }
      console.log(
        `[models] outcome=${res.refreshOutcome} activeSlots=[${res.activeSlots.join(',')}] ` +
          `union=${res.unionIds.length} runnable=${res.runnableIds.length} ` +
          `persisted=${res.models.length > 0}`
      )
    }

    // The previous cache must be read BEFORE the write below: the auto-advance rule
    // compares the stored model against the PREVIOUS list's default.
    const prevCached = (getSettings().cachedModels as ModelInfo[]) ?? []
    const sel = applyModelSelectionRules(getSettings().model, prevCached, {
      models: res.models,
      unionIds: res.unionIds,
      runnableIds: res.runnableIds,
      outcome: res.refreshOutcome
    })

    const patch: Partial<AppSettings> = {
      apiKeyValid: res.results.map((r) => r.valid),
      apiKeyError: res.results.map((r) => r.error)
    }
    // Overwrite the cache ONLY at the activeComplete bar. On a partial or failed refresh
    // the union is missing whatever the failed key alone could see, so writing it would
    // quietly delete real models from the picker — and, because the pre-spawn guard reads
    // this cache, could then block a selection that a transient network error caused to
    // "disappear". The last known good list stays, marked stale in the UI instead.
    const verified = res.refreshOutcome === 'allComplete' || res.refreshOutcome === 'activeComplete'
    if (verified && res.models.length > 0) {
      patch.cachedModels = res.models
      patch.modelsUpdatedAt = updatedAt
    }
    if (sel.changed) patch.model = sel.model
    // Advisory flag from migrations M1/M3: only live evidence may clear it, and only at
    // the activeComplete bar. A partial refresh proves nothing about the stored id.
    if (verified && res.unionIds.includes(sel.model)) patch.modelNeedsVerification = false
    setSettings(patch)

    return {
      results: res.results,
      slots: res.slots,
      models: res.models,
      unionIds: res.unionIds,
      runnableIds: res.runnableIds,
      activeSlots: res.activeSlots,
      refreshOutcome: res.refreshOutcome,
      model: sel.model,
      notice: sel.notice,
      updatedAt,
      anyValid: res.anyValid
    }
  })

  // ---- File dialogs ----
  ipcMain.handle(
    'dialog:openFile',
    async (_e, opts: { filters?: Electron.FileFilter[] }) => {
      if (!win) return ''
      const res = await dialog.showOpenDialog(win, {
        properties: ['openFile'],
        filters: opts?.filters
      })
      return res.canceled ? '' : res.filePaths[0]
    }
  )

  ipcMain.handle('dialog:openFolder', async () => {
    if (!win) return ''
    const res = await dialog.showOpenDialog(win, { properties: ['openDirectory'] })
    return res.canceled ? '' : res.filePaths[0]
  })

  ipcMain.handle(
    'dialog:saveFile',
    async (
      _e,
      args: {
        srcPath?: string
        defaultName: string
        defaultDir?: string
        logPaths?: string[]
        /** The file the user chose to translate, so the token report can name it (REP-1). */
        inputPath?: string
      }
    ) => {
      if (!win) return ''
      const defaultPath = args.defaultDir
        ? path.join(args.defaultDir, args.defaultName)
        : args.defaultName
      const res = await dialog.showSaveDialog(win, {
        defaultPath,
        filters: [
          { name: 'Subtitles', extensions: ['srt', 'sup', 'ass'] },
          { name: 'All Files', extensions: ['*'] }
        ]
      })
      if (res.canceled || !res.filePath) return ''
      if (args.srcPath && fs.existsSync(args.srcPath)) {
        fs.copyFileSync(args.srcPath, res.filePath)
      }
      // Copy any log/report files (token report, progress, thoughts) next to the saved SRT.
      // Each temp log path shares the same base as the temp SRT; we re-derive the dest
      // path using the same extension so they land alongside the user-chosen file.
      if (args.logPaths?.length) {
        const destBase = res.filePath.replace(/\.[^.]+$/, '')
        // Preserve the full compound suffix (e.g. ".tokens.json", ".progress.log")
        // rather than just path.extname() — otherwise ".tokens.json" would become
        // ".json" and ".progress.log"/".thoughts.log" would collide on ".log".
        const KNOWN_SUFFIXES = ['.tokens.json', '.progress.log', '.thoughts.log']
        for (const logPath of args.logPaths) {
          if (fs.existsSync(logPath)) {
            const suffix = KNOWN_SUFFIXES.find((s) => logPath.endsWith(s)) ?? path.extname(logPath)
            const dest = `${destBase}${suffix}`
            try {
              // The token report records the temp paths the engine was handed, so the user opens a
              // file next to their subtitle and reads two paths that no longer exist (REP-1). Only
              // this one sidecar is rewritten; everything else is still copied byte for byte.
              if (suffix === '.tokens.json') {
                const report = fs.readFileSync(logPath, 'utf-8')
                fs.writeFileSync(dest, retargetTokenReport(report, args.inputPath ?? '', res.filePath))
              } else {
                fs.copyFileSync(logPath, dest)
              }
            } catch {
              // Non-fatal: log file copy failure should not block the SRT save.
            }
          }
        }
      }
      return res.filePath
    }
  )

  // ---- Shell helpers ----
  ipcMain.handle('shell:showItem', (_e, p: string) => {
    if (p) shell.showItemInFolder(p)
  })
  ipcMain.handle('shell:openExternal', (_e, url: string) => shell.openExternal(url))

  // ---- Video tracks ----
  ipcMain.handle('video:probeTracks', async (_e, filePath: string) => {
    const { ffmpegPath } = getSettings()
    return probeTracks(filePath, ffmpegPath)
  })

  // Silent extraction to a temp .srt (used as translation input for a chosen track)
  ipcMain.handle(
    'video:extractToTemp',
    async (_e, args: { filePath: string; subtitleIndex: number }) => {
      const { ffmpegPath } = getSettings()
      const out = tempOutputPath('.srt')
      const res = await extractTrack(args.filePath, args.subtitleIndex, out, false, ffmpegPath)
      return res.ok ? { ok: true, path: out } : { ok: false, error: res.error }
    }
  )

  ipcMain.handle(
    'video:extractTrack',
    async (
      _e,
      args: { filePath: string; subtitleIndex: number; isImage: boolean; defaultName: string }
    ) => {
      if (!win) return { ok: false, error: 'no window' }
      const { ffmpegPath, outputFolder } = getSettings()
      const defaultPath = outputFolder
        ? path.join(outputFolder, args.defaultName)
        : args.defaultName
      const res = await dialog.showSaveDialog(win, { defaultPath })
      if (res.canceled || !res.filePath) return { ok: false, canceled: true }
      const out = await extractTrack(
        args.filePath,
        args.subtitleIndex,
        res.filePath,
        args.isImage,
        ffmpegPath
      )
      return { ...out, path: res.filePath }
    }
  )

  // ---- TMDB ----
  ipcMain.handle(
    'tmdb:search',
    async (_e, args: { query: string; type: 'all' | 'movie' | 'tv' }) => {
      const { tmdbApiKey } = getSettings()
      return tmdbSearch(tmdbApiKey, args.query, args.type)
    }
  )
  ipcMain.handle(
    'tmdb:cast',
    async (_e, args: { tmdbId: string; mediaType: 'movie' | 'tv' }) => {
      const { tmdbApiKey } = getSettings()
      return tmdbCast(tmdbApiKey, args.tmdbId, args.mediaType)
    }
  )

  // ---- Translate / Transcribe ----

  /**
   * Check the chosen model against what the keys actually reported, just before spawning.
   *
   * Lives here rather than in `pythonBridge` on purpose: `modelsList` already imports the
   * bridge for `resolveGstBin`, so calling the guard from inside the bridge would close an
   * import cycle. `ipc` sits above both, so this is the natural seam — and it is the one
   * point every run passes through.
   *
   * Returns false when the run must not start; the refusal is reported on the same output
   * channel a failed run uses, so the UI needs no new path to surface it.
   */
  const passesModelGuard = (model: string, keys: string[]): boolean => {
    const s = getSettings()
    const verdict = guardModelForSpawn(
      model,
      (s.cachedModels as ModelInfo[]) ?? [],
      activeKeySlots(keySlotsFor(keys))
    )
    if (verdict.warning) send('translate:output', { stream: 'stderr', line: verdict.warning })
    if (!verdict.ok) {
      send('translate:output', { stream: 'stderr', line: verdict.error ?? 'Model unavailable.' })
      send('translate:done', { code: -1, outputPath: '' })
      return false
    }
    return true
  }

  ipcMain.handle('translate:start', (_e, args: TranslateArgs) => {
    const { writeTokenReport, progressLog, thoughtsLog, resumeContextSize } = getSettings()
    if (!passesModelGuard(args.model, args.apiKeys)) return ''
    const fullArgs: TranslateArgs = {
      ...args,
      writeTokenReport,
      progressLog,
      thoughtsLog,
      resumeContextSize
    }
    // Declared and initialised BEFORE the call, because several failure paths inside
    // `startTranslate` — a busy slot, a refused non-UTF-8 `.ass`, a spawn that throws —
    // invoke `onDone` synchronously, i.e. before this statement's own binding exists.
    // Destructuring straight into the closure put `logPaths` in the temporal dead zone and
    // turned every one of those refusals into a ReferenceError. There are no sidecars to
    // report when a job never started, so an empty list is the correct value for them.
    let logPaths: string[] = []
    const started = startTranslate(fullArgs, {
      onOutput: (stream, line) => send('translate:output', { stream, line }),
      onDone: (code, op, reason) =>
        send('translate:done', {
          code,
          outputPath: op,
          logPaths,
          reason,
          // Only a run the engine called successful is worth scanning. A failed run has no complete
          // output to judge, and warning about a file the user was already told about would be noise.
          // A run the app ended is excluded for the same reason: its output is partial by
          // definition, so "part of this does not look right" would be describing the Stop.
          warnings: code === 0 && !reason ? scanOutputFiles(fullArgs.inputFile, op) : []
        })
    })
    logPaths = started.logPaths
    return started.outputPath
  })

  ipcMain.handle('transcribe:start', async (_e, args: TranscribeArgs) => {
    if (!passesModelGuard(args.model, args.apiKeys)) return ''
    // Awaited because unreadable audio is converted first; the renderer's contract is
    // unchanged, since `startTranscribe` was already a Promise across the IPC boundary.
    return await startTranscribe(args, {
      onOutput: (stream, line) => send('translate:output', { stream, line }),
      onDone: (code, outputPath, reason) => send('translate:done', { code, outputPath, reason })
    })
  })

  ipcMain.handle('translate:stop', () => {
    stopCurrent()
    return true
  })
  ipcMain.handle('translate:isRunning', () => isRunning())
}
