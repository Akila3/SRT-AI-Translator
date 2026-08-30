/**
 * The engine's own default for `--resume-context-size` (cli.py). Shared so the main
 * process and the Settings UI agree on the value at which the flag is omitted entirely.
 */
export const DEFAULT_RESUME_CONTEXT_SIZE = 50

export interface SubtitleTrack {
  index: number
  codec: string
  lang: string
  name: string
  isImage: boolean
}

export interface AppSettings {
  /**
   * Persisted-settings format version. `defaults` MUST keep this at 0: electron-store
   * returns the default for any absent key, so a non-zero default would make every
   * legacy profile report "already migrated" and skip the whole chain.
   */
  schemaVersion: number
  sourceLang: string
  targetLang: string
  apiKeys: string[]
  apiKeyTiers: string[]
  apiKeyValid: (boolean | null)[]
  apiKeyError: string[]
  theme: string
  model: string
  /**
   * Advisory flag set by the offline migrations when the stored model id looks
   * suspicious but cannot be proven gone. It drives a UI hint and NOTHING else — it
   * must never authorise a reset. Cleared by the first `activeComplete` refresh that
   * finds the id.
   */
  modelNeedsVerification: boolean
  batchSize: number
  batchContext: boolean
  /** When false, temperature/top-p/top-k are omitted entirely so the model's own defaults apply. */
  customGenerationParams: boolean
  temperature: number
  topP: number
  topK: number | null
  thinkingLevel: string
  thinkingBudget: number
  /**
   * Transcribe-page override of Settings → Model & Generation. Default off: this tab
   * uses the global model and thinking values. When on, the three fields below are
   * what a transcribe run sends. Empty strings / budget 0 mean "use the global".
   * No schema bump: sanitizeSettingsView overlays these from defaults when absent.
   */
  transcribeOverride: boolean
  transcribeModel: string
  transcribeThinkingLevel: string
  transcribeThinkingBudget: number
  serviceTier: string
  paidQuota: boolean
  disableStreaming: boolean
  /** Lines of prior context replayed when resuming an interrupted job. 50 = engine default, 0 disables. */
  resumeContextSize: number
  tmdbApiKey: string
  outputFolder: string
  ffmpegPath: string
  systemPrompt: string
  showTokenStats: boolean
  writeTokenReport: boolean
  progressLog: boolean
  thoughtsLog: boolean
  cachedModels: ModelInfo[]
  modelsUpdatedAt: string | null
}

export interface ModelInfo {
  id: string
  label: string
  /**
   * Where this entry came from. `seed` means "we ship this id in a static list" and is
   * explicitly NOT evidence that the model is runnable — only `live` is.
   */
  source: 'live' | 'seed'
  /** API-key slot indices whose fetch returned this id. Always empty for seed entries. */
  availableOn: number[]
}

/** Per-key validation outcome shown next to each API key slot. */
export interface KeyCheck {
  valid: boolean | null
  error: string
}

/** What one API key slot returned during a refresh. */
export interface SlotFetchResult {
  /** Index into `AppSettings.apiKeys`. */
  slot: number
  /** True when this slot was actually queried (an empty slot is skipped). */
  queried: boolean
  /** True when the query returned a model list without error. */
  ok: boolean
  /** Raw model ids this slot reported. Empty unless `ok`. */
  ids: string[]
}

/**
 * How complete one refresh attempt was. Deliberately NOT persisted: it describes a
 * single fetch, and a stale value could later authorise a destructive reset.
 *
 * - `allComplete`    every configured non-empty slot answered. Required to reset a
 *                    user's model override, because that destroys an explicit choice.
 * - `activeComplete` every slot in the ACTIVE SET answered. Enough to auto-advance the
 *                    default, which is reversible. A one-key user has a one-slot active
 *                    set, so this is reachable for them.
 * - `partial`        something answered, but the active set is not fully covered.
 * - `failed`         nothing answered.
 */
export type RefreshOutcome = 'allComplete' | 'activeComplete' | 'partial' | 'failed'

