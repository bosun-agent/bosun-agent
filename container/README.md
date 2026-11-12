# BOSUN 컨테이너 설치 (웹 + Agent. Portainer는 기존 것 사용)

`docker compose up -d` 한 번으로 화면(웹)·Agent를 띄운다. Portainer는 **따로 있는 것을 그대로 쓴다** — 주소와 API 키는 첫 접속 설정 페이지에서 넣는다. 설계 근거는 `docs/컨테이너_설치_설계_11-12.md`, 설정 페이지는 `docs/첫실행_설정페이지_11-12.md`.

```
호스트(또는 LAN)                        bosun 스택
 127.0.0.1:3001  →  [bosun] 화면 + WEB 백엔드(node) ── docker-agent(자식 프로세스)
                                                       └─ 정책 훅(python3) → Portainer API
 <Portainer 호스트>:9443  →  [기존 Portainer]  ← 도커 소켓을 가진 유일한 컨테이너(이 스택 밖)
```

- **웹·Agent 컨테이너에는 도커 소켓이 없다.** 도커 조작은 전부 Portainer를 거친다(정책 설계).
- 웹에는 로그인이 없어 **`127.0.0.1`로만 발행**한다 → 다른 PC에서는 SSH 터널로 접속한다.
- 첫 접속 화면(설정 페이지)이 OpenRouter 키·Portainer 주소·Portainer API 키를 받는다. 값은 사용자가 직접 발급하며, 저장 전에 실제로 확인한다.
- Portainer가 스택 밖에 있으므로 자체 서명 인증서를 그대로 쓴다: 훅·MCP 도구는 `PORTAINER_TLS_VERIFY=0`(예시에 포함), 설정 페이지의 확인 요청은 검증 실패 시 한 번 더 시도한다.
- 이 스택에 Portainer를 **함께 띄울 수도 있다**(선택): `docker compose --profile portainer up -d`. 9443을 이미 쓰는 Portainer가 있으면 포트가 충돌하므로 기본에서는 뺐다.

---

## 1. 준비

| 무엇 | 왜 |
|---|---|
| Docker + Docker Compose v2 | 스택 실행 |
| OpenRouter API 키 | 모델 호출 |
| 기존 Portainer(LAN에서 접속 가능) | 도커 조작은 전부 여기를 거친다. Agent가 붙을 수 있어야 한다 |
| Portainer API 키 | 설정 페이지에서 넣는다(Portainer → My account → Access tokens) |

```bash
cp container/.env.example container/.env
#   OPENROUTER_API_KEY=sk-or-...        (설정 페이지에서 넣어도 된다)
#   PORTAINER_URL / PORTAINER_URL_INTERNAL  ← 기존 Portainer 주소로 바꾼다(예시 값이 들어 있다)
```

> **`.env`를 고친 뒤에는 컨테이너를 재생성해야 반영됩니다**: `docker compose up -d` (`restart`는 env를 다시 읽지 않는다).
> - Portainer 주소 두 개는 역할이 다르다: `PORTAINER_URL`은 화면의 "Portainer 열기" 링크(브라우저가 여는 주소), `PORTAINER_URL_INTERNAL`은 Agent·훅이 붙는 주소(컨테이너 안에서 보이는 주소). 기존 Portainer를 LAN으로 쓰면 둘 다 그 주소를 쓴다.
> - Agent가 붙는 주소는 설정 페이지에서도 바꿀 수 있다(그때는 컨테이너 안 `agent.env`에 기록되고, 위 `PORTAINER_URL_INTERNAL`은 `agent.env`를 처음 만들 때만 씨앗으로 쓰인다).
> - 관리자 계정·비밀번호 항목(`PORTAINER_ADMIN_*`)은 **이 스택에 Portainer를 함께 띄울 때만** 필요하다. 기존 Portainer를 쓰면 그 Portainer에서 직접 만든다.

## 2. 올리기

```bash
docker compose up -d --build          # 첫 빌드: node 이미지 + docker-agent 릴리스 바이너리 + mcp-portainer 설치
docker compose logs -f bosun          # 진입점 로그(agent.yaml 생성·경고)를 본다
```

