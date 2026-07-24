# syntax=docker/dockerfile:1

# ---- builder: install locked dependencies and compile TypeScript ----
FROM node:24-slim AS builder

WORKDIR /app

# Dependencies first, cached independently of source changes.
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# Re-install without dev dependencies for the runtime layer.
RUN npm ci --omit=dev

# ---- runtime: minimal, non-root ----
FROM node:24-slim AS runtime

# Semgrep is distributed as a Python package, so it is installed into its own virtualenv and only
# its CLI is exposed on PATH — keeping it entirely separate from the application's dependencies.
# Disable it with BICHO_SCANNER__SEMGREP_ENABLED=false to run without this layer's cost.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 python3-venv ca-certificates \
    && python3 -m venv /opt/semgrep \
    && /opt/semgrep/bin/pip install --no-cache-dir "semgrep==1.170.1" \
    && ln -s /opt/semgrep/bin/semgrep /usr/local/bin/semgrep \
    && rm -rf /var/lib/apt/lists/*

# A writable home so tools that cache under $HOME (Semgrep writes ~/.semgrep) work as non-root.
RUN groupadd --system bicho \
    && useradd --system --gid bicho --create-home --home-dir /home/bicho bicho

WORKDIR /app
COPY --from=builder --chown=bicho:bicho /app/node_modules ./node_modules
COPY --from=builder --chown=bicho:bicho /app/dist ./dist
COPY --chown=bicho:bicho package.json ./
COPY --chown=bicho:bicho resources ./resources

ENV NODE_ENV=production \
    HOME=/home/bicho \
    BICHO_ENVIRONMENT=production \
    PORT=8000

USER bicho
EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/main.js"]
