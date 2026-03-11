#!/usr/bin/env bash
# Generate GIF files from the architecture SVGs for LinkedIn sharing
# Requires: Playwright (installed in ../e2e/), ffmpeg (brew install ffmpeg)
#
# Usage: bash docs/diagrams/generate-gif.sh
# Output: docs/diagrams/architecture.png, docs/diagrams/data-flow.gif

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
E2E_DIR="$PROJECT_ROOT/e2e"
OUTPUT_DIR="$SCRIPT_DIR"

echo "=== BookStore Architecture GIF Generator ==="
echo ""

# Check dependencies
if ! command -v ffmpeg &>/dev/null; then
  echo "❌ ffmpeg not found. Install with: brew install ffmpeg"
  exit 1
fi

if [ ! -d "$E2E_DIR/node_modules" ]; then
  echo "❌ Playwright not installed. Run: cd e2e && npm install"
  exit 1
fi

# Create a temporary Playwright script that:
# 1. Opens the SVG in a browser
# 2. Takes screenshots every 100ms for 6 seconds (60 frames)
# 3. Saves frames to a temp directory

TEMP_DIR=$(mktemp -d)
FRAMES_DIR_STATIC="$TEMP_DIR/static"
FRAMES_DIR_ANIMATED="$TEMP_DIR/animated"
mkdir -p "$FRAMES_DIR_STATIC" "$FRAMES_DIR_ANIMATED"

# Generate the Playwright capture script
cat > "$TEMP_DIR/capture.mjs" << 'CAPTURE_SCRIPT'
import { chromium } from 'playwright';
import { resolve } from 'path';

const [,, svgPath, outputDir, frameCount, intervalMs] = process.argv;
const frames = parseInt(frameCount) || 60;
const interval = parseInt(intervalMs) || 100;

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1600, height: 1100 } });

  const fileUrl = `file://${resolve(svgPath)}`;
  await page.goto(fileUrl);
  await page.waitForTimeout(1000); // Let animations start

  for (let i = 0; i < frames; i++) {
    const num = String(i).padStart(4, '0');
    await page.screenshot({ path: `${outputDir}/frame_${num}.png` });
    await page.waitForTimeout(interval);
  }

  await browser.close();
  console.log(`Captured ${frames} frames to ${outputDir}`);
})();
CAPTURE_SCRIPT

echo "📸 Capturing architecture diagram (static → single frame)..."
cd "$E2E_DIR"
npx playwright test --config=/dev/null 2>/dev/null || true
node "$TEMP_DIR/capture.mjs" \
  "$OUTPUT_DIR/architecture.svg" \
  "$FRAMES_DIR_STATIC" \
  1 100

echo "📸 Capturing animated data flow (60 frames @ 100ms = 6s loop)..."
node "$TEMP_DIR/capture.mjs" \
  "$OUTPUT_DIR/data-flow-animated.svg" \
  "$FRAMES_DIR_ANIMATED" \
  60 100

echo ""
echo "🎬 Converting to GIF..."

# Static architecture → PNG (high quality, no animation needed)
cp "$FRAMES_DIR_STATIC/frame_0000.png" "$OUTPUT_DIR/architecture.png"
echo "✅ Architecture PNG: $OUTPUT_DIR/architecture.png"

# Animated data flow → GIF
ffmpeg -y -framerate 10 -i "$FRAMES_DIR_ANIMATED/frame_%04d.png" \
  -vf "fps=10,scale=1200:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=128:stats_mode=diff[p];[s1][p]paletteuse=dither=bayer:bayer_scale=3" \
  "$OUTPUT_DIR/data-flow.gif" 2>/dev/null

echo "✅ Data Flow GIF: $OUTPUT_DIR/data-flow.gif"

# Cleanup
rm -rf "$TEMP_DIR"

echo ""
echo "=== Done! ==="
echo "Files created:"
echo "  📊 $OUTPUT_DIR/architecture.png (static, high-res)"
echo "  🎞️  $OUTPUT_DIR/data-flow.gif (animated, 6s loop)"
echo ""
echo "LinkedIn tip: Upload the GIF directly — LinkedIn supports animated GIFs in posts."
echo "Recommended post dimensions: 1200x627 for feed display."
