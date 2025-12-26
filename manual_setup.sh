#!/bin/bash
# Manual setup script for TrustMesh Binding Service
# Run this if automated setup failed due to permission issues

echo "🧹 Cleaning up..."
rm -rf node_modules pnpm-lock.yaml package-lock.json

echo "📦 Installing dependencies..."
# Trying npm as it might be more stable in this mixed env
npm install

echo "🔨 Building..."
npm run build

echo "✅ Build complete. Starting server..."
npm run start
