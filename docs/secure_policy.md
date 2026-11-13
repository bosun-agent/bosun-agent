# MCP 기본 보안 정책 분류표

이 문서는 Portainer MCP를 사용하는 Docker 관리 Agent에 적용할 **Secure 정책 초안**을 정리한다. 각 `ALLOW / ASK / DENY` 값은 해당 작업에 대한 정책 제안이며, 시스템 API 자체의 인증·접근권한을 대신하지 않는다.

## 1. 정책 분류 기준

| 정책 | 의미 |
|---|---|
| **ALLOW** | 허용된 Tool·메서드·경로·대상·인자 조건을 충족한 작업을 별도 승인 없이 실행 |
| **ASK** | 사전 조건을 충족한 작업에 한해, 실행 대상과 확정된 인자를 사용자에게 보여주고 **해당 호출 1건**의 승인 후 실행 |
| **DENY** | 사용자 승인이 있더라도 실행 불가. 미분류 Tool, 메서드, 경로는 기본적으로 거부 |

| 위험도 | 판단 기준 |
|---|---|
| **R0** | 일반 상태·목록 조회, 자원 변경 없음 |
| **R1** | 비밀정보·내부 구성·민감 메타데이터가 포함될 수 있는 조회 |
| **R2** | 자원 생성, 실행 상태·연결성 변경 또는 서비스 가용성 영향 |
| **R3** | 삭제, 강제 종료, 임의 명령 실행, 데이터 반출, 권한 상승 등 고위험 작업 |

정책은 **동작의 실제 효과**를 기준으로 분류한다. `GET`이라고 자동 ALLOW하지 않고, `POST`라고 무조건 변경 작업으로 단정하지 않는다. `ASK`도 위험 인자의 예외 허가가 아니며, 필수 제한이 만족되지 않으면 **DENY**한다.

**작업 경로 원칙:** Docker 자원 조회는 `docker_proxy`의 제한된 `GET` 경로를 활용하고, **신규 컨테이너·서비스 배포 및 구성 변경은 Portainer의 스택(Compose) 도구를 우선한다.** 컨테이너 시작·정지·재시작 등 필요한 개별 제어는 별도 작업으로 분류한다. Docker Engine API에 대한 직접 생성·삭제가 기본적으로 허용된다는 뜻은 아니다.

## 2. 기본 Tool 정책

| MCP Tool | 호출 범위 | 정책 | 위험도 | 필수 조건 | 근거 |
|---|---|---|---|---|---|
| `EndpointList` | `GET /endpoints` | **ALLOW** | R0 | 허용된 환경 목록과 식별자 중심으로 최소 조회 | 작업 대상 환경 식별 |
| `docker_proxy` | Docker Engine API 경유 | **경로·인자별** | 작업별 | 3~5절의 `(method, path)`와 인자 조건에만 적용; 조회 중심, 필요한 개별 제어는 조건부 승인 | 임의 경로를 통과시킬 수 있으므로 포괄 ALLOW 금지 |
| `StackCreateDockerStandaloneString` | Portainer 스택(Compose) 생성 | **ASK** | R3 | 허용 환경, 검증된 Compose 내용, 생성할 스택 이름·영향 범위 확인; 5.7절 참조 | 신규 서비스 배포의 우선 경로 |
| `StackUpdate` | 기존 스택 Compose 변경 | **ASK** | R3 | 허용 환경·스택 ID, 수정 전후 Compose·영향 범위 확인; 5.7절 참조 | 기존 서비스 구성·배포 변경 |
| `StackStart` · `StackStop` | 스택 실행 상태 변경 | **ASK** | R2 | 허용 환경·스택 ID·현재 상태 확인, 호출 단위 승인 | 스택 단위 가용성 변경 |
| `StackDelete` | Docker Standalone 스택 삭제 (`DELETE /stacks/{id}`) | **ASK** | R3 | 허용 환경·스택·삭제 범위 및 볼륨 동반 삭제 시 백업 검증; 호출별 승인; 5.10절 참조 | 스택의 컨테이너·네트워크 제거와 서비스 중단, 볼륨 동반 삭제 시 데이터 손실 가능 |
| `backup_volume` | Soteria MCP 백업 실행 (`POST /v1/backups`) | **ASK** | R2 | 허용된 백업 대상·경로·인자 검증 및 호출별 승인; 5.8절 참조 | 백업 산출물 생성과 저장소 접근으로 자원 사용·데이터 취급에 영향 |
| `backup_status` | Soteria MCP 백업 상태·산출물 정보 조회 (`GET /v1/backups/{job_id}`) | **ALLOW** | R0 | 허용된 `job_id`의 작업 상태·산출물 메타데이터만 조회; 5.9절 참조 | 기존 백업 작업에 대한 조회로 신규 백업 실행이나 자원 변경 없음 |
| 기타 직접 MCP Tool | 6절 확장 정책 참조 | **기본 DENY** | 작업별 | 명시적으로 노출을 선택하고 세부 정책에 포함한 경우만 적용 | 필요하지 않은 도구 노출 최소화 |

## 3. `docker_proxy` 작업별 정책

다음 작업 이름은 **Docker Engine API 작업 식별자**이며 MCP Tool 이름이 아니다. 실제 호출은 모두 `docker_proxy`의 `method`, `path`, `environment_id` 및 관련 인자로 구분한다. **조회와 필요한 개별 컨테이너 제어를 대상으로 하며, 새 서비스 배포는 2절의 스택 Tool을 우선한다.**

