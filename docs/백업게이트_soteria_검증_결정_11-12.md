# soteria 백업 게이트 — 실측 검증과 팀 결정 (11-12)

대상: `https://github.com/seoulorigin/soteria` (offen/docker-volume-backup MPL-2.0 포크, `serve` 명령·MCP 서버 추가)
검증 방법: Go 1.27로 `cmd/backup`·`cmd/mcp` 빌드 후 `serve`를 실제 기동해 HTTP(API)와 MCP(stdio) 양쪽을 호출. 아래 모든 판정은 실행 결과와 소스 위치를 근거로 붙였다.
검증 환경: 도커 데몬이 없는 리눅스 호스트(컨테이너가 도커를 조작하는 부분은 미검증), 백업 대상·아카이브는 로컬 임시 디렉터리.

재현 자산: `/opt/data/cache/scratch/soteria-test/verify2.sh`(API 시나리오), `mcp_probe3.py`(MCP 호출), `logs/`

---

## 1. 팀원 지적 7건 판정

| # | 지적 | 판정 | 근거 요약 |
|---|---|---|---|
| 1 | 같은 이름으로 백업하면 예전 파일을 덮어씀 | **사실** | 중복 검사가 job_id 하나뿐이고 메모리에만 존재(재시작 시 소실). 재시작 후 같은 job_id → 200, 파일 해시가 바뀜 |
| 2 | 저장 위치를 안 적으면 실패(문서엔 선택이라 적혀 있음) | **사실(문서가 틀림)** | 코드는 필수(400), MCP 스키마·문서는 "생략 시 /archive"라고 안내 |
| 3 | 아무 폴더나 백업할 수 있음 | **사실** | 경로 존재·읽기 가능 여부만 검사. 허용 목록 없음 |
| 4 | 보관 기간에 "영구"·이상한 이름도 받음 | **부분 사실** | 문자열은 400으로 거부. 그러나 숫자는 무검증(-1·-2·99999 전부 통과)이고 파일명·job_id에 검증 없음 |
| 5 | 문서 예시대로면 누구나 접속 + agent와 포트 겹침 | **사실** | 인증 0건, 기본 바인드가 모든 인터페이스. `-http-addr` 플래그가 무시되어 조일 수단도 없음 |
| 6 | 살아있는 DB 백업은 복원 시 어긋날 수 있음(문서 보강 필요) | **사실(설계상)** | 정지 단계가 통째로 생략되고, 결과에 정합성 여부 필드가 없고, agent에게 정지 수단이 없음 |
| 7 | 복원 기능은 수동 | **사실(의도된 사양)** | 복원 명령 없음, 문서에 수동 절차로 명시 |

### 재현에 쓴 실제 값

| 확인 | 측정 결과 |
|---|---|
| 자격증명 없이 `/healthz`·POST | 200 |
| 비루프백 IP로 POST | 200 (모든 인터페이스에 열림) |
| `serve -http-addr 127.0.0.1:18080` (문서 표기) | 로그 `addr=:8080`, 18080 접속 불가 |
| `-http-addr`를 앞에 둔 경우 | 로그 `addr=127.0.0.1:18080`, 정상 |
| archive 생략(API) | `400 archive is required: a backup without a local artifact cannot be verified` |
| archive 생략(MCP `backup_volume`) | `isError:true`, 위와 같은 400 문구 |
| 앱 데이터가 아닌 폴더를 source로 | `200 succeeded` |
| 같은 job_id 재사용(같은 프로세스) | `409 already exists` |
| 재시작 후 같은 job_id 재사용 | `200 succeeded`, `job-dup.tar.gz` 해시 `2bf9ab48…` → `792ea00e…` |
| 다른 job_id + 같은 `filename` | `200 succeeded`, `same-name.tar.gz` 해시 `819df9ac…` → `12f7124c…` |
| `retention_days:"영구"` | `400 cannot unmarshal string … int32` |
| `retention_days:-2` / `99999` | 200 / 200 |
| `retention_days:0` | 200, 아카이브는 그대로(전부 삭제 금지 안전장치) |
| `filename:"../x.tar.gz"` | `500 open /x.tar.gz: permission denied` |
| `job_id:"../../escaped-by-jobid"` | 200, 아티팩트가 `archive/escaped-by-jobid.tar.gz`(접두어 `job-` 소실) |
| 실행 로그의 정지 단계 | `Stopping` 0건 |
| `backup restore` | `panic: unknown command: restore` |

---

## 2. 고칠 항목(팀 결정 반영 후 남은 것)

### 2-1. `-http-addr` 플래그가 무시된다 + 기본 바인드가 전체 인터페이스 — 필수

`serve -http-addr 127.0.0.1:18080`처럼 플래그를 서브커맨드 **뒤에** 쓰면 Go의 플래그 파싱이 첫 비플래그 인자에서 멈춰 값이 전혀 반영되지 않는다. 기본값이 `:8080`(모든 인터페이스)이라 "포트를 바꿔 로컬만 열려고 했다"는 의도가 조용히 무시된다. 문서 두 곳(`docs/how-tos/approval-triggered-backup.md`, `TESTING.md`)이 모두 이 표기를 쓴다.

