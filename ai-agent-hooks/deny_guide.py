"""
거부 안내 공용 모듈 (11/1) — 막힌 요청을 ① 무엇이 막혔나 ② 왜 ③ 대신 할 수 있는 것 형식으로 설명한다.
policy guard(docker_proxy)와 stack guard(스택 도구)가 함께 쓴다.

원칙
  - 문장은 모델이 아니라 훅이 정해진 대로 만든다(승인 카드 설명과 같은 이유).
  - ③은 Agent 안에서 되는 안전한 대안을 먼저 쓰고, 없으면 "관리자에게 요청"으로 안내한다.
    Portainer 화면에서 직접 하라고는 안내하지 않는다(그 화면에는 이 정책이 적용되지 않는다).
"""
import re

ADMIN = "꼭 필요하면 관리자에게 요청하세요."

# docker_proxy 요청 종류별 (조건, 이유, 대안). 위에서부터 처음 맞는 것을 쓴다.
PROXY_RULES = [
    (lambda m, p, r: "/exec" in p and "백업 컨테이너" in r and "대상이 아님" in r,
     "컨테이너 안에서 명령을 실행하면 안을 마음대로 바꾸거나 비밀값을 읽을 수 있어서, 백업 명령 하나만 예외로 열어 두었습니다.",
     "로그 보기나 상세 보기로 상태를 확인할 수 있습니다. 볼륨 백업이 필요하면 \"지금 백업해줘\"라고 하세요."),
    (lambda m, p, r: "컨테이너가 없습니다" in r,
     "이름이 틀렸거나, 이미 지워졌거나, 다른 환경에 있는 컨테이너일 수 있습니다.",
     "컨테이너 목록을 먼저 보고 정확한 이름을 확인하세요."),
    (lambda m, p, r: "대상 컨테이너를 확인하지 못했습니다" in r,
     "실행하기 전에 정확히 어떤 컨테이너인지 확인해야 하는데, 지금 확인할 수 없습니다.",
     "잠시 뒤 다시 시도하세요. 계속되면 관리자에게 알리세요."),
    (lambda m, p, r: "관리 도구 컨테이너" in r,
     "관리 도구(Portainer)가 멈추면 이 Agent를 포함한 전체 관리가 멈춥니다.",
     "다른 컨테이너는 그대로 관리할 수 있습니다."),
    (lambda m, p, r: m == "DELETE" and re.match(r"/(images|networks)/", p),
     "다른 컨테이너가 쓰고 있을 수 있고, 지우면 되돌릴 수 없습니다.",
     "필요 없는 컨테이너는 정지한 뒤 삭제할 수 있습니다. 이미지·네트워크 정리는 " + ADMIN),
    (lambda m, p, r: re.match(r"/volumes/", p) and m in ("DELETE", "POST") or p == "/volumes/create",
     "볼륨에는 앱의 데이터가 저장되어 있어, 지우면 영구히 사라지고 백업할 수도 없습니다.",
     "볼륨은 스택(Compose)을 만들 때 함께 만들어집니다. 삭제는 " + ADMIN),
    (lambda m, p, r: p == "/containers/create",
     "컨테이너를 직접 만들면 위험한 설정을 하나하나 막기 어렵습니다.",
     "스택(Compose)으로 만들 수 있습니다. 예: \"nginx로 웹 서버 만들어줘\"."),
    (lambda m, p, r: "/exec" in p and ("백업" in r or "backup" in r),
     "백업 명령 예외는 정해진 백업 컨테이너의 backup 명령 하나만, 정해진 방식으로만 허용합니다.",
     "\"지금 백업해줘\"라고 하면 정해진 방식으로 백업을 실행합니다."),
    (lambda m, p, r: "/exec" in p,
     "컨테이너 안에서 명령을 실행하면 안을 마음대로 바꾸거나 비밀값을 읽을 수 있습니다.",
     "로그 보기나 상세 보기로 상태를 확인할 수 있습니다. 볼륨 백업이 필요하면 \"지금 백업해줘\"라고 하세요. " + ADMIN),
    (lambda m, p, r: re.search(r"/(archive|export)$|/images/get|/images/[^/]+/get$", p),
     "컨테이너·이미지 안의 파일을 통째로 꺼내면 비밀값이 섞여 나갈 수 있습니다.",
     "로그나 상세 정보로 확인할 수 있습니다. 파일이 꼭 필요하면 관리자에게 요청하세요."),
    (lambda m, p, r: "/prune" in p,
     "한 번에 여러 개를 지워서 되돌릴 수 없습니다.",
     "필요 없는 컨테이너를 하나씩 정지한 뒤 삭제할 수 있습니다."),
    (lambda m, p, r: p.endswith("/kill"),
     "강제 종료는 프로그램이 데이터를 저장할 틈 없이 멈춥니다.",
     "정지(stop)를 쓰면 안전하게 멈춥니다."),
    (lambda m, p, r: m == "DELETE" and p.startswith("/containers/"),
     "실행 중인 컨테이너를 지우면 작업 중이던 데이터가 사라질 수 있습니다.",
     "먼저 정지하고, 정지된 것을 확인한 뒤 삭제하세요(각각 승인을 받습니다)."),
    (lambda m, p, r: p == "/images/create" and "출처" in r,
     "검토되지 않은 이미지에는 위험한 프로그램이 들어 있을 수 있습니다.",
     "같은 용도의 Docker Hub 공식 이미지를 쓰세요(예: nginx, mysql, redis, postgres)."),
    (lambda m, p, r: p == "/images/create",
     "파일이나 주소에서 이미지를 가져오면 출처를 확인할 수 없습니다.",
     "Docker Hub 공식 이미지를 이름으로 받을 수 있습니다(예: nginx, 태그 alpine)."),
    (lambda m, p, r: re.search(r"/(pause|unpause)$", p),  # 11/6 정책표 DENY
     "일시정지된 앱은 실행 중처럼 보이지만 응답하지 않아 헷갈리기 쉽고, 보안 정책에서 기본으로 막아 둔 작업입니다.",
     "멈추려면 정지(stop), 다시 쓰려면 시작(start)을 쓰세요(각각 승인)."),
    (lambda m, p, r: p == "/images/search",  # 11/6 정책표 DENY
     "외부 저장소 검색은 보안 정책에서 기본 관리 범위 밖으로 막아 둔 작업입니다.",
     "쓰려는 용도를 말해 주면 Docker Hub 공식 이미지(예: nginx, mysql, redis, postgres)로 추천하고, 받기 단계에서 이름을 확인합니다."),
    (lambda m, p, r: p.startswith("/networks"),
     "컨테이너의 네트워크를 바꾸면 서비스 통신이 끊기거나 경계가 바뀔 수 있어, 보안 정책에서 막아 둔 작업입니다.",
     "서로 통신해야 하는 서비스는 한 스택에 함께 넣으세요(스택 수정). 같은 스택 안의 서비스는 이름으로 바로 통신합니다. 네트워크 목록·상세 보기는 할 수 있습니다."),
    (lambda m, p, r: p.endswith("/logs"),
     "로그를 끝없이 받거나 너무 많이 받으면 응답이 멈추거나 비밀값이 많이 섞입니다.",
     "최근 로그를 tail 1~200줄 안에서 볼 수 있습니다(예: 최근 100줄)."),
    (lambda m, p, r: "경로" in r or "형식" in r or "문자" in r,
     "경로를 숨기거나 바꿔 쓰는 형식은 검사를 피하는 데 쓰일 수 있습니다.",
     "일반적인 경로로 다시 요청하세요."),
]
PROXY_DEFAULT = ("초보자 보호를 위해 정해진 작업만 허용합니다.",
                 "할 수 있는 일: 조회(목록·상세·로그·사용량), 컨테이너 시작·정지·재시작, 정지된 컨테이너 삭제, "
                 "공식 이미지 받기, 스택(Compose)으로 새 앱 만들기·고치기·켜기·끄기. 그 밖의 작업은 관리자에게 요청하세요.")

