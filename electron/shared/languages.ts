export interface LangOption {
  value: string
  label: string
  /** Name passed to the gst CLI via -l (Gemini understands full language names) */
  gstName: string
}

export const LANGUAGES: LangOption[] = [
  { value: 'auto', label: 'Auto Detect', gstName: '' },
  { value: 'af', label: 'Afrikaans', gstName: 'Afrikaans' },
  { value: 'sq', label: 'Albanian', gstName: 'Albanian' },
  { value: 'am', label: 'Amharic', gstName: 'Amharic' },
  { value: 'ar', label: 'Arabic', gstName: 'Arabic' },
  { value: 'hy', label: 'Armenian', gstName: 'Armenian' },
  { value: 'az', label: 'Azerbaijani', gstName: 'Azerbaijani' },
  { value: 'eu', label: 'Basque', gstName: 'Basque' },
  { value: 'be', label: 'Belarusian', gstName: 'Belarusian' },
  { value: 'bn', label: 'Bengali', gstName: 'Bengali' },
  { value: 'bs', label: 'Bosnian', gstName: 'Bosnian' },
  { value: 'bg', label: 'Bulgarian', gstName: 'Bulgarian' },
  { value: 'ca', label: 'Catalan', gstName: 'Catalan' },
  { value: 'zh', label: 'Chinese (Simplified)', gstName: 'Simplified Chinese' },
  { value: 'zh-TW', label: 'Chinese (Traditional)', gstName: 'Traditional Chinese' },
  { value: 'hr', label: 'Croatian', gstName: 'Croatian' },
  { value: 'cs', label: 'Czech', gstName: 'Czech' },
  { value: 'da', label: 'Danish', gstName: 'Danish' },
  { value: 'nl', label: 'Dutch', gstName: 'Dutch' },
  { value: 'en', label: 'English', gstName: 'English' },
  { value: 'et', label: 'Estonian', gstName: 'Estonian' },
  { value: 'fi', label: 'Finnish', gstName: 'Finnish' },
  { value: 'fr', label: 'French', gstName: 'French' },
  { value: 'gl', label: 'Galician', gstName: 'Galician' },
  { value: 'ka', label: 'Georgian', gstName: 'Georgian' },
  { value: 'de', label: 'German', gstName: 'German' },
  { value: 'el', label: 'Greek', gstName: 'Greek' },
  { value: 'gu', label: 'Gujarati', gstName: 'Gujarati' },
  { value: 'ht', label: 'Haitian Creole', gstName: 'Haitian Creole' },
  { value: 'he', label: 'Hebrew', gstName: 'Hebrew' },
  { value: 'hi', label: 'Hindi', gstName: 'Hindi' },
  { value: 'hu', label: 'Hungarian', gstName: 'Hungarian' },
  { value: 'is', label: 'Icelandic', gstName: 'Icelandic' },
  { value: 'id', label: 'Indonesian', gstName: 'Indonesian' },
  { value: 'ga', label: 'Irish', gstName: 'Irish' },
  { value: 'it', label: 'Italian', gstName: 'Italian' },
  { value: 'ja', label: 'Japanese', gstName: 'Japanese' },
  { value: 'kn', label: 'Kannada', gstName: 'Kannada' },
  { value: 'kk', label: 'Kazakh', gstName: 'Kazakh' },
  { value: 'ko', label: 'Korean', gstName: 'Korean' },
  { value: 'ky', label: 'Kyrgyz', gstName: 'Kyrgyz' },
  { value: 'lv', label: 'Latvian', gstName: 'Latvian' },
  { value: 'lt', label: 'Lithuanian', gstName: 'Lithuanian' },
  { value: 'mk', label: 'Macedonian', gstName: 'Macedonian' },
  { value: 'ms', label: 'Malay', gstName: 'Malay' },
  { value: 'ml', label: 'Malayalam', gstName: 'Malayalam' },
  { value: 'mr', label: 'Marathi', gstName: 'Marathi' },
  { value: 'mn', label: 'Mongolian', gstName: 'Mongolian' },
  { value: 'ne', label: 'Nepali', gstName: 'Nepali' },
  { value: 'no', label: 'Norwegian', gstName: 'Norwegian' },
  { value: 'ps', label: 'Pashto', gstName: 'Pashto' },
  { value: 'fa', label: 'Persian', gstName: 'Persian' },
  { value: 'pl', label: 'Polish', gstName: 'Polish' },
  { value: 'pt', label: 'Portuguese', gstName: 'Portuguese' },
  { value: 'pa', label: 'Punjabi', gstName: 'Punjabi' },
  { value: 'ro', label: 'Romanian', gstName: 'Romanian' },
  { value: 'ru', label: 'Russian', gstName: 'Russian' },
  { value: 'sr', label: 'Serbian', gstName: 'Serbian' },
  { value: 'si', label: 'Sinhala', gstName: 'Sinhala' },
  { value: 'sk', label: 'Slovak', gstName: 'Slovak' },
  { value: 'sl', label: 'Slovenian', gstName: 'Slovenian' },
  { value: 'so', label: 'Somali', gstName: 'Somali' },
  { value: 'es', label: 'Spanish', gstName: 'Spanish' },
  { value: 'sw', label: 'Swahili', gstName: 'Swahili' },
  { value: 'sv', label: 'Swedish', gstName: 'Swedish' },
  { value: 'tl', label: 'Tagalog', gstName: 'Tagalog' },
  { value: 'tg', label: 'Tajik', gstName: 'Tajik' },
  { value: 'ta', label: 'Tamil', gstName: 'Tamil' },
  { value: 'te', label: 'Telugu', gstName: 'Telugu' },
  { value: 'th', label: 'Thai', gstName: 'Thai' },
  { value: 'tr', label: 'Turkish', gstName: 'Turkish' },
  { value: 'tk', label: 'Turkmen', gstName: 'Turkmen' },
  { value: 'uk', label: 'Ukrainian', gstName: 'Ukrainian' },
  { value: 'ur', label: 'Urdu', gstName: 'Urdu' },
  { value: 'uz', label: 'Uzbek', gstName: 'Uzbek' },
  { value: 'vi', label: 'Vietnamese', gstName: 'Vietnamese' },
  { value: 'cy', label: 'Welsh', gstName: 'Welsh' },
  { value: 'xh', label: 'Xhosa', gstName: 'Xhosa' },
  { value: 'yo', label: 'Yoruba', gstName: 'Yoruba' },
  { value: 'zu', label: 'Zulu', gstName: 'Zulu' }
]

