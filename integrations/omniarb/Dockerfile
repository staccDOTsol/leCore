# The desk as a long-lived process: the shape to run when you want the launch,
# bridge and trade endpoints, because those are jobs that outlive a request.
FROM node:22-slim

WORKDIR /app
COPY package.json package-lock.json ./
# viem is the only runtime dependency the server actually loads; playwright and
# sharp are for the launcher's own tooling and would pull a browser into the image.
RUN npm ci --omit=dev --ignore-scripts && npm prune --omit=dev

COPY src ./src
COPY site ./site
COPY build ./build
COPY live-config.json deployments.json ./

ENV PORT=8080 HOST=0.0.0.0
EXPOSE 8080
CMD ["node", "site/server.mjs"]
