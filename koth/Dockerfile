# King of the Hill bot: Telegram first. One container = the bots + the /metadata static server.
FROM node:22-slim
WORKDIR /app/koth
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci --omit=dev && npm i -g tsx@4
COPY src ./src
COPY scripts ./scripts
COPY genesis ./genesis
ENV NODE_ENV=production KOTH_DATA_DIR=/data KOTH_PORT=8787
VOLUME ["/data"]
EXPOSE 8787
CMD ["tsx", "src/bot.ts"]
