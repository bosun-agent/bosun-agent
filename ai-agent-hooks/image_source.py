"""
이미지 출처 제한 공용 모듈 (11/1, 정책표 5.7 "허용된 이미지 출처만").
stack guard(스택 Compose의 image)와 policy guard(이미지 받기 POST /images/create)가 함께 쓴다.

허용 규칙: Docker Hub 공식 이미지만(11/1 시원 님 결정)
  슬래시 없는 이름(nginx, mysql:8, redis:7-alpine). docker.io/nginx, docker.io/library/nginx, library/nginx도 같은 것으로 본다.
  나머지(개인·회사 계정 이미지, 다른 레지스트리)는 거부한다.
"""

DOCKER_HUB_PREFIXES = ("docker.io/", "index.docker.io/", "registry-1.docker.io/")


def image_name(ref: str) -> str:
    """태그·digest를 뗀 소문자 이름. Docker Hub 접두어와 library/는 떼어 낸다."""
    name = ref.strip().split("@", 1)[0]
    slash = name.rfind("/")
    colon = name.rfind(":")
    if colon > slash:  # 마지막 '/' 뒤의 ':'만 태그(앞의 ':'는 레지스트리 포트)
        name = name[:colon]
    name = name.lower()
    for p in DOCKER_HUB_PREFIXES:
        if name.startswith(p):
            name = name[len(p):]
            break
    if name.startswith("library/"):
        name = name[len("library/"):]
    return name


def image_allowed(ref: str) -> bool:
    name = image_name(ref)
    return bool(name) and "/" not in name


def reject_text(ref: str) -> str:
    return (f"이미지 '{ref}'는 허용되지 않은 출처입니다. Docker Hub 공식 이미지(슬래시 없는 이름, 예: nginx, mysql, redis)만 쓸 수 있습니다. "
            "같은 용도의 공식 이미지를 사용자에게 제안하세요.")
