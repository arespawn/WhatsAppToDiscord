# syntax=docker/dockerfile:1

FROM node:24-bookworm-slim AS deps
WORKDIR /usr/local/WA2DC
RUN apt-get update \
	&& apt-get install -y --no-install-recommends \
		g++ \
		libcairo2-dev \
		libgif-dev \
		libjpeg62-turbo-dev \
		libpango1.0-dev \
		librsvg2-dev \
		make \
		pkg-config \
		python3 \
	&& rm -rf /var/lib/apt/lists/* \
	&& mkdir -p /usr/local/WA2DC \
	&& chown node:node /usr/local/WA2DC

COPY --chown=node:node package*.json ./
COPY --chown=node:node scripts/patchBaileysAndroidBrowser.js ./scripts/patchBaileysAndroidBrowser.js
USER node
RUN npm ci --omit=dev

FROM node:24-bookworm-slim
WORKDIR /usr/local/WA2DC
RUN apt-get update \
	&& apt-get install -y --no-install-recommends \
		gosu \
		libcairo2 \
		libgif7 \
		libjpeg62-turbo \
		libpango-1.0-0 \
		libpixman-1-0 \
		librsvg2-2 \
	&& rm -rf /var/lib/apt/lists/* \
	&& chown node:node /usr/local/WA2DC

COPY --from=deps --chown=node:node /usr/local/WA2DC/node_modules ./node_modules
COPY --chown=node:node package*.json ./
COPY --chown=node:node . .
RUN chmod +x /usr/local/WA2DC/scripts/docker-entrypoint.sh

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "const fs=require('fs'); const cmdline=fs.readFileSync('/proc/1/cmdline','utf8'); process.exit(cmdline.includes('src/index.js') ? 0 : 1)"

ENTRYPOINT ["scripts/docker-entrypoint.sh"]
