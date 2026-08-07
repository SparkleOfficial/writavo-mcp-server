# syntax=docker/dockerfile:1
#
#   docker build -t writavo-mcp-server .
#
# This repository is self-contained: it vendors openapi.yaml and the three generator scripts, so
# the build context is this directory and nothing else. The tool surface is COMPILED from the
# specification rather than hand written, and the build re-runs that compilation with --check, so
# an image can never be produced from a checkout whose committed surface has drifted from the
# spec it claims to implement.

# -- Stage 1: install and compile ------------------------------------------------------------
FROM node:22-alpine AS builder
WORKDIR /app

COPY package.json ./
RUN npm install --no-package-lock

COPY openapi.yaml tsconfig.json ./
COPY scripts ./scripts
COPY src ./src

# Regenerate and fail if the committed surface is not what the specification produces.
RUN node scripts/gen-mcp-tools.mjs --check
RUN npx tsc

# -- Stage 2: runtime ------------------------------------------------------------------------
FROM node:22-alpine
LABEL io.modelcontextprotocol.server.name="com.writavo/cms"
WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev --no-package-lock && npm cache clean --force

COPY --from=builder /app/dist ./dist
COPY README.md LICENSE ./

USER node
ENTRYPOINT ["node", "dist/index.js"]
