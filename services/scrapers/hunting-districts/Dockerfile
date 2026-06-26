FROM node:20-alpine

WORKDIR /app

# Copy workspace manifests for layer caching
COPY package.json ./
COPY packages/shared/package.json ./packages/shared/
COPY services/scrapers/package.json ./services/scrapers/

RUN npm install --workspace=packages/shared --workspace=services/scrapers

# Copy source after deps to preserve cache
COPY packages/shared/ ./packages/shared/
COPY services/scrapers/shared/ ./services/scrapers/shared/
COPY services/scrapers/hunting-districts/ ./services/scrapers/hunting-districts/

WORKDIR /app/services/scrapers

# Override root tsconfig module settings for Node.js CommonJS runtime
ENV TS_NODE_COMPILER_OPTIONS='{"module":"commonjs","moduleResolution":"node"}'

CMD ["npx", "ts-node", "--transpile-only", "hunting-districts/index.ts"]