# 스택 검사 거부 이유(문구)에 들어 있는 말로 고른다.
STACK_RULES = [
    (r"조회에 실패|대상을 찾지 못했습니다",  # 11/6: 같은 이름·수정 대상 확인
     "실행하기 전에 정확히 어떤 스택인지, 같은 이름이 있는지 확인해야 하는데 지금 확인할 수 없습니다.",
     "스택 목록을 먼저 보고 정확한 스택을 확인하세요. 계속되면 관리자에게 알리세요."),
    (r"entrypoint\(|command '.*허용 목록|healthcheck test는",  # 11/9 정책표 5.7 231줄
     "시작 명령을 마음대로 바꾸면 컨테이너 안에서 아무 프로그램이나 실행할 수 있습니다(정책표 5.7: 미리 허용한 것만).",
     "command·entrypoint를 빼고 이미지 기본 설정으로 만드세요. 지금 허용된 옵션: redis 저장(--appendonly yes, --save 60 1)·"
     "메모리(--maxmemory 256mb, --maxmemory-policy), mysql·mariadb 문자 설정(--character-set-server=utf8mb4, --collation-server)·"
     "--max-connections. 상태 확인(healthcheck)은 redis [\"CMD\",\"redis-cli\",\"ping\"], "
     "mysql [\"CMD\",\"mysqladmin\",\"ping\",\"-h\",\"localhost\"]. 다른 옵션은 " + ADMIN),
    (r"비밀번호·토큰 값|주소 안에 비밀번호|비밀번호 없이 누구나|RANDOM_ROOT_PASSWORD",  # 11/9 정책표 5.7·238줄
     "Compose와 Env는 Portainer·대화 기록·승인 기록에 그대로 남아서, 비밀번호를 적으면 여러 곳에 퍼집니다(정책표 5.7).",
     "mysql·mariadb는 비밀번호를 적지 말고 MYSQL_RANDOM_ROOT_PASSWORD: \"yes\"(mariadb는 MARIADB_RANDOM_ROOT_PASSWORD)로 만들면 "
     "앱이 스스로 강한 비밀번호를 만듭니다(관리자가 로그에서 확인). postgres처럼 비밀번호가 꼭 필요한 앱은 " + ADMIN),
    (r"관리용 스택",
     "백업처럼 전체 관리에 쓰는 스택이 멈추거나 바뀌면 데이터 보호가 멈춥니다.",
     "다른 앱(스택)은 그대로 켜고 끄고 고칠 수 있습니다. 관리 스택 변경은 " + ADMIN),
    (r"가려져|가려진 값",
     "가려진 값([REDACTED])은 실제 값이 아니라서, 그대로 넣으면 비밀번호가 망가집니다.",
     "그 값은 새로 정해 직접 적으세요. 지금 스택에 원래 있던 environment 값은 [REDACTED] 그대로 두면 원래 값으로 되살아납니다."),
    (r"스택 수정의|StackFileContent\)가 필요",
     "스택 수정은 Compose 내용만 바꾸도록 정해져 있습니다(정책표 5.7). 이미지 강제 재배포·되돌리기·정리 옵션은 영향이 커서 쓰지 않습니다.",
     "StackFileInspect로 지금 Compose를 읽고, 바꾼 Compose 전체만 StackUpdate로 보내세요."),
    (r"privileged|cap_add|devices|security_opt|sysctls|'pid'|'ipc'|network_mode|userns|cgroup",
     "서버 전체를 건드릴 수 있는 권한이나 격리 해제 설정입니다.",
     "그 설정을 빼고 만들면 됩니다. 일반 웹·DB 앱에는 필요하지 않습니다."),
    (r"호스트 폴더|docker\.sock|호스트 경로|bind",
     "서버(호스트)의 파일이나 Docker 자체에 접근할 수 있게 됩니다.",
     "이름 있는 볼륨을 쓰세요. 예: volumes: [\"data:/data\"] 와 최상위 volumes: {data: {}}."),
    (r"'\$' 변수 치환",
     "검사한 뒤에 값이 바뀌어 위험한 값이 들어갈 수 있습니다.",
     "값을 직접 적으세요('$' 글자가 필요하면 '$$')."),
    (r"restart",
     "계속 실패하는 앱이 끝없이 다시 켜지면 서버에 부담이 됩니다.",
     "restart는 no, unless-stopped, on-failure:1~5 중에서 고르세요."),
    (r"호스트 포트",
     "1024 미만은 시스템용 포트이고, 9443·8000은 관리 도구(Portainer)가 씁니다.",
     "1024~65535 사이 포트를 쓰세요(예: \"8080:80\"). 호스트 포트를 빼면 Docker가 빈 번호를 고릅니다."),
    (r"상한",
     "한 앱이 서버 자원을 독차지하면 다른 앱이 느려지거나 멈춥니다.",
     "서비스당 메모리 2GB, CPU 2개 이하로 적으세요. 적지 않으면 메모리 512MB·CPU 1개가 기본으로 들어갑니다."),
    (r"출처",
     "검토되지 않은 이미지에는 위험한 프로그램이 들어 있을 수 있습니다.",
     "같은 용도의 Docker Hub 공식 이미지를 쓰세요(예: nginx, mysql, redis, postgres)."),
    (r"같은 이름|container_name",
     "같은 이름이 이미 있으면 기존 앱과 섞이거나 헷갈립니다(정책표 5.7 이름 충돌 거부).",
     "다른 이름으로 새로 만들거나, 기존 앱을 고치려면 그 스택을 수정(StackUpdate)하세요. 기존 앱을 켜기만 하려면 StackStart를 쓰면 됩니다."),
    (r"portainer",
     "관리 도구(Portainer)를 건드리면 전체 관리가 멈출 수 있습니다.",
     "이름에 portainer가 들어가지 않게 바꾸세요."),
    (r"이름|형식",
     "Compose와 Docker의 이름·값 규칙에 맞지 않습니다.",
     "스택 이름은 소문자·숫자·-·_만 쓰세요(예: my-web). 값은 예시 형식에 맞춰 적으세요."),
    (r"허용된 스택 도구가 아닙니다",
     "앱(스택) 삭제는 되돌리기 어려워 이 Agent에서는 하지 않습니다(정책표 StackDelete DENY).",
     "스택 목록 보기, 만들기, 수정, 켜기·끄기는 할 수 있습니다. 삭제는 " + ADMIN),
]
STACK_DEFAULT = ("초보자용으로 검사를 마친 설정만 허용합니다.",
                 "쓸 수 있는 설정: image, command(허용 목록만), environment, ports, expose, 이름 있는 volumes, restart, depends_on, "
                 "networks(bridge), labels, working_dir, user, hostname, container_name, healthcheck(허용 목록만), mem_limit, mem_reservation, "
                 "cpus, deploy.resources, stop_signal, stop_grace_period, tty, stdin_open, read_only, init.")


def fmt(prefix, what, why, alt):
    return f"{prefix} ① 막힌 것: {what} ② 이유: {why} ③ 대신 할 수 있는 것: {alt}"


def proxy_reason(prefix, what, method, path):
    m, p = (method or "GET").upper(), re.sub(r"^/v\d+(\.\d+)?", "", path or "")
    for cond, why, alt in PROXY_RULES:
        try:
            if cond(m, p, what):
                return fmt(prefix, what, why, alt)
        except Exception:  # noqa: BLE001 — 안내 고르기 실패는 기본 안내로
            break
    return fmt(prefix, what, *PROXY_DEFAULT)


def stack_reason(prefix, what):
    for pat, why, alt in STACK_RULES:
        if re.search(pat, what, re.I):
            return fmt(prefix, what, why, alt)
    return fmt(prefix, what, *STACK_DEFAULT)
