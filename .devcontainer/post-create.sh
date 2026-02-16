#!/bin/bash
set -e

# Install jq for JSON parsing
sudo apt-get update
sudo apt-get install -y jq

echo "Installing ralphex..."

# Fetch latest version from GitHub
RALPHEX_VERSION=$(curl -fsSL https://api.github.com/repos/umputun/ralphex/releases/latest | jq -r '.tag_name' | sed 's/^v//')
echo "Latest ralphex version: $RALPHEX_VERSION"

# Ensure /usr/local/bin exists
mkdir -p /usr/local/bin

# Detect architecture and install appropriate ralphex package
ARCH=$(uname -m)
case $ARCH in
  aarch64)
    RALPHEX_ARCH="arm64"
    ;;
  x86_64)
    RALPHEX_ARCH="amd64"
    ;;
  *)
    echo "Unsupported architecture: $ARCH"
    exit 1
    ;;
esac

echo "Detected architecture: $ARCH (using $RALPHEX_ARCH)"
curl -fsSL -o /tmp/ralphex.deb "https://github.com/umputun/ralphex/releases/download/v${RALPHEX_VERSION}/ralphex_${RALPHEX_VERSION}_linux_${RALPHEX_ARCH}.deb"
sudo dpkg -i /tmp/ralphex.deb
rm /tmp/ralphex.deb




echo "Installing Claude..."
curl -fsSL https://claude.ai/install.sh | bash

echo "Installing Codex..."
npm i -g @openai/codex

