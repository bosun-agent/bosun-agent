"""단독 테스트용 가짜 Portainer (11/1).
import하면 127.0.0.1의 빈 포트에 뜨고, 이 프로세스와 테스트가 실행하는 훅이 이 서버를 쓰도록 환경변수를 바꾼다.
  - 컨테이너 조회: 이름 'missing…'은 404, 'portainer'는 관리 도구 컨테이너, 나머지는 이름에서 만든 가짜 전체 ID
  - 스택 조회: STACKS에 있는 것만(id 4 'myweb', id 5 'bosun-backup', id 6 swarm 스택), 그 밖은 404. 목록·파일 조회도 STACKS 기준(11/6)
  - 컨테이너 목록: CONTAINERS(이름 목록). filters의 compose 프로젝트 라벨은 PROJECTS로 거른다(11/6)
  - exec 조회: EXECS에 넣은 것만, 그 밖은 404. exec 시작(POST)은 _log를 Docker 로그 형식으로 돌려주고 끝난 상태로 바꾼다
"""
import hashlib
import json
import os
import re
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import parse_qs, unquote, urlsplit

KEY = "fake-test-key"


NAMES = {"": ""}  # 가짜 전체 ID → 이름
EXECS = {}  # 가짜 exec ID → exec 정보(11/2 백업 명령 예외 테스트용). 테스트가 직접 채운다
# 11/6 스택 수정·같은 이름 테스트용. 테스트가 바꿔 쓸 수 있다
STACKS = {
    4: {"Id": 4, "Name": "myweb", "EndpointId": 3, "Type": 2,
        "_file": "services:\n  web:\n    image: nginx:alpine\n  db:\n    image: mysql:8\n    environment:\n"
                 "      MYSQL_ROOT_PASSWORD: Old-Secret-1106\n      MYSQL_DATABASE: app\n"},
    5: {"Id": 5, "Name": "bosun-backup", "EndpointId": 3, "Type": 2, "_file": "services:\n  backup:\n    image: offen/docker-volume-backup:v2.50.1\n"},
    6: {"Id": 6, "Name": "swarmapp", "EndpointId": 3, "Type": 1, "_file": ""},
}
CONTAINERS = ["agent-test", "web-old"]   # 컨테이너 이름 목록
# 11/9 데이터 볼륨 규칙 테스트용: 스택(프로젝트) → 컨테이너가 쓰는 볼륨 이름 목록
STACK_MOUNTS = {}
PROJECTS = {"outside-app"}               # Portainer 밖에서 만든 Compose 프로젝트 이름


def fake_id(name):
    i = hashlib.sha256(name.encode()).hexdigest()
    NAMES[i] = name
    return i


class _H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _send(self, code, body=None):
        data = json.dumps(body).encode() if body is not None else b""
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.headers.get("X-API-Key") != KEY:
            return self._send(401, {"message": "bad key"})
        path = urlsplit(self.path).path
        m = re.fullmatch(r"/api/endpoints/\d+/docker/containers/([^/]+)/json", path)
        if m:
            ref = unquote(m.group(1))
            if ref.startswith("missing"):
                return self._send(404, {"message": "No such container"})
            if re.fullmatch(r"[0-9a-f]{64}", ref):
                if ref not in NAMES:
                    return self._send(404, {"message": "No such container"})
                return self._send(200, {"Id": ref, "Name": "/" + NAMES[ref]})
            return self._send(200, {"Id": fake_id(ref), "Name": "/" + ref})
        m = re.fullmatch(r"/api/endpoints/\d+/docker/exec/([0-9a-f]{64})/json", path)
        if m:
            return self._send(200, EXECS[m.group(1)]) if m.group(1) in EXECS else self._send(404, {"message": "No such exec instance"})
        m = re.fullmatch(r"/api/stacks/(\d+)(/file)?", path)
        if m:
            st = STACKS.get(int(m.group(1)))
            if not st:
                return self._send(404, {"message": "not found"})
            if m.group(2):
                return self._send(200, {"StackFileContent": st["_file"]})
            return self._send(200, {k: v for k, v in st.items() if not k.startswith("_")})
        if path == "/api/endpoints":  # 11/7 이어서 하기 요약용
            return self._send(200, [{"Id": 3, "Name": "local", "Type": 1}])
        if path == "/api/stacks":
            return self._send(200, [{k: v for k, v in st.items() if not k.startswith("_")} for st in STACKS.values()])
        if re.fullmatch(r"/api/endpoints/\d+/docker/containers/json", path):
            q = parse_qs(urlsplit(self.path).query)
            if "filters" in q:
                flt = json.loads(q["filters"][0])
                label = flt.get("label", [""])[0]
                if label.split("=", 1)[-1] in STACK_MOUNTS:
                    proj = label.split("=", 1)[1]
                    return self._send(200, [{"Id": fake_id(proj + "-1"), "Names": ["/" + proj + "-1"],
                                             "Mounts": [{"Type": "volume", "Name": v} for v in STACK_MOUNTS[proj]]}])
                proj = label.split("=", 1)[1] if "=" in label else ""
                return self._send(200, [{"Id": fake_id(proj + "-1"), "Names": ["/" + proj + "-1"]}] if proj in PROJECTS else [])
            return self._send(200, [{"Id": fake_id(n), "Names": ["/" + n]} for n in CONTAINERS])
        return self._send(404, {"message": "unknown"})


    def do_POST(self):
        if self.headers.get("X-API-Key") != KEY:
            return self._send(401, {"message": "bad key"})
        self.rfile.read(int(self.headers.get("Content-Length") or 0))
        m = re.fullmatch(r"/api/endpoints/\d+/docker/exec/([0-9a-f]{64})/start", urlsplit(self.path).path)
        if not m or m.group(1) not in EXECS:
            return self._send(404, {"message": "No such exec instance"})
        info = EXECS[m.group(1)]
        info.update({"Pid": 4321, "ExitCode": info.get("_exit", 0), "Running": False})  # 실행 끝난 상태로 바꾼다
        line = info.get("_log", "backup finished").encode()
        data = b"\x01\x00\x00\x00" + len(line).to_bytes(4, "big") + line
        self.send_response(200)
        self.send_header("Content-Type", "application/vnd.docker.raw-stream")
        self.end_headers()
        self.wfile.write(data)


_srv = HTTPServer(("127.0.0.1", 0), _H)
threading.Thread(target=_srv.serve_forever, daemon=True).start()
os.environ["PORTAINER_URL"] = f"http://127.0.0.1:{_srv.server_port}"
os.environ["PORTAINER_API_KEY"] = KEY
os.environ.pop("AGENT_ENV_FILE", None)