/** UI source list includes Auto Detect; target list excludes it. */
export const SOURCE_LANGUAGES = LANGUAGES
export const TARGET_LANGUAGES = LANGUAGES.filter((l) => l.value !== 'auto')

const byValue = new Map(LANGUAGES.map((l) => [l.value, l]))

export function langLabel(code: string): string {
  return byValue.get(code)?.label ?? code
}

export function gstLanguageName(code: string): string {
  return byValue.get(code)?.gstName ?? code
}

/** ffprobe ISO 639-2/B (3-letter) → our 2-letter UI codes */
export const ISO3_TO_CODE: Record<string, string> = {
  AFR: 'af', SQI: 'sq', ALB: 'sq', AMH: 'am', ARA: 'ar', ARM: 'hy', HYE: 'hy',
  AZE: 'az', EUS: 'eu', BAQ: 'eu', BEL: 'be', BEN: 'bn', BOS: 'bs', BUL: 'bg',
  CAT: 'ca', CHI: 'zh', ZHO: 'zh', HRV: 'hr', CZE: 'cs', CES: 'cs', DAN: 'da',
  DUT: 'nl', NLD: 'nl', ENG: 'en', EST: 'et', FIN: 'fi', FRE: 'fr', FRA: 'fr',
  GLG: 'gl', GEO: 'ka', KAT: 'ka', GER: 'de', DEU: 'de', GRE: 'el', ELL: 'el',
  GUJ: 'gu', HAT: 'ht', HEB: 'he', HIN: 'hi', HUN: 'hu', ISL: 'is', ICE: 'is',
  IND: 'id', GLE: 'ga', ITA: 'it', JPN: 'ja', KAN: 'kn', KAZ: 'kk', KOR: 'ko',
  KIR: 'ky', LAV: 'lv', LIT: 'lt', MAC: 'mk', MKD: 'mk', MAY: 'ms', MSA: 'ms',
  MAL: 'ml', MAR: 'mr', MON: 'mn', NEP: 'ne', NOR: 'no', PUS: 'ps', PER: 'fa',
  FAS: 'fa', POL: 'pl', POR: 'pt', PAN: 'pa', RON: 'ro', RUM: 'ro', RUS: 'ru',
  SRP: 'sr', SIN: 'si', SLK: 'sk', SLO: 'sk', SLV: 'sl', SOM: 'so', SPA: 'es',
  SWA: 'sw', SWE: 'sv', TGL: 'tl', TAJ: 'tg', TAM: 'ta', TEL: 'te', THA: 'th',
  TUR: 'tr', TUK: 'tk', UKR: 'uk', URD: 'ur', UZB: 'uz', VIE: 'vi', WEL: 'cy',
  CYM: 'cy', XHO: 'xh', YOR: 'yo', ZUL: 'zu'
}

export function normalizeTrackLang(raw: string | undefined): string {
  if (!raw) return ''
  const up = raw.toUpperCase()
  if (ISO3_TO_CODE[up]) return ISO3_TO_CODE[up]
  // already a 2-letter code?
  const low = raw.toLowerCase()
  if (byValue.has(low)) return low
  return ''
}
