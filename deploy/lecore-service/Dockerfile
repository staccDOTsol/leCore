# leCore HTTP service as a Fly app: /tools, /invoke, /door, /doors — the
# "lecore-front" the x402-tokens gateway talks to (LECORE_FRONT_URL).
#
#   fly launch --config fly.lecore-service.toml --dockerfile deploy/lecore-service/Dockerfile --no-deploy
#   fly volumes create lecore_data --size 3 -a lecore-service
#   fly secrets set LECORE_TOKEN=sk-lecore-<random> -a lecore-service
#   fly deploy --config fly.lecore-service.toml --dockerfile deploy/lecore-service/Dockerfile
#   fly secrets set LECORE_FRONT_URL=https://lecore-service.fly.dev LECORE_FRONT_KEY=sk-lecore-<same> -a x402-tokens
FROM python:3.12-slim
WORKDIR /app
ENV PYTHONUNBUFFERED=1 PYTHONHASHSEED=0 PIP_NO_CACHE_DIR=1
COPY requirements.txt ./
RUN pip install --no-cache-dir numpy flask pillow
COPY . .
# The MCP doors keep their partitions (tenants, ouroboros memory, tool memo)
# under LECORE_MEMORY_ROOT; the store behind /sql|/graphql persists to --persist.
ENV LECORE_MEMORY_ROOT=/data/lecore_memory PORT=8080
EXPOSE 8080
CMD ["sh", "-c", "mkdir -p /data/lecore_memory && exec python3 holographic_service.py --host 0.0.0.0 --port ${PORT} ${LECORE_TOKEN:+--token $LECORE_TOKEN} --persist /data/store.json"]