| 작업 | Method | Path | 정책 | 위험도 | 필수 인자·대상 제한 | 판단 근거 |
|---|---|---|---|---|---|---|
| `ContainerDelete` | `DELETE` | `/containers/{id}` | **ASK** | R3 | `force=false`, `link` 미지정; `v=true`는 익명 볼륨 백업 검증 시에만 허용; 보호 대상·상태·승인 내용 일치; 5.3절 참조 | 컨테이너 제거 및 익명 볼륨 동반 삭제 시 데이터 손실 가능성으로 대상·삭제 범위별 승인 필요 |
| `ContainerInspect` | `GET` | `/containers/{id}/json` | **ASK** | R1 | 허용 대상 및 `size` 제한; 원본 응답을 그대로 전달하지 않고 안전한 필드만 제공; 5.5절 참조 | 컨테이너 설정에 비밀정보가 포함될 수 있음 |
| `ContainerKill` | `POST` | `/containers/{id}/kill` | **DENY** | R3 | 허용 대상 없음 | 강제 시그널로 서비스 장애를 유발할 수 있음 |
| `ContainerList` | `GET` | `/containers/json` | **ALLOW** | R0 | 허용 환경에 한정, 응답 필드 최소화 | 일반 컨테이너 상태 목록 |
| `ContainerLogs` | `GET` | `/containers/{id}/logs` | **ASK** | R1 | `follow=false`, `tail` 미지정 시 `100` 자동 보충·명시 시 1~200, 조회 시간·출력 범위 제한; 안전한 출력 처리 조건; 5.4절 참조 | 로그에 계정정보·토큰 등 민감정보가 포함될 수 있음 |
| `ContainerPause` | `POST` | `/containers/{id}/pause` | **DENY** | R2 | 기본 정책에서 허용하지 않음 | 서비스 실행·가용성 변경 |
| `ContainerRestart` | `POST` | `/containers/{id}/restart` | **ASK** | R2 | 환경·대상 ID·상태 확인; 중복 실행 제한 | 서비스 중단 또는 재기동 |
| `ContainerStart` | `POST` | `/containers/{id}/start` | **ASK** | R2 | 환경·대상 ID 및 현재 상태 확인 | 서비스 실행 상태 변경 |
| `ContainerStats` | `GET` | `/containers/{id}/stats` | **ALLOW** | R0 | `stream=false`; 결과량 제한 | 컨테이너 사용량 확인 |
| `ContainerStop` | `POST` | `/containers/{id}/stop` | **ASK** | R2 | 환경·대상 ID 확인; 적절한 중지 제한 시간 | 서비스 중단 |
| `ContainerTop` | `GET` | `/containers/{id}/top` | **ASK** | R1 | 프로세스 인자에 포함된 민감 문자열 보호 | 명령줄·인자에 비밀정보가 포함될 수 있음 |
| `ContainerUnpause` | `POST` | `/containers/{id}/unpause` | **DENY** | R2 | 기본 정책에서 허용하지 않음 | 서비스 실행 상태 변경 |
| `ImageCreate` | `POST` | `/images/create` | **ASK** | R2 | 레지스트리 pull 전용, 명시적인 이미지 참조·태그/다이제스트와 플랫폼 검증; import 차단; 5.6절 참조 | 이미지 다운로드로 로컬 리소스·공급망 노출면 변경 |
| `ImageHistory` | `GET` | `/images/{name}/history` | **ASK** | R1 | `CreatedBy` 등 민감 문자열 제거 | 이미지 빌드 이력에 자격정보 포함 가능 |
| `ImageInspect` | `GET` | `/images/{name}/json` | **ASK** | R1 | 이미지 환경변수·민감 설정 보호 | 이미지 메타데이터에 민감정보 포함 가능 |
| `ImageList` | `GET` | `/images/json` | **ALLOW** | R0 | 필터와 출력 크기 제한 | 이미지 목록 조회 |
| `ImageSearch` | `GET` | `/images/search` | **DENY** | R1 | 기본 정책에서 외부 레지스트리 검색 제외 | 외부 조회 경로 및 기본 관리 기능 범위 밖 |
| `NetworkConnect` | `POST` | `/networks/{id}/connect` | **DENY** | R2 | 기본 정책에서 연결 변경 금지 | 컨테이너 네트워크 경계 변경 |
| `NetworkCreate` | `POST` | `/networks/create` | **DENY** | R2 | 기본 정책에서 네트워크 생성 금지 | 네트워크 구조·드라이버·옵션 변경 |
| `NetworkDisconnect` | `POST` | `/networks/{id}/disconnect` | **DENY** | R2 | 기본 정책에서 연결 해제 금지 | 서비스 통신 단절 가능 |
| `NetworkInspect` | `GET` | `/networks/{id}` | **ALLOW** | R1 | 내부 IP·설정정보 필요한 필드만 제공 | 네트워크 설정 조회(민감 필드 제한 필요) |
| `NetworkList` | `GET` | `/networks` | **ALLOW** | R0 | 필요한 식별자·상태 중심으로 응답 축소 | 네트워크 목록 조회 |
| `SystemDataUsage` | `GET` | `/system/df` | **ALLOW** | R0 | 결과량 제한 | 디스크·리소스 사용량 조회 |
| `SystemInfo` | `GET` | `/info` | **ALLOW** | R1 | 호스트명·보안 구성·레지스트리 설정 등 민감 필드 제외 | 엔진 호스트 설정 및 내부 구성 노출 가능 |
| `SystemVersion` | `GET` | `/version` | **ALLOW** | R0 | 버전 관련 필드만 반환 | Docker Engine 버전 조회 |
| `VolumeCreate` | `POST` | `/volumes/create` | **DENY** | R2 | 기본 정책에서 생성 금지 | 드라이버 옵션·호스트 경로 영향 가능 |
| `VolumeInspect` | `GET` | `/volumes/{name}` | **ASK** | R1 | `Mountpoint`, `Options` 등 내부 경로·설정 제한 | 호스트 저장소 정보 노출 가능 |
| `VolumeList` | `GET` | `/volumes` | **ALLOW** | R0 | 이름·드라이버 등 필요한 항목만 제공 | 볼륨 목록 조회 |

### 3.1 기본 목록 외 추가 Docker Engine 작업

| 작업 | Method | Path | 정책 | 위험도 | 필수 인자·대상 제한 | 판단 근거 |
|---|---|---|---|---|---|---|
| `ContainerCreate` | `POST` | `/containers/create` | **DENY** | R3 | 직접 생성은 허용하지 않음; 검증된 `StackCreateDockerStandaloneString`으로 대체 | Compose 기반 배포를 우선하여 직접 생성 경로 축소 |
| `ImageDelete` | `DELETE` | `/images/{name}` | **DENY** | R3 | 기본 정책에서 이미지 직접 삭제 제외 | 이미지 손실·서비스 재시작 영향; Docker 직접 작업 허용 목록 밖 |
| `NetworkDelete` | `DELETE` | `/networks/{id}` | **ASK** | R3 | 허용된 미사용 네트워크·보호 대상 여부 확인 및 호출별 승인; 5.12절 참조 | 네트워크 구성 삭제 및 서비스 연결성 영향 가능 |
| `VolumeDelete` | `DELETE` | `/volumes/{name}` | **ASK** | R3 | 사용하지 않는 허용 볼륨, `force=false`, Soteria 백업 검증 및 호출별 승인; 5.11절 참조 | 볼륨 데이터의 영구 손실 가능성으로 대상·백업·승인 조건 필요 |
| `SystemPing` | `GET` | `/_ping` | **ALLOW** | R0 | 상태만 반환 | Engine 응답 확인 |

## 4. 기본 DENY 경로

명시적으로 아래 작업을 차단한다. 동일 동작을 수행하는 별칭·버전 경로·인코딩 변형도 허용하지 않는다.

| Method | 경로 | 정책 | 사유 |
|---|---|---|---|
| `GET` | `/containers/{id}/archive` | **DENY** | 컨테이너 내부 파일 반출 |
| `PUT` | `/containers/{id}/archive` | **DENY** | 컨테이너 내부 파일 쓰기 |
| `GET` | `/containers/{id}/export` | **DENY** | 컨테이너 파일시스템 전체 반출 |
| `GET` | `/images/get` | **DENY** | 이미지 tar 다운로드 |
| `GET` | `/images/{name}/get` | **DENY** | 이미지 tar 다운로드 |
| `POST` | `/containers/{id}/exec` | **DENY** | 컨테이너 내부 임의 명령 실행 준비 |
| `POST` | `/exec/{id}/start` | **DENY** | 컨테이너 내부 임의 명령 실행 |
| `POST` | `/containers/create` | **DENY** | 직접 컨테이너 생성 대신 Compose 기반 스택 생성 사용 |
| `DELETE` | `/images/{name}` | **DENY** | 이미지 직접 삭제 제외 |
| `POST` | `/*/prune` | **DENY** | 대량 삭제 및 데이터 손실 위험 |

## 5. 공통 인자·대상 정책

아래 공통 정책 중 environment_id, method, path, query_params, headers는 docker_proxy 호출에 적용하며, Portainer의 스택 생성·갱신·시작·정지 Tool에는 각 Tool의 인자 계약과 5.1절·5.7절의 조건을, `StackDelete`에는 5.1절·5.10절의 조건을, Soteria MCP의 `backup_volume`·`backup_status`에는 5.1절 및 각각 5.8절·5.9절의 조건을 적용한다.

| 범위 | 정책 조건 |
|---|---|
| `tool_name` | `EndpointList`, `docker_proxy`, `StackCreateDockerStandaloneString`, `StackUpdate`, `StackStart`, `StackStop`, `StackDelete`, Soteria MCP의 `backup_volume`, `backup_status`를 기본 정책 대상으로 지정. 그 외 Tool은 명시적으로 정책에 추가된 경우만 허용 |
| `environment_id` | 호출 대상 환경을 명시하고, 사용자에게 허가된 환경 범위만 허용. 다른 환경 ID로 전환하는 행위는 별개 요청으로 취급 |
| `method` | 문자열 HTTP 메서드를 명시해야 함. 누락·비정상 자료형·지원하지 않는 메서드는 차단 |
| `path` | `/`로 시작하는 지정 경로만 허용. `%`, 역슬래시, `?`, `#`, 공백, `..` 경로요소, `//` 등 경로 해석이 모호한 입력은 차단 |
| `query_params` | 메서드·경로별 허용 키·자료형·값만 통과. 알 수 없는 키는 기본 차단 |
| `headers` | 임의 헤더 추가 금지. 특히 인증·Host·Cookie 계열 헤더 주입 불허 |
| `body` | 조회에는 불필요한 body 금지. 생성·변경 요청은 지정된 필드·자료형·중첩 구조만 허용 |
| `select`·응답 | 필요한 필드만 반환하고 민감정보를 제한. `select`는 비밀정보 마스킹 자체를 보장하지 않음 |
| `ContainerLogs` | `follow=false`, `tail` 상한, 로그 민감정보 보호 |
| `ContainerStats` | `stream=false`; 장시간 스트리밍 금지 |
| `ContainerDelete` | `force=false`; `v=true`는 익명 볼륨 삭제 대상 식별·백업 검증 후 허용; 보호 대상 제외, 삭제할 리소스 식별자 명시 |
| 신규 서비스 배포 | `docker_proxy`의 `ContainerCreate` 직접 호출을 사용하지 않고, 스택(Compose) 생성·수정 도구의 인자 및 Compose 내용을 검증 |
| `ImageCreate` | pull 형태만; 저장소·태그·플랫폼 범위 제한. 파일/URL import와 임의 본문 거부 |
| 삭제·재시작·스택 변경 | 실제 대상·위험·최종 인자를 보여주고 해당 호출에만 승인. 승인 만료·거절 시 실행하지 않음; 일괄/지속 승인 금지 |
| 보호 리소스 | Agent·Portainer 실행 자체에 필요한 컨테이너/볼륨/네트워크 및 관리 리소스는 변경·삭제 기본 차단 |
| 예외·미분류 | 잘못된 입력, 예기치 않은 경로, 중첩 인자 우회, 정책 판단 불가 시 DENY |

