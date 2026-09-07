# The desk as a long-lived process. It holds no key: the visitor's wallet signs
# every transaction, so this image is safe to run anywhere it can reach the RPCs.
FROM node:22-slim

WORKDIR /app

# viem is the only thing the site server imports. package.json also lists
# playwright and sharp for the launcher's own tooling — installing those here
# would drag a browser into the image for code this process never loads.
RUN npm install --omit=dev --ignore-scripts --no-package-lock --no-fund --no-audit viem@2.56.3

COPY src ./src
COPY site ./site
COPY build ./build
COPY live-config.json deployments.json package.json ./

ENV PORT=8080 HOST=0.0.0.0 NODE_ENV=production
EXPOSE 8080
CMD ["node", "site/server.mjs"]
