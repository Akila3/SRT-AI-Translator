/**
 * Detect a translated subtitle the engine believed was fine.
 *
 * The engine validates a batch by *counting* items, not by reading them. A measured run translated
 * correctly to index 463, then emitted the two-character filler "ב-" for the remaining 136 items of
 * a 300-item batch. The count matched, so the engine reported success and wrote the file. The user
 * received a subtitle that looks complete and is not.
 *
 * This module never repairs and never blocks. It warns, and the file on disk stays byte-identical to
 * what the engine wrote — a wrong repair on a file the user believes is finished is worse than the
 * corruption. It is pure so `test:gates` can cover it with no key, no spawn and no dialog.
 *
 * **Every threshold here is relative.** The first draft of this detector used absolute figures
 * measured on Hebrew output ("no cue under 4 characters, mean length 26.3"), which are a property of
 * Hebrew rather than of correctness: a language with naturally short cues would trip them on every
 * clean run, and the first false alarm on a good file teaches the user to ignore the warning
 * permanently. Each cue is therefore judged against its own source cue and against the run's own
 * distribution, never against a constant.
 *
 * Alignment (REP-32) is a fourth signal, reported separately from S1/S2/S3. Filler is "this text is
 * not a translation". Drift is "the text may be fine but it sits on the wrong timings". Folding
 * those into one heading sends the user looking for garbage words when the real fault is a shift.
 */

/** A contiguous range of cues that two independent signals both found suspicious. */
export interface SanityWarning {
  /** Cue index of the first suspect cue, as numbered in the file. */
  from: number
  /** Cue index of the last suspect cue. */
  to: number
  /** How many aligned cues the range spans. */
  cues: number
  /** Which signals tripped, for the log and for gate assertions. */
  signals: string[]
  /** User-facing text. */
  message: string
}

/**
 * Below this many aligned cues no window is meaningful and every signal is noise, so a short output
 * produces no warning at all. This is a real detection gap and it is accepted: a 29-cue file is read
 * end to end by anyone who cares about it. It is also what stops the five-cue `verify:live` probe
 * from becoming a false positive.
 */
const MIN_CUES = 30

const WINDOW = 50
const STEP = 10

/**
 * S1 trips at a run of this many byte-identical translations in a row.
 * Measured: the clean control's longest such run is 8; the corrupted batch's is 136. Twelve is 1.5x
 * the observed clean maximum and one eleventh of the observed fault, so it sits far from both.
 */
const S1_RUN = 12

/**
 * S2 flags a cue whose length ratio falls below this fraction of the run's median ratio.
 * Measured: the filler is 2 characters against sources averaging ~30 — a ratio of ~0.07 against a
 * clean median near 0.9, so roughly 0.08x, well inside the threshold.
 */
const S2_MEDIAN_FRACTION = 0.25

/** S2 trips when this share of a window's cues are flagged. */
const S2_WINDOW_SHARE = 0.2

/**
 * S3 trips when fewer than this share of a window's cues have the same number of lines as their
 * source. Measured: 99% (198/201) on the clean batch, 79% (64/81) on the degraded stretch that
 * preceded the filler. On a 50-cue window, 90% allows five disagreements where the clean rate
 * predicts fewer than one.
 */
const S3_AGREEMENT = 0.9

/**
 * A window is drifted when its length-correlation sits this far below the run's **best** window.
 *
 * The first sketch used the median window. That fails on the measured flash-3.5 Boeing output:
 * most windows are already drifted, so the median *is* the fault (0.32) and a median-relative
 * rule goes quiet exactly when the file is worst. The best window is still the run's own high
 * side — Bad Sisters sits 0.75–0.97 against its own 0.97 — and a 0.30 drop is wider than that
 * clean spread and narrower than the Boeing drop (0.9-ish against under 0.4).
 *
 * If even the best window is below ALIGN_BEST_FLOOR, there is no healthy region to compare
 * against. That floor is below every clean window measured on Bad Sisters (min 0.75), but it is
 * still an absolute length-correlation cut: a correctly aligned pair whose cue lengths naturally
 * do not move together would trip it. The floor therefore only fires when the source is also
 * fragment-heavy — the measured cause of merging — so a low-r language with professional
 * punctuation stays silent. Relative-drop detection does not need that corroboration.
 * Windows with no length variance (r === null) are treated as aligned.
 */
const ALIGN_DROP = 0.3
const ALIGN_BEST_FLOOR = 0.6