### 5.1 인자 정책 판정 원칙

아래 원칙은 `docker_proxy`와 직접 MCP Tool 모두에 적용하되, **호출 인자 형식은 Tool별로 구분**한다. `docker_proxy`는 `environment_id`·`method`·원문 `path`·`query_params` 등을 사용하고, 2절의 스택 직접 Tool은 **Tool 이름(`operationId`) 및 스펙에 정의된 `endpointId`·`id`·요청 body**로 판정한다. Soteria MCP의 `backup_volume`·`backup_status`는 Tool 이름과 각 Tool에 정의된 요청 인자로 판정한다. 아래 5.2절의 `environment_id`·`query_params`·버전 접두 경로 조건은 `docker_proxy`용이며, 스택 생성·갱신·시작·정지 Tool에는 5.7절, `StackDelete`에는 5.10절, `backup_volume`에는 5.8절, `backup_status`에는 5.9절의 인자 조건을 적용한다. `ALLOW` 또는 `ASK`라도 필수 조건을 충족하지 못하면 **DENY**한다.

| 검사 항목 | 정책 |
|---|---|
| 호출 식별 | `docker_proxy`는 `tool_name`, `environment_id`, `method`, 정규화 전 원문 `path`의 조합을 검사한다. 직접 스택 Tool은 정확한 `operationId`, 필수 `endpointId`, 필요한 경우 스택 `id` 및 요청 body를 검사한다. 미등록 조합은 DENY |
| 인자 화이트리스트 | `docker_proxy`는 작업별 `query_params`를, 직접 스택 Tool은 스펙상 path/query 인자와 본문 필드를 각각 허용 목록으로 검사한다. 누락된 필수 인자, 중복 키, 타입 오류, 허용되지 않은 키·중첩 필드는 DENY |
| 표현 정규화 | 문자열/숫자/불리언은 작업별 지정 형식으로 정규화하되 모호하거나 서로 충돌하는 표현은 DENY. `False`와 `"false"`처럼 허용한 형식만 명시적으로 처리 |
| 경로·대상 | `docker_proxy` 원문 `path`의 `%`, `\`, `?`, `#`, 공백, `.`·`..` 경로요소, `//` 및 예상 밖 접두어는 DENY. 직접 스택 Tool은 임의 `path` 대신 `endpointId`·`id`로 대상 환경·스택을 확인한다. 실제 자원과 불일치하면 DENY |
| 헤더·본문 | `docker_proxy`의 임의 `headers`, 조회용 `body`, 미등록 본문 필드는 DENY. 스택 생성·갱신 Tool의 body는 5.7절의 스키마·필드 제한을 적용하며, `StackDelete`에는 body를 허용하지 않음. 인증정보의 호출별 덮어쓰기 금지 |
| 승인 결합 | `ASK`에는 실제 Tool 이름, 대상 환경·자원, 메서드 또는 작업, 검증된 전체 인자·본문, 예상 영향 범위를 표시. 승인 후 대상이나 인자가 바뀌면 기존 승인 재사용 금지 |
| 출력 보호 | `select`만으로 마스킹을 보장하지 않음. 민감 원본을 모델이나 WEB에 전달하지 않도록 신뢰할 수 있는 응답 필드 제한·마스킹 경로가 있어야 함 |
| 판단 불가 | 허용 환경·보호 대상 여부·응답 보호 조건을 확인할 수 없으면 DENY. 허용 목록에 없는 기능을 ASK로 자동 강등하지 않음 |

### 5.2 공통 식별자와 query 인자

| 항목 | 허용 | DENY 조건 |
|---|---|---|
| `environment_id` | 사용자가 접근할 수 있는 것으로 확인된 양의 정수 환경 ID | 누락, 임의 추정, 다른 사용자/환경, 정수가 아닌 값 |
| 컨테이너·이미지·네트워크 ID 및 볼륨 이름·ID | 지정된 환경에 존재하며 보호 리소스가 아닌 현재 대상 ID 또는 검증된 이름 | 대상 혼동, 다른 환경의 동명이인, 예상과 다른 실제 ID·이름, 보호 대상 |
| `query_params` | 작업별 허용 키와 값만 포함하는 JSON 객체 | 문자열을 통한 우회 인코딩, 미등록 키, 타입 오류, 비어 있어야 할 요청에 추가된 값 |
| `select` | 응답 최소화에 필요한 검토된 필드 선택식 | 원본 비밀값을 포함한 결과를 그대로 노출하거나, 필수 마스킹을 우회하는 선택식 |
| 버전 접두 경로 | 정책 엔진이 명시적으로 지원한 단일 Docker API 버전 경로만 표준 경로로 변환 | 중복 버전 접두, 경로 재해석 차이, 비표준 별칭 |

### 5.3 `ContainerDelete` — `DELETE /containers/{id}` · ASK

| 인자·조건 | ASK 요청이 가능한 조건 | DENY 조건 |
|---|---|---|
| `environment_id`, `{id}` | 현재 승인 대상의 환경·컨테이너가 정확히 일치 | 불명확하거나 다른 자원, 보호 대상 |
| `query_params.force` | **미지정 또는 `false`** | `true`, `1` 등 강제 삭제 요청, 비정상 표현 |
| `query_params.v` | **미지정 또는 `false`**; `true`는 삭제 대상 익명 볼륨의 식별·백업 검증 완료 시 허용 | 비정상 값, `true`에서 삭제 대상 익명 볼륨 식별·백업·검증 불가 |
| `query_params.link` | **미지정** | 링크 삭제 모드 또는 예상 밖 값 |
| 기타 `query_params` | 없음 | 모든 추가 키 |
| `body`, `headers` | 없음 | 전달됨 |
| 자원 상태 | 사전 조회한 특정 컨테이너, 정지 상태, 보호 대상이 아님 | 실행 중, 사전 조회 누락, 삭제 대상 변경·식별 불가 |
| 익명 볼륨 백업 | `v=true`에서 실제 삭제 대상 익명 볼륨이 있으면 각 볼륨과 Soteria `source`의 일치 및 5.8절의 백업 성공·산출물 검증을 확인 | 삭제 대상 일부라도 미등록·미백업, 대상 불일치, 백업 실패·미완료·검증 불가 |
| 승인 범위 | 컨테이너 1개에 대한 삭제 1건과 확정된 `v` 값·익명 볼륨 삭제 범위를 포함 | 전체·지속 승인 또는 다른 ID/옵션·삭제 범위 재사용 |

삭제 전 inspect **설정 기록이 있더라도 데이터 백업·복구를 보장하지 않는다.** `v=true`에서 익명 볼륨이 삭제된다면 별도의 Soteria 백업 검증이 필요하다. 기록 실패·보호 대상 확인 불가·삭제 범위 변경 시에는 DENY한다.

### 5.4 `ContainerLogs` — `GET /containers/{id}/logs` · ASK

