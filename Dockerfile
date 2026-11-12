FROM node:22-alpine

# Base tools matching sibling project containers
RUN apk add --no-cache python3 make g++ nano

# Ensure dev dependencies and file-watcher polling inside Docker volumes
ENV NODE_ENV=development
ENV CHOKIDAR_USEPOLLING=true
ENV ASTRO_TELEMETRY_DISABLED=1

WORKDIR /app

# Copy package manifests first for layer caching
COPY package.json ./
COPY package-lock.json ./

# Install all dependencies (including devDependencies)
RUN npm ci --include=dev

# Copy project source
COPY . .

EXPOSE 4321

CMD ["npm", "run", "dev", "--", "--host", "0.0.0.0", "--port", "4321"]
