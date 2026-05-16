#!/bin/bash
set -e

DATA_DIR="${DATA_DIR:-/data}"
mkdir -p "$DATA_DIR"
mkdir -p /etc/wireguard

cleanup() {
    echo "Shutting down — tearing down WireGuard..."
    wg-quick down wg0 2>/dev/null || true
    exit 0
}
trap cleanup SIGTERM SIGINT

exec node index.js
