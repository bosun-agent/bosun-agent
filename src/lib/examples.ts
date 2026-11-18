// Home과 도움말에 보여주는 예시 요청. 누르면 입력창에 채운다(보내지는 않는다).
// 내용은 Agent 설정(저장소 agent 브랜치의 instruction [할 수 있는 일])을 따른다.

export interface ExamplePrompt {
  text: string
  // 정책 칸을 못 읽을 때의 기본값: 승인 없이 바로 실행 / 승인 카드
  kind: 'auto' | 'approval' | 'blocked'
  // 설정 > 정책 칸의 항목(server/policy.ts). 칸을 읽으면 이 항목이 있는 칸으로 표시한다.
  item?: string
}

export const EXAMPLE_PROMPTS: ExamplePrompt[] = [
  { text: '실행 중인 컨테이너 목록 보여줘', kind: 'auto', item: 'container_list' },
  { text: 'nginx로 8080 포트 여는 웹 서버 만들어줘', kind: 'approval', item: 'stack_create' },
  { text: '이미지 목록과 크기 알려줘', kind: 'auto', item: 'image_list' },
  { text: 'web 컨테이너 재시작해줘', kind: 'approval', item: 'container_restart' },
  { text: 'web 컨테이너 최근 로그 50줄 보여줘', kind: 'approval', item: 'container_logs' },
  { text: 'cache 앱 데이터 지금 백업해줘', kind: 'approval', item: 'backup_volume' },
  { text: 'web 컨테이너 안에서 ls 실행해줘', kind: 'blocked', item: 'exec' },
  { text: '네트워크 목록 보여줘', kind: 'auto', item: 'network_list' },
  { text: '컨테이너 CPU·메모리 사용량 알려줘', kind: 'auto', item: 'container_stats' },
]
