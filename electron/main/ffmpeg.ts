import { spawn } from 'child_process'
import { app } from 'electron'
import path from 'path'
import fs from 'fs'
import { normalizeTrackLang } from '../shared/languages'
import { durationFromProbe, percentOf, readProgressChunk } from '../shared/ffmpegProgress'
import type { SubtitleTrack } from '../shared/types'

const EXE = process.platform === 'win32' ? '.exe' : ''

/**
 * Resolve ffmpeg/ffprobe in priority order so the app stays portable:
 *   1. Explicit path set in Settings → Advanced (user override)
 *   2. A copy bundled next to the app (resources/bin) — fully portable
 *   3. The system PATH (developer machines / users who have FFmpeg installed)
 */
function bundledBinDir(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'bin')
    : path.join(app.getAppPath(), 'resources', 'bin')
}

function resolveTool(tool: 'ffmpeg' | 'ffprobe', ffmpegPath?: string): string {
  if (ffmpegPath && ffmpegPath.trim()) {
    const dir = path.dirname(ffmpegPath)
    return path.join(dir, tool + EXE)
  }
  const bundled = path.join(bundledBinDir(), tool + EXE)
  if (fs.existsSync(bundled)) return bundled
  return tool
}

/**
 * Directories that contain ffmpeg/ffprobe, in priority order, to prepend to a
 * child process's PATH. The bundled `gst` CLI shells out to plain `ffmpeg`, so
 * it must be discoverable on PATH (it even hard-exits on list-models if not).
 */
export function ffmpegPathDirs(ffmpegPath?: string): string[] {
  const dirs: string[] = []
  if (ffmpegPath && ffmpegPath.trim()) dirs.push(path.dirname(ffmpegPath))
  const dir = bundledBinDir()
  if (fs.existsSync(path.join(dir, 'ffmpeg' + EXE))) dirs.push(dir)
  return dirs
}

/**
 * Build a child-process env with the resolved ffmpeg dir(s) APPENDED to PATH.
 * We append (not prepend) on purpose: the bundled bin dir also contains gst.exe,
 * and prepending it would shadow the intended `gst` (e.g. the pip install in dev)
 * — which broke non-UTF-8 output. Appending keeps the right gst while still
 * making ffmpeg discoverable for gst's internal calls.
 */
export function envWithFfmpeg(ffmpegPath?: string, extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const dirs = ffmpegPathDirs(ffmpegPath)
  const sep = process.platform === 'win32' ? ';' : ':'
  const base = process.env.PATH ?? process.env.Path ?? ''
  const PATH = dirs.length ? [base, ...dirs].join(sep) : base
  return { ...process.env, ...extra, PATH }
}

function execCapture(
  cmd: string,
  args: string[],
  opts?: { signal?: AbortSignal; onStdout?: (chunk: string) => void }
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let proc
    try {
      proc = spawn(cmd, args, opts?.signal ? { signal: opts.signal } : {})
    } catch (err) {
      resolve({ code: -1, stdout: '', stderr: (err as Error).message })
      return
    }
    proc.stdout.on('data', (d) => {
      const text = d.toString()
      stdout += text
      opts?.onStdout?.(text)
    })
    proc.stderr.on('data', (d) => (stderr += d.toString()))
    proc.on('error', (err) => resolve({ code: -1, stdout, stderr: err.message }))
    proc.on('close', (code) => resolve({ code, stdout, stderr }))
  })
}

/**
 * How far along a long ffmpeg call is, reported as it runs.
 *
 * `pct` is null when the input will not say how long it is; the caller shows the elapsed
 * time instead rather than an invented bar.
 */
export type ProgressReporter = (pct: number | null, elapsedMs: number) => void

