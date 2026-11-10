// Home과 도움말에 보여주는 예시 요청. 누르면 입력창에 채운다(보내지는 않는다).
// 내용은 Agent 설정(Agent 담당 agent.direct.yaml instruction의 [할 수 있는 일])을 따른다.

export interface ExamplePrompt {
  text: string
  // 승인 없이 바로 실행 / 승인 카드
  kind: 'auto' | 'approval'
}

export const EXAMPLE_PROMPTS: ExamplePrompt[] = [
  { text: '실행 중인 컨테이너 목록 보여줘', kind: 'auto' },
  { text: 'nginx 컨테이너 최근 로그 100줄 보여줘', kind: 'auto' },
  { text: '이미지 목록과 크기 알려줘', kind: 'auto' },
  { text: 'web 컨테이너 재시작해줘', kind: 'approval' },
  { text: 'nginx:alpine으로 8080 포트 여는 컨테이너 만들어줘', kind: 'approval' },
  { text: '안 쓰는 test 컨테이너 정지하고 삭제해줘', kind: 'approval' },
  { text: '네트워크 목록 보여줘', kind: 'auto' },
  { text: '컨테이너 CPU·메모리 사용량 알려줘', kind: 'auto' },
]