export interface CheckKeysResult {
  results: KeyCheck[]
  /** Per-slot fetch detail. Replaces the old "take the list from the first valid key". */
  slots: SlotFetchResult[]
  /** Display list: the union of every live id, or the seed when no fetch ever succeeded. */
  models: ModelInfo[]
  /** Union of ids across every slot that answered. */
  unionIds: string[]
  /** Intersection across the active set — the ids that can actually run right now. */
  runnableIds: string[]
  /** `orderKeySlots(...).slice(0, 2)`: the slots buildTranslateArgs will emit. */
  activeSlots: number[]
  refreshOutcome: RefreshOutcome
  anyValid: boolean
}

export interface TranslateArgs {
  /** Minted by the renderer so it can recognise its own events — see `RunId`. */
  runId?: RunId
  inputFile: string
  videoFile?: string
  audioFile?: string
  streamIndex?: number
  sourceLang: string
  targetLang: string
  model: string
  apiKeys: string[]
  batchSize: number
  batchContext: boolean
  customGenerationParams: boolean
  temperature: number
  topP: number
  topK: number | null
  thinkingLevel: string
  thinkingBudget: number
  serviceTier: string
  paidQuota: boolean
  disableStreaming: boolean
  description?: string
  systemPrompt?: string
  ffmpegPath?: string
  resumeFrom?: number
  resumeContextSize?: number
  writeTokenReport: boolean
  progressLog: boolean
  thoughtsLog: boolean
}

export interface TranscribeArgs {
  /** Minted by the renderer so it can recognise its own events — see `RunId`. */
  runId?: RunId
  mediaFile: string
  outputFile: string
  targetLang: string
  model: string
  apiKeys: string[]
  thinkingLevel: string
  thinkingBudget: number
  customGenerationParams: boolean
  temperature: number
  topP: number
  topK: number | null
  description?: string
  ffmpegPath?: string
}

/**
 * Which run an event belongs to.
 *
 * Both pages stay mounted for the life of the app (App.tsx keeps them so their inputs survive a
 * tab switch), and both listen on the SAME two channels — there is one `translate:output` and one
 * `translate:done` for translation and transcription alike. Nothing addressed those events, so
 * every runner received every event and a finished run's state was overwritten by the next run of
 * the other kind: its `outputPath` and `logPaths` were replaced, and Save would then copy the
 * other run's file under this one's name (validator finding SOL-01).
 *
 * The id is minted by the RENDERER, before it asks main to start anything, because output begins
 * arriving during that call and an id handed back afterwards would come too late to filter it.
 * Optional in the type only so an older payload cannot fail to compile; every producer sets it.
 */
export type RunId = string

export interface ProcOutput {
  stream: 'stdout' | 'stderr'
  line: string
  /** The run this line came from. A runner ignores anything that is not its own. */
  runId?: RunId
}

/**
 * Which piece of ffmpeg work a progress report belongs to.
 *
 * This is what correlates a report with the thing on screen that is waiting for it, and it is
 * an enumeration rather than a generated id because the three are already mutually exclusive
 * in practice: `export` and `prepare` share the Translate page's single ffmpeg lock, and
 * `convert` can only run inside a transcription job, of which there is at most one. A page
 * therefore ignores any kind it did not start — which matters, because a transcription's
 * conversion and a track export CAN overlap, being on different pages under different locks.
 *
 * - `export`  — a subtitle track written to a file the user chose.
 * - `prepare` — a track extracted to a temp file so it can be translated.
 * - `convert` — audio normalised to MP3 before transcription.
 */
export type FfmpegTaskKind = 'export' | 'prepare' | 'convert'

/**
 * How far one ffmpeg task has got. Its own channel, NOT the engine's output stream: every
 * tick would otherwise become a log row and undo the panel work of FP-3.
 */
export interface FfmpegProgress {
  kind: FfmpegTaskKind
  /**
   * Whole percent, or null when the input's duration is unknown and only elapsed time can
   * honestly be shown. Never reaches 100 while the task is running.
   */
  pct: number | null
  /** Milliseconds since the task started, so a page can show a clock without owning one. */
  elapsedMs: number
  /**
   * The task has ended, however it ended — stop showing it. `pct` is meaningless here.
   * Present because `convert` runs inside a job the renderer never awaits, so nothing else
   * would tell its page that the conversion is over.
   */
  done?: boolean
}

/**
 * Which `gst` binary a run will actually use.
 *
 * Shared rather than declared in the bridge because the preload must be able to type it without
 * importing main-process code. It answers release-gate check D1 — "the packaged app runs the
 * packaged engine" — which was unanswerable while the only report of it was a `console.log` that
 * a packaged Windows build has no console to print to (MAN-5).
 */
