import { buildWorkbenchSeed } from './seed'
import type { WorkbenchState } from './types'

// 键守恒工作台独立存储桶，与分层建模的 data-layer-studio:entries 互不影响。
const STORAGE_KEY = 'data-layer-studio:key-conservation'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function readStorage(): WorkbenchState {
  const fallback = buildWorkbenchSeed()
  if (typeof window === 'undefined' || !window.localStorage) {
    return fallback
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
  try {
    const parsed = JSON.parse(raw) as WorkbenchState
    // 与种子合并，后续版本新增字段时老缓存也能补齐。
    const seed = buildWorkbenchSeed()
    return {
      packs: parsed.packs ?? seed.packs,
      schemas: parsed.schemas ?? seed.schemas,
      activeSchemaVersion: parsed.activeSchemaVersion ?? seed.activeSchemaVersion,
      jobs: parsed.jobs ?? [],
      matrices: parsed.matrices ?? [],
      calibers: parsed.calibers ?? [],
      seals: parsed.seals ?? [],
    }
  } catch {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
}

let cache: WorkbenchState | null = null

export function workbenchState(): WorkbenchState {
  if (cache === null) {
    cache = readStorage()
  }
  return cache
}

export function saveWorkbench(state: WorkbenchState): void {
  cache = clone(state)
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(cache))
  }
}

export function resetWorkbench(): WorkbenchState {
  const fresh = buildWorkbenchSeed()
  saveWorkbench(fresh)
  return fresh
}

export function workbenchStorageKey(): string {
  return STORAGE_KEY
}
