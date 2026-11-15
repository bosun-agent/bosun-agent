# BOSUN 컨테이너 설치 (웹 + Agent. Portainer는 기존 것 사용)

`docker compose up -d` 한 번으로 화면(웹)·Agent를 띄운다. Portainer는 **따로 있는 것을 그대로 쓴다** — API 키는 첫 접속 설정 페이지에서 넣는다.

```
호스트(또는 LAN)                        bosun 스택
 127.0.0.1:3001  →  [bosun] 화면 + WEB 백엔드(node) ── docker-agent(자식 프로세스)
                                                       └─ 정책 훅(python3) → Portainer API
 <Portainer 호스트>:9443  →  [기존 Portainer]  ← 도커 소켓을 가진 유일한 컨테이너(이 스택 밖)
```

- **웹·Agent 컨테이너에는 도커 소켓이 없다.** 도커 조작은 전부 Portainer를 거친다(정책 설계).
- 웹에는 로그인이 없어 **`127.0.0.1`로만 발행**한다 → 다른 PC에서는 SSH 터널로 접속한다.
- **Portainer는 이 스택에 넣지 않는다.** 사용자가 따로 설치한다(팀 기본: `portainer/portainer-compose.yaml`). 관리자 계정과 API 키는 그 화면에서 만든다.
- 첫 접속 화면(설정 페이지)이 OpenRouter 키·Portainer 주소·Portainer API 키를 받는다. 값은 사용자가 직접 발급하며, 저장 전에 실제로 확인한다.
- Portainer가 스택 밖에 있으므로 자체 서명 인증서를 그대로 쓴다: 훅·MCP 도구는 `PORTAINER_TLS_VERIFY=0`(예시에 포함), 설정 페이지의 확인 요청은 검증 실패 시 한 번 더 시도한다.

---

## 1. 준비

| 무엇 | 왜 |
|---|---|
| Docker + Docker Compose v2 | 스택 실행 |
| OpenRouter API 키 | 모델 호출 |
| Portainer(따로 설치, LAN에서 접속 가능) | 도커 조작은 전부 여기를 거친다. Agent가 붙을 수 있어야 한다. 팀 기본 compose: `portainer/portainer-compose.yaml` |
| Portainer API 키 | 그 Portainer 화면 → My account → Access tokens. 설정 페이지에서 넣는다 |

이 PC에 Portainer를 띄웠다면 **따로 준비할 파일은 없다.** 키 두 개는 첫 접속 설정 페이지에서 넣고, Portainer 주소는 기본값(`https://host.docker.internal:9443`, Docker Desktop 기준)으로 붙는다.

Portainer가 다른 PC에 있거나(리눅스 서버 포함) 키를 미리 넣어 두고 싶을 때만 양식을 복사해 고친다.

```bash
cp container/.env.example container/.env
#   PORTAINER_URL / PORTAINER_URL_INTERNAL  ← 그 Portainer 주소로 바꾼다
#   OPENROUTER_API_KEY, PORTAINER_API_KEY   (설정 페이지에서 넣어도 된다)
```

> **`.env`를 고친 뒤에는 컨테이너를 재생성해야 반영됩니다**: `docker compose up -d` (`restart`는 env를 다시 읽지 않는다).
> - Portainer 주소 두 개는 역할이 다르다: `PORTAINER_URL`은 화면의 "Portainer 열기" 링크(브라우저가 여는 주소), `PORTAINER_URL_INTERNAL`은 Agent·훅이 붙는 주소(컨테이너 안에서 보이는 주소). 기존 Portainer를 LAN으로 쓰면 둘 다 그 주소를 쓴다.
> - Agent가 붙는 주소는 설정 페이지에서도 바꿀 수 있다(그때는 컨테이너 안 `agent.env`에 기록되고, 위 `PORTAINER_URL_INTERNAL`은 `agent.env`를 처음 만들 때만 씨앗으로 쓰인다).
> - 관리자 계정·API 키는 **그 Portainer에서 직접** 만든다(관리자 계정 → My account → Access tokens). 이 스택은 자격증명을 받지 않는다.

## 2. 올리기

```bash
docker compose up -d --build          # 첫 빌드: node 이미지 + docker-agent 릴리스 바이너리 + mcp-portainer 설치 + mcp-soteria 빌드
docker compose logs -f bosun          # 진입점 로그(agent.yaml 생성·경고)를 본다
```

> 저장소를 갱신했다면 반드시 `--build`를 붙인다: `container/entrypoint.sh`는 **이미지 안에** 들어간다. `docker compose up -d`만 하면 예전 이미지가 계속 돌아, 고친 스크립트·화면 코드가 컨테이너에 반영되지 않는다.

