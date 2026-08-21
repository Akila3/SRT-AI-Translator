import React, { useState, useRef } from 'react'

// ─── Tooltip ("?") ───────────────────────────────────────────────────────────
export function Tooltip({ tip }: { tip: string }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <span className="relative inline-flex items-center">
      <span
        className="ml-1 inline-flex h-4 w-4 cursor-help items-center justify-center rounded-full border border-gray-300 text-[10px] font-semibold text-gray-500 hover:bg-gray-100 dark:border-gray-600 dark:text-gray-400 dark:hover:bg-gray-700"
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
      >
        ?
      </span>
      {open && (
        <span
          className="absolute left-5 top-0 z-50 w-80 whitespace-pre-wrap rounded-md border border-gray-200 bg-white p-3 text-xs leading-relaxed text-gray-700 shadow-lg dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300"
          style={{ pointerEvents: 'none' }}
        >
          {tip}
        </span>
      )}
    </span>
  )
}

export function Label({
  children,
  tip
}: {
  children: React.ReactNode
  tip?: string
}): React.JSX.Element {
  return (
    <div className="mb-1.5 flex items-center text-[11px] font-semibold tracking-wide text-gray-500 dark:text-gray-400">
      <span className="uppercase">{children}</span>
      {tip && <Tooltip tip={tip} />}
    </div>
  )
}

// ─── Button ──────────────────────────────────────────────────────────────────
type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger'
export function Button({
  children,
  variant = 'primary',
  className = '',
  ...rest
}: {
  variant?: ButtonVariant
  className?: string
} & React.ButtonHTMLAttributes<HTMLButtonElement>): React.JSX.Element {
  const base =
    'inline-flex items-center justify-center gap-1.5 rounded-md px-3.5 py-2 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50'
  const variants: Record<ButtonVariant, string> = {
    primary: 'bg-brand text-white hover:bg-brand-hover',
    secondary:
      'border border-gray-300 bg-white text-gray-800 hover:bg-gray-50 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 dark:hover:bg-gray-600',
    ghost: 'text-brand hover:bg-blue-50 dark:hover:bg-blue-950/40',
    danger: 'bg-red-600 text-white hover:bg-red-700'
  }
  return (
    <button className={`${base} ${variants[variant]} ${className}`} {...rest}>
      {children}
    </button>
  )
}

// ─── Text input ────────────────────────────────────────────────────────────
export function TextInput({
  className = '',
  ...rest
}: React.InputHTMLAttributes<HTMLInputElement>): React.JSX.Element {
  return (
    <input
      className={`rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 outline-none placeholder:text-gray-400 focus:border-brand focus:ring-1 focus:ring-brand disabled:bg-gray-100 disabled:text-gray-400 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 dark:placeholder:text-gray-500 dark:disabled:bg-gray-800 dark:disabled:text-gray-500 ${className}`}
      {...rest}
    />
  )
}

// Number input with min/max clamping on change
export function NumberInput({
  value,
  onChange,
  min,
  max,
  step,
  allowEmpty = false,
  disabled,
  placeholder,
  className = ''
}: {
  value: number | null
  onChange: (v: number | null) => void
  min: number
  max: number
  step?: number
  allowEmpty?: boolean
  disabled?: boolean
  placeholder?: string
  className?: string
}): React.JSX.Element {
  return (
    <TextInput
      type="number"
      className={`no-spin ${className}`}
      min={min}
      max={max}
      step={step}
      disabled={disabled}
      placeholder={placeholder}
      value={value === null ? '' : value}
      onChange={(e) => {
        const raw = e.target.value
        if (raw === '') {
          onChange(allowEmpty ? null : min)
          return
        }
        let n = step && step < 1 ? parseFloat(raw) : parseInt(raw, 10)
        if (Number.isNaN(n)) n = min
        n = Math.min(max, Math.max(min, n))
        if (step && step < 1) n = Math.round(n * 100) / 100
        onChange(n)
      }}
    />
  )
}

