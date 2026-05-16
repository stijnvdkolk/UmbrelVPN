FROM node:24-alpine

RUN apk add --no-cache \
    wireguard-tools \
    iptables \
    ip6tables \
    curl \
    openresolv \
    bash

WORKDIR /app

COPY server/package.json server/package-lock.json* ./
RUN npm ci --omit=dev

COPY server/ ./
COPY web/ ./web/
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 3080

ENTRYPOINT ["/entrypoint.sh"]