| 인자·조건 | ASK 요청이 가능한 조건 | DENY 조건 |
|---|---|---|
| `query_params.follow` | **`false` 명시** | `true`, 스트리밍·연결 유지 유도, 비정상 표현 |
| `query_params.tail` | **미지정 시 `100` 자동 보충, 명시 시 1~200의 정수 라인 수** | `all`, 0 이하, 200 초과, 비정상 값 |
| `query_params.stdout`·`stderr` | 불리언, 적어도 한 출력 채널은 `true` | 둘 다 `false`, 비정상 타입 |
| `query_params.since`·`until` | 미지정 또는 **0 이상 UNIX 시각**. 둘 다 있으면 `since ≤ until` | 역전된 시각, 비정상 값 또는 모호한 문자열 |
| `query_params.timestamps` | 불리언 | 비정상 타입 |
| 기타 `query_params` | 없음 | 미등록 키, 다른 스트리밍 방식 |
| `body`, `headers` | 없음 | 전달됨 |
| 출력 | 요청 범위 내 제한된 로그만 제공하고 비밀값을 필터링 | 토큰·암호·인증 헤더 등 원문 노출, 무제한 스트림 |

`tail` 한도는 **Secure 기본 정책 제안값(200줄)**이다. 모델에서 `select`를 지정하더라도 로그는 평문/스트림으로 반환될 수 있으므로, 신뢰할 수 있는 출력 필터가 없으면 해당 ASK 요청을 실행 가능 대상으로 취급하지 않고 **DENY**한다.

### 5.5 `ContainerInspect` — `GET /containers/{id}/json` · ASK

| 인자·조건 | ASK 요청이 가능한 조건 | DENY 조건 |
|---|---|---|
| `query_params.size` | 미지정 또는 `false` | `true` 및 추가 용량 산출 요청, 비정상 표현 |
| 기타 `query_params` | 없음 | 미등록 키 |
| `body`, `headers` | 없음 | 전달됨 |
| 기본 제공 가능한 응답 필드 | `Id`, `Name`, `Image`, `Created`, `State.Status`, `RestartCount` 등 필요 최소치 | 전체 inspect JSON의 무제한 전달 |
| 반드시 보호할 응답 예 | `Config.Env`, `Config.Cmd`, `Args`, `HostConfig.Binds`, `Mounts.Source`, `LogPath`, `ResolvConfPath` 등은 기본 미공개 | 비밀값, 호스트 경로, 실행 인자, 보안 설정의 원문 노출 |
| 출력 필터 | 허용 필드가 실제 응답에서 추출되고 나머지가 제거되었음을 보장하는 처리 | 모델이 선택한 `select`만 신뢰하거나 마스킹 여부가 불확실한 경우 |

`ASK`는 **민감정보를 그대로 보여주기 위한 포괄 승인**이 아니다. 조회 결과에 대한 안전한 필드 제한이 보장되지 않으면 DENY한다. 상세 구성 전체가 필요한 관리 기능은 별도 정책으로 분리한다.

### 5.6 `ImageCreate` — `POST /images/create` · ASK

이 경로는 이름과 달리 이미지 **레지스트리 pull과 파일/URL import가 모두 가능한 API**이므로, 기본 정책은 pull만 허용한다.

| 인자·조건 | ASK 요청이 가능한 조건 | DENY 조건 |
|---|---|---|
| `query_params.fromImage` | **필수**. 명시적인 레지스트리 이미지 참조이며 허용된 출처에 속함 | 누락, URL·파일 경로, 금지된 출처, 모호한 이미지 참조 |
| `query_params.tag` | 명시적 태그 또는 `fromImage`에 포함된 명시적 digest와 충돌하지 않는 표현 | 빈 문자열, tag/digest 모순, 암묵적으로 모든 태그를 받는 요청 |
| `query_params.platform` | 미지정 또는 `os[/arch[/variant]]` 형식으로 승인된 플랫폼 | 지원하지 않는 값·형식, 플랫폼 범위를 임의 확대 |
| `query_params.fromSrc`, `repo`, `message`, `changes` | 없음 | 하나라도 지정 (이미지 import·변형 경로) |
| 기타 `query_params` | 없음 | 미등록 키 |
| `body`, `headers` | 없음 | 이미지 아카이브 본문, `X-Registry-Auth` 등 호출별 인증정보 전달, 임의 헤더 |
| 승인 대상 | 최종 이미지 참조(레지스트리·저장소·태그 또는 digest) 1건과 대상 환경 | wildcard·복수 이미지, 사전 승인과 다른 이미지 |

허용 레지스트리 목록이 비어 있거나 이미지 출처를 확인할 수 없으면 DENY한다. 태그보다 digest 고정을 권장하지만, **이 문서에서는 특정 레지스트리나 태그를 근거 없이 기본 허용값으로 지정하지 않는다.**

### 5.7 스택(Compose) 생성·갱신 — 조건부 ASK

새로운 컨테이너 또는 서비스를 배포할 때 `docker_proxy`의 `POST /containers/create`를 사용하지 않고, Portainer MCP의 **`StackCreateDockerStandaloneString`**(`POST /stacks/create/standalone/string`)을 우선한다. 기존 스택의 Compose 변경은 **`StackUpdate`**(`PUT /stacks/{id}`)로 별도 승인한다. 스택의 시작·정지는 `StackStart`/`StackStop`을 사용하며 역시 호출별 ASK다.

**직접 스택 Tool의 요청 인자 조건** (아래 Compose 내부 필드 검사와 별개):

| Tool·인자 | ASK를 검토할 수 있는 조건 | DENY 조건 |
|---|---|---|
| 생성 `endpointId` | 필수 양의 정수이며 사용자가 허가받은 Docker Standalone 환경 ID와 일치 | 누락·잘못된 타입·미승인 환경 |
| 생성 body: `Name`, `StackFileContent` | `stacks.composeStackFromFileContentPayload`의 필수 필드. 유효한 단일 스택 이름과 검증 가능한 Compose YAML 문자열 | 누락·타입 오류·이름 충돌·검증 불가 Compose |
| 생성 body: `Env`, `Registries`, `FromAppTemplate`, `Webhook` | `Env`는 허용된 `{name, value}` 문자열 쌍만, `Registries`는 승인된 정수 ID 목록만 허용. `FromAppTemplate`은 미지정 또는 `false`, `Webhook`은 미지정 | 비밀값·미승인 레지스트리·템플릿/웹훅 기능 활성화·미등록 필드 |
| 수정 `id`, `endpointId` | 두 인자 모두 필수 양의 정수. `id`가 지정한 기존 스택과 `endpointId`의 실제 소속 환경이 일치 | 누락·대상 변경·미승인 환경 또는 스택 |
| 수정 body: `StackFileContent`, `Env`, `Registries` | `stacks.updateStackPayload` 사용. 이 정책의 **Compose 수정 요청에는 `StackFileContent` 문자열을 필수로 요구**하며, `Env`·`Registries`는 위의 허용 범위 안에서만 지정 | Compose 없는 수정, 유효하지 않은 환경변수·레지스트리·미등록 필드 |
| 수정 body: `Prune`, `PullImage`, `RepullImageAndRedeploy`, `RollbackTo`, `Webhook` | 기본 정책에서는 **모두 미지정**. 이미지 강제 재배포·롤백·서비스 정리·웹훅 관련 기능은 별도 정책 필요 | 값이 `false`여도 필드가 전달되거나, 승인받은 Compose 변경 외 추가 효과를 요청 |
| 시작·정지 `id`, `endpointId` 및 body | 두 정수 인자로 기존 스택과 소속 환경을 식별하고, 별도의 요청 body 없이 호출 | 인자 누락·다른 스택/환경·불필요한 body |

`StackUpdate`의 `StackFileContent`는 MCP 스펙에서는 선택 필드지만, **이 제안 정책은 Compose 수정 작업에 한해 필수로 제한**한다. 각 요청의 미등록 path/query 인자와 본문 필드는 DENY한다. `Env`가 사용하는 `name`·`value`는 MCP 스펙의 `portainer.Pair` 필드명이다.

**Compose YAML 내부 설정 검사:**

