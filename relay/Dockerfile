FROM node:24-bookworm-slim

# Debian glibc image required by Cloudflare's `workerd` runtime (`wrangler dev --local`)
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl \
  && rm -rf /var/lib/apt/lists/*

# Install Wrangler in an isolated prefix so the Astro repo's package-lock.json stays lean
WORKDIR /opt/wrangler
RUN npm init -y >/dev/null 2>&1 \
  && npm install --no-audit --no-fund wrangler@4

ENV PATH="/opt/wrangler/node_modules/.bin:${PATH}"
ENV WRANGLER_SEND_METRICS=false

WORKDIR /app/relay

COPY relay/ ./

EXPOSE 4323

CMD ["wrangler", "dev", "--local", "--env", "staging", "--persist-to", "/tmp/wrangler-state", "--ip", "0.0.0.0", "--port", "4323"]
