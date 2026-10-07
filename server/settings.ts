// 설정 화면 값. 모델 목록은 운영자가 AGENT_MODELS로 정하고, 화면은 그 안에서만 고른다.

import type { Settings } from '../src/lib/agentProtocol.ts'
import { config } from './config.ts'
import { getSetting, setSetting } from './store.ts'

// 저장된 값이 목록에서 빠졌으면 첫 번째 모델로 돌아간다. 목록이 비어 있으면 agent.yaml 모델을 쓴다(undefined).
export function currentModel(): string | undefined {
  const saved = getSetting('model')
  return saved && config.agentModels.includes(saved) ? saved : config.agentModels[0]
}

export function getSettings(): Settings {
  return { model: currentModel() ?? null, models: config.agentModels }
}

// 목록에 없는 모델이면 false.
export function saveModel(model: string): boolean {
  if (!config.agentModels.includes(model)) return false
  setSetting('model', model)
  return true
}
