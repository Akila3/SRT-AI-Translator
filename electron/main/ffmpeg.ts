import { spawn } from 'child_process'
import { app } from 'electron'
import path from 'path'
import fs from 'fs'
import { normalizeTrackLang } from '../shared/languages'
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
  signal?: AbortSignal
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let proc
    try {
      proc = spawn(cmd, args, signal ? { signal } : {})
    } catch (err) {
      resolve({ code: -1, stdout: '', stderr: (err as Error).message })
      return
    }
    proc.stdout.on('data', (d) => (stdout += d.toString()))
    proc.stderr.on('data', (d) => (stderr += d.toString()))
    proc.on('error', (err) => resolve({ code: -1, stdout, stderr: err.message }))
    proc.on('close', (code) => resolve({ code, stdout, stderr }))
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
  signal?: AbortSignal
): Promise<{ ok: boolean; error?: string }> {
  const ffmpeg = resolveTool('ffmpeg', ffmpegPath)
  const { code, stderr } = await execCapture(
    ffmpeg,
    [
      '-y', '-i', inputPath,
      '-vn', '-sn', '-dn', '-map', '0:a:0', '-map_metadata', '-1',
      '-ac', '1', '-ar', '22050', '-c:a', 'libmp3lame', '-b:a', '64k',
      outPath
    ],
    signal
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

export async function extractTrack(
  filePath: string,
  subtitleIndex: number,
  outPath: string,
  isImage: boolean,
  ffmpegPath?: string
): Promise<{ ok: boolean; error?: string }> {
  const ffmpeg = resolveTool('ffmpeg', ffmpegPath)
  const args = isImage
    ? ['-y', '-i', filePath, '-map', `0:s:${subtitleIndex}`, '-c:s', 'copy', outPath]
    : ['-y', '-i', filePath, '-map', `0:s:${subtitleIndex}`, '-c:s', 'srt', outPath]
  const { code, stderr } = await execCapture(ffmpeg, args)
  if (code === 0) return { ok: true }
  return { ok: false, error: stderr.split(/\r?\n/).slice(-5).join('\n') }
}
