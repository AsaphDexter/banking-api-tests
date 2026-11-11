# Runs the Playwright API tests (no browser is needed for API testing).
FROM node:22-slim
WORKDIR /work
# install dependencies first, so this step is cached until package files change
COPY package.json package-lock.json ./
RUN npm ci
# then everything else (.dockerignore keeps node_modules, reports and git files out)
COPY . .
CMD ["npx", "playwright", "test"]