// ─── Select ────────────────────────────────────────────────────────────────
export function Select({
  value,
  onChange,
  options,
  className = '',
  disabled
}: {
  value: string
  onChange: (v: string) => void
  options: { value: string; label: string }[]
  className?: string
  disabled?: boolean
}): React.JSX.Element {
  return (
    <select
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
      className={`rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 outline-none focus:border-brand focus:ring-1 focus:ring-brand disabled:bg-gray-100 disabled:text-gray-400 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 dark:disabled:bg-gray-800 dark:disabled:text-gray-500 ${className}`}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  )
}

// ─── Toggle ───────────────────────────────────────────────────────────────
export function Toggle({
  checked,
  onChange,
  disabled
}: {
  checked: boolean
  onChange: (v: boolean) => void
  disabled?: boolean
}): React.JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-5 w-9 flex-shrink-0 items-center rounded-full transition-colors disabled:opacity-50 ${
        checked ? 'bg-brand' : 'bg-gray-300 dark:bg-gray-600'
      }`}
    >
      <span
        className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
          checked ? 'translate-x-4' : 'translate-x-0.5'
        }`}
      />
    </button>
  )
}

export function ToggleRow({
  label,
  desc,
  checked,
  onChange,
  tip,
  disabled
}: {
  label: string
  desc: string
  checked: boolean
  onChange: (v: boolean) => void
  tip?: string
  disabled?: boolean
}): React.JSX.Element {
  return (
    <div className="flex items-start gap-3 py-1">
      <div className="pt-0.5">
        <Toggle checked={checked} onChange={onChange} disabled={disabled} />
      </div>
      <div className="flex-1">
        <div className="flex items-center text-sm font-medium text-gray-800 dark:text-gray-200">
          {label}
          {tip && <Tooltip tip={tip} />}
        </div>
        <div className="text-xs text-gray-500 dark:text-gray-400">{desc}</div>
      </div>
    </div>
  )
}

// ─── Card / Box ──────────────────────────────────────────────────────────────
export function Box({
  children,
  className = ''
}: {
  children: React.ReactNode
  className?: string
}): React.JSX.Element {
  return (
    <div className={`rounded-lg border border-gray-200 bg-white p-5 dark:border-gray-700 dark:bg-gray-800 ${className}`}>{children}</div>
  )
}

export function BoxTitle({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <div className="mb-4 text-[15px] font-semibold text-gray-900 dark:text-gray-100">{children}</div>
}

export function Divider(): React.JSX.Element {
  return <div className="my-1 h-px w-full bg-gray-200 dark:bg-gray-700" />
}

export function Pill({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <span className="rounded-full bg-blue-50 px-2.5 py-0.5 text-xs font-medium text-brand dark:bg-blue-950/50 dark:text-blue-300">
      {children}
    </span>
  )
}

// ─── File picker ─────────────────────────────────────────────────────────────
export function FilePicker({
  value,
  onPick,
  onClear,
  placeholder
}: {
  value: string
  onPick: () => void
  onClear?: () => void
  placeholder: string
}): React.JSX.Element {
  return (
    <div className="flex items-center gap-2">
      <TextInput readOnly value={value} placeholder={placeholder} className="flex-1" />
      <Button variant="secondary" onClick={onPick}>
        Browse
      </Button>
      {value && onClear && (
        <button
          title="Clear"
          onClick={onClear}
          className="flex h-9 w-9 items-center justify-center rounded-md border border-gray-300 text-gray-500 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-400 dark:hover:bg-gray-700"
        >
          ✕
        </button>
      )}
    </div>
  )
}

// ─── Progress bar ────────────────────────────────────────────────────────────
export function ProgressBar({ pct }: { pct: number }): React.JSX.Element {
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-gray-200 dark:bg-gray-700">
      <div
        className="h-full rounded-full bg-brand transition-all duration-300"
        style={{ width: `${Math.min(100, Math.max(0, pct))}%` }}
      />
    </div>
  )
}