| 검사 대상 | ASK를 검토할 수 있는 조건 | DENY 조건 |
|---|---|---|
| Tool·대상 환경 | 지정된 스택 Tool, 허용된 `endpointId`, 필요한 스택 ID와 사용자 권한 확인 | 다른 환경·스택, 미확인 ID 또는 미노출 Tool |
| 스택 생성 요청 | 단일 Docker Standalone 스택, 명시적 스택 이름, 검토된 Compose 문자열 | 다중·예상 밖 배포, 이름 충돌, 검증할 수 없는 원격 정의 |
| 스택 갱신 요청 | 변경할 기존 스택을 확인하고 수정 전후 정의 및 영향 범위를 검토 | 대상 불명확, 기존 정의 미확인, 승인 후 설정 변경 |
| `services` · `image` | 사전에 허용된 이미지 출처와 명시적 서비스 정의 | 허용되지 않은 이미지·서비스 또는 임의 이미지 빌드 |
| `command` · `entrypoint` | 이미지의 기본 실행 설정을 우선하며, 별도 지정이 필요한 경우 사전에 허용된 실행 명령·인자·엔트리포인트만 사용 | 검증되지 않은 명령 덮어쓰기·임의 실행 파일 또는 셸 명령 실행 |
| `restart` | `no`, 재시도 횟수를 제한한 `on-failure`, 사전 허용된 `unless-stopped` 등 명시적으로 허용된 정책만 사용 | 미승인 자동 재시작 정책·검증되지 않은 무제한 실패 재시도 |
| `privileged`, `cap_add`, `devices` | 없음 | 권한 상승·장치 직접 접근 옵션 |
| `pid`, `ipc`, `network_mode` | 격리된 기본 또는 사전 허용된 값 | `host` 등 호스트 네임스페이스 공유 |
| `volumes` · 마운트 | 검증된 이름 있는 볼륨과 허용된 마운트 대상만 | 호스트 경로 bind, 호스트 루트(`/`)·Docker socket(`/var/run/docker.sock`)·관리 데이터 볼륨 마운트 |
| `security_opt`, `sysctls` 등 보안·커널 설정 | 사전 검증된 명시적 허용 범위만 | 권한 상승·보안 완화, 검사할 수 없는 옵션 |
| 포트·네트워크·자원 | 허용된 포트 공개 범위와 격리 네트워크를 유지하고, CPU·메모리는 설정 시 형식·값·설정 간 유효성을 검사하며 미지정 시 별도 제한값을 강제하지 않음 | 미승인 공개 포트·네트워크, 유효하지 않은 CPU·메모리 설정 |
| 환경변수·비밀값 | 허용된 키·값 형식; 비밀값은 안전한 별도 주입 경로 사용 | 평문 토큰·패스워드를 Compose나 승인 로그에 포함 |
| 승인 범위 | 확정된 대상 환경·스택·Compose·변경 영향을 표시하여 호출 1건에 승인 | 다른 환경·스택에 승인 재사용, 변경된 Compose를 재승인 없이 실행 |

CPU·메모리 리소스 설정을 생략한 경우 별도 제한값을 자동 보충하지 않고 Docker의 기본 동작을 따른다. Secure 정책상 고정된 CPU·메모리 상한은 두지 않으며, 이는 Docker Desktop VM의 물리적·설정상 한계를 초과하여 사용할 수 있음을 의미하지 않는다.

Compose 내용을 검사할 수 없거나 금지 필드가 포함되면 **ASK로 위험 조건을 무시하지 않고 DENY**한다. 생성·갱신·시작·정지는 서로 다른 작업이므로 각각 별도의 권한 판정 및 승인을 적용한다. 스택 삭제는 5.10절의 조건을 적용한다. Git 기반 자동 재배포·외부 저장소 기반 생성은 기본 범위에서 제외한다.

### 5.8 Soteria `backup_volume` — 백업 실행 · ASK / R2

Soteria MCP의 `backup_volume`은 백업 산출물을 생성하는 작업이며 내부적으로 `POST /v1/backups`를 호출한다. `docker_proxy`의 `method`·`path`·`query_params`가 아닌 Soteria MCP Tool의 인자 계약을 적용한다.

| 인자·조건 | ASK 요청이 가능한 조건 | DENY 조건 |
|---|---|---|
| `source` | 필수. 허용된 앱 데이터 볼륨이 실제로 연결된 백업 원본 경로이며 대상과의 대응 관계가 확인됨 | 미지정, 임의 경로·호스트 민감 경로, 허용되지 않은 볼륨 또는 실제 마운트 관계 확인 불가 |
| `archive` | 필수. 사전에 허용된 백업 산출물 저장 디렉터리를 명시 | 미지정, 미승인·존재하지 않는 경로 또는 저장 가능 여부 확인 불가 |
| `volume` | 미지정 또는 확인된 백업 대상 볼륨을 나타내는 레이블 | 실제 대상과 불일치하는 레이블 또는 레이블만으로 백업 대상이 확인됐다고 판단하는 경우 |
| `job_id` | 미지정 또는 형식이 유효하고 다른 작업과 충돌하지 않는 식별자. 삭제 승인과 연계할 때는 해당 요청을 식별할 수 있어야 함 | 비정상 값, 기존 작업과 중복·충돌하는 식별자, 승인 건과의 대응 관계 확인 불가 |
| `wait` | 불리언. `true`는 완료 결과 확인, `false`는 접수 후 별도의 완료 확인이 필요한 요청 | 비정상 값, `pending`·`running`을 백업 완료로 간주 |
| 미등록 인자·산출물 | MCP Tool에 정의된 인자만 사용하고, 허용된 파일명·보관 정책 범위에서 기존 백업 산출물을 덮어쓰지 않음 | 임의 추가 인자, 정책에 맞지 않는 파일명·보관 조건, 기존 산출물 덮어쓰기 |
| 백업 결과 | 작업 상태가 `succeeded`이고, 존재하는 0바이트 초과의 산출물 및 SHA-256 검증 정보를 확인할 수 있음 | `failed`, 미완료 상태, 산출물 누락·빈 파일, 체크섬 누락 또는 검증 불가 |
| 승인·응답 | 확정된 대상·원본·저장 경로·인자에 대한 호출 1건의 승인. 응답에는 필요한 작업 상태·산출물 메타데이터만 제공 | 승인 범위를 벗어난 대상·인자 변경, 승인 재사용, 민감한 내부 경로·데이터의 불필요한 노출 |

`volume`은 표시용 레이블이며 실제 백업 원본은 `source`로 정해진다. 따라서 허용된 볼륨과 `source`의 대응 관계가 확인되지 않으면 ASK 대상에서 제외하고 DENY한다. 백업 산출물 검증은 데이터 복원 성공을 보장하지 않는다.

### 5.9 Soteria `backup_status` — 백업 상태·산출물 조회 · ALLOW / R0

Soteria MCP의 `backup_status`는 기존 백업 작업의 상태와 산출물 메타데이터를 조회하며 내부적으로 `GET /v1/backups/{job_id}`를 호출한다. `docker_proxy` 인자가 아닌 해당 MCP Tool의 인자 계약을 적용한다.

| 인자·조건 | ALLOW 조건 | DENY 조건 |
|---|---|---|
| `job_id` | 필수. 형식이 유효하고 조회가 허가된 백업 작업 식별자 | 미지정·빈 값·비정상 값, 권한이 없거나 대상 확인이 불가능한 작업 ID |
| 기타 인자 | 없음 | `job_id` 외의 모든 인자 |
| 조회 범위 | 허용된 백업 작업 1건의 상태 및 필요한 산출물 메타데이터 | 허용 범위 밖의 작업 조회, 다른 작업의 정보 노출 |
| 응답 | 작업 상태 및 필요한 산출물 정보(이름·크기·SHA-256 등)만 제공하고 민감한 내부 경로·정보는 제한 | 백업 원본·저장 경로 등 불필요한 민감정보의 원문 노출, 안전한 응답 제한 불가 |
| 작업 효과 | 기존 작업에 대한 조회만 수행 | 신규 백업 실행·백업 작업 변경·자원 삭제 등 조회 외 동작 |

### 5.10 `StackDelete` — `DELETE /stacks/{id}` · ASK / R3

Portainer MCP의 `StackDelete`는 허용된 Docker Standalone 스택에 한하여 호출별 ASK로 분류한다. `removeVolumes=true`는 삭제 대상 볼륨의 백업 조건을 충족한 경우에만 허용한다.

