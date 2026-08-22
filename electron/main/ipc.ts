import { ipcMain, dialog, shell, BrowserWindow } from 'electron'
import type { ChildProcess } from 'child_process'
import fs from 'fs'
import path from 'path'
import { getSettings, setSettings } from './store'
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
  describeEngine,
  keySlotsFor,
  noUsableApiKeyMessage,
  type KeyPreflight
} from './pythonBridge'
import { copyExclusive, writeExclusive } from './exclusiveFile'
import { ACTIVE_SET_SIZE, activeKeySlots, orderKeySlots } from '../shared/keyOrder'
import { CONSOLE_LOG_SUFFIX } from '../shared/consoleLog'
import { scanTranslatedOutput } from '../shared/outputSanity'
import type {
  TranslateArgs,
  TranscribeArgs,
  AppSettings,
  FfmpegProgress,
  FfmpegTaskKind,
  ModelInfo,
  RefreshOutcome,
  SaveResult,
  SlotFetchResult
} from '../shared/types'

let win: BrowserWindow | null = null
export function setMainWindow(w: BrowserWindow): void {
  win = w
  // Dropped as soon as it goes, because from SOL-04 onwards the main process deliberately OUTLIVES
  // it: `before-quit` holds the app open while the engine is terminated, and every engine line,
  // progress tick and terminal event produced during that window used to be pushed at a destroyed
  // object. That throws in the main process, and it would throw part-way through the very shutdown
  // sequence that was added to stop orphaning the engine (SOL-11).
  w.on('closed', () => {
    if (win === w) win = null
  })
}

/**
 * Push an event to the renderer, if there is still a renderer.
 *
 * Both halves are checked. `win.isDestroyed()` is not enough on its own: the WebContents can be
 * gone while the BrowserWindow object is still reachable, and it is `webContents.send` that throws.
 * Dropping an event here is always the right answer — there is nothing left to display it, and the
 * shutdown path's real work is terminating the child, deleting scratch files and closing the
 * console, none of which needs a window.
 */
