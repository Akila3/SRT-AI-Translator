import { create } from 'zustand'
import type { AppSettings, ModelInfo } from '../../electron/shared/types'

interface StoreState {
  loaded: boolean
  settings: AppSettings | null
  modelsUpdatedAt: string | null
  load: () => Promise<void>
  patch: (p: Partial<AppSettings>) => Promise<void>
  setModels: (models: ModelInfo[], updatedAt: string | null) => void
}

export const useStore = create<StoreState>((set, get) => ({
  loaded: false,
  settings: null,
  modelsUpdatedAt: null,

  load: async () => {
    const settings = await window.api.getSettings()
    set({ settings, modelsUpdatedAt: settings.modelsUpdatedAt, loaded: true })
  },

  patch: async (p) => {
    const updated = await window.api.setSettings(p)
    set({ settings: updated })
  },

  setModels: (models, updatedAt) => {
    const s = get().settings
    if (!s) return
    set({ settings: { ...s, cachedModels: models, modelsUpdatedAt: updatedAt }, modelsUpdatedAt: updatedAt })
  }
}))