- 조치(구현): `serve`용 플래그를 서브커맨드에서 직접 파싱 — 이제 `serve -http-addr …`도 먹는다(전역 `-http-addr`도 계속 동작하며 기본값 역할)
- 조치(수정): **기본 바인드는 `:8080`을 유지했다.** 컨테이너 안에서 루프백에만 바인딩하면 퍼블리시한 포트가 컨테이너에 도달하지 못하기 때문이다. 대신 (1) 문서의 compose를 `127.0.0.1:18081:8080`으로 바꾸고 (2) 와일드카드 주소로 바인딩할 때 "인증 없음·외부 접근 가능" 경고를 로그로 남긴다
- 조치(구현): 요청 본문은 `Content-Type: application/json`일 때만 처리(브라우저 경유 트리거 차단, 위반 시 415)
- 조치(구현): MCP 클라이언트 기본 API 주소를 발행 포트(18081)로 맞춤

### 2-2. 저장 위치(archive) 문서·스키마 불일치 — 필수

코드는 필수(400)인데 MCP 스키마(`cmd/mcp/main.go`의 `archive` 설명)와 `docs/how-tos/mcp-server.md`는 "생략 시 /archive"라고 적혀 있어, 그대로 따르는 에이전트는 항상 실패한다.

- 조치(권장): 요청에 `archive`가 없으면 서버 기본값 `/archive`를 사용하도록 코드를 바꾸고 문서·스키마는 유지
- 대안: 스키마·문서를 "필수"로 수정

### 2-3. 파일명·job_id 검증 — 최소 버전 필요

`filename:"../x.tar.gz"`는 컨테이너 안 `/x.tar.gz`로 쓰려다 실패(500)한다. 컨테이너는 root로 실행되므로 배포 환경에 따라 아카이브 밖 경로에 쓰기가 가능하다. `job_id`도 기본 파일명에 그대로 들어가 접두어 `job-`이 사라지는 부작용이 있다.

- 조치: `filename`·`job_id`에 `/`와 `..` 금지(최소), 여유가 되면 `^[A-Za-z0-9._-]{1,128}$` 화이트리스트 + `filepath.Base` 일치 확인
- 이 항목은 보안 목적이 아니라 "엉뚱한 500·경로 이탈" 방지 목적이다

### 2-4. 보관 기간 검증 + 문서 정정 — 필수

`-1`(영구)·`-2`·`99999`가 모두 통과한다. 팀 결정은 "영구 보관 없이 최대 기간"이므로 문서가 현재 권장하는 영구 보관 문구도 함께 고쳐야 한다.

- 조치: `retention_days`는 `1 ~ N`(기본 30, 상한 365 같은 설정값)만 허용. `-1`·`0`·기타 음수·과대값은 400. env `BACKUP_RETENTION_DAYS`도 동일 규칙
- 조치: `docs/how-tos/approval-triggered-backup.md`에서 "롤백용은 `-1`로 두라"는 안내(요청 필드 표, Restoring 절)를 최대 기간 정책으로 교체
- 참고: 프루닝은 삭제 대상이 전부가 되는 경우 아무것도 지우지 않는다(`internal/storage/storage.go`). 디스크 정리를 확실히 하려면 별도 정리 명령이나 전용 아카이브 디렉터리 분리가 필요하다

### 2-5. DB 정합성 문서화 — 필수(범위는 팀장 확정)

soteria 컨테이너에는 도커 소켓을 주지 않으므로 스스로 앱을 멈출 수 없다. 그런데 문서는 정지 책임을 호출자에게 한 문장으로 넘기고, 호출자(Bosun)에게는 정지 수단이 없다.

- 조치(문서): "DB 볼륨이면 (1) 컨테이너 정지 또는 (2) 덤프(`pg_dump`/`mysqldump`) 선행"을 각주가 아니라 **절차 단계**로 명시(`approval-triggered-backup.md`·`mcp-server.md`)
- 조치(워크플로): Agent 지시문에 `정지 → backup_volume → sha256 확인 → 삭제/교체 → 재시작` 순서를 넣는다
- 선택(보류): 응답에 `quiesced: true/false`를 추가해 게이트가 live 백업을 거부하도록. 팀장 결정이 "문서 절차화 + Agent가 지키게"이므로 이번 범위에서는 제외. 단일 도구로 묶는 최종 형태도 스코프 결정 사항으로 남긴다

---

## 3. 팀 결정 (11-12)

