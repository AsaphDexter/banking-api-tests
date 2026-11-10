# Runs the Playwright API tests (no browser is needed for API testing).
FROM node:22-slim
WORKDIR /work
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json playwright.config.ts ./
COPY tests ./tests
COPY perf ./perf
CMD ["npx", "playwright", "test"]
