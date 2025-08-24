#!/bin/bash

# Setup script for Bubble Tab Manager development

echo "Bubble Tab Manager - Setup Script"
echo "================================="

# Check for Node.js
if ! command -v node &> /dev/null; then
    echo "❌ Node.js is not installed."
    echo ""
    echo "Please install Node.js (v18 or later) first:"
    echo "  - Download from: https://nodejs.org/"
    echo "  - Or use a package manager:"
    echo "    - macOS: brew install node"
    echo "    - Ubuntu/Debian: sudo apt install nodejs npm"
    echo "    - Arch: sudo pacman -S nodejs npm"
    echo ""
    exit 1
fi

echo "✅ Node.js $(node --version) detected"

# Check for npm
if ! command -v npm &> /dev/null; then
    echo "❌ npm is not installed."
    echo "Please install npm (usually comes with Node.js)"
    exit 1
fi

echo "✅ npm $(npm --version) detected"

# Install dependencies
echo ""
echo "Installing dependencies..."
npm install

# Initial build
echo ""
echo "Running initial build..."
npm run build

echo ""
echo "✅ Setup complete!"
echo ""
echo "Next steps:"
echo "1. Run 'npm run dev' for development mode with watch"
echo "2. Open Chrome and go to chrome://extensions/"
echo "3. Enable Developer mode"
echo "4. Click 'Load unpacked' and select the 'dist' folder"
echo ""
echo "Happy developing! 🚀"