첫 기동에서 컨테이너가 하는 일(`container/entrypoint.sh`):

1. `/opt/bosun/agent.env` 생성(없을 때만, 권한 600) — 값은 `container/.env`에서 온다
2. `/opt/bosun/agent.yaml` 생성 — 기준 설정의 자리표시자(`/절대경로/`→`/app/ai-agent-hooks/`, `/실행폴더/`→`/opt/bosun/`)를 치환하고, `uvx` 도구 등록을 이미지에 고정 설치한 `mcp-portainer`로 바꾼다. 남은 자리표시자가 있으면 **여기서 멈춘다**(그대로 두면 정책 훅이 모든 도구 호출을 막는다)
   - 기동마다 `SOTERIA_API`·`SOTERIA_NETWORK`를 `agent.env`에 맞추고, `agent.yaml`의 mcp-soteria 주소를 설치판 주소로 바꾼다(7절)
3. `AGENT_TOKEN` 생성(비워 두면 매 기동 새로 생성)
4. WEB 백엔드 실행 → 백엔드가 `docker-agent`를 자식 프로세스로 띄운다

## 3. Portainer 설치와 값 넣기

### 3-1. Portainer (사용자가 따로)

이 스택에는 넣지 않는다. 팀 기본 compose로 올린다:

```bash
cd portainer && docker compose -f portainer-compose.yaml up -d
# UI: https://<호스트>:9443  (자체 서명 인증서 경고는 정상)
```

- 처음이면 UI에서 **관리자 계정**을 만들고(초기 설정), 그다음 **Get Started (local)** 로 Docker 환경을 등록한다. 환경이 0개면 다음 단계에서 저장이 막힌다(docker_proxy가 쓸 대상이 없다).
- **My account → Access tokens** 에서 API 키를 만든다(이 키를 다음 단계에서 쓴다).

### 3-2. 값 넣기 (첫 접속 화면)

새로 설치하면 **첫 접속 화면이 설정 페이지**다. BOSUN은 값을 만들어 주지 않는다. 사용자가 직접 발급받아 넣는다.

| 칸 | 어디서 받나 |
|---|---|
| OpenRouter API 키 | openrouter.ai → Keys (`sk-or-…`) |
| Portainer API 키 | Portainer 화면 → My account → Access tokens (`ptr_…`) |

- Portainer 주소 칸은 평소엔 숨어 있다. `container/.env`의 `PORTAINER_URL_INTERNAL`(예시값 `https://host.docker.internal:9443` = 이 PC의 Portainer)로 연결해 보고, 안 될 때만 주소 칸이 나온다. 컨테이너에서도 닿는 주소여야 한다.