/**
 * The media's length in seconds, or null if it will not say.
 *
 * Only ever used to turn ffmpeg's reported position into a percentage, so every failure here
 * is answered with null — an unreadable file is about to fail in the actual call, where the
 * error belongs, and a stream with no duration is a legitimate input that simply cannot have
 * a percentage.
 *
 * `signal` is not optional in spirit, only in signature. This runs *before* the work it
 * measures, so a caller whose work can be cancelled must pass its signal or the cancellation
 * cannot reach the first child process it starts — reading a header is normally instant, but
 * on an unreachable network path it is not bounded by anything (validator finding FP6-01).
 */
export async function probeDuration(
  filePath: string,
  ffmpegPath?: string,
  signal?: AbortSignal
): Promise<number | null> {
  const ffprobe = resolveTool('ffprobe', ffmpegPath)
  const { stdout } = await execCapture(
    ffprobe,
    [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      filePath
    ],
    { signal }
  )
  return durationFromProbe(stdout)
}

/**
 * Run ffmpeg so that it says how far it has got.
 *
 * The whole of the change is `-progress pipe:1`: it costs one extra ffprobe (only when
 * somebody is listening) and turns a call that was silent for minutes into one that reports
 * every half second. `-nostats` removes the human-readable stderr counter that would
 * otherwise be interleaved with the errors we read back on failure.
 *
 * The flags lead the command line rather than trailing it: they are global options, and
 * ffmpeg binds anything placed after an input or an output to that file instead.
 */
async function execFfmpeg(
  ffmpeg: string,
  args: string[],
  opts: {
    /** The file whose duration turns a position into a percentage. */
    source: string
    ffmpegPath?: string
    signal?: AbortSignal
    onProgress?: ProgressReporter
  }
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const { onProgress } = opts
  if (!onProgress) return execCapture(ffmpeg, args, { signal: opts.signal })

  const startedAt = Date.now()
  // The signal goes to the probe as well as to the work. Without it a Stop pressed during
  // this measurement cannot end anything: the check below is only reached once ffprobe has
  // finished of its own accord, which on a stalled network path may be never, and the job
  // slot stays held for all of it (validator finding FP6-01). The check stays as well — an
  // abort makes the probe resolve, and resolving must not then start the conversion.
  const duration = await probeDuration(opts.source, opts.ffmpegPath, opts.signal)
  if (opts.signal?.aborted) return { code: -1, stdout: '', stderr: 'Aborted.' }

  // Only whole lines are ever parsed. A pipe read can end mid-number, and `out_time_us=1000`
  // is a perfectly valid parse of the first half of `out_time_us=10000000` — a report that is
  // not merely missing but WRONG, and wrong in the one direction the bar must never move.
  // The remainder is carried to the next chunk, exactly as the engine's stdout is read.
  let carry = ''
  const withProgress = ['-progress', 'pipe:1', '-nostats', ...args]
  return execCapture(ffmpeg, withProgress, {
    signal: opts.signal,
    onStdout: (chunk) => {
      carry += chunk
      const lastBreak = carry.lastIndexOf('\n')
      if (lastBreak < 0) return
      const complete = carry.slice(0, lastBreak + 1)
      carry = carry.slice(lastBreak + 1)
      const { outTimeSec } = readProgressChunk(complete)
      if (outTimeSec === null) return
      onProgress(percentOf(outTimeSec, duration), Date.now() - startedAt)
    }
  })
}

const IMAGE_CODECS = ['hdmv_pgs_subtitle', 'pgssub', 'dvd_subtitle', 'dvdsub', 'xsub']

export async function probeTracks(filePath: string, ffmpegPath?: string): Promise<SubtitleTrack[]> {
  const ffprobe = resolveTool('ffprobe', ffmpegPath)
  const args = [
    '-v', 'error',
    '-select_streams', 's',
    '-show_entries', 'stream=index,codec_name:stream_tags=language,title',
    '-of', 'json',
    filePath
  ]
  const { stdout } = await execCapture(ffprobe, args)
  let parsed: { streams?: Array<{ codec_name?: string; tags?: { language?: string; title?: string } }> }
  try {
    parsed = JSON.parse(stdout || '{}')
  } catch {
    return []
  }
  const streams = parsed.streams ?? []
  return streams.map((s, i) => {
    const codec = s.codec_name ?? 'unknown'
    const isImage = IMAGE_CODECS.includes(codec)
    const langRaw = s.tags?.language ?? ''
    const code = normalizeTrackLang(langRaw)
    const baseName = s.tags?.title || langRaw || `Track ${i}`
    return {
      // subtitle-relative index → used for ffmpeg -map 0:s:N
      index: i,
      codec,
      lang: code || langRaw.toLowerCase(),
      name: isImage ? `${baseName} (PGS)` : baseName,
      isImage
    }
  })
}

