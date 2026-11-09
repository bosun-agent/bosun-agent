import { isDemo } from '../lib/agent'
import { DEV_SCENARIOS } from '../lib/mockAgent'

interface DevScenarioBarProps {
  disabled?: boolean
  onRun: (command: string) => void
}

// 개발 모드와 공개 데모 전용. 실제 AI Agent 없이 화면 상태를 하나씩 재현하는 버튼 모음.
export function DevScenarioBar({ disabled, onRun }: DevScenarioBarProps) {
  return (
    <div className="flex items-center gap-1.5 overflow-x-auto border-t border-dashed border-neutral-300 px-3 py-2 sm:px-4">
      <span
        title={isDemo ? '실제 Docker에 연결되지 않은 목업 응답' : undefined}
        className="shrink-0 text-[11px] font-medium text-neutral-400"
      >
        {isDemo ? 'DEMO · 목업' : 'DEV'}
      </span>
      {DEV_SCENARIOS.map(({ command, label }) => (
        <button
          key={command}
          type="button"
          disabled={disabled}
          onClick={() => onRun(command)}
          title={command}
          className="shrink-0 rounded-lg border border-neutral-200 px-2 py-1 text-xs text-neutral-600 hover:bg-neutral-100 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {label}
        </button>
      ))}
    </div>
  )
}