- 넣은 값은 저장 전에 실제로 확인한다: OpenRouter는 `GET /api/v1/key`(401이면 거부), Portainer는 `GET /api/endpoints`(`X-API-Key`; 키 오류·주소 오류·Docker 환경 0개를 구분해 알려준다. 자체 서명 인증서는 검증을 끄고 다시 본다).
- 하나라도 실패하면 **저장하지 않고** 그 칸 아래에 이유가 뜬다. 저장되면 `agent.env`에 기록되고(권한 600) Agent가 다시 시작된다.
- 값이 하나라도 남아 있으면 저장이 됐더라도 설정 페이지에 머문다.
- 화면 대신 `container/.env`의 `PORTAINER_URL_INTERNAL`·`PORTAINER_API_KEY`에 넣고 `docker compose up -d` 해도 같다(그때는 화면에 "이미 설정됨"으로 뜬다).
- **나중에 키를 바꾸려면**: 화면 오른쪽 위 ⚙(설정) → **API 키** 탭에서 두 키 모두 바꿀 수 있다(저장 전에 같은 연결 확인을 하고, Portainer에 못 붙으면 주소 칸이 나온다). 처음 설정 페이지를 다시 보려면 주소 끝에 `?setup=1`을 붙인다(예: <http://localhost:3001/?setup=1>). 저장된 값은 "이미 설정됨"으로 표시되고, 바꿀 칸만 채워 저장하면 된다(넣지 않은 칸은 그대로 둔다).

## 4. 접속

- 화면: <http://127.0.0.1:3001> (다른 PC에서는 `ssh -L 3001:127.0.0.1:3001 <user>@<host>` 터널을 열고 <http://localhost:3001>)
- Portainer: 그 Portainer 주소(이 PC에 띄웠다면 <https://localhost:9443>)

---

## 5. 확인 체크리스트 (로컬 도커에서 처음 검증할 때)

순서대로 확인하고, 실패하면 아래 진단표를 본다.

```bash
# 1) 컨테이너·빌드
docker compose ps
docker compose logs bosun | grep -E "entrypoint|agent\]" | tail -20

# 2) 컨테이너 안 준비물(이미지에 다 들어갔는지)
docker compose exec bosun sh -lc 'docker-agent version; python3 -c "import yaml; print(\"pyyaml ok\")"; command -v mcp-portainer; ls -l /app/tools/bin/mcp-soteria'

# 3) agent.yaml 치환 결과(자리표시자 0개)
docker compose exec bosun sh -lc 'grep -c "/절대경로/\|/실행폴더/\|uvx" /opt/bosun/agent.yaml || echo "0 (정상)"'

# 4) 에이전트 API(루프백). {"status":"ok"}면 정상. (토큰은 진입점 안에서만 있어 exec 셸에는 없다)
docker compose exec bosun sh -lc 'curl -sS http://127.0.0.1:8080/health; echo'

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
| 도구가 `A valid authorization token is missing`(401) | agent.env에 `PORTAINER_API_KEY=` **빈 줄**이 남아 있다(docker-agent가 그 줄을 "값 있음"으로 읽어 빈 문자열을 도구까지 넘긴다). 또는 에이전트가 키 저장 **전**의 환경으로 떠 있다 | 설정 페이지에서 그 칸을 다시 저장하면 빈 줄이 지워진다. 그래도 같은 오류면 `docker compose restart bosun`(Agent는 값을 시작할 때만 읽는다) |
| 도구가 `Invalid JWT token`(401) | 키 이름이 아예 없어 `${env.PORTAINER_API_KEY}`가 치환되지 않았다 | 설정 페이지에서 키를 넣어 저장 |
| 설정 페이지에서 "Portainer에 연결하지 못했어요" | 주소가 틀렸거나, 그 주소가 컨테이너에서 보이지 않는다 | 주소를 확인한다(기존 Portainer면 호스트 LAN 주소). 컨테이너에서 확인: `docker compose exec bosun sh -lc 'set -a; . /opt/bosun/agent.env; set +a; curl -sk "$PORTAINER_URL/api/endpoints"'` |
| 설정 페이지에서 "Docker 환경(endpoint)이 아직 없어요" | 그 Portainer에 Docker 환경이 등록되지 않았다 | Portainer 화면에서 Get Started(local)로 등록한 뒤 다시 저장한다 |
| 빌드 실패(바이너리 다운로드) | 네트워크/버전 태그 | `docker compose build --no-cache bosun`, `DOCKER_AGENT_VERSION` 값 확인 |
| 빌드 실패(`soteria` 단계, git clone·go build) | 브랜치 이름이 바뀌었거나(main에 합쳐짐) 네트워크 | `docker-compose.yaml`의 `SOTERIA_REF` 값 확인 |
| "지금 백업"이 `백업 창구 스택 'bosun-soteria'을 찾지 못했습니다` | 7절 3단계를 안 했거나 Portainer 환경 ID가 다르다 | 7절 3단계. 환경 ID가 3이 아니면 `agent.yaml`의 `SOTERIA_ENDPOINT_ID`도 고친다 |
| "지금 백업"이 창구에 연결하지 못함 | 창구가 bosun 네트워크에 없다(PC 직접 실행용으로 만든 스택) | 7절 3단계를 bosun 컨테이너 안에서 다시 실행한다(`SOTERIA_NETWORK`가 들어가 다시 배포된다). 확인: `docker compose exec bosun curl -sS http://bosun-soteria:8080/healthz` |

## 7. 백업 켜기 (처음 한 번)

백업은 두 가지이고, 둘 다 **Portainer 스택**으로 둔다(이 compose 파일에 넣지 않는다). 훅이 새 앱 볼륨을 넣으려고 Portainer로 다시 배포하기 때문이다. 자세한 규칙은 `README-agent.md` 6-1~6-3절.

| | 지금 백업 (soteria) | 정시 백업 |
|---|---|---|
| 스택 이름 | `bosun-soteria` | `bosun-backup` |
| 언제 | "지금 백업해줘", 데이터가 있는 앱을 수정·삭제하기 전(훅이 강제) | 매일 12시·18시·23시, 7일 보관 |
| 새 앱 볼륨 | 훅이 자동으로 넣는다 | 훅이 자동으로 넣는다(11/15부터) |

키 두 개를 넣은 뒤(3-2) 아래를 한 번만 한다. 1~2는 호스트에서, 3은 bosun 컨테이너 안에서 한다.

**1. soteria 이미지 만들기** (팀원 저장소. 11/15 기준 `fix/gate-request-hardening` 브랜치, main에 합쳐지면 main)

```bash
git clone -b fix/gate-request-hardening https://github.com/bosun-agent/soteria.git ~/soteria-src
cd ~/soteria-src && docker build -t soteria:test .
```

**2. 백업 파일 볼륨 만들기**

```bash
docker volume create bosun_soteria_backups
```

**3. 창구 스택(`bosun-soteria`) 만들기.** 지금 있는 앱 볼륨을 찾아 읽기 전용으로 붙이고, bosun 스택 네트워크(`bosun_default`)에 이름 `bosun-soteria`로 붙인다.

```bash
docker compose exec bosun sh -lc 'cd /app/ai-agent-hooks && AGENT_ENV_FILE=/opt/bosun/agent.env PORTAINER_TLS_VERIFY=0 SOTERIA_ENDPOINT_ID=3 SOTERIA_TARGETS_FILE=/opt/bosun/soteria_targets.json python3 tools/soteria_setup.py'
```

- 끝에 `창구 응답: 정상`이 나오면 된다.
- `SOTERIA_ENDPOINT_ID`는 Portainer 환경 ID다(Portainer 화면에서 환경을 열면 주소에 `#!/3/docker/…`처럼 보인다). 기준 설정(`agent.yaml`)은 `3`으로 되어 있다. 3이 아니면 위 명령의 값과 함께 `agent.yaml`도 고치고 다시 켠다:
  `docker compose exec bosun sed -i 's/SOTERIA_ENDPOINT_ID: "3"/SOTERIA_ENDPOINT_ID: "<ID>"/' /opt/bosun/agent.yaml && docker compose restart bosun`

**4. 정시 백업 스택(`bosun-backup`) 만들기.** Portainer 화면 → Stacks → Add stack → 이름 `bosun-backup`, Web editor에 아래를 붙여 넣고 Deploy. 처음에는 앱 볼륨 없이 시작해도 된다(새 앱 볼륨은 훅이 넣는다). 이미 있는 앱도 정시 백업에 넣으려면 `backup/bosun-backup-compose.yaml`처럼 `volumes`에 직접 적는다(직접 적은 볼륨은 Agent가 지우지 못한다).

```yaml
services:
  backup:
    image: offen/docker-volume-backup:v2.50.1
    container_name: bosun-backup
    restart: unless-stopped
    environment:
      BACKUP_CRON_EXPRESSION: "0 12,18,23 * * *"
      TZ: "Asia/Seoul"
      BACKUP_RETENTION_DAYS: "7"
      BACKUP_FILENAME: "backup-%Y-%m-%dT%H-%M-%S.tar.gz"
    mem_limit: 256m
    cpus: 0.5
    volumes:
      - bosun_backups:/archive
volumes:
  bosun_backups:
    name: bosun_backups
```

설치판에서 바뀌는 값(이미지 기본값, `container/.env`에 적으면 그 값을 쓴다):

| 값 | 설치판 | 뜻 |
|---|---|---|
| `SOTERIA_API` | `http://bosun-soteria:8080` | 훅·mcp-soteria가 창구에 붙는 주소. 컨테이너 안의 `127.0.0.1`은 bosun 자신이라 이름으로 부른다 |
| `SOTERIA_NETWORK` | `bosun_default` | 창구를 붙일 네트워크. compose 이름(`name: bosun`)을 바꾸면 `<이름>_default` |

진입점이 기동마다 이 두 값을 `agent.env`에 맞추고, `agent.yaml`의 mcp-soteria 주소(기본값 `http://127.0.0.1:18090`)를 `SOTERIA_API`로 바꾼다. 저장 위치·파일 꺼내는 방법은 `README-backup.md`.

### 재부팅 뒤 자동으로 다시 켜지는지

`bosun`(이 compose), `bosun-soteria`·`bosun-backup`(위 스택)은 `restart: unless-stopped`, 팀 기본 Portainer는 `restart: always`라 Docker가 켜지면 같이 켜진다. Docker 자체가 부팅 때 켜지도록 해 둔다: 리눅스 `sudo systemctl enable docker`, Docker Desktop은 설정의 "Start Docker Desktop when you sign in".

## 8. 라이선스

BOSUN MIT / docker-agent Apache-2.0 / Portainer CE 무료 배포판 / offen 볼륨백업·soteria MPL-2.0 / Node·Debian 각 패키지 라이선스. Open WebUI는 쓰지 않는다(자체 화면) → 해당 브랜딩 조항과 무관.
