import { useEffect, useRef, useState, useCallback } from 'react'

export type RunStatus = 'idle' | 'running' | 'done' | 'error'

export interface TokenTally {
  prompt: number
  thoughts: number
  output: number
  total: number
}

export interface RunnerState {
  status: RunStatus
  log: string[]
  progress: number
  tokenStats: string
  tokens: TokenTally | null
  currentLine: number
  totalLines: number
  statusText: string
  outputPath: string
  logPaths: string[]
  exitCode: number | null
}

const INITIAL: RunnerState = {
  status: 'idle',
  log: [],
  progress: 0,
  tokenStats: '',
  tokens: null,
  currentLine: 0,
  totalLines: 0,
  statusText: '',
  outputPath: '',
  logPaths: [],
  exitCode: null
}

// Strip ANSI escape sequences (cursor moves, line erases, colors) that the CLI
// emits for its live terminal UI but which render as garbage in a plain log.
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g

// A line that is purely the animated progress/spinner bar — noise we don't want
// to accumulate in the log.
function isSpinnerLine(s: string): boolean {
  return /[█░]/.test(s) || /^Translating:\s*\|/.test(s)
}

function deriveStatus(s: string): string | null {
  if (/sending batch/i.test(s)) return 'Sending batch…'
  if (/validating token size/i.test(s)) return 'Validating tokens…'
  if (/token size validated|translating/i.test(s)) return 'Translating…'
  if (/starting translation/i.test(s)) return 'Starting…'
  return null
}

export function useRunner(): {
  state: RunnerState
  start: (launch: () => Promise<string>) => Promise<void>
  stop: () => Promise<void>
  reset: () => void
} {
  const [state, setState] = useState<RunnerState>(INITIAL)
  const cleanup = useRef<Array<() => void>>([])

  useEffect(() => {
    return () => cleanup.current.forEach((fn) => fn())
  }, [])

  const reset = useCallback(() => {
    setState(INITIAL)
  }, [])

  const start = useCallback(async (launch: () => Promise<string>) => {
    cleanup.current.forEach((fn) => fn())
    cleanup.current = []
    setState({ ...INITIAL, status: 'running' })

    const offOut = window.api.onOutput(({ line }) => {
      if (!line) return
      const clean = line.replace(ANSI, '').trim()
      if (!clean) return

      setState((s) => {
        let { progress, tokenStats, tokens, currentLine, totalLines, statusText } = s

        // Total line count — announced once at the start.
        const totalDecl = clean.match(/translation of (\d+) lines/i)
        if (totalDecl) totalLines = parseInt(totalDecl[1], 10)

        // Progress "(cur/total)" — usually inside the spinner line.
        const frac = clean.match(/(\d+)\s*\/\s*(\d+)/)
        if (frac && /translat|batch|processing|%/i.test(clean)) {
          const cur = parseInt(frac[1], 10)
          const tot = parseInt(frac[2], 10)
          if (tot > 0) {
            currentLine = cur
            totalLines = tot
            progress = Math.min(100, Math.round((cur / tot) * 100))
          }
        }

        const pct = clean.match(/(\d{1,3})\s?%/)
        if (pct) progress = Math.min(100, parseInt(pct[1], 10))

        // Token breakdown line.
        const tk = clean.match(
          /Prompt Tokens:\s*(\d+)\s*\|\s*Thoughts Tokens:\s*(\d+)\s*\|\s*Output Tokens:\s*(\d+)\s*\|\s*Total Tokens:\s*(\d+)/i
        )
        if (tk) {
          tokens = {
            prompt: parseInt(tk[1], 10),
            thoughts: parseInt(tk[2], 10),
            output: parseInt(tk[3], 10),
            total: parseInt(tk[4], 10)
          }
          tokenStats = clean
        }

        const st = deriveStatus(clean)
        if (st) statusText = st

        // Keep a clean log for error inspection: drop spinner/progress noise,
        // token lines (surfaced separately), and consecutive duplicates.
        let log = s.log
        const skip = isSpinnerLine(clean) || tk !== null
        if (!skip && clean !== s.log[s.log.length - 1]) {
          log = [...s.log, clean]
        }

        return { ...s, log, progress, tokenStats, tokens, currentLine, totalLines, statusText }
      })
    })

    const offDone = window.api.onDone(({ code, outputPath, logPaths }) => {
      setState((s) => ({
        ...s,
        status: code === 0 ? 'done' : 'error',
        progress: code === 0 ? 100 : s.progress,
        statusText: code === 0 ? 'Completed' : 'Failed',
        outputPath,
        logPaths: logPaths ?? [],
        exitCode: code
      }))
    })

    cleanup.current = [offOut, offDone]

    try {
      await launch()
    } catch (e) {
      setState((s) => ({ ...s, status: 'error', log: [...s.log, String(e)] }))
    }
  }, [])

  const stop = useCallback(async () => {
    await window.api.stop()
    setState((s) => ({ ...s, status: s.status === 'running' ? 'error' : s.status }))
  }, [])

  return { state, start, stop, reset }
}
