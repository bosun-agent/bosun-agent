# BOSUN 올인원 이미지: 화면(정적) + WEB 백엔드 + Docker Agent + 정책 훅을 한 컨테이너로 띄운다.
#
#   (저장소 루트에서)  docker compose up -d --build
#   화면: http://127.0.0.1:3001   Portainer: https://127.0.0.1:9443
#
# 웹·Agent는 도커 소켓을 쓰지 않는다. 도커 조작은 전부 Portainer를 거친다(정책 설계).
# 그래서 이 이미지에는 소켓 마운트가 필요 없고, 소켓을 가진 컨테이너는 portainer 하나뿐이다.

FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build:web

# soteria "지금 백업" MCP(mcp-soteria). 팀원 저장소에서 리눅스용으로 빌드한다(CGO 없이, 이 이미지 아키텍처 그대로).
# 11/15 기준 fix/gate-request-hardening 브랜치(요청 검사 강화). main에 합쳐지면 SOTERIA_REF=main.
# 같은 브랜치의 새 커밋을 받으려면 docker compose build --no-cache bosun (git clone 층이 캐시된다).
FROM golang:1.27-alpine AS soteria
ARG SOTERIA_REF=fix/gate-request-hardening
RUN apk add --no-cache git \
 && git clone --depth 1 -b "$SOTERIA_REF" https://github.com/bosun-agent/soteria.git /src
WORKDIR /src
RUN CGO_ENABLED=0 go build -o /out/mcp-soteria ./cmd/mcp

FROM node:22-bookworm-slim

# 팀 고정 버전(README-agent.md / portainer-compose.yaml과 맞춘다)
ARG DOCKER_AGENT_VERSION=1.148.0
ARG MCP_PORTAINER_VERSION=2.45.1

ENV DEBIAN_FRONTEND=noninteractive
# python3 + PyYAML: 정책·백업·스택 검사 훅이 쓴다(없으면 on_error: block 훅이 조회까지 막는다).
# ca-certificates: 모델 API·Portainer(HTTPS) 호출.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl python3 python3-yaml python3-pip \
 && rm -rf /var/lib/apt/lists/*

# docker-agent는 공식 컨테이너 이미지가 없어 릴리스 바이너리를 넣는다(Apache-2.0).
RUN ARCH="$(dpkg --print-architecture)" \
 && curl -fsSL -o /usr/local/bin/docker-agent \
      "https://github.com/docker/docker-agent/releases/download/v${DOCKER_AGENT_VERSION}/docker-agent-linux-${ARCH}" \
 && chmod +x /usr/local/bin/docker-agent \
 && docker-agent version

# mcp-portainer는 런타임 uvx 대신 이미지에 고정 설치한다(네트워크·캐시 의존 제거).
# 진입점이 agent.yaml의 `command: uvx …`를 `command: mcp-portainer`로 바꾼다.
RUN pip3 install --no-cache-dir --break-system-packages "mcp-portainer==${MCP_PORTAINER_VERSION}" \
 && command -v mcp-portainer >/dev/null

WORKDIR /app

# 컨테이너 안에서만 0.0.0.0으로 연다. 밖으로는 compose가 127.0.0.1로만 발행한다(로그인 없음).
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    HOST_IN_CONTAINER=1 \
    PORT=3001 \
    STATIC_DIR=/app/dist \
    WEB_DB_PATH=/data/web.db \
    BOSUN_HOME=/opt/bosun

# container/.env 없이도 뜨게 하는 기본값(이 PC에 띄운 Portainer, Docker Desktop 기준). container/.env에 적으면 그 값이 이긴다.
ENV PORTAINER_URL=https://localhost:9443 \
    PORTAINER_URL_INTERNAL=https://host.docker.internal:9443 \
    AGENT_MODELS=openrouter/deepseek/deepseek-v4.1-flash

# soteria 백업 창구(관리 스택 bosun-soteria). 컨테이너 안의 127.0.0.1은 이 컨테이너 자신이라
# 창구를 bosun 스택 네트워크(compose 이름 bosun → bosun_default)에 붙이고 이름으로 부른다(README-agent.md 6-2).
# 진입점이 이 두 값을 agent.env와 agent.yaml(mcp-soteria의 SOTERIA_API)에 맞춘다.
ENV SOTERIA_API=http://bosun-soteria:8080 \
    SOTERIA_NETWORK=bosun_default

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY server ./server
COPY src/lib/agentProtocol.ts src/lib/sse.ts ./src/lib/
COPY ai-agent-hooks ./ai-agent-hooks
COPY agents ./agents
COPY container/entrypoint.sh /usr/local/bin/bosun-entrypoint
COPY --from=build /app/dist ./dist
# agent.yaml의 `command: /절대경로/../tools/bin/mcp-soteria`가 /app/ai-agent-hooks/../tools/bin/mcp-soteria로 치환된다
COPY --from=soteria /out/mcp-soteria ./tools/bin/mcp-soteria

# 개발용 값(가짜 Agent)은 이미지에 넣지 않는다.
# Windows에서 받은 저장소는 줄 끝이 CRLF일 수 있다 → 진입점의 \r을 지운다(안 지우면 'bash\r'을 찾다 죽는다).
RUN rm -rf server/dev \
 && sed -i 's/\r$//' /usr/local/bin/bosun-entrypoint \
 && chmod +x /usr/local/bin/bosun-entrypoint \
 && mkdir -p /data "$BOSUN_HOME" \
 && chown -R node:node /data "$BOSUN_HOME" /app

USER node
VOLUME ["/data", "/opt/bosun"]
EXPOSE 3001
ENTRYPOINT ["/usr/local/bin/bosun-entrypoint"]