> 저장소를 갱신했다면 반드시 `--build`를 붙인다: `container/entrypoint.sh`는 **이미지 안에** 들어간다. `docker compose up -d`만 하면 예전 이미지가 계속 돌아, 고친 스크립트·화면 코드가 컨테이너에 반영되지 않는다.

> 함께 띄운 Portainer(`--profile portainer`)에는 **헬스체크를 두지 않았다**(11-12 첫 실행에서 확인): 그 이미지에 `wget`이 없으면 unhealthy로 굳고, `depends_on: service_healthy` 때문에 `bosun`이 아예 뜨지 않는다. 기존 Portainer를 쓰면 이 문제 자체가 없다.

첫 기동에서 컨테이너가 하는 일(`container/entrypoint.sh`):

1. `/opt/bosun/agent.env` 생성(없을 때만, 권한 600) — 값은 `container/.env`에서 온다
2. `/opt/bosun/agent.yaml` 생성 — 기준 설정의 자리표시자(`/절대경로/`→`/app/ai-agent-hooks/`, `/실행폴더/`→`/opt/bosun/`)를 치환하고, `uvx` 도구 등록을 이미지에 고정 설치한 `mcp-portainer`로 바꾼다. 남은 자리표시자가 있으면 **여기서 멈춘다**(그대로 두면 정책 훅이 모든 도구 호출을 막는다)
3. `AGENT_TOKEN` 생성(비워 두면 매 기동 새로 생성)
4. WEB 백엔드 실행 → 백엔드가 `docker-agent`를 자식 프로세스로 띄운다

## 3. 최초 1회: 값 넣기 (첫 접속 화면)

새로 설치하면 **첫 접속 화면이 설정 페이지**다. BOSUN은 값을 만들어 주지 않는다. 사용자가 직접 발급받아 넣는다.

| 칸 | 어디서 받나 |
|---|---|
| OpenRouter API 키 | openrouter.ai → Keys (`sk-or-…`) |
| Portainer 주소 | **Agent가 붙는 주소**. 기존 Portainer면 그 주소(예: `https://10.0.11.177:9443`), 스택에 함께 띄웠으면 `https://portainer:9443` |
| Portainer API 키 | 기존 Portainer 화면 → My account → Access tokens (`ptr-…`) |

- 관리자 계정은 **그 Portainer에서 직접** 만든다. 우리는 관리자 비밀번호를 받지 않고, 기존 Portainer의 초기 설정 관문(5분 제한·setup token)은 이미 지난 상태다.
- 넣은 값은 저장 전에 실제로 확인합니다: OpenRouter는 `GET /api/v1/key`(401이면 거부), Portainer는 `GET /api/endpoints`(`X-API-Key`; 키 오류·주소 오류·Docker 환경 0개를 구분해 알려준다. 자체 서명 인증서는 검증을 끄고 다시 본다).
- 하나라도 실패하면 **저장하지 않고** 그 칸 아래에 이유가 뜬다. 저장되면 `agent.env`에 기록되고(권한 600) Agent가 다시 시작된다.
- 값이 하나라도 남아 있으면 저장이 됐더라도 설정 페이지에 머문다.

스택에 Portainer를 함께 띄웠을 때(선택)는 초기 설정을 스크립트로 끝낼 수도 있다(관리자 계정 생성 + 키 발급 + `agent.env` 기록까지):

```bash
docker compose --profile portainer up -d
docker compose exec bosun /usr/local/bin/portainer-bootstrap
docker compose restart bosun
```

- 이 경로는 스택을 올린 뒤 **5분 안에 실행해야 한다**(Portainer가 첫 기동 후 5분 안에 관리자를 만들지 않으면 API를 막는다). 놓쳤으면 `docker compose restart portainer` 후 곧바로 실행한다.
- 미초기화 인스턴스의 setup token 게이트는 그 서비스의 `command: ["--no-setup-token"]`으로 꺼 두었다. 게이트를 켜 두려면 그 줄을 지우고 로그의 `setup_token` 값을 초기 설정 화면에 붙여넣는다.
- 기존 Portainer에는 이 스크립트를 쓰지 않는다(관리자 계정을 새로 만들려 하면 거부된다).

