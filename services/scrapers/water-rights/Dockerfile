FROM node:20-alpine

WORKDIR /app

COPY package.json ./
COPY packages/shared/package.json ./packages/shared/
COPY services/scrapers/package.json ./services/scrapers/

RUN npm install --workspace=packages/shared --workspace=services/scrapers

COPY packages/shared/ ./packages/shared/
COPY services/scrapers/shared/ ./services/scrapers/shared/
COPY services/scrapers/water-rights/ ./services/scrapers/water-rights/

WORKDIR /app/services/scrapers

ENV TS_NODE_COMPILER_OPTIONS='{"module":"commonjs","moduleResolution":"node"}'

CMD ["npx", "ts-node", "--transpile-only", "water-rights/index.ts"]