/** Pearson needs this many usable cues in a window; below that the coefficient is noise. */
const ALIGN_MIN_POINTS = 20

/**
 * Share of adjacent cues that look like a sentence continuing across the boundary — the source
 * ends without sentence-final punctuation and the next cue starts lowercase.
 *
 * Measured: professionally authored Bad Sisters 3.5%; YouTube-style Boeing auto-transcript 53%.
 * Twenty percent is several times the professional rate and well under the auto-caption rate.
 * A short file is not judged: the five-cue live probe must not grow a scary pre-flight note.
 */
const FRAGMENT_NOTE_RATE = 0.2

const SENTENCE_END = /[.!?…。！？]["'”’)\]]*\s*$/u
const STARTS_LOWER = /^\p{Ll}/u

const EXPECTED_COUNT = /Expected\s+(\d+)\s+lines,\s+got\s+(\d+)/i
const FRAGMENT_NOTE_IN_LOG = /cues often break mid-sentence/i

interface Cue {
  index: number
  text: string
}

interface Pair {
  index: number
  source: string
  output: string
  /**
   * Counted in no signal: a cue whose source is empty (the ratio is undefined and identity is
   * meaningless), or one whose translation is byte-identical to its source — a number, a name, a
   * caption, legitimately untranslated. Including those would inflate S2 towards 1.0 and dilute the
   * median.
   */
  excluded: boolean
  ratio: number
  shortfall: boolean
  lineDisagree: boolean
}

/** ASS override blocks carry no visible text and would distort every length ratio. */
const ASS_TAGS = /\{[^}]*\}/g

function normalize(text: string): string {
  return text.replace(/\r\n?/g, '\n').trim()
}

function countLines(text: string): number {
  if (text === '') return 0
  return text.split('\n').length
}

/**
 * Read cues out of SRT or ASS.
 *
 * Deliberately forgiving: this runs on output the engine may have mangled, and a parse that throws
 * would turn a corrupted file into a crashed save. Anything unrecognisable simply yields no cues,
 * which yields no warning.
 */
export function parseCues(text: string): Cue[] {
  const body = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')

  if (/^\s*Dialogue\s*:/m.test(body)) {
    const cues: Cue[] = []
    for (const line of body.split('\n')) {
      const m = /^\s*Dialogue\s*:(.*)$/.exec(line)
      if (!m) continue
      // The ten-field event format: text is everything after the ninth comma, and may itself
      // contain commas, which is why this splits with a limit rather than on every comma.
      const fields = m[1].split(',')
      if (fields.length < 10) continue
      const raw = fields.slice(9).join(',')
      cues.push({
        index: cues.length + 1,
        text: normalize(raw.replace(ASS_TAGS, '').replace(/\\N/gi, '\n'))
      })
    }
    return cues
  }

  const cues: Cue[] = []
  for (const block of body.split(/\n{2,}/)) {
    const lines = block.split('\n').filter((l) => l.trim() !== '')
    if (lines.length < 2) continue
    const index = Number.parseInt(lines[0].trim(), 10)
    if (!Number.isFinite(index)) continue
    const timing = lines.findIndex((l) => l.includes('-->'))
    if (timing < 0) continue
    cues.push({ index, text: normalize(lines.slice(timing + 1).join('\n')) })
  }
  return cues
}

function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = sorted.length >> 1
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

/** Pearson r, or null when a series has no variance (or too few points). */
function pearson(xs: number[], ys: number[]): number | null {
  const n = xs.length
  if (n < 3 || n !== ys.length) return null
  let sx = 0
  let sy = 0
  for (let i = 0; i < n; i++) {
    sx += xs[i]
    sy += ys[i]
  }
  const mx = sx / n
  const my = sy / n
  let num = 0
  let dx = 0
  let dy = 0
  for (let i = 0; i < n; i++) {
    const x = xs[i] - mx
    const y = ys[i] - my
    num += x * y
    dx += x * x
    dy += y * y
  }
  if (dx === 0 || dy === 0) return null
  return num / Math.sqrt(dx * dy)
}