## 4. 접속

- 화면: <http://127.0.0.1:3001> (다른 PC에서는 `ssh -L 3001:127.0.0.1:3001 <user>@<host>` 터널을 열고 <http://localhost:3001>)
- 기존 Portainer: 그 Portainer 주소(예: <https://10.0.11.177:9443>, 자체 서명 인증서 경고는 정상). 함께 띄웠으면 <https://<호스트>:9443>.

---

## 5. 확인 체크리스트 (로컬 도커에서 처음 검증할 때)

순서대로 확인하고, 실패하면 아래 진단표를 본다.

```bash
# 1) 컨테이너·빌드
docker compose ps
docker compose logs bosun | grep -E "entrypoint|agent\]" | tail -20

# 2) 컨테이너 안 준비물(이미지에 다 들어갔는지)
docker compose exec bosun sh -lc 'docker-agent version; python3 -c "import yaml; print(\"pyyaml ok\")"; command -v mcp-portainer'

# 3) agent.yaml 치환 결과(자리표시자 0개)
docker compose exec bosun sh -lc 'grep -c "/절대경로/\|/실행폴더/\|uvx" /opt/bosun/agent.yaml || echo "0 (정상)"'

# 4) 에이전트 API(루프백, 토큰 필요)
docker compose exec bosun sh -lc 'curl -sS http://127.0.0.1:8080/health; echo; curl -sS -H "Authorization: Bearer $AGENT_TOKEN" http://127.0.0.1:8080/api/agents'

# 5) 화면 응답 + 설정 상태(값이 다 들어갔는지)
curl -s -o /dev/null -w 'web HTTP=%{http_code}\n' http://127.0.0.1:3001
curl -s http://127.0.0.1:3001/api/setup/status

# 6) Portainer 주소(훅·Agent가 쓰는 경로) — HTTPS + 자체 서명이라 -k
docker compose exec bosun sh -lc 'set -a; . /opt/bosun/agent.env; set +a; curl -sk --retry 10 --retry-connrefused --retry-delay 3 "$PORTAINER_URL/api/endpoints" | head -c 200; echo'

# 7) mcp-portainer가 Portainer에 붙는지(키가 들어간 뒤)
docker compose exec bosun sh -lc 'set -a; . /opt/bosun/agent.env; set +a; curl -sS -H "X-API-Key: $PORTAINER_API_KEY" "$PORTAINER_URL/api/stacks" | head -c 200; echo'
```

화면에서 직접: 대화 한 번 주고(모델 응답 확인) → "컨테이너 목록 보여줘"(조회 도구 동작 확인) → 삭제 요청을 해 **승인 카드**가 뜨는지 확인(정책 훅 동작 확인).

## 6. 잘 안 될 때

| 증상 | 원인 | 확인·해결 |
|---|---|---|
| 컨테이너가 계속 재시작 | 진입점이 중단됨(치환 실패·기준 설정 없음) | `docker compose logs bosun`의 `[entrypoint]` 줄 |
| 화면에 "Agent 연결 실패" | Agent 자식 프로세스가 즉사 | 로그의 `[agent]` 줄. `agent.env`가 없거나 경로가 틀리면 `--env-from-file` 오류로 즉시 종료한다 |
| 조회까지 전부 차단 | 정책 훅이 실패(fail-closed) | 3번 체크리스트(pyyaml)와 `agent.yaml`의 `AGENT_ENV_FILE` 경로. 훅은 `--env-from-file` 값을 받지 못하므로 경로가 agent.yaml 안에 있어야 한다 |
| 모델 호출만 실패 | 키 없음/모델 이름 | `container/.env`의 `OPENROUTER_API_KEY`, `AGENT_MODELS` 형식(`provider/model`) |
| Portainer API 401/403 | API 키 없음/만료 | 설정 페이지에서 그 칸을 다시 저장하거나 `container/.env`의 `PORTAINER_API_KEY`에 넣고 `docker compose up -d` |
| `dependency failed to start: container bosun-portainer is unhealthy` | (함께 띄운 경우) compose에 헬스체크를 두면 이 이미지에서 unhealthy로 굳는다 | 헬스체크를 쓰지 않는다(수정됨). 기존 Portainer를 쓰면 이 서비스가 뜨지 않으므로 나오지 않는다 |
| `volume "portainer_data" already exists but was created for project …` 경고 | 다른 프로젝트가 만든 볼륨 | 이 스택은 자기 볼륨(`bosun_portainer_data`)을 쓴다(수정됨). 기존 Portainer를 쓰면 이 볼륨은 만들지 않는다 |
| `admin init: HTTP 403` (함께 띄운 경우) | 미초기화 인스턴스의 **setup token 게이트**가 켜져 있다(헤더 `X-Setup-Token` 필요) | 그 서비스의 `command: ["--no-setup-token"]`(기본)에서는 나오지 않는다. 게이트를 켜 둔 경우 초기 설정 화면에 로그의 `setup_token` 값을 붙여넣는다 |
| `[0/4] … HTTP 303` / `Redirect-Reason: AdminInitTimeout` (함께 띄운 경우) | Portainer 첫 기동 후 5분 안에 관리자 계정이 만들어지지 않아 API가 막혔다 | `docker compose restart portainer` 로 창을 다시 연 뒤 곧바로 bootstrap 실행(스크립트가 이 상황을 알아서 안내한다) |
| bootstrap에서 `curl: (60) SSL certificate problem: self-signed certificate` | 컨테이너가 **옛 이미지**로 돌고 있다(고친 스크립트에 `-k`가 들어 있음) | `docker compose up -d --build` 로 이미지를 다시 빌드한 뒤 bootstrap을 다시 실행한다 |
| bootstrap 단계 번호가 `[1/4]`부터 시작한다 | 위와 같은 이유(옛 스크립트) | 같은 조치. 최신 스크립트는 `[0/4] Portainer 응답 대기`로 시작한다 |
| 설정 페이지에서 "Portainer에 연결하지 못했어요" | 주소가 틀렸거나, 그 주소가 컨테이너에서 보이지 않는다 | 주소를 확인한다(기존 Portainer면 호스트 LAN 주소). 컨테이너에서 확인: `docker compose exec bosun sh -lc 'set -a; . /opt/bosun/agent.env; set +a; curl -sk "$PORTAINER_URL/api/endpoints"'` |
| 설정 페이지에서 "Docker 환경(endpoint)이 아직 없어요" | 그 Portainer에 Docker 환경이 등록되지 않았다 | Portainer 화면에서 Get Started(local)로 등록한 뒤 다시 저장한다 |
| 9443 이미 사용 중 (함께 띄운 경우) | 기존 Portainer가 9443을 쓰고 있다 | `--profile portainer`를 쓰지 않는다(기본). 기존 Portainer 주소를 설정 페이지에 넣는다 |
| 빌드 실패(바이너리 다운로드) | 네트워크/버전 태그 | `docker compose build --no-cache bosun`, `DOCKER_AGENT_VERSION` 값 확인 |

## 7. 백업·게이트 추가

- **볼륨 백업**: 앱이 생긴 뒤에만 만들 수 있다(볼륨 이름이 필요하다). Agent에게 앱과 함께 만들게 하거나, `backup/bosun-backup-compose.yaml`을 복사해 볼륨 이름을 채운다. `docker-compose.yaml`의 주석 예시 참고.
- **soteria 백업 게이트**: `docker-compose.yaml`의 주석 예시로 API 컨테이너를 올리고, `ai-agent-hooks/agent.yaml.example`의 soteria 도구 예시(주석)를 켠다. 저장 위치·보관 기간은 저장 위치 안내 문서(`README-backup.md`, 별도 PR) 4~5절.

## 8. 라이선스

BOSUN MIT / docker-agent Apache-2.0 / Portainer CE 무료 배포판 / offen 볼륨백업·soteria MPL-2.0 / Node·Debian 각 패키지 라이선스. Open WebUI는 쓰지 않는다(자체 화면) → 해당 브랜딩 조항과 무관.
