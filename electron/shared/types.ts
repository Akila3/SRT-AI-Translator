export interface SubtitleTrack {
  index: number
  codec: string
  lang: string
  name: string
  isImage: boolean
}

export interface AppSettings {
  sourceLang: string
  targetLang: string
  apiKeys: string[]
  apiKeyTiers: string[]
  apiKeyValid: (boolean | null)[]
  apiKeyError: string[]
  theme: string
  model: string
  batchSize: number
  batchContext: boolean
  temperature: number
  topP: number
  topK: number | null
  thinkingLevel: string
  thinkingBudget: number
  serviceTier: string
  paidQuota: boolean
  disableStreaming: boolean
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
  available: boolean
}

export interface TranslateArgs {
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
  writeTokenReport: boolean
  progressLog: boolean
  thoughtsLog: boolean
}

export interface TranscribeArgs {
  mediaFile: string
  outputFile: string
  targetLang: string
  model: string
  apiKeys: string[]
  thinkingLevel: string
  thinkingBudget: number
  description?: string
  ffmpegPath?: string
}

export interface ProcOutput {
  stream: 'stdout' | 'stderr'
  line: string
}

export interface ProcDone {
  code: number | null
  outputPath: string
  logPaths?: string[]
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