| 항목 | 결정 | 결과 |
|---|---|---|
| 같은 이름 덮어쓰기 | 허용 — 임시 저장(작업 실수 대비) 용도라 문제 없음 | 덮어쓰기 가드 불필요. 단 되돌릴 때는 응답의 해시를 그대로 믿지 말고 그 시점에 파일을 다시 해시해 비교 |
| 개인정보 파일 백업 | 허용 — 사용자 로컬에서만 동작 | source 허용경로 검증 불필요. `source`는 앱 데이터 폴더 하나로 정하는 운영 규칙만 유지 |
| 보관 기간 | 영구 보관 없음, 최대 기간 설정 | 2-4 적용. 오래 보관할 파일은 사용자가 별도 폴더로 직접 이동 |
| 접속 개방 | 로컬에서만 동작하므로 인증은 넣지 않음 | 인증 불필요. 단 2-1(바인드·플래그·Content-Type)은 그대로 필요 |
| 정합성 | 문서 보강 필요 | 2-5 |
| 자동 복원 | 검토 중 — 도입한다면 덮어쓰기 방식으로 | 신규 스코프. 지금은 복원 기능 없음. 도입 시 볼륨을 비우지 않고 덮어쓰며, 정지·재시작 책임 주체는 그때 확정 |

---

## 4. 남은 작업과 담당

| 작업 | 담당(안) | 상태 |
|---|---|---|
| 플래그 파싱 수정 | 배포 형태 담당 | 완료 `c5616fa` |
| Content-Type 검사(415) | 〃 | 완료 `2a87e46` |
| 바인드 경고 + 문서의 루프백 발행 | 〃 | 완료 `c5616fa`, `b9b871c` |
| archive 기본값 처리 + 스키마·문서 정합 | AI Agent | 완료 `8c5ecbb`, `cfe426a`, `b9b871c` |
| `filename`/`job_id` 검증 | AI Agent | 완료 `dfb7c44` |
| 보관 기간 검증 + 문서 정정 | AI Agent | 완료 `aeeddbc`, `b9b871c` |
| DB 정합성 문서 절차화 | AI Agent(문서) | 문서 완료 `b9b871c` — Agent 지시문 반영은 아래 배선 항목 |
| 사용자용 저장 위치 안내 | 문서 | 완료(`README-backup.md`) |
| Bosun 배선(agent.yaml toolsets·`permissions.allow`·지시문 순서) | Agent 파트 | 미착수 |
| 로컬 도커 실증(`TESTING.md` 절차) | 팀 | 미착수 — 이 환경에 도커 데몬이 없다 |
| 자동 복원 설계 | 팀장 확정 후 | 보류(도입 시 덮어쓰기) |

권장 순서: 입력 검증(2-3) → 플래그·바인드(2-1) → archive 기본값(2-2) → 보관 기간·문서(2-4) → 정합성 문서(2-5) → 복원 설계.
수정은 항목당 1커밋·별도 브랜치로 쌓는다(이 포크는 upstream과 역사가 끊긴 4커밋이라 항목별 리뷰·롤백이 어렵다).

---

## 4-1. 구현 결과 (11-12) — 실측

브랜치 `fix/gate-request-hardening` (soteria 저장소, main에서 분기), 항목당 1커밋.
검증: Go 1.27 빌드 후 `serve`를 실제 기동해 아래를 측정(스크립트 `/opt/data/cache/scratch/verify_final.sh`, 로그 `/opt/data/cache/scratch/soteria-final/logs/`). 단위 테스트 `go test ./cmd/backup/ ./cmd/mcp/` 통과.

| 확인 | 결과 |
|---|---|
| `serve -http-addr 127.0.0.1:18081` (플래그가 서브커맨드 뒤) | 로그 `addr=127.0.0.1:18081`, 실제로 그 주소에 열림 |
| 기본 실행(`serve`) | 로그 `addr=:8080` + "인증 없음" 경고 1줄 |
| `archive` 생략(`BACKUP_ARCHIVE` 설정) | 200, 아카이브에 아티팩트 생성 |
| `archive` 생략(`BACKUP_ARCHIVE` 없음) | 400 `archive "/archive" does not exist` (기본값 적용 확인) |
| `filename:"../x.tar.gz"` | 400 `must not contain a path separator` |
| `job_id:"../../escaped"` | 400 `must not contain a path separator` |
| `retention_days`: -1 / 0 / 99999 | 각각 400 `must be between 1 and 365` |
| `retention_days`: 30 | 200 |
| `Content-Type: text/plain` | 415 `Content-Type must be application/json` |
| 컨테이너 기본 보관(-1)로 API 실행 | 200 + 로그 `retention period adjusted for a gate backup configured=-1 used=365` |
| 같은 `filename`으로 두 번(다른 job_id) | 둘 다 200, 아티팩트 덮어씀(팀 결정대로 유지) |

## 5. 미검증 항목

- 컨테이너 이미지 빌드·실행(`Dockerfile`)과 실제 도커 볼륨 대상 백업 — 이 환경에 도커 데몬이 없다
- 원격 스토리지 백엔드(S3·SSH·WebDAV 등) 동작
- 여러 호스트에서 동시 승인이 들어올 때의 순서 보장(파일 잠금은 컨테이너 내부 경로라 컨테이너 간 배타가 없다는 서술만 소스로 확인)
