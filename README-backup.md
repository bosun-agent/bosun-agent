# BOSUN — 백업 저장 위치 설정

백업 파일은 컨테이너 안이 아니라 **내 PC의 어느 폴더에 쌓이는지**로 결정된다.
이 문서는 그 폴더를 정하고, 직접 열어보고 보관할 수 있게 만드는 방법을 다룬다.

---

## 1. 저장 위치는 두 가지 방식뿐이다

백업 컨테이너는 만든 아카이브를 항상 컨테이너 안 `/archive`에 쓴다. 중요한 건 **그 `/archive`가 내 PC의 무엇에 연결되어 있느냐**다.

| 방식 | 설정에 쓰는 형태 | 파일이 실제로 있는 곳 | 이런 경우에 |
|---|---|---|---|
| 도커 볼륨 | `bosun_backups:/archive` | 도커가 관리하는 내부 저장소. 탐색기에서 안 보인다 | 설정이 가장 간단. 파일을 직접 만질 일이 없을 때 |
| 내 폴더 연결 | `${HOME}/bosun-backups:/archive` | 내가 만든 폴더. 탐색기에서 바로 보인다 | 파일을 꺼내 보거나 복사·USB 보관하고 싶을 때 **(권장)** |

팀 기본 설정(`backup/bosun-backup-compose.yaml`)은 도커 볼륨(`bosun_backups`)을 쓴다.
내 PC에서 직접 관리하려면 아래 2절로 바꾸면 된다.

---

## 2. 권장: 내 PC 폴더에 저장하기 (4단계)

### (1) 폴더를 만든다

```bash
# macOS / Linux
mkdir -p "${HOME}/bosun-backups"
```

```powershell
# Windows (PowerShell)
New-Item -ItemType Directory -Force C:\bosun-backups
```

### (2) compose에서 `/archive`에 연결할 곳만 바꾼다

`backup/bosun-backup-compose.yaml`:

```yaml
    volumes:
      - bosun-data-1102:/backup/bosun-data-1102:ro
      - bosun-t16b-1102-redis:/backup/bosun-t16b-1102-redis:ro
      - "${HOME}/bosun-backups:/archive"   # 앞 = 내 PC 경로, 뒤 = 컨테이너 경로(고정, 바꾸지 않는다)
```

- **왼쪽(내 PC 경로)** 만 바꾼다. 오른쪽 `/archive`는 컨테이너 안 약속된 자리라 그대로 둔다.
- Windows는 **슬래시**로 적는다: `- "C:/bosun-backups:/archive"`. `C:\bosun-backups`처럼 역슬래시를 쓰면 compose가 오류를 낸다.
- `~`(틸드)는 환경에 따라 그대로 문자로 취급될 수 있다. `${HOME}` 또는 절대경로(`/Users/내이름/bosun-backups`)를 쓴다.
- 폴더를 쓰기로 했으면 맨 아래 `volumes:`의 `bosun_backups:` 정의는 지워도 된다(남겨도 무해하다).

### (3) 다시 올린다

- Portainer → **Stacks** → `bosun-backup` → **Update the stack**
- 또는 터미널에서:
  ```bash
  docker compose -f backup/bosun-backup-compose.yaml up -d
  ```

### (4) 제대로 붙었는지 확인한다

```bash
ls -l "${HOME}/bosun-backups"          # 내 폴더 (비어 있어도 정상: 아직 백업 전)
docker exec bosun-backup ls -l /archive # 컨테이너가 보는 같은 폴더
curl -s -X POST http://127.0.0.1:18081/v1/backups \
  -H 'Content-Type: application/json' \
  -d '{"source":"/backup/bosun-data-1102","archive":"/archive","wait":true}'   # soteria API를 쓰는 경우
```

두 명령이 **같은 파일 목록**을 보여주면 정상이다. 한쪽만 보이면 5절을 확인한다.

---

## 3. 도커 볼륨을 그대로 쓸 때: 파일은 어디 있나

- 위치 확인: `docker volume inspect bosun_backups` → `Mountpoint`가 실제 경로다.
  - Linux: `/var/lib/docker/volumes/bosun_backups/_data` (관리자 권한 필요)
  - macOS / Windows: 도커가 만든 **가상 머신 안**이라 Finder·탐색기에서 직접 열 수 없다. Docker Desktop → **Volumes** 화면에서 확인하거나 아래처럼 꺼낸다.
- 파일 꺼내기: `docker cp bosun-backup:/archive/<파일명> ~/Downloads/`
- 볼륨을 폴더로 옮겨 두기(기존 백업 살리기):
  ```bash
  docker run --rm -v bosun_backups:/from -v "${HOME}/bosun-backups:/to" alpine \
    sh -c 'cp -a /from/. /to/'
  ```
  그 다음 2절처럼 설정을 바꾸면 이후 백업부터 내 폴더에 쌓인다.

---

## 4. 승인 트리거 API(soteria)를 쓰는 경우

soteria는 백업을 HTTP로 요청받고 **결과 파일의 경로·크기·해시**를 돌려준다.
저장 위치는 요청의 `archive` 값으로 정해지고, 그 값은 **컨테이너 안 경로**다.

