# Builds one scraper into a single bundled file and runs it with Node.
# Build from the repository root:
#   docker build -f services/scrapers/Dockerfile --build-arg SCRAPER=cadastral -t landfinder-scrapers:cadastral-latest .
ARG SCRAPER

FROM node:20-alpine AS build
ARG SCRAPER
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared/package.json ./packages/shared/
COPY services/scrapers/package.json ./services/scrapers/
RUN npm ci --workspace=packages/shared --workspace=services/scrapers
COPY packages/shared/ ./packages/shared/
COPY services/scrapers/ ./services/scrapers/
RUN npx esbuild services/scrapers/${SCRAPER}/index.ts \
      --bundle --platform=node --target=node20 --format=cjs \
      --external:pg-native --outfile=/out/scraper.js

FROM node:20-alpine
WORKDIR /app
COPY --from=build /out/scraper.js ./scraper.js
COPY services/scrapers/certs/ ./certs/
USER node
CMD ["node", "scraper.js"]
