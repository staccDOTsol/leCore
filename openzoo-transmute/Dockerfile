# The hosted explorer (openzoo-transmute hub): every transmuted site on a
# cluster from one public host, read-only. See lib/hub.js.
#
#   fly launch --no-deploy            (app name in fly.toml)
#   fly deploy --remote-only
FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY bin ./bin
COPY lib ./lib
ENV PORT=8080 OPENZOO_CLUSTER=mainnet
EXPOSE 8080
CMD ["node", "bin/openzoo-transmute.js", "hub", "--host", "0.0.0.0"]
