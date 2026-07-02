export interface FreeTier {
  rpm: string
  rpd: string
  tpm: string
  tpr: string
}

const LITE: FreeTier = { rpm: '30', rpd: '1,500', tpm: '1,000,000', tpr: '64,000' }
const FLASH: FreeTier = { rpm: '15', rpd: '500', tpm: '1,000,000', tpr: '1,048,576' }
const PRO: FreeTier = { rpm: '5', rpd: '25', tpm: '250,000', tpr: '1,048,576' }

export const FREE_TIER: Record<string, FreeTier> = {
  // "latest" aliases resolve to the newest model in each tier
  'gemini-flash-lite-latest': LITE,
  'gemini-flash-latest': FLASH,
  'gemini-pro-latest': PRO,
  'gemini-3.5-flash': FLASH,
  'gemini-3.1-flash-lite': LITE,
  'gemini-3.1-pro': PRO,
  'gemini-2.5-flash': FLASH,
  'gemini-2.5-flash-lite': LITE,
  'gemini-2.5-pro': PRO
}

/** Fall back to per-family limits for any fetched model not explicitly listed. */
function lookupFreeTier(model: string): FreeTier | undefined {
  if (FREE_TIER[model]) return FREE_TIER[model]
  if (/flash-lite/.test(model)) return LITE
  if (/pro/.test(model)) return PRO
  if (/flash/.test(model)) return FLASH
  return undefined
}

export function paidQuotaTooltip(model: string, modelLabel: string): string {
  const ft = lookupFreeTier(model)
  const limits = ft
    ? `\n• ${ft.rpm} RPM  — requests per minute\n• ${ft.rpd} RPD  — requests per day\n• ${ft.tpm} TPM  — tokens per minute\n• ${ft.tpr} tokens per request`
    : '\n• See Google AI Studio for current limits'
  return (
    `Enable this if you have a paid Google AI Studio account (Google AI Pro or higher).\n\n` +
    `When OFF — the app adds conservative delays to stay within the free-tier rate limits for ${modelLabel}:${limits}\n\n` +
    `When ON — rate limiting is disabled and the app runs at full speed. Only enable this if you are actually on a paid plan, or you will hit 429 quota errors.`
  )
}

export const THINKING_LEVELS = [
  { value: 'disabled', label: 'Disabled' },
  { value: 'minimal', label: 'Minimal' },
  { value: 'low', label: 'Low (Default)' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' }
]

export const SERVICE_TIERS = [
  { value: 'standard', label: 'Standard (Default)' },
  { value: 'flex', label: 'Flex' },
  { value: 'priority', label: 'Priority' }
]