```json
{"job_id":"approval-42","source":"/backup/bosun-data-1102","archive":"/archive","wait":true}
```

- 내 PC 폴더를 `/archive`에 붙여 두었다면 요청에는 항상 `"/archive"`를 쓴다(내 PC 경로를 넣으면 안 된다).
- **`archive`는 생략해도 된다.** 생략하면 서버가 컨테이너의 `BACKUP_ARCHIVE`, 그것도 없으면 `/archive`를 쓴다. 내 PC 경로(예: `~/bosun-backups`)를 그대로 적으면 "존재하지 않는다"는 오류가 난다.
- 에이전트(MCP `backup_volume`)에서도 같은 값이다: `source`는 백업 대상, `archive`는 저장 위치.
- 응답의 `artifact.path`는 **컨테이너 안 경로**(예: `/archive/job-approval-42.tar.gz`)다. 내 PC에서는 같은 파일이 `~/bosun-backups/job-approval-42.tar.gz`로 보인다.

---

## 5. 보관 기간과 저장 위치는 서로 영향을 준다

- 보관 기간(`BACKUP_RETENTION_DAYS`, 현재 7일)이 지난 파일은 **저장 위치에서 자동 삭제**된다. 즉 `/archive`를 내 폴더에 붙이면 **내 폴더의 오래된 파일도 지워진다.**
- 오래 남겨야 하는 파일(롤백 직전 스냅샷 등)은 **다른 폴더**에 복사해 둔다. 예: `~/bosun-backups-keep/`. 저장 위치를 하나 더 만들려고 설정을 늘릴 필요는 없다.
- 영구 보관은 지원하지 않는다: 요청으로 지정하는 보관 기간은 1일부터 상한(기본 365일, `BACKUP_MAX_RETENTION_DAYS`로 조정)까지만 허용되고, 그 밖의 값은 거부되거나 상한으로 조정된다. 오래 보관할 파일은 사용자가 직접 별도 폴더·외부 저장소로 옮긴다.
- 참고: 삭제 대상이 **전부**가 되는 경우에는 안전을 위해 아무것도 지우지 않는다. 그래서 오래된 파일 한두 개가 남아 있을 수 있다. 디스크 정리를 확실히 하려면 오래된 파일만 골라 지우면 된다:
  ```bash
  find "${HOME}/bosun-backups" -name '*.tar.gz' -mtime +30 -delete
  ```

---

## 6. 잘 안 될 때

| 증상 | 원인 | 해결 |
|---|---|---|
| `permission denied` / 백업이 500으로 실패 | 연결한 폴더에 컨테이너가 쓸 수 없다 | 폴더 권한을 확인한다. 리눅스는 `chmod 777`로 임시 확인, macOS는 Docker Desktop → Settings → Resources → File sharing에 그 폴더가 포함되는지 본다 |
| 내 폴더에 파일이 안 생긴다 | 설정을 바꾼 뒤 스택을 다시 올리지 않았다 | (3)단계 Update the stack 실행 후 `docker exec bosun-backup ls -l /archive`로 먼저 확인 |
| `415 Content-Type must be application/json` | 요청을 JSON으로 보내지 않았다 | `-H 'Content-Type: application/json'`를 붙인다 |
| `retention_days must be between 1 and …` | 보관 기간을 0·음수·상한 초과로 보냈다 | 1~상한(기본 365) 사이 값을 쓴다. 영구 보관은 지원하지 않는다 |
| `filename/job_id … must not contain a path separator` | 이름에 `/`나 `..`를 넣었다 | 파일 이름만 넣는다(경로 금지) |
| `archive "..." does not exist` | 컨테이너 안에 그 경로가 없다 | 컨테이너 경로(`/archive`)를 쓰고 있는지 확인. 내 PC 경로를 넣으면 이 오류가 난다 |
| compose가 경로를 못 읽는다 | Windows 역슬래시, `~` 미확장 | `"C:/bosun-backups:/archive"` 또는 `${HOME}` 사용 |
| 아카이브는 생겼는데 내용이 비어 보인다 | 백업 대상 볼륨을 안 붙였거나 경로가 틀렸다 | `source`가 컨테이너 안 마운트 경로(`/backup/<볼륨이름>`)인지 확인 |
| 파일 소유자가 root로 보인다 | 컨테이너가 root로 실행된다 | 정상이다. 지울 때 관리자 권한이 필요할 수 있다 |

---

## 7. 백업이 제대로 만들어졌는지 스스로 확인하기

```bash
# 1) 파일이 있는지 + 크기가 0이 아닌지
ls -lh "${HOME}/bosun-backups"
# 2) 안에 뭐가 들었는지 (압축을 풀지 않고 목록만)
tar -tzf "${HOME}/bosun-backups/<파일명>.tar.gz" | head -20
# 3) 파일이 그대로인지 지문 찍어두기 (다른 곳에 복사한 뒤 비교할 때 쓴다)
sha256sum "${HOME}/bosun-backups/<파일명>.tar.gz"
```

되돌리는 절차는 `docs/복원절차서_관리자용_11-07.md`를 따른다.