| 인자·조건 | ASK 요청이 가능한 조건 | DENY 조건 |
|---|---|---|
| `id` | 필수 양의 정수. 현재 삭제 대상인 특정 스택의 ID가 확인됨 | 누락·비정상 값, 스택 식별 불가 또는 승인 대상 불일치 |
| `endpointId` | 필수 양의 정수. 사용자에게 허가된 Docker Standalone 환경이며 해당 스택의 실제 소속 환경과 일치 | 미승인 환경, 다른 환경에 속한 스택, 타입·대상 확인 불가 |
| `external` | 미지정 또는 `false` | `true`, 비정상 값, 외부 Swarm 스택 삭제 요청 |
| `removeVolumes` | 미지정 또는 `false`; `true`는 실제 삭제 대상 볼륨 전체에 대한 백업 검증 조건 충족 시 허용 | 비정상 값, `true`에서 삭제 대상 볼륨의 일부라도 식별·백업·검증 불가 |
| 삭제 대상·영향 | 허용된 일반 스택이며 삭제되는 컨테이너·네트워크 및 볼륨 범위를 확인 | Bosun·Portainer·백업 서비스 등 보호 스택, 영향 범위 불명확, 보호 리소스 포함 |
| 볼륨 백업 검증 | `removeVolumes=true`이면 삭제 대상인 이름 있는 볼륨·익명 볼륨 각각에 대해 실제 대상과 백업 `source`의 일치 및 5.8절에 따른 백업 성공·산출물 검증 확인 | 미등록·미백업 볼륨, 대상 불일치, 백업 실패·미완료·산출물 검증 불가 |
| 기타 인자·본문 | 위의 허용 인자 외 추가 인자 및 요청 body 없음 | 미등록 인자·불필요한 body·인증 관련 임의 값 |
| 승인 범위 | 확정된 환경·스택 ID·`removeVolumes` 값과 삭제 영향 범위를 표시하고 호출 1건에만 승인 | 승인 없는 실행, 삭제 범위·대상 변경, 승인 재사용 |

`removeVolumes`를 미지정하거나 `false`로 지정하면 볼륨 데이터 삭제에 대한 Soteria 백업을 필수 조건으로 요구하지 않는다. 다만 스택 소유 컨테이너·네트워크 제거에 따른 서비스 영향 확인과 호출별 승인은 유지한다. `StackDeleteKubernetesByName` 등 다른 스택 삭제 Tool은 이 정책의 허용 대상이 아니다.

### 5.11 `VolumeDelete` — `DELETE /volumes/{name}` · ASK / R3

`docker_proxy`의 `VolumeDelete`는 지정된 개별 볼륨의 데이터를 삭제할 수 있으므로, 이름 있는 볼륨과 익명 볼륨 모두 대상 확인·백업 검증·호출별 승인을 필수로 한다.

| 인자·조건 | ASK 요청이 가능한 조건 | DENY 조건 |
|---|---|---|
| `environment_id`, `{name}` | 허가된 환경에서 삭제할 특정 볼륨의 실제 이름·대상을 확인 | 다른 환경, 볼륨 식별 불가, 승인 대상 불일치 |
| `query_params.force` | 미지정 또는 `false` | `true`, 비정상 값 또는 강제 삭제 요청 |
| 기타 `query_params` | 없음 | 미등록 키·예상 밖 값 |
| `body`, `headers` | 없음 | 전달됨 |
| 사용 상태 | 삭제 대상 볼륨의 컨테이너 참조 관계를 확인하고, 백업 검증 후 백업용 마운트를 포함한 모든 참조가 해제된 상태에서 삭제 | 삭제 시점에 참조 컨테이너가 남아 있거나 참조 관계를 확인할 수 없는 경우 |
| 보호 대상 | 허용된 일반 데이터 볼륨 | Bosun·Portainer·백업 서비스 등 관리용·보호 볼륨 |
| 백업 검증 | 해당 볼륨과 Soteria `source`의 일치 및 5.8절의 백업 성공·산출물 검증 확인 | 백업 대상 미등록, 대상 불일치, 백업 실패·미완료·산출물 검증 불가 |
| 승인 범위 | 확인된 환경·볼륨 이름·삭제 영향과 전체 인자에 대한 호출 1건의 승인 | 승인 없는 실행, 대상·인자 변경, 승인 재사용 |

### 5.12 `NetworkDelete` — `DELETE /networks/{id}` · ASK / R3

`docker_proxy`의 `NetworkDelete`는 특정 네트워크를 제거하는 작업으로, 대상 환경·연결 상태·보호 리소스 여부를 확인하고 호출별 승인한다. 볼륨 데이터 백업은 필수 조건이 아니다.

| 인자·조건 | ASK 요청이 가능한 조건 | DENY 조건 |
|---|---|---|
| `environment_id`, `{id}` | 허가된 환경에 존재하는 특정 네트워크의 실제 ID 또는 검증된 이름 확인 | 다른 환경, 네트워크 식별 불가, 승인 대상 불일치 |
| `query_params`, `body`, `headers` | 없음 | 미등록 인자·불필요한 본문·임의 헤더 |
| 네트워크 상태 | 연결된 컨테이너가 없는 삭제 가능 네트워크 | 연결된 컨테이너가 있거나 연결 상태를 확인할 수 없음 |
| 보호 대상 | 허용된 일반 사용자 정의 네트워크 | Docker 기본·시스템 네트워크, Bosun·Portainer·백업 서비스 등 관리용·보호 네트워크 |
| 승인 범위 | 확인된 환경·네트워크·연결성 영향에 대한 호출 1건의 승인 | 승인 없는 실행, 대상 변경, 승인 재사용 |

---

## 6. Portainer MCP 직접 Tool 확장 정책

아래 표는 MCP 담당이 제시한 **`BASE`·`DOCKER` 프로필** 범위의 직접 Tool별 정책이다. 2절의 스택 관련 Tool은 Compose 기반 배포·관리의 기본 **노출 제안 대상**이고, 그 밖의 Tool은 확장 후보로 분류한다. 표의 `ALLOW`·`ASK`는 실제 Agent에 자동 노출된다는 의미가 아니라, **해당 Tool을 노출하기로 선택했을 때 적용할 조건부 정책**이다.

