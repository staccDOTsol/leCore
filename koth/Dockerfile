# King of the Hill bot: Telegram first. One container = the openzoo proxy (inference) + the bots + the /metadata server.
FROM node:22-slim
WORKDIR /app/koth
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci --omit=dev && npm i -g tsx@4 openzoo
COPY src ./src
COPY scripts ./scripts
COPY genesis ./genesis
COPY start.sh ./start.sh
ENV NODE_ENV=production KOTH_DATA_DIR=/data KOTH_PORT=8787 OPENZOO_NO_TUNNEL=1
VOLUME ["/data"]
EXPOSE 8787
CMD ["sh", "./start.sh"]