/**
 * Transcode an audio file to mono MP3 for the engine.
 *
 * The engine loads audio with pydub, which hands ffmpeg a forced input format; an
 * AAC/M4A/FLAC file is then decoded as `mp3float`, produces no packets, and dies with
 * "Conversion failed!" — reported by the frozen build as `name 'exit' is not defined`,
 * because PyInstaller omits the `site` builtin that `exit()` comes from. Verified against
 * gst 3.7.0 on 2026-08-19: of the formats the picker offers, only `.mp3` and `.wav` survive.
 *
 * MP3 is not an arbitrary choice — it is what the engine's own `extract_audio_from_video`
 * produces for video input, so this hands it a shape it already reads. Mono at 64 kbps
 * matches its own downmix-and-compress step and keeps the upload small; speech does not
 * benefit from more.
 */
export async function convertAudioToMp3(
  inputPath: string,
  outPath: string,
  ffmpegPath?: string,
  signal?: AbortSignal,
  onProgress?: ProgressReporter
): Promise<{ ok: boolean; error?: string }> {
  const ffmpeg = resolveTool('ffmpeg', ffmpegPath)
  const { code, stderr } = await execFfmpeg(
    ffmpeg,
    [
      '-y', '-i', inputPath,
      '-vn', '-sn', '-dn', '-map', '0:a:0', '-map_metadata', '-1',
      '-ac', '1', '-ar', '22050', '-c:a', 'libmp3lame', '-b:a', '64k',
      outPath
    ],
    { source: inputPath, ffmpegPath, signal, onProgress }
  )
  if (code === 0 && fs.existsSync(outPath) && fs.statSync(outPath).size > 0) return { ok: true }

  // A failed or cancelled conversion still leaves a partial file behind, and nothing
  // downstream knows about a path that was never returned to it.
  try {
    if (fs.existsSync(outPath)) fs.unlinkSync(outPath)
  } catch {
    /* best effort */
  }
  const detail = stderr.trim().split(/\r?\n/).slice(-3).join(' ').trim()
  return { ok: false, error: detail || `ffmpeg exited with code ${code}` }
}

/**
 * Write one subtitle track out of a container.
 *
 * `onProgress` is optional and absent by default because two callers of this are silent by
 * design (the verification probes), and asking for progress costs an extra ffprobe. When it
 * IS supplied the percentage is measured against the *video's* duration, which is the right
 * denominator: ffmpeg walks the whole container to find the track's packets, so the work is
 * proportional to the film's length rather than to the subtitle's size.
 */
export async function extractTrack(
  filePath: string,
  subtitleIndex: number,
  outPath: string,
  isImage: boolean,
  ffmpegPath?: string,
  onProgress?: ProgressReporter
): Promise<{ ok: boolean; error?: string }> {
  const ffmpeg = resolveTool('ffmpeg', ffmpegPath)
  const args = isImage
    ? ['-y', '-i', filePath, '-map', `0:s:${subtitleIndex}`, '-c:s', 'copy', outPath]
    : ['-y', '-i', filePath, '-map', `0:s:${subtitleIndex}`, '-c:s', 'srt', outPath]
  const { code, stderr } = await execFfmpeg(ffmpeg, args, {
    source: filePath,
    ffmpegPath,
    onProgress
  })
  if (code === 0) return { ok: true }
  return { ok: false, error: stderr.split(/\r?\n/).slice(-5).join('\n') }
}
