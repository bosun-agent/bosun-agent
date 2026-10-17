// 설정의 정보·정책 화면 값. Docker Agent 상태와 agent.yaml 요약을 만든다.
// agent.yaml JSON(GET /api/agents/:id)에는 훅 경로, MCP 실행 줄, env 이름 같은 운영 정보가 있다.
// 화면에는 아래에서 고른 필드만 보내고, 문자열은 비밀값 형식을 한 번 더 가린다(계약 5장 4항).

import { readFileSync } from 'node:fs'
import type { AgentConfigSummary, SystemInfo } from '../src/lib/agentProtocol.ts'
import * as agent from './agentClient.ts'
import { config } from './config.ts'
import { maskText } from './mask.ts'

type Obj = Record<string, unknown>

const obj = (v: unknown): Obj => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {})
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? maskText(v) : undefined)
const strs = (v: unknown): string[] => arr(v).flatMap((x) => (typeof x === 'string' ? [maskText(x)] : []))

// 경로는 파일 이름만 보여준다. `C:/.../python.exe -X utf8 C:/.../guard.py` → `guard.py`
function scriptName(command: string): string {
  const parts = command.split(/\s+/).filter(Boolean)
  const script = parts.findLast((p) => /\.(py|sh|js|ts|ps1|exe)$/i.test(p)) ?? parts[0] ?? ''
  return maskText(script.split(/[\\/]/).at(-1) ?? '')
}

// 훅 설정은 두 모양이다. 도구 단계 훅은 `[{matcher, hooks: [...]}]`, 나머지는 `[{type, command}]`.
function hooksOf(hooks: unknown): AgentConfigSummary['agents'][number]['hooks'] {
  return Object.entries(obj(hooks)).flatMap(([event, entries]) => {
    const defs = arr(entries).flatMap((e) => {
      const entry = obj(e)
      const inner = arr(entry.hooks)
      const list = inner.length ? inner : [entry]
      return list.map((d) => ({ matcher: str(entry.matcher), def: obj(d) }))
    })
    if (defs.length === 0) return []
    return [
      {
        event,
        scripts: defs.map(({ def }) => (typeof def.command === 'string' ? scriptName(def.command) : (str(def.type) ?? '?'))),
        matchers: [...new Set(defs.flatMap(({ matcher }) => (matcher ? [matcher] : [])))],
      },
    ]
  })
}

function toolsetsOf(toolsets: unknown): AgentConfigSummary['agents'][number]['toolsets'] {
  return arr(toolsets).map((t) => {
    const ts = obj(t)
    const lifecycle = obj(ts.lifecycle)
    return {
      type: str(ts.type) ?? '?',
      ...(typeof ts.command === 'string' ? { command: scriptName(ts.command) } : {}),
      args: strs(ts.args),
      tools: strs(ts.tools),
      // 값은 비밀일 수 있어서 이름만 보낸다.
      env: Object.keys(obj(ts.env)),
      ...(str(lifecycle.call_timeout) ? { callTimeout: str(lifecycle.call_timeout) } : {}),
    }
  })
}

export function summarizeConfig(raw: unknown): AgentConfigSummary {
  const cfg = obj(raw)
  // Agents는 배열이다(latest.Agents). 이름 필드에 JSON 태그가 없어서 `Name`으로 온다.
  const agents = arr(cfg.agents).map((a) => {
    const ag = obj(a)
    const maxIterations = typeof ag.max_iterations === 'number' ? ag.max_iterations : undefined
    return {
      name: str(ag.Name) ?? str(ag.name) ?? 'root',
      description: str(ag.description),
      model: str(ag.model),
      safety: str(ag.safety),
      ...(maxIterations !== undefined ? { maxIterations } : {}),
      instruction: str(ag.instruction),
      toolsets: toolsetsOf(ag.toolsets),
      hooks: hooksOf(ag.hooks),
    }
  })
  const models = Object.entries(obj(cfg.models)).map(([name, m]) => {
    const model = obj(m)
    return {
      name,
      provider: str(model.provider),
      model: str(model.model),
      ...(typeof model.max_tokens === 'number' ? { maxTokens: model.max_tokens } : {}),
    }
  })
  const perms = obj(cfg.permissions)
  return { agents, models, permissions: { allow: strs(perms.allow), ask: strs(perms.ask), deny: strs(perms.deny) } }
}

// npm 없이 node로 바로 띄워도 버전이 나오게 package.json을 읽는다.
const WEB_VERSION = (() => {
  try {
    return (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version?: string }).version ?? 'dev'
  } catch {
    return 'dev'
  }
})()

export async function systemInfo(running: number): Promise<SystemInfo> {
  const info: SystemInfo = {
    web: {
      version: WEB_VERSION,
      maxTurns: config.maxTurns,
      running,
      approvalTimeoutSec: Math.round(config.approvalTimeoutMs / 1000),
    },
    agent: { name: config.agentName, reachable: false },
  }
  try {
    const health = await agent.health()
    info.agent.reachable = health.status === 'ok'
    if (health.version) info.agent.version = health.version
    const ready = await agent.ready()
    info.agent.ready = ready.ready
    if (ready.latest_error) info.agent.error = maskText(ready.latest_error)
  } catch {
    return info
  }
  try {
    info.config = summarizeConfig(await agent.getAgentConfig())
  } catch (err) {
    console.warn('[system] agent config failed', err)
  }
  return info
}