function flattenCue(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

function fragmentRateFromSources(texts: readonly string[]): number {
  if (texts.length < MIN_CUES) return 0
  let hits = 0
  let considered = 0
  for (let i = 0; i < texts.length - 1; i++) {
    const a = flattenCue(texts[i])
    const b = flattenCue(texts[i + 1])
    if (!a || !b) continue
    considered++
    if (isFragmentContinuation(a, b)) hits++
  }
  return considered === 0 ? 0 : hits / considered
}

function isFragmentContinuation(prev: string, next: string): boolean {
  const a = flattenCue(prev)
  const b = flattenCue(next)
  if (!a || !b) return false
  return !SENTENCE_END.test(a) && STARTS_LOWER.test(b)
}

/**
 * Share of adjacent cue pairs that look like a sentence continuing across the boundary.
 *
 * Returns 0 for a file too short to judge. Exported so G3 can pin the threshold without spawning.
 */
export function fragmentContinuationRate(sourceText: string): number {
  let cues: Cue[]
  try {
    cues = parseCues(sourceText ?? '')
  } catch {
    return 0
  }
  if (cues.length < MIN_CUES) return 0
  return fragmentRateFromSources(cues.map((c) => c.text))
}

/**
 * Log line the bridge emits when the source looks fragment-heavy. The Translate page picks this
 * out of the runner log so the advisory is visible while StatusCard is showing (the raw log is
 * hidden during a run). Exported so G3 can pin the same recognition the abort helper uses.
 */
export function fragmentNoteInLog(logText: string): string | null {
  for (const line of (logText ?? '').split('\n')) {
    if (FRAGMENT_NOTE_IN_LOG.test(line)) return line
  }
  return null
}

/**
 * Advisory for a fragment-heavy source, or null when the file is fine / too short / unreadable.
 *
 * Emitted on stdout before spawn so it is in the console log. It does not block Start. A parse
 * failure must not throw: a note we cannot produce is not a reason to skip the run.
 */
export function sourceFragmentNote(sourceText: string): string | null {
  const rate = fragmentContinuationRate(sourceText)
  if (rate < FRAGMENT_NOTE_RATE) return null
  const pct = Math.round(rate * 100)
  return (
    `This source file’s cues often break mid-sentence (about ${pct}%). ` +
    `The model will probably merge those fragments into whole sentences, which shifts later text ` +
    `onto the wrong timings and can stop the run. Re-segment the source into whole sentences ` +
    `before translating.`
  )
}

/**
 * Plain-language explanation when the engine reported a short item count, or null for any other
 * failure.
 *
 * Three consecutive errors do not identify a cause — that stop is generic — so they are not
 * treated as evidence of merging. A short `Expected N lines, got M` is the observed fact; merging
 * is one possible cause, not a diagnosis, unless the same log already carries the fragment-heavy
 * source note. Takes flattened console text so G3 can cover it without a renderer. Must not
 * recommend a stronger model, and must not imply that batch size or a streaming toggle reliably
 * fixes merging — both were measured, and both failed.
 */
export function explainTranslateAbort(logText: string): string | null {
  const text = logText ?? ''
  const count = EXPECTED_COUNT.exec(text)
  const short = count !== null && Number(count[2]) < Number(count[1])
  if (!short) return null
  if (fragmentNoteInLog(text)) {
    return (
      `The model returned fewer subtitle lines than it was asked for. This source’s cues often ` +
      `break mid-sentence, so merging those fragments is the likely cause — later text would sit ` +
      `on the wrong timings. Re-segment the source into whole sentences and translate that. ` +
      `A stronger model, a smaller batch, or turning streaming off will not reliably stop the merging.`
    )
  }
  return (
    `The model returned fewer subtitle lines than it was asked for. That can happen when it ` +
    `merges cues that continue across boundaries, or when a response is truncated or malformed. ` +
    `Merging is one possible cause, not a confirmed diagnosis. Check the log for the count mismatch.`
  )
}

/**
 * Windowed source-vs-output cue-length correlation. Independent of S1/S2/S3: a drifted cue is a
 * perfectly plausible translation of *something*, so those signals stay quiet.
 *
 * Passthrough cues (excluded from filler) stay in the sample — a name or a number at the same
 * index is evidence the pairing is still lined up. Cues already known to be filler (S1 run
 * members, S2 shortfall) are left out, so a collapsed stretch cannot be misread as a shift.
 */
function alignmentWarnings(pairs: Pair[], runMember: readonly boolean[]): SanityWarning[] {
  interface Win {
    start: number
    end: number
    r: number | null
  }
  const wins: Win[] = []
  for (let start = 0; start < pairs.length; start += STEP) {
    const end = Math.min(start + WINDOW, pairs.length)
    if (end - start < MIN_CUES) break
    const xs: number[] = []
    const ys: number[] = []
    for (let i = start; i < end; i++) {
      if (pairs[i].shortfall || runMember[i]) continue
      xs.push(pairs[i].source.length)
      ys.push(pairs[i].output.length)
    }
    wins.push({
      start,
      end: end - 1,
      r: xs.length >= ALIGN_MIN_POINTS ? pearson(xs, ys) : null
    })
  }
  const defined = wins.filter((w): w is Win & { r: number } => w.r !== null)
  if (defined.length === 0) return []
  const best = Math.max(...defined.map((w) => w.r))
  // Absolute floor only with a fragment-heavy source (SOL-63). Relative drop always applies.
  const wholeFileLow =
    best < ALIGN_BEST_FLOOR && fragmentRateFromSources(pairs.map((p) => p.source)) >= FRAGMENT_NOTE_RATE
  const drifted = defined.filter((w) => (wholeFileLow ? true : best - w.r >= ALIGN_DROP))
  if (drifted.length === 0) return []

  const regions: Array<{ start: number; end: number }> = []
  for (const win of drifted) {
    const last = regions[regions.length - 1]
    if (last && win.start <= last.end + 1) last.end = Math.max(last.end, win.end)
    else regions.push({ start: win.start, end: win.end })
  }

  return regions.map((region) => {
    const first = pairs[region.start].index
    const last = pairs[region.end].index
    const count = region.end - region.start + 1
    return {
      from: first,
      to: last,
      cues: count,
      signals: ['wrong timings'],
      message:
        `Cues ${first}–${last} (${count} of ${pairs.length}) look like a real translation on ` +
        `the wrong timings — source and output cue lengths stop moving together in this range, ` +
        `which is what happens when the model merges lines and every later cue shifts earlier. ` +
        `Nothing has been changed: the file is exactly as the engine wrote it. Check that the ` +
        `dialogue still sits on the right pictures before using it.`
    }
  })
}

/**
 * The longest run of consecutive byte-identical translations in `slice`, ignoring runs whose sources
 * are also all identical.
 *
 * That last condition is what stops a file of repeated sound cues — "♪", "[MUSIC]" — from tripping
 * the signal: their sources repeat too, so the run is disqualified. An excluded cue breaks a run
 * rather than being skipped over, which can only make the signal harder to trip.
 */
function longestIdenticalRun(slice: Pair[]): number {
  let best = 0
  let start = 0
  while (start < slice.length) {
    if (slice[start].excluded) {
      start++
      continue
    }
    let end = start + 1
    while (end < slice.length && !slice[end].excluded && slice[end].output === slice[start].output) {
      end++
    }
    const sourcesVary = slice.slice(start, end).some((p) => p.source !== slice[start].source)
    if (sourcesVary) best = Math.max(best, end - start)
    start = end
  }
  return best
}

/**
 * Compare a translated subtitle against the source it came from.
 *
 * Returns one warning per suspect region, or an empty list. Filler regions (S1/S2/S3) and
 * alignment regions are separate entries — they describe different faults. Never throws: a
 * missing, empty or unparseable file must produce no warning and must not stop the run from ending.
 */
export function scanTranslatedOutput(sourceText: string, outputText: string): SanityWarning[] {
  let sourceCues: Cue[]
  let outputCues: Cue[]
  try {
    sourceCues = parseCues(sourceText ?? '')
    outputCues = parseCues(outputText ?? '')
  } catch {
    return []
  }
  if (sourceCues.length === 0 || outputCues.length === 0) return []

  // Aligned by index. A cue present in one file and not the other is skipped, never guessed at.
  const byIndex = new Map<number, string>()
  for (const cue of outputCues) if (!byIndex.has(cue.index)) byIndex.set(cue.index, cue.text)

  const pairs: Pair[] = []
  for (const cue of sourceCues) {
    const output = byIndex.get(cue.index)
    if (output === undefined) continue
    const excluded = cue.text === '' || output === cue.text
    pairs.push({
      index: cue.index,
      source: cue.text,
      output,
      excluded,
      ratio: cue.text.length === 0 ? 0 : output.length / cue.text.length,
      shortfall: false,
      lineDisagree: countLines(output) !== countLines(cue.text)
    })
  }
  if (pairs.length < MIN_CUES) return []

  const counted = pairs.filter((p) => !p.excluded)
  if (counted.length === 0) return []

  // Mark the cues that sit inside a long identical run. Used twice below: to keep them out of the
  // S2 baseline, and to trim a reported range back to the cues that earned it.
  const runMember = new Array<boolean>(pairs.length).fill(false)
  {
    let start = 0
    while (start < pairs.length) {
      if (pairs[start].excluded) {
        start++
        continue
      }
      let end = start + 1
      while (end < pairs.length && !pairs[end].excluded && pairs[end].output === pairs[start].output) {
        end++
      }
      const sourcesVary = pairs.slice(start, end).some((p) => p.source !== pairs[start].source)
      if (sourcesVary && end - start >= S1_RUN) for (let i = start; i < end; i++) runMember[i] = true
      start = end
    }
  }

  // S2 is a ratio of a ratio, which is what carries it across languages and expansion factors
  // without a per-language constant.
  //
  // The baseline excludes cues already known to sit in a long identical run. Without that, a file
  // where the filler is the *majority* defeats the signal by definition: the median ratio becomes
  // the filler's own ratio, so nothing is short relative to it and S2 goes quiet exactly when the
  // damage is worst. G3's pair fixtures caught this. On a clean file the exclusion is a no-op —
  // the longest identical run measured on a real translation is 8, below S1's threshold of 12 — so
  // it costs nothing in false positives and is what lets a mostly-filler file still be seen.
  const baseline: number[] = []
  for (let i = 0; i < pairs.length; i++) {
    if (!pairs[i].excluded && !runMember[i]) baseline.push(pairs[i].ratio)
  }
  const reference = baseline.length > 0 ? baseline : counted.map((p) => p.ratio)
  const cutoff = median(reference) * S2_MEDIAN_FRACTION
  for (const p of pairs) p.shortfall = !p.excluded && p.ratio < cutoff
  const isEvidence = (i: number): boolean => runMember[i] || pairs[i].shortfall || pairs[i].lineDisagree

  interface Affected {
    start: number
    end: number
    signals: Set<string>
  }
  const affected: Affected[] = []
  for (let start = 0; start < pairs.length; start += STEP) {
    const end = Math.min(start + WINDOW, pairs.length)
    if (end - start < MIN_CUES) break
    const slice = pairs.slice(start, end)
    const inWindow = slice.filter((p) => !p.excluded)
    if (inWindow.length === 0) continue

    const s1 = longestIdenticalRun(slice) >= S1_RUN
    const s2 = inWindow.filter((p) => p.shortfall).length / inWindow.length >= S2_WINDOW_SHARE
    const s3 = inWindow.filter((p) => !p.lineDisagree).length / inWindow.length < S3_AGREEMENT

    // Two of three must trip in the SAME window. No signal warns alone: S1 would fire on a file of
    // repeated sound cues, S2 on a language that compresses hard, S3 on a translator that
    // legitimately re-wraps.
    const signals = [s1 && 'repeated text', s2 && 'length collapse', s3 && 'line structure'].filter(
      (s): s is string => typeof s === 'string'
    )
    if (signals.length >= 2) affected.push({ start, end: end - 1, signals: new Set(signals) })
  }

  const drifted = alignmentWarnings(pairs, runMember)
  if (affected.length === 0) return drifted

  // Merge windows that overlap or touch; regions separated by a clean window are reported separately.
  const regions: Affected[] = []
  for (const win of affected) {
    const last = regions[regions.length - 1]
    if (last && win.start <= last.end + 1) {
      last.end = Math.max(last.end, win.end)
      for (const s of win.signals) last.signals.add(s)
    } else {
      regions.push({ start: win.start, end: win.end, signals: new Set(win.signals) })
    }
  }

  const filler = regions.map((region) => {
    // Trim to the cues that actually carry evidence. Windows are 50 wide and step by 10, so raw
    // window bounds overshoot by up to 49 cues on either side; a warning that names 31 clean cues
    // as suspect is the kind of imprecision that gets warnings ignored.
    let from = region.start
    let to = region.end
    while (from <= to && !isEvidence(from)) from++
    while (to >= from && !isEvidence(to)) to--
    if (from > to) {
      from = region.start
      to = region.end
    }
    const first = pairs[from].index
    const last = pairs[to].index
    const count = to - from + 1
    return {
      from: first,
      to: last,
      cues: count,
      signals: [...region.signals],
      message:
        `Cues ${first}–${last} (${count} of ${pairs.length}) do not look like a real translation ` +
        `— ${[...region.signals].join(' and ')}. The engine counts items rather than reading them, ` +
        `so a run like this is reported as success. Nothing has been changed: the file is exactly ` +
        `as the engine wrote it. Check that range before using it.`
    }
  })
  return [...filler, ...drifted]
}
