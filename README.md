# Umbrella VPN

A community Umbrel app that routes all traffic on your Umbrel Home through a WireGuard VPN.

## Install

1. Open your Umbrel dashboard
1. Go to **App Store → Community App Stores** (in the top right)
1. Paste this repo URL: `https://github.com/stijnvdkolk/UmbrelVPN`
1. Find **Umbrella VPN** in the store and install it

## Setup

1. Open the Umbrella VPN app on your Umbrel dashboard
1. Paste your WireGuard config and click **Save Configuration**
1. Click **Connect**

Enable **Auto-connect** to reconnect automatically when Umbrel restarts.

## Features

- Routes all Umbrel traffic through WireGuard
- Preserves local network access (dashboard, SSH)
- Kill switch — blocks internet if VPN drops
- Auto-connect on boot
- Status dashboard with public IP, transfer stats

## Development

```bash
# Build the Docker image locally
docker build -t umbrella-vpn .

# Run it (requires --cap-add and --device for WireGuard)
docker run --rm -it \
  --cap-add NET_ADMIN \
  --cap-add NET_RAW \
  --device /dev/net/tun \
  --network host \
  -v $(pwd)/data:/data \
  -e PORT=3080 \
  -e DATA_DIR=/data \
  umbrella-vpn
```

## Works with

Any WireGuard VPN provider — ProtonVPN, Mullvad, NordVPN, IVPN, Windscribe, or your own server. Just paste the WireGuard `.conf` file.
