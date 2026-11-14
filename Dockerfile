FROM node:24-bookworm-slim

# Minimal base + curl for container healthchecks (Debian glibc matches host Node 24)
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl \
  && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=development
ENV CHOKIDAR_USEPOLLING=true
ENV ASTRO_TELEMETRY_DISABLED=1

WORKDIR /app

COPY package.json ./
COPY package-lock.json ./

RUN npm ci --include=dev

COPY . .

EXPOSE 4321

CMD ["npm", "run", "dev", "--", "--host", "0.0.0.0", "--port", "4321"]
