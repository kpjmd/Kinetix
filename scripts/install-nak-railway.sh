#!/bin/bash

# NAK binary installer for Railway/cloud environments (no Go required)
# Downloads pre-built nak binary from GitHub releases

set -e

NAK_VERSION="v0.18.4"
INSTALL_DIR="${NAK_INSTALL_DIR:-/app/bin}"
NAK_BIN="$INSTALL_DIR/nak"

echo "[NAK] Installing nak $NAK_VERSION to $NAK_BIN"

mkdir -p "$INSTALL_DIR"

# Detect OS and architecture
OS=$(uname -s | tr '[:upper:]' '[:lower:]')
ARCH=$(uname -m)

case "$ARCH" in
  x86_64) ARCH="amd64" ;;
  aarch64|arm64) ARCH="arm64" ;;
  *) echo "[NAK] Unsupported architecture: $ARCH"; exit 1 ;;
esac

DOWNLOAD_URL="https://github.com/fiatjaf/nak/releases/download/${NAK_VERSION}/nak-${NAK_VERSION}-${OS}-${ARCH}"
echo "[NAK] Downloading from $DOWNLOAD_URL"

if curl -fsSL "$DOWNLOAD_URL" -o "$NAK_BIN"; then
  chmod +x "$NAK_BIN"
  echo "[NAK] Installed successfully: $NAK_BIN"
  "$NAK_BIN" --version 2>&1 || true
else
  echo "[NAK] Download failed — Clawstr posting will be unavailable"
  exit 1
fi