// ─── Spinner ─────────────────────────────────────────────────────────────────
export function Spinner(): React.JSX.Element {
  return (
    <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-gray-300 border-t-brand dark:border-gray-600 dark:border-t-brand" />
  )
}

// ─── Live status card (structured translation progress) ───────────────────────
interface StatusCardProps {
  running: boolean
  statusText: string
  currentLine: number
  totalLines: number
  batchSize: number
  tokens: { prompt: number; thoughts: number; output: number; total: number } | null
  showTokens: boolean
  model: string
}

function StatCell({ label, value, accent }: { label: string; value: React.ReactNode; accent?: boolean }): React.JSX.Element {
  return (
    <div>
      <div className="mb-0.5 text-[10px] font-semibold uppercase tracking-wide text-gray-400 dark:text-gray-500">{label}</div>
      <div className={`flex items-center gap-1.5 text-sm font-medium ${accent ? 'text-brand' : 'text-gray-800 dark:text-gray-100'}`}>
        {value}
      </div>
    </div>
  )
}

export function StatusCard({
  running,
  statusText,
  currentLine,
  totalLines,
  batchSize,
  tokens,
  showTokens,
  model
}: StatusCardProps): React.JSX.Element {
  const pct = totalLines > 0 ? Math.round((currentLine / totalLines) * 100) : 0
  const totalBatches = totalLines > 0 && batchSize > 0 ? Math.ceil(totalLines / batchSize) : 0
  const currentBatch = totalBatches > 0 ? Math.min(totalBatches, Math.floor(currentLine / batchSize) + 1) : 0
  const tokenCols: { label: string; value: number; className: string }[] = tokens
    ? [
        { label: 'Prompt', value: tokens.prompt, className: 'text-blue-600 dark:text-blue-400' },
        { label: 'Thoughts', value: tokens.thoughts, className: 'text-purple-600 dark:text-purple-400' },
        { label: 'Output', value: tokens.output, className: 'text-green-600 dark:text-green-400' },
        { label: 'Total', value: tokens.total, className: 'text-gray-900 dark:text-gray-100' }
      ]
    : []

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3 rounded-lg border border-gray-200 bg-gray-50 px-4 py-3 dark:border-gray-700 dark:bg-gray-900/40">
        <StatCell label="Lines translated" value={totalLines > 0 ? `${currentLine} / ${totalLines}` : `${currentLine}`} />
        <StatCell label="Progress" value={`${pct}%`} />
        {totalBatches > 0 && <StatCell label="Batch" value={`${currentBatch} / ${totalBatches}`} />}
        <StatCell
          label="Status"
          accent={running}
          value={
            <>
              {statusText || (running ? 'Working…' : '—')}
              {running && <Spinner />}
            </>
          }
        />
      </div>

      {showTokens && tokens && (
        <div className="rounded-lg border border-gray-200 bg-white px-4 py-3 dark:border-gray-700 dark:bg-gray-800">
          <div className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-gray-400 dark:text-gray-500">
            Token Usage{model ? ` · ${model}` : ''}
          </div>
          <div className="flex gap-6">
            {tokenCols.map((c) => (
              <div key={c.label}>
                <div className="mb-0.5 text-[10px] text-gray-400 dark:text-gray-500">{c.label}</div>
                <div className={`text-[15px] font-semibold tabular-nums ${c.className}`}>{c.value.toLocaleString()}</div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Log panel ───────────────────────────────────────────────────────────────
export function LogPanel({ lines }: { lines: string[] }): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  React.useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight
  }, [lines])
  return (
    <div
      ref={ref}
      className="thin-scroll max-h-48 overflow-y-auto rounded-md bg-gray-900 p-3 font-mono text-[11px] leading-relaxed text-gray-100"
    >
      {lines.length === 0 ? (
        <div className="text-gray-500">Waiting to start…</div>
      ) : (
        lines.map((l, i) => (
          <div key={i} className="log-row whitespace-pre-wrap">
            {l}
          </div>
        ))
      )}
    </div>
  )
}