function send(channel: string, payload: unknown): void {
  if (!win || win.isDestroyed()) return
  const wc = win.webContents
  if (!wc || wc.isDestroyed()) return
  try {
    wc.send(channel, payload)
  } catch {
    // A renderer that went away between the check and the send. Nothing to deliver to, and this
    // sits on the path that ends a run — throwing here would strand the job it is ending.
  }
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

/**
 * Every compound suffix a run can leave beside its subtitle.
 *
 * Compound, and matched as a whole, because `path.extname()` sees only the last dot: it turns
 * `.tokens.json` into `.json` and reduces all three `.log` sidecars to the same `.log`, so the
 * last one copied would silently overwrite the others. The list is therefore exhaustive by
 * obligation — anything that starts writing a new sidecar has to appear here in the same change.
 */
export const KNOWN_SIDECAR_SUFFIXES = [
  '.tokens.json',
  '.progress.log',
  '.thoughts.log',
  CONSOLE_LOG_SUFFIX
]

/**
 * Where a sidecar lands when its subtitle is saved to `savedPath`.
 *
 * Split out of the save handler so it can be proven rather than argued about: the property that
 * matters is that the whole set maps to distinct names, and that is a statement about this
 * function, not about a dialog.
 *
 * An unrecognised path keeps `path.extname()`'s answer, which is what the handler has always
 * done. That is a deliberately imperfect fallback — it exists so an unforeseen sidecar is still
 * delivered rather than dropped — and it is exactly why the list above must stay complete.
 */
export function sidecarDestination(logPath: string, savedPath: string): string {
  const suffix = KNOWN_SIDECAR_SUFFIXES.find((s) => logPath.endsWith(s)) ?? path.extname(logPath)
  return `${savedPath.replace(/\.[^.]+$/, '')}${suffix}`
}

/**
 * Canonical sidecar paths that exist beside `savedPath` and were not written by this save.
 *
 * They keep looking like reports about the subtitle the user just saved, which is SOL-15's
 * leftover class — including types this run never generated. Scanning after the write, rather
 * than hoping a rename succeeded, is what makes the warning honest (SOL-15, round 5). The
 * save handler does not move these files; it reports them.
 */
export function leftoverCanonicals(savedPath: string, written: readonly string[]): string[] {
  const stem = savedPath.replace(/\.[^.]+$/, '')
  const writtenAbs = new Set(written.map((p) => path.resolve(p)))
  const leftover: string[] = []
  for (const suffix of KNOWN_SIDECAR_SUFFIXES) {
    const canonical = `${stem}${suffix}`
    try {
      if (!fs.existsSync(canonical)) continue
    } catch {
      continue
    }
    if (writtenAbs.has(path.resolve(canonical))) continue
    leftover.push(canonical)
  }
  return leftover
}

const EMPTY_SAVE: SaveResult = {
  path: '',
  consolePath: '',
  sidecars: [],
  displaced: [],
  stale: []
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

/**
 * HTTPS only. `shell.openExternal` and `setWindowOpenHandler` used to forward any scheme;
 * a compromised renderer or a future caller with untrusted content could launch `file:` or
 * a registered custom protocol (SOL-24). Parse failures and anything else are refusals.
 */
export function isHttpsUrl(url: string): boolean {
  try {
    return new URL(url).protocol === 'https:'
  } catch {
    return false
  }
}

/**
 * Open an approved HTTPS URL.
 *
 * Non-HTTPS is a refusal, not a launch, and resolves without opening. A valid HTTPS URL
 * that the OS cannot open rejects, so `shell:openExternal` can surface it (SOL-24).
 * `setWindowOpenHandler` has no caller to tell — it must catch.
 */
export function openApprovedExternal(url: string): Promise<void> {
  if (!isHttpsUrl(url)) return Promise.resolve()
  return shell.openExternal(url)
}

/**
 * Do these results still describe the keys the user has?
 *
 * A full check is a sequence of network round trips — up to a minute per key against the
 * fetch timeout — and everything it produces is addressed **by slot index**: the verdicts,
 * the error strings, and `ModelInfo.availableOn`, which `guardModelForSpawn` reads as proof
 * that a model exists. Nothing in that payload carries the key it came from, so if a slot's
 * key changed while the fetch was in flight, applying the result writes one key's evidence
 * onto a different key: a brand-new key inherits a ✓ or a ✗ it never earned, and the
 * pre-spawn guard starts vouching for models on a credential that never reported them.
 * `SettingsPage` clears exactly this evidence when a key is edited, and the late write
 * silently puts it back.
 *
 * Tiers are deliberately not compared. They are not part of what a check learns, this
 * handler does not persist them, and `orderKeySlots` does not rank by them — so including
 * them would discard good results for a change that could not have invalidated them.
 *
 * The counterpart in `models:refresh` needs no equivalent because it identifies its slot by
 * key MATERIAL rather than by position (`singleKeyRefreshScope`): an edited key simply stops
 * matching and the scope becomes non-authoritative.
 */
export function keySnapshotChanged(requested: readonly string[], current: readonly string[]): boolean {
  if (requested.length !== current.length) return true
  return requested.some((k, i) => (k ?? '') !== (current[i] ?? ''))
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
    // slots reported a live one. Read through getSettings() so a malformed persisted
    // cache cannot throw on `.map` (SOL-29). updatedAt comes from the same view so a
    // missing Conf key is `null`, matching preload's `string | null` (SOL-36).
    const s = getSettings()
    const cached = s.cachedModels
    const availability: ModelAvailability = {}
    for (const m of cached) {
      if (m?.source === 'live' && Array.isArray(m.availableOn) && m.availableOn.length) {
        availability[m.id] = m.availableOn
      }
    }
    const models = buildModelList(cached.map((m) => m.id), availability)
    return { models, updatedAt: s.modelsUpdatedAt ?? null }
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

    // Nothing here may be applied to a different set of keys than it was learned from.
    // Discarded WHOLE, before the selection rules are even consulted: a partial apply is
    // the worst of the three outcomes, because it would leave the verdicts, the model
    // cache and the stored selection describing different moments.
    if (keySnapshotChanged(keys, getSettings().apiKeys ?? [])) {
      const s = getSettings()
      return {
        results: [],
        slots: [],
        // The persisted list, unchanged — this is what the picker is still showing.
        models: (s.cachedModels as ModelInfo[]) ?? [],
        unionIds: [],
        runnableIds: [],
        activeSlots: activeKeySlots(keySlotsFor(s.apiKeys ?? [])),
        // Truthful about the fetch, which may well have been complete. `discarded` is what
        // says the result was not used, rather than overloading this into a lie.
        refreshOutcome: res.refreshOutcome,
        discarded: true,
        model: s.model,
        notice:
          'Your keys changed while they were being checked, so that result was discarded ' +
          'rather than applied to the keys you have now. Press “Fetch Models & Check API ' +
          'Keys” again.',
        updatedAt,
        anyValid: false
      }
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
      discarded: false,
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
    ): Promise<SaveResult> => {
      // Annotated, and the empty return corrected with it. This handler used to return a bare string
      // and was changed to return an object; the no-window path kept returning `''`, which the
      // declared `SaveResult` says cannot happen. Nothing crashed — `''.path` is merely `undefined`
      // and every caller tests it — but a type that is wrong in one branch is a type nobody can rely
      // on, and this round adds a third field to it (SOL-15).
      if (!win) return EMPTY_SAVE
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
      if (res.canceled || !res.filePath) return EMPTY_SAVE
      // Transcribe uses this handler as a DESTINATION PICKER: no source file, no logs, just a
      // path. Round 4 displaced every canonical sidecar whenever that path already existed, so
      // merely choosing `episode.srt` renamed four reports the user never agreed to move, and
      // Transcribe never mentioned it (SOL-17). A picker must not mutate the disk.
      if (!args.srcPath) {
        return { path: res.filePath, consolePath: '', sidecars: [], displaced: [], stale: [] }
      }

      // The subtitle itself IS the file the dialog obtained consent for, so overwriting here is
      // the user's own decision and must stay a plain copy. A missing temp, a thrown copy, or a
      // failed exclusive sidecar used to look like success (SOL-22): the invoke rejected with no
      // renderer catch, or returned a path after writing nothing / swallowing the report error.
      let destExisted = false
      try {
        destExisted = fs.existsSync(res.filePath)
      } catch {
        destExisted = false
      }
      try {
        if (!fs.existsSync(args.srcPath)) {
          return {
            ...EMPTY_SAVE,
            error: 'The translated subtitle is no longer available to save.'
          }
        }
        fs.copyFileSync(args.srcPath, res.filePath)
      } catch (e) {
        if (!destExisted) {
          try {
            fs.unlinkSync(res.filePath)
          } catch {
            /* partial dest we created */
          }
        }
        const detail = e instanceof Error ? e.message : String(e)
        return { ...EMPTY_SAVE, error: `Could not save the subtitle: ${detail}` }
      }

      // Sidecars are never overwritten and never renamed. The dialog named one file. Moving a
      // stranger's `episode.console.log` aside "to keep the association honest" was still acting
      // on a file nobody consented to touch (SOL-12, round 5). Exclusive create steps around
      // whatever is already there; leftover canonical names are REPORTED as `stale` so they
      // cannot silently look like this run (SOL-15). A sidecar that cannot be written is
      // reported on `error` rather than swallowed — the subtitle has already landed (SOL-22).
      let consolePath = ''
      const sidecars: string[] = []
      const sidecarErrors: string[] = []
      if (args.logPaths?.length) {
        for (const logPath of args.logPaths) {
          if (!fs.existsSync(logPath)) {
            sidecarErrors.push(`could not find ${path.basename(logPath)}`)
            continue
          }
          const dest = sidecarDestination(logPath, res.filePath)
          const suffix =
            KNOWN_SIDECAR_SUFFIXES.find((s) => dest.endsWith(s)) ?? path.extname(dest)
          try {
            const body = dest.endsWith('.tokens.json')
              ? retargetTokenReport(
                  fs.readFileSync(logPath, 'utf-8'),
                  args.inputPath ?? '',
                  res.filePath
                )
              : null
            const written =
              body !== null
                ? writeExclusive(body, dest, suffix)
                : copyExclusive(logPath, dest, suffix)
            if (written) {
              sidecars.push(written)
              if (suffix === CONSOLE_LOG_SUFFIX) consolePath = written
            } else {
              sidecarErrors.push(`could not write ${path.basename(dest)}`)
            }
          } catch (e) {
            const detail = e instanceof Error ? e.message : String(e)
            sidecarErrors.push(`${path.basename(logPath)}: ${detail}`)
          }
        }
      }
      return {
        path: res.filePath,
        consolePath,
        sidecars,
        displaced: [],
        stale: leftoverCanonicals(res.filePath, sidecars),
        ...(sidecarErrors.length
          ? {
              error:
                sidecarErrors.length === 1
                  ? `The subtitle was saved, but a report was not: ${sidecarErrors[0]}`
                  : `The subtitle was saved, but some reports were not: ${sidecarErrors.join('; ')}`
            }
          : {})
      }
    }
  )

  // ---- Engine ----
  // Which binary a run will use, for Settings > Advanced. The only addition to the IPC method
  // surface in this whole fix pass, and it exists because the previous answer was a console
  // line that a packaged Windows build has nowhere to print (MAN-5).
  ipcMain.handle('engine:info', () => describeEngine())

  // ---- Shell helpers ----
  ipcMain.handle('shell:showItem', (_e, p: string) => {
    if (p) shell.showItemInFolder(p)
  })
  ipcMain.handle('shell:openExternal', (_e, url: string) => openApprovedExternal(url))

  // ---- Video tracks ----
  ipcMain.handle('video:probeTracks', async (_e, filePath: string) => {
    const { ffmpegPath } = getSettings()
    return probeTracks(filePath, ffmpegPath)
  })

  /**
   * Report an ffmpeg task's progress on its OWN channel.
   *
   * Deliberately not `translate:output`: the renderer treats that stream as engine log lines,
   * so a tick every half second would become a log row, and a long extraction would bury the
   * run in noise that FP-3 exists to prevent.
   */
  const progressTo =
    (kind: FfmpegTaskKind) =>
    (pct: number | null, elapsedMs: number): void =>
      send('ffmpeg:progress', { kind, pct, elapsedMs } satisfies FfmpegProgress)

  const endProgress = (kind: FfmpegTaskKind): void =>
    send('ffmpeg:progress', { kind, pct: null, elapsedMs: 0, done: true } satisfies FfmpegProgress)

  // Extraction to a temp .srt (used as translation input for a chosen track). No longer
  // silent: on a large container this is the minutes-long pause REP-11 was reported against.
  ipcMain.handle(
    'video:extractToTemp',
    async (_e, args: { filePath: string; subtitleIndex: number }) => {
      const { ffmpegPath } = getSettings()
      const out = tempOutputPath('.srt')
      try {
        const res = await extractTrack(
          args.filePath,
          args.subtitleIndex,
          out,
          false,
          ffmpegPath,
          progressTo('prepare')
        )
        return res.ok ? { ok: true, path: out } : { ok: false, error: res.error }
      } finally {
        endProgress('prepare')
      }
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
      try {
        const out = await extractTrack(
          args.filePath,
          args.subtitleIndex,
          res.filePath,
          args.isImage,
          ffmpegPath,
          progressTo('export')
        )
        return { ...out, path: res.filePath }
      } finally {
        endProgress('export')
      }
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
   *
   * `runId` is not optional in spirit. This is a REFUSAL, and a refusal emits a terminal event —
   * so unaddressed it reaches whichever run is genuinely in progress on the other page and tells
   * it that it has failed, while its engine carries on. Same shape as `refuseStart()`, same
   * remedy (SOL-01).
   */
  const passesModelGuard = (
    model: string,
    keys: string[],
    runId?: string,
    activeLimit = ACTIVE_SET_SIZE
  ): boolean => {
    const s = getSettings()
    const slots = keySlotsFor(keys)
    const ranked = orderKeySlots(slots)
    if (ranked.length === 0) {
      send('translate:output', {
        stream: 'stderr',
        line: noUsableApiKeyMessage(slots),
        runId
      })
      send('translate:done', { code: -1, outputPath: '', runId, reason: 'guard' })
      return false
    }
    const verdict = guardModelForSpawn(
      model,
      s.cachedModels,
      // Slice the ranked full list. Passing a one-element keys array would renumber slots
      // and mis-read `availableOn` (SOL-23). Transcription never emits `-k2`, so its limit is 1.
      ranked.slice(0, activeLimit)
    )
    if (verdict.warning)
      send('translate:output', { stream: 'stderr', line: verdict.warning, runId })
    if (!verdict.ok) {
      send('translate:output', {
        stream: 'stderr',
        line: verdict.error ?? 'Model unavailable.',
        runId
      })
      send('translate:done', { code: -1, outputPath: '', runId, reason: 'guard' })
      return false
    }
    return true
  }

  ipcMain.handle('translate:start', (_e, args: TranslateArgs) => {
    const { writeTokenReport, progressLog, thoughtsLog, resumeContextSize } = getSettings()
    if (!passesModelGuard(args.model, args.apiKeys, args.runId)) return ''
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
    // The path the engine actually read. Declared before the call for the same TDZ reason as
    // `logPaths`. Warnings only fire on a later successful `close`, by which time this has
    // been rewritten to the UTF-8 copy when one was made (SOL-21).
    let sourcePath = fullArgs.inputFile
    // Stamped on every event this request produces, including the ones emitted synchronously
    // before `startTranslate` returns and including a refusal. Both pages listen on these two
    // channels for the whole life of the app, so an unaddressed event is delivered to runs it has
    // nothing to do with (SOL-01).
    const runId = args.runId
    const started = startTranslate(fullArgs, {
      onOutput: (stream, line) => send('translate:output', { stream, line, runId }),
      onDone: (code, op, reason, ownLogs) =>
        send('translate:done', {
          code,
          runId,
          outputPath: op,
          // Two sources, because the two are known at different times and by different things:
          // the engine's sidecars are named up front from the arguments it was given, while the
          // console log is reported by the bridge when the run ends, which is the only moment
          // anyone knows whether it exists.
          logPaths: [...logPaths, ...(ownLogs ?? [])],
          reason,
          // Only a run the engine called successful is worth scanning. A failed run has no complete
          // output to judge, and warning about a file the user was already told about would be noise.
          // A run the app ended is excluded for the same reason: its output is partial by
          // definition, so "part of this does not look right" would be describing the Stop.
          warnings: code === 0 && !reason ? scanOutputFiles(sourcePath, op) : []
        })
    })
    logPaths = started.logPaths
    sourcePath = started.sourcePath
    return started.outputPath
  })

  /**
   * Ask one key whether it still works, for the transcription preflight (REP-2).
   *
   * Same seam and same reason as `passesModelGuard`: `modelsList` imports the bridge, so the
   * bridge cannot import `modelsList` back. This is handed in as a function instead.
   *
   * It reuses `refreshModels`, which is the same call translation gets for free from the engine
   * — one `list-models` round trip — so the classification of "rejected" versus "could not be
   * checked" is shared with the Settings panel rather than re-derived here.
   */
  const keyPreflight = async (
    apiKey: string,
    signal: AbortSignal,
    adopt?: (child: ChildProcess) => void
  ): Promise<KeyPreflight> => {
    // `ownsJobSlot` is the difference between this caller and the Settings panel, and it is not
    // cosmetic: this one runs inside a reserved transcription slot, so a Stop here must not let
    // `startTranscribe` release that slot while the fetch's own process is still alive. Settings
    // deliberately keeps the bounded behaviour, because it protects nothing (SOL-02).
    const res = await refreshModels(apiKey, signal, { ownsJobSlot: true, onChild: adopt })
    // Carried on every verdict, because it is a statement about a process rather than about the
    // key: a fetch that survived its kill matters just as much when the key turned out to be fine.
    const survivor = { orphaned: res.orphaned, orphanPid: res.orphanPid, orphan: res.orphan }
    if (res.verdict === 'valid') return { verdict: 'valid', message: '', ...survivor }
    if (res.verdict === 'rejected') {
      return {
        ...survivor,
        verdict: 'rejected',
        message:
          `The API rejected this key before the transcription started: ${res.error} ` +
          'Nothing was sent and no quota was spent. Open Settings > Gemini API Keys to fix it.'
      }
    }
    return {
      ...survivor,
      verdict: 'unchecked',
      message: `The API key could not be checked first: ${res.error} Starting anyway.`
    }
  }

  ipcMain.handle('transcribe:start', async (_e, args: TranscribeArgs) => {
    if (!passesModelGuard(args.model, args.apiKeys, args.runId, 1)) return ''
    // Awaited because unreadable audio is converted first; the renderer's contract is
    // unchanged, since `startTranscribe` was already a Promise across the IPC boundary.
    const runId = args.runId
    return await startTranscribe(
      args,
      {
        onOutput: (stream, line) => send('translate:output', { stream, line, runId }),
        // Transcription has no Save step — the output path was chosen before the run — so its
        // console log is already sitting beside that output and never travels through
        // `dialog:saveFile`. It is reported here purely so the panel can point at it.
        onDone: (code, outputPath, reason, logPaths) =>
          send('translate:done', { code, outputPath, reason, logPaths, runId }),
        // The payload is built by the bridge, which is the only thing that knows whether the
        // conversion is still running; this just forwards it.
        onProgress: (p) => send('ffmpeg:progress', p)
      },
      keyPreflight
    )
  })

  ipcMain.handle('translate:stop', () => {
    stopCurrent()
    return true
  })
  ipcMain.handle('translate:isRunning', () => isRunning())
}
