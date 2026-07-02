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

function execCapture(cmd: string, args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let proc
    try {
      proc = spawn(cmd, args)
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
