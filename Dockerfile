# BOSUN WEB 이미지: 빌드한 화면(dist)과 WEB 백엔드(server/)를 한 컨테이너로 띄운다.
# Node가 TypeScript 타입만 지우고 바로 실행하므로 백엔드는 빌드하지 않는다(Node 22.18+).
#
#   docker build -t bosun-web .
#   docker run --env-file web.env -p 127.0.0.1:3001:3001 -v bosun_web_data:/data bosun-web
#
# web.env에 넣을 값은 README의 "실제 Docker Agent에 붙일 때"와 같다. ADMIN_PASSWORD_HASH와 JWT_SECRET이 없으면 뜨지 않는다.
# AGENT_URL은 컨테이너 밖 Docker Agent 주소다(같은 compose면 서비스 이름, 예: http://agent:8080).

FROM node:22.19-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build:web

FROM node:22.19-alpine
WORKDIR /app
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3001 \
    STATIC_DIR=/app/dist \
    WEB_DB_PATH=/data/web.db
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server ./server
COPY src/lib/agentProtocol.ts src/lib/sse.ts ./src/lib/
COPY --from=build /app/dist ./dist
# 개발용 값(가짜 Agent, 개발 계정)은 이미지에 넣지 않는다.
RUN rm -rf server/dev && mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 3001
CMD ["node", "server/main.ts"]
