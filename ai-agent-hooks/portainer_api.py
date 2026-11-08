"""
Portainer REST 조회 공용 모듈 (11/1). 정책 훅(컨테이너를 ID로 고정)과 승인 카드 설명 훅(ID → 이름)이 함께 쓴다.

주소·키는 환경변수 PORTAINER_URL·PORTAINER_API_KEY, 없으면 훅 env의 AGENT_ENV_FILE(agent.env 경로)에서 읽는다.
훅은 --env-from-file 값을 받지 못하므로(백업 훅 설명 참고) yaml의 훅 env에 AGENT_ENV_FILE을 적어 준다.
"""
import json
import os
import ssl
import urllib.error
import urllib.parse
import urllib.request


class PortainerError(Exception):
    def __init__(self, msg, status=None):
        super().__init__(msg)
        self.status = status


def _read_env_file(path):
    values = {}
    if not path:
        return values
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            key = key.strip()
            if key.startswith("export "):
                key = key[len("export "):].strip()
            values[key] = value.strip().strip('"').strip("'")
    return values


def get(path, timeout=5):
    """Portainer REST GET 결과(JSON). 실패하면 PortainerError(404면 status=404)."""
    try:
        file_values = _read_env_file(os.environ.get("AGENT_ENV_FILE", ""))
    except OSError as e:
        raise PortainerError(f"AGENT_ENV_FILE을 읽지 못했습니다: {e}") from None
    base_url = os.environ.get("PORTAINER_URL") or file_values.get("PORTAINER_URL")
    api_key = os.environ.get("PORTAINER_API_KEY") or file_values.get("PORTAINER_API_KEY")
    if not base_url or not api_key:
        raise PortainerError("PORTAINER_URL 또는 PORTAINER_API_KEY를 찾지 못했습니다(AGENT_ENV_FILE 확인).")
    verify = str(os.environ.get("PORTAINER_TLS_VERIFY") or file_values.get("PORTAINER_TLS_VERIFY") or "1").strip().lower() \
        not in {"0", "false", "no", "off"}
    ctx = ssl.create_default_context()
    if not verify:
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
    req = urllib.request.Request(base_url.rstrip("/") + path, headers={"X-API-Key": api_key}, method="GET")
    try:
        with urllib.request.urlopen(req, timeout=timeout, context=ctx) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        raise PortainerError(f"Portainer 조회 실패(HTTP {e.code})", e.code) from None
    except (urllib.error.URLError, OSError, ValueError) as e:
        raise PortainerError(f"Portainer에 연결하지 못했습니다: {getattr(e, 'reason', e)}") from None


def post_raw(path, body, timeout=5):
    """Portainer REST POST. 응답 본문(bytes)을 그대로 돌려준다. 실패하면 PortainerError."""
    try:
        file_values = _read_env_file(os.environ.get("AGENT_ENV_FILE", ""))
    except OSError as e:
        raise PortainerError(f"AGENT_ENV_FILE을 읽지 못했습니다: {e}") from None
    base_url = os.environ.get("PORTAINER_URL") or file_values.get("PORTAINER_URL")
    api_key = os.environ.get("PORTAINER_API_KEY") or file_values.get("PORTAINER_API_KEY")
    if not base_url or not api_key:
        raise PortainerError("PORTAINER_URL 또는 PORTAINER_API_KEY를 찾지 못했습니다(AGENT_ENV_FILE 확인).")
    verify = str(os.environ.get("PORTAINER_TLS_VERIFY") or file_values.get("PORTAINER_TLS_VERIFY") or "1").strip().lower() \
        not in {"0", "false", "no", "off"}
    ctx = ssl.create_default_context()
    if not verify:
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
    req = urllib.request.Request(base_url.rstrip("/") + path, data=json.dumps(body).encode(), method="POST",
                                 headers={"X-API-Key": api_key, "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout, context=ctx) as resp:
            return resp.read()
    except urllib.error.HTTPError as e:
        raise PortainerError(f"Portainer 요청 실패(HTTP {e.code})", e.code) from None
    except (urllib.error.URLError, OSError) as e:
        raise PortainerError(f"Portainer에 연결하지 못했습니다: {getattr(e, 'reason', e)}") from None


def container(environment_id, ref, timeout=5):
    """이름이나 ID로 컨테이너를 찾아 (전체 ID, 이름)을 돌려준다. Docker가 실제로 고르는 대상과 같다."""
    c = get(f"/api/endpoints/{environment_id}/docker/containers/{urllib.parse.quote(str(ref), safe='')}/json", timeout)
    return c["Id"], str(c.get("Name", "")).lstrip("/")


def stack_name(stack_id, timeout=5):
    return str(get(f"/api/stacks/{int(stack_id)}", timeout).get("Name", ""))
