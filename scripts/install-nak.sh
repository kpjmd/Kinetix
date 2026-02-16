#!/bin/bash

# Clawstr NAK Installation Script
# Installs the NAK CLI tool and generates a Nostr keypair for the Kinetix agent

set -e  # Exit on error

echo "==================================="
echo "Clawstr NAK Installation Script"
echo "==================================="
echo ""

# Colors for output
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

# Step 1: Check Go installation
echo "Step 1: Checking Go installation..."
if ! command -v go &> /dev/null; then
    echo -e "${RED}Error: Go is not installed.${NC}"
    echo "Please install Go from https://golang.org/dl/"
    exit 1
fi

GO_VERSION=$(go version)
echo -e "${GREEN}✓ Go is installed: $GO_VERSION${NC}"
echo ""

# Step 2: Install NAK
echo "Step 2: Installing NAK CLI..."
echo "Running: go install github.com/fiatjaf/nak@latest"

if go install github.com/fiatjaf/nak@latest; then
    echo -e "${GREEN}✓ NAK installed successfully${NC}"
else
    echo -e "${RED}Error: Failed to install NAK${NC}"
    exit 1
fi

# Verify NAK installation
if ! command -v nak &> /dev/null; then
    echo -e "${YELLOW}Warning: NAK is installed but not in PATH${NC}"
    echo "NAK binary is likely at: ~/go/bin/nak"
    echo "Add ~/go/bin to your PATH or use the full path"
    NAK_CMD="$HOME/go/bin/nak"
else
    NAK_CMD="nak"
    echo -e "${GREEN}✓ NAK is in PATH${NC}"
fi

# Show NAK version
NAK_VERSION=$($NAK_CMD --version 2>&1 || echo "version unknown")
echo "NAK version: $NAK_VERSION"
echo ""

# Step 3: Create Clawstr directory
echo "Step 3: Creating Clawstr directory..."
CLAWSTR_DIR="$HOME/.clawstr"
SECRET_KEY_PATH="$CLAWSTR_DIR/secret.key"

if [ ! -d "$CLAWSTR_DIR" ]; then
    mkdir -p "$CLAWSTR_DIR"
    echo -e "${GREEN}✓ Created directory: $CLAWSTR_DIR${NC}"
else
    echo -e "${YELLOW}Directory already exists: $CLAWSTR_DIR${NC}"
fi
echo ""

# Step 4: Generate Nostr keypair
echo "Step 4: Generating Nostr keypair..."

if [ -f "$SECRET_KEY_PATH" ]; then
    echo -e "${YELLOW}Warning: Secret key already exists at $SECRET_KEY_PATH${NC}"
    read -p "Overwrite existing key? This will create a new identity! (y/N): " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        echo "Keeping existing key."
        EXISTING_KEY=true
    else
        EXISTING_KEY=false
    fi
else
    EXISTING_KEY=false
fi

if [ "$EXISTING_KEY" = false ]; then
    # Generate new secret key
    SECRET_KEY=$($NAK_CMD key generate)
    echo "$SECRET_KEY" > "$SECRET_KEY_PATH"
    echo -e "${GREEN}✓ Generated new secret key${NC}"
else
    SECRET_KEY=$(cat "$SECRET_KEY_PATH")
    echo -e "${GREEN}✓ Using existing secret key${NC}"
fi
echo ""

# Step 5: Set secure file permissions
echo "Step 5: Setting secure file permissions..."
chmod 600 "$SECRET_KEY_PATH"
echo -e "${GREEN}✓ Set permissions to 600 (owner read/write only)${NC}"
echo ""

# Step 6: Output hex public key (for debugging/API use)
echo "Step 6: Deriving hex public key..."
HEX_PUBLIC_KEY=$($NAK_CMD key public "$SECRET_KEY")
echo -e "${GREEN}✓ Hex public key: $HEX_PUBLIC_KEY${NC}"
echo ""

# Step 7: Convert to npub format
echo "Step 7: Converting to npub format..."
PUBLIC_KEY=$($NAK_CMD encode npub "$HEX_PUBLIC_KEY")
echo -e "${GREEN}✓ Public key (npub): $PUBLIC_KEY${NC}"
echo ""

# Summary
echo "==================================="
echo "Installation Complete!"
echo "==================================="
echo ""
echo "Summary:"
echo "  - NAK CLI: $NAK_CMD"
echo "  - Secret key: $SECRET_KEY_PATH"
echo "  - Hex public key: $HEX_PUBLIC_KEY"
echo "  - Public key (npub): $PUBLIC_KEY"
echo ""
echo "Next steps:"
echo "  1. Add to .env: CLAWSTR_SECRET_KEY_PATH=$SECRET_KEY_PATH"
echo "  2. Run: npm run register:clawstr"
echo "  3. Test connection: npm run test:clawstr"
echo ""
echo -e "${GREEN}Ready for Clawstr integration!${NC}"
