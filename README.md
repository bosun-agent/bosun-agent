# BOSUN

컨테이너를 자연어로 관리하는 도구. 초보 사용자가 채팅으로 앱(스택)을 만들고 관리하되,
위험한 작업은 **코드(정책 훅·권한 규칙)와 사람의 승인**이 막는다.

- **웹 파트** — 채팅 화면 + 백엔드. 실행·설정 안내는 `README-web.md`
- **에이전트 파트** — 정책 훅, Agent 설정, Portainer·백업 구성. 안내는 `README-agent.md`

버전 고정: docker-agent **v1.148.0** / mcp-portainer **2.45.1** / Portainer CE **2.45.1** / 모델 `deepseek/deepseek-v4.1-flash`(OpenRouter)

## 저장소 구조

| 경로 | 파트 | 무엇 |
|---|---|---|
| `src/`, `index.html`, `vite.config.ts` | 웹 | 채팅 화면(React) |
| `server/` | 웹 | 백엔드. Agent를 띄우고 대화·승인 카드·정책 차단을 중계 |
| `Dockerfile` | 웹 | 웹 이미지. SQLite는 `/data`(볼륨) |
| `ai-agent-hooks/` | Agent | 정책 훅 10개·공용 모듈·테스트, 기준 설정 `agent.yaml.example` |
| `agents/` | Agent | 초보자용·숙련자용 설정 예시(`make_agents.py`가 만든다) |
| `portainer/`, `backup/` | Agent | Portainer CE 2.45.1, 볼륨 백업 컨테이너 compose |
| `docs/` | 공통 | 동작 기준·테스트 목록, 설계·구현 정리, 복원 절차서 |

## 준비물

| 무엇 | 왜 |
|---|---|
| Node.js **22.18 이상** | 백엔드 `.ts`를 Node가 바로 실행한다. 낮으면 `npm start`부터 실패한다(`node -v`) |
| Docker Desktop + Portainer 컨테이너(`bosun-portainer`) | Agent가 Portainer를 거쳐 Docker를 다룬다. API 키도 여기서 만든다 |
| docker-agent 실행 파일 **v1.148.0 이상** | Docker Desktop에 든 `docker agent` 플러그인은 버전이 낮아 agent.yaml을 못 읽을 수 있다 |
| Python 3 + PyYAML, uv(`uvx`) | agent.yaml이 정책·백업 훅(Python)과 `mcp-portainer`(uvx)를 실행한다 |
| OpenRouter API 키 | 모델 호출 |

## 빠른 실행 (스크립트)

값을 한 파일에 모아 두고 스크립트가 나머지를 만든다. 손으로 `agent.yaml` 경로를 치환할 필요가 없다.

```bash
./scripts/bootstrap.sh            # 1) 없는 프로그램 설치(Node 22 · docker-agent · uv · PyYAML)
cp bosun.env.example bosun.env    # 2) 키 2개 채우기(OpenRouter, Portainer)
./scripts/setup.sh                # 3) 실행 폴더·agent.yaml·server/real.env 생성 + 검사
./scripts/up.sh                   # 4) Portainer → 백엔드 → 화면 한 번에 (Ctrl+C로 전체 종료)
```

각 단계에 `--check`를 붙이면 **아무것도 바꾸지 않고** 빠진 것만 확인한다.

| 스크립트 | 하는 일 |
|---|---|
| `scripts/bootstrap.sh` | Node 22 · docker-agent v1.148.0 · uv(`uvx`) · PyYAML · docker/compose 설치(있으면 건너뜀) |
| `scripts/setup.sh` | `agent.env`(600) · `agent.yaml` 경로 치환 · `agents/*.yaml` 생성 · `server/real.env` 생성 · 설정 검사 |
| `scripts/up.sh` | Portainer 기동 → `npm start`(백엔드+Agent) → 화면. 백엔드 로그는 `.bosun/backend.log` |

`setup.sh`가 하는 검사(실패하면 실행 전에 멈춘다): Node 22.18 이상 · PyYAML · `uvx` · docker-agent 실행 파일 · 경로가 붙어버린 곳(`agent-runagent.env`) · 남은 자리표시자 · 모델 이름(agent.yaml `models` 또는 `provider/model`).

## 실행

화면만 볼 때(Node만 필요):

```bash
git clone https://github.com/bosun-agent/bosun-agent.git
cd bosun-agent
npm install
npm run dev            # http://localhost:5173, 목업 Agent로 동작
```

웹 + Agent 전체:

```bash
npm install
npm start              # 터미널 1: 백엔드(3001) + Docker Agent(8080)
npm run dev:http       # 터미널 2: 화면
```

`npm start`는 `server/real.env`가 있어야 Agent를 띄운다.
Portainer 실행, Agent 실행 폴더·`agent.env` 준비는 `README-web.md`와 `README-agent.md`에 있다.

## 올리면 안 되는 것

`.gitignore`가 막는다. 값이 든 파일은 저장소에 올리지 않는다.

| 파일 | 무엇 |
|---|---|
| `agent.env` | OpenRouter·Portainer 키 (Agent 실행 폴더) |
| `server/real.env` | 웹 ↔ Agent 연동 토큰·경로 |
| `session.db`, `*.sqlite3` | 대화 기록, 백업·주입 기록 |
| `server/data/web.db` | 승인 카드·승인 감사 기록 |
| `agent.yaml`, `agents/*.yaml` | 경로가 PC마다 다른 실제 설정(`.example`만 커밋한다) |

## 문서

| 파일 | 무엇 |
|---|---|
| `docs/동작기준_테스트목록.md` | 정책표와의 차이·예외, 실제 AI 시나리오 테스트 T01~T42 |
| `docs/AI_Agent_설계_구현_정리_11-04.md` | 설계·구현 정리 |
| `docs/복원절차서_관리자용_11-07.md` | 볼륨 복원 절차(관리자 작업) |
| `README-web.md`, `README-agent.md` | 파트별 실행·설정·문제 해결 |

## 라이선스

MIT (`LICENSE`)