export interface EngineInfo {
  /** Absolute path when known; the bare name when PATH lookup found nothing. */
  path: string
  /** True when this is the copy shipped inside the app, i.e. what a release is supposed to run. */
  bundled: boolean
  /** False when the name could not be resolved at all — the run will fail at spawn. */
  found: boolean
}

/**
 * Why a run ended, when something other than the engine decided it.
 *
 * A boolean would not do. A killed process and a crashed one both exit non-zero, so the
 * renderer cannot tell them apart, and the main process is the only place that knows — but
 * "the app ended this run" is not one thing: `user` is a button press and reads as Stopped,
 * while `stalled` and `guard` are the app refusing to continue and must keep reading as
 * failures. Reporting either of those as a Stop would tell the user they did something they
 * did not do, and would bury the cause.
 *
 * Absent means the engine exited on its own and the exit code decides, as before.
 */
export type TerminalReason = 'user' | 'stalled' | 'guard'

export interface ProcDone {
  code: number | null
  outputPath: string
  logPaths?: string[]
  /**
   * The run this ending belongs to — see `RunId`.
   *
   * It matters most on the path that is easiest to overlook: a start REFUSED because another job
   * holds the slot also emits a terminal event, and unaddressed that event reached the runner of
   * the job actually running, telling a healthy run it had failed while its engine carried on.
   */
  runId?: RunId
  /** Set only when the app ended the run rather than the engine. Optional: absent is the norm. */
  reason?: TerminalReason
  /**
   * Advisory messages about the output the engine just wrote — see `outputSanity.ts`. Optional, and
   * everything that ignores it keeps working: the renderer shows these beside Save so the user reads
   * them *before* choosing where to put the file. Nothing here ever blocks a save or alters a file.
   */
  warnings?: string[]
}

/**
 * What the save dialog resolves to.
 *
 * It used to be the subtitle's path alone, and the renderer DERIVED the sidecar names from it. That
 * stopped being safe once sidecars stopped overwriting strangers' files: an occupied name is stepped,
 * so the destination is no longer predictable and has to be reported (SOL-12). `path` is `''` when
 * the user cancelled, exactly as the bare string was.
 *
 * Declared HERE rather than in the preload, where it started, so the main-process handler that
 * produces it is checked against it. While it lived on the renderer side alone, one branch of that
 * handler was still returning the bare string this type replaced and nothing objected (SOL-15).
 */
export interface SaveResult {
  path: string
  /** Where the console log actually landed, or '' if there was none to copy. */
  consolePath: string
  /**
   * Where EVERY sidecar actually landed — console, token report, progress, thoughts.
   *
   * Reporting only the console left the other three unaccounted for: a stepped
   * `episode-2.tokens.json` existed and nothing in the app ever mentioned it (SOL-15). With the full
   * list the panel can say plainly that a report was saved under a different name.
   */
  sidecars: string[]
  /**
   * Kept for wire compatibility. `dialog:saveFile` no longer moves sidecars (SOL-12/17, round 5);
   * it always returns `[]`. Leftovers are `stale`.
   */
  displaced: string[]
  /**
   * Canonical sidecar names that still exist beside the saved subtitle and were NOT written by
   * this save — an older run's report, or another tool's file of the same name (SOL-12, SOL-15).
   * They were left untouched; the panel must say so, because their names otherwise look like
   * they belong to the subtitle just saved.
   */
  stale: string[]
  /**
   * Why this save is not a clean success (SOL-22).
   *
   * Absent on cancel and on a picker-only call (`srcPath` omitted). Set with an empty `path`
   * when the subtitle itself could not be written. Set *with* a `path` when the subtitle landed
   * but a requested sidecar did not — the page must still say the report is missing.
   */
  error?: string
}

export interface TmdbResult {
  id: string
  title: string
  type: 'Movie' | 'TV Show'
  year: string
  poster: string | null
  mediaType: 'movie' | 'tv'
}

export interface CastMember {
  name: string
  character: string
  gender: string
}

export interface TmdbDetails {
  cast: CastMember[]
  title: string
  genres: string
  genreList: string[]
  typeLabel: string
  imdbId: string
  tmdbId: string
  seasons: number
  yearStart: string
  yearEnd: string
  mediaType: 'movie' | 'tv'
}