| 분류 | Tool | Method | Portainer API Path | 확장 정책 | 판단 근거 |
|---|---|---|---|---|---|
| `endpoints` | `AgentVersions` | `GET` | `/endpoints/agent_versions` | **ALLOW** | 환경 Agent 버전 목록 조회 |
| `endpoints` | `EndpointAssociationDelete` | `PUT` | `/endpoints/{id}/association` | **DENY** | 리소스 제거 또는 연관 해제; 기본 관리 범위에서 제외 |
| `endpoints` | `EndpointCreate` | `POST` | `/endpoints` | **DENY** | 관리 대상·설정 또는 실행 상태를 변경하는 작업 |
| `endpoints` | `EndpointCreateGlobalKey` | `POST` | `/endpoints/global-key` | **DENY** | 관리 대상·설정 또는 실행 상태를 변경하는 작업 |
| `endpoints` | `EndpointDelete` | `DELETE` | `/endpoints/{id}` | **DENY** | 리소스 제거 또는 연관 해제; 기본 관리 범위에서 제외 |
| `endpoints` | `EndpointDeleteBatch` | `POST` | `/endpoints/delete` | **DENY** | 리소스 제거 또는 연관 해제; 기본 관리 범위에서 제외 |
| `endpoints` | `EndpointDeleteBatchDeprecated` | `DELETE` | `/endpoints` | **DENY** | 리소스 제거 또는 연관 해제; 기본 관리 범위에서 제외 |
| `endpoints` | `EndpointDockerBrowsePut` | `POST` | `/endpoints/{id}/docker/v2/browse/put` | **DENY** | Docker 환경의 파일 쓰기 동작 |
| `endpoints` | `endpointDockerhubStatus` | `GET` | `/endpoints/{id}/dockerhub/{registryId}` | **DENY** | 관리·인증·설정 상세 정보 노출 우려; 기본 범위에서 제외 |
| `endpoints` | `endpointForceUpdateService` | `PUT` | `/endpoints/{id}/forceupdateservice` | **DENY** | 관리 대상·설정 또는 실행 상태를 변경하는 작업 |
| `endpoints` | `EndpointInspect` | `GET` | `/endpoints/{id}` | **ASK** | 환경 상세 설정·메타데이터 노출 가능 |
| `endpoints` | `EndpointMTLSAgentCertificateError` | `GET` | `/endpoints/{id}/mtls_certificate_error` | **DENY** | 인증서 설정·오류 정보 노출 우려 |
| `endpoints` | `EndpointMTLSCertificate` | `GET` | `/endpoints/{id}/mtls_certificate` | **DENY** | 인증서·신뢰정보 공개 위험 |
| `endpoints` | `endpointRegistriesList` | `GET` | `/endpoints/{id}/registries` | **DENY** | 관리·인증·설정 상세 정보 노출 우려; 기본 범위에서 제외 |
| `endpoints` | `endpointRegistryAccess` | `PUT` | `/endpoints/{id}/registries/{registryId}` | **DENY** | 구성·권한·상태 변경; 기본 범위에서 제외 |
| `endpoints` | `EndpointSetPolicyStatuses` | `PUT` | `/endpoints/{id}/edge/policies/statuses` | **DENY** | 구성·권한·상태 변경; 기본 범위에서 제외 |
| `endpoints` | `EndpointSettingsUpdate` | `PUT` | `/endpoints/{id}/settings` | **DENY** | 관리 대상·설정 또는 실행 상태를 변경하는 작업 |
| `endpoints` | `EndpointSnapshot` | `POST` | `/endpoints/{id}/snapshot` | **DENY** | 상태·관리 동작 또는 인증 관련 호출; 기본 범위에서 제외 |
| `endpoints` | `EndpointSnapshots` | `POST` | `/endpoints/snapshot` | **DENY** | 상태·관리 동작 또는 인증 관련 호출; 기본 범위에서 제외 |
| `endpoints` | `EndpointSummaryCounts` | `GET` | `/endpoints/summary` | **ALLOW** | 환경 수량 요약 조회 |
| `endpoints` | `EndpointUpdate` | `PUT` | `/endpoints/{id}` | **DENY** | 관리 대상·설정 또는 실행 상태를 변경하는 작업 |
| `endpoints` | `EndpointUpdateRelations` | `PUT` | `/endpoints/relations` | **DENY** | 관리 대상·설정 또는 실행 상태를 변경하는 작업 |
| `endpoints` | `namespacesAccessUpdate` | `PUT` | `/endpoints/{id}/pools/{rpn}/access` | **DENY** | 관리 대상·설정 또는 실행 상태를 변경하는 작업 |
| `endpoints,docker` | `snapshotContainerInspect` | `GET` | `/docker/{environmentId}/snapshot/containers/{containerId}` | **ASK** | 컨테이너 스냅샷 상세 구성 노출 |
| `endpoints,docker` | `snapshotContainersList` | `GET` | `/docker/{environmentId}/snapshot/containers` | **ASK** | 스냅샷 메타데이터 조회 |
| `endpoints,docker` | `snapshotInspect` | `GET` | `/docker/{environmentId}/snapshot` | **ASK** | 스냅샷 설정·메타데이터 조회 |
| `endpoints` | `TrustEdgeEndpoints` | `POST` | `/endpoints/edge/trust` | **DENY** | 관리 대상·설정 또는 실행 상태를 변경하는 작업 |
| `docker` | `containerImageStatus` | `GET` | `/docker/{environmentId}/containers/{containerId}/image_status` | **ALLOW** | 컨테이너 이미지 상태 조회 |
| `docker` | `containersImageStatusClear` | `POST` | `/docker/{environmentId}/containers/image_status/clear` | **DENY** | 관리 대상·설정 또는 실행 상태를 변경하는 작업 |
| `docker` | `dockerContainerGpusInspect` | `GET` | `/docker/{environmentId}/containers/{containerId}/gpus` | **ALLOW** | GPU 할당·장치 정보 조회 |
| `docker` | `dockerDashboard` | `GET` | `/docker/{environmentId}/dashboard` | **ALLOW** | Docker 환경 대시보드 조회 |
| `docker` | `dockerImagesList` | `GET` | `/docker/{environmentId}/images` | **ALLOW** | Docker 이미지 목록 조회 |
| `docker` | `ServiceImageStatus` | `GET` | `/docker/{environmentId}/services/{serviceId}/image_status` | **ALLOW** | 서비스 이미지 상태 조회 |
| `docker` | `serviceImageStatusClear` | `POST` | `/docker/{environmentId}/services/image_status/clear` | **DENY** | 관리 대상·설정 또는 실행 상태를 변경하는 작업 |
| `docker` | `stacksImageStatusClear` | `POST` | `/stacks/image_status/clear` | **DENY** | 관리 대상·설정 또는 실행 상태를 변경하는 작업 |
| `stacks` | `EdgeStackWebhookInvoke` | `POST` | `/edge_stacks/webhooks/{webhookID}` | **DENY** | 웹훅으로 스택 동작 수행 |
| `stacks` | `StackAssociate` | `PUT` | `/stacks/{id}/associate` | **DENY** | 관리 대상·설정 또는 실행 상태를 변경하는 작업 |
| `stacks` | `StackConvert` | `POST` | `/stacks/{id}/convert` | **DENY** | 관리 대상·설정 또는 실행 상태를 변경하는 작업 |
| `stacks` | `StackCreateDockerStandaloneFile` | `POST` | `/stacks/create/standalone/file` | **DENY** | 관리 대상·설정 또는 실행 상태를 변경하는 작업 |
| `stacks` | `StackCreateDockerStandaloneRepository` | `POST` | `/stacks/create/standalone/repository` | **DENY** | 관리 대상·설정 또는 실행 상태를 변경하는 작업 |
| `stacks` | `StackCreateDockerStandaloneString` | `POST` | `/stacks/create/standalone/string` | **ASK** | Docker Standalone Compose 생성 우선 경로; 5.7절의 정의·대상·인자 검증 후 호출별 승인 |
| `stacks` | `StackCreateDockerSwarmFile` | `POST` | `/stacks/create/swarm/file` | **DENY** | 관리 대상·설정 또는 실행 상태를 변경하는 작업 |
| `stacks` | `StackCreateDockerSwarmRepository` | `POST` | `/stacks/create/swarm/repository` | **DENY** | 관리 대상·설정 또는 실행 상태를 변경하는 작업 |
| `stacks` | `StackCreateDockerSwarmString` | `POST` | `/stacks/create/swarm/string` | **DENY** | 관리 대상·설정 또는 실행 상태를 변경하는 작업 |
| `stacks` | `StackCreateKubernetesFile` | `POST` | `/stacks/create/kubernetes/string` | **DENY** | 관리 대상·설정 또는 실행 상태를 변경하는 작업 |
| `stacks` | `StackCreateKubernetesGit` | `POST` | `/stacks/create/kubernetes/repository` | **DENY** | 관리 대상·설정 또는 실행 상태를 변경하는 작업 |
| `stacks` | `StackCreateKubernetesUrl` | `POST` | `/stacks/create/kubernetes/url` | **DENY** | 관리 대상·설정 또는 실행 상태를 변경하는 작업 |
| `stacks` | `StackDelete` | `DELETE` | `/stacks/{id}` | **ASK** | 허용된 Docker Standalone 스택의 삭제·영향 범위 확인 및 호출별 승인; `removeVolumes=true`는 삭제 대상 볼륨의 백업 검증 필수; 5.10절 참조 |
| `stacks` | `StackDeleteKubernetesByName` | `DELETE` | `/stacks/name/{name}` | **DENY** | 스택 및 관련 리소스 삭제 |
| `stacks` | `StackFileInspect` | `GET` | `/stacks/{id}/file` | **ASK** | 스택 정의 파일에 환경변수·구성 노출 가능 |
| `stacks` | `StackGitRedeploy` | `PUT` | `/stacks/{id}/git/redeploy` | **DENY** | 스택 재배포로 서비스 변경 |
| `stacks` | `stackImagesStatus` | `GET` | `/stacks/{id}/images_status` | **ALLOW** | 상태·요약·목록 조회; 필요한 정보만 반환 |
| `stacks` | `StackInspect` | `GET` | `/stacks/{id}` | **ASK** | 스택 배포 구성·환경 정보 노출 가능 |
| `stacks` | `StackList` | `GET` | `/stacks` | **ALLOW** | 스택 목록 조회 |
| `stacks` | `StackMigrate` | `POST` | `/stacks/{id}/migrate` | **DENY** | 관리 대상·설정 또는 실행 상태를 변경하는 작업 |
| `stacks` | `StackStart` | `POST` | `/stacks/{id}/start` | **ASK** | 허용 환경·스택·현재 상태 확인 및 호출별 승인 |
| `stacks` | `StackStop` | `POST` | `/stacks/{id}/stop` | **ASK** | 허용 환경·스택·서비스 영향 확인 및 호출별 승인 |
| `stacks` | `StacksWebhookInvoke` | `POST` | `/stacks/webhooks/{webhookID}` | **DENY** | 웹훅을 통한 스택 동작 수행 |
| `stacks` | `StackUpdate` | `PUT` | `/stacks/{id}` | **ASK** | 기존 스택 Compose 수정 전후 확인·위험 옵션 검사 및 호출별 승인; 5.7절 참조 |
| `stacks` | `StackUpdateGit` | `POST` | `/stacks/{id}/git` | **DENY** | 관리 대상·설정 또는 실행 상태를 변경하는 작업 |
| `gitops` | `GitOperationRepoFilePreview` | `POST` | `/gitops/repo/file/preview` | **ASK** | 원격 저장소 파일·구성내용 확인 |
| `gitops` | `GitOperationRepoFilesSearch` | `POST` | `/gitops/repo/files/search` | **ASK** | 외부 저장소 파일 목록 요청 |
| `gitops` | `GitOperationRepoHelmValues` | `POST` | `/gitops/repo/helm/values` | **ASK** | 외부 Helm 설정 값 열람 |
| `gitops` | `GitOperationRepoRefs` | `POST` | `/gitops/repo/refs` | **ASK** | 외부 저장소 참조 정보 조회 |
| `gitops` | `GitOpsSourceGet` | `GET` | `/gitops/sources/{id}` | **ASK** | Git 원본·설정 상세 조회 |
| `gitops` | `GitOpsSourcesCreateGit` | `POST` | `/gitops/sources/git` | **DENY** | 관리 대상·설정 또는 실행 상태를 변경하는 작업 |
| `gitops` | `GitOpsSourcesDelete` | `DELETE` | `/gitops/sources/{id}` | **DENY** | 리소스 제거 또는 연관 해제; 기본 관리 범위에서 제외 |
| `gitops` | `GitOpsSourcesList` | `GET` | `/gitops/sources` | **ALLOW** | 상태·요약·목록 조회; 필요한 정보만 반환 |
| `gitops` | `GitOpsSourcesSummary` | `GET` | `/gitops/sources/summary` | **ALLOW** | 상태·요약·목록 조회; 필요한 정보만 반환 |
| `gitops` | `GitOpsSourcesTest` | `POST` | `/gitops/sources/test` | **DENY** | 상태·관리 동작 또는 인증 관련 호출; 기본 범위에서 제외 |
| `gitops` | `GitOpsSourcesTestById` | `POST` | `/gitops/sources/{id}/test` | **DENY** | 상태·관리 동작 또는 인증 관련 호출; 기본 범위에서 제외 |
| `gitops` | `GitOpsSourcesUpdateAccess` | `PUT` | `/gitops/sources/{id}/access` | **DENY** | 관리 대상·설정 또는 실행 상태를 변경하는 작업 |
| `gitops` | `GitOpsSourcesUpdateGit` | `PUT` | `/gitops/sources/{id}` | **DENY** | 관리 대상·설정 또는 실행 상태를 변경하는 작업 |
| `gitops` | `GitOpsSourceWorkflowsList` | `GET` | `/gitops/sources/{id}/workflows` | **ALLOW** | 상태·요약·목록 조회; 필요한 정보만 반환 |
| `gitops` | `GitOpsWorkflowDestroy` | `DELETE` | `/gitops/workflows/{id}/destroy` | **DENY** | 리소스 제거 또는 연관 해제; 기본 관리 범위에서 제외 |
| `gitops` | `GitOpsWorkflowDetach` | `DELETE` | `/gitops/workflows/{id}/detach` | **DENY** | 리소스 제거 또는 연관 해제; 기본 관리 범위에서 제외 |
| `gitops` | `GitOpsWorkflowGet` | `GET` | `/gitops/workflows/{id}` | **ASK** | 워크플로 세부 설정 확인 |
| `gitops` | `GitOpsWorkflowsList` | `GET` | `/gitops/workflows` | **ALLOW** | 상태·요약·목록 조회; 필요한 정보만 반환 |
| `gitops` | `GitOpsWorkflowsSummary` | `GET` | `/gitops/workflows/summary` | **ALLOW** | 상태·요약·목록 조회; 필요한 정보만 반환 |
| `gitops` | `WorkflowCreate` | `POST` | `/gitops/workflows` | **DENY** | 관리 대상·설정 또는 실행 상태를 변경하는 작업 |
| `gitops` | `WorkflowUpdate` | `PUT` | `/gitops/workflows/{id}` | **DENY** | 관리 대상·설정 또는 실행 상태를 변경하는 작업 |
| `system` | `systemInfo` | `GET` | `/system/info` | **ALLOW** | 상태·요약·목록 조회; 필요한 정보만 반환 |
| `system` | `systemNodesCount` | `GET` | `/system/nodes` | **ALLOW** | 상태·요약·목록 조회; 필요한 정보만 반환 |
| `system` | `systemStatus` | `GET` | `/system/status` | **ALLOW** | 상태·요약·목록 조회; 필요한 정보만 반환 |
| `system` | `systemUpdate` | `POST` | `/system/update` | **DENY** | Portainer 자체 업데이트 실행 |
| `system` | `systemVersion` | `GET` | `/system/version` | **ALLOW** | 상태·요약·목록 조회; 필요한 정보만 반환 |
| `settings` | `DefaultRegistryUpdate` | `PUT` | `/settings/default_registry` | **DENY** | 관리 대상·설정 또는 실행 상태를 변경하는 작업 |
| `settings` | `SettingsAdditionalFunctionalityInspect` | `GET` | `/settings/additional_functionality` | **DENY** | 관리 설정 또는 내부 정보 조회; 기본 정책의 비노출 영역 |
| `settings` | `SettingsAdditionalFunctionalityUpdate` | `PUT` | `/settings/additional_functionality` | **DENY** | 관리 대상·설정 또는 실행 상태를 변경하는 작업 |
| `settings` | `SettingsEdgeMTLSCACertificates` | `GET` | `/settings/edge/mtls_ca_certificate` | **DENY** | 인증서·신뢰설정 관련 정보 |
| `settings` | `SettingsEdgeMTLSCertificates` | `GET` | `/settings/edge/mtls_certificate` | **DENY** | 인증서·신뢰설정 관련 정보 |
| `settings` | `SettingsExperimentalInspect` | `GET` | `/settings/experimental` | **DENY** | 관리 설정 또는 내부 정보 조회; 기본 정책의 비노출 영역 |
| `settings` | `SettingsExperimentalUpdate` | `PUT` | `/settings/experimental` | **DENY** | 관리 대상·설정 또는 실행 상태를 변경하는 작업 |
| `settings` | `SettingsInspect` | `GET` | `/settings` | **DENY** | 관리 설정 또는 내부 정보 조회; 기본 정책의 비노출 영역 |
| `settings` | `SettingsPublic` | `GET` | `/settings/public` | **ALLOW** | 공개 설정 조회 |
| `settings` | `SettingsUpdate` | `PUT` | `/settings` | **DENY** | 관리 대상·설정 또는 실행 상태를 변경하는 작업 |
| `status` | `StatusInspect` | `GET` | `/status` | **ALLOW** | 상태 정보 조회 |
| `motd` | `MOTD` | `GET` | `/motd` | **ALLOW** | 안내 메시지 조회 |
| `auth` | `AuthenticateUser` | `POST` | `/auth` | **DENY** | 인증 기능을 Agent에 위임하지 않음 |
| `auth` | `Logout` | `POST` | `/auth/logout` | **DENY** | 로그인 세션 상태 변경 |
| `auth` | `ValidateOAuth` | `POST` | `/auth/oauth/validate` | **DENY** | 인증 관련 호출은 Agent 범위 밖 |

**확장 정책 원칙:** Tool을 새로 노출할 때는 위 분류뿐 아니라 접근 가능한 환경·대상 리소스·중첩 인자·응답 민감정보 범위를 동일하게 제한한다. 미등록 직접 Tool과 미분류 경로는 DENY한다.
