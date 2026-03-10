---
name: diagrams
description: Regenerate architecture diagrams (SVG → PNG/GIF) for docs and LinkedIn sharing
disable-model-invocation: true
argument-hint: [architecture|data-flow|all]
allowed-tools: Bash
---

Regenerate the architecture diagram files from SVGs.

## Arguments
- No args or `all`: regenerate both architecture and data-flow diagrams
- `architecture`: regenerate only the static architecture diagram
- `data-flow`: regenerate only the animated data-flow GIF

## Prerequisites
- ImageMagick (magick) must be installed: `brew install imagemagick`
- Playwright must be installed: `cd e2e && npm install`

## Source Files
- `docs/diagrams/architecture.svg` — static infrastructure overview (edit this to update the architecture diagram)
- `docs/diagrams/data-flow-animated.svg` — animated data flow with CSS animations (edit this to update the data flow)

## Output Files
- `docs/diagrams/architecture.png` — high-res PNG of architecture (for GitHub README, docs)
- `docs/diagrams/architecture.gif` — GIF version (for LinkedIn sharing)
- `docs/diagrams/data-flow.gif` — animated GIF (6s loop, for LinkedIn sharing)

## Steps

### Architecture PNG + GIF
```bash
cd /Volumes/Other/rand/llm/microservice
node -e "
const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1600, height: 1200 } });
  await page.goto('file://' + process.cwd() + '/docs/diagrams/architecture.svg');
  await page.waitForTimeout(1000);
  await page.screenshot({ path: 'docs/diagrams/architecture.png', clip: { x: 0, y: 0, width: 1600, height: 1200 }, timeout: 60000 });
  await browser.close();
  console.log('Architecture PNG captured');
})();
"
magick docs/diagrams/architecture.png -resize 1200x -colors 128 docs/diagrams/architecture.gif
echo "Architecture GIF generated"
```

### Animated Data-Flow GIF
```bash
cd /Volumes/Other/rand/llm/microservice
mkdir -p /tmp/gif-frames/animated
node -e "
const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  await page.goto('file://' + process.cwd() + '/docs/diagrams/data-flow-animated.svg');
  await page.waitForTimeout(1500);
  for (let i = 0; i < 60; i++) {
    const num = String(i).padStart(4, '0');
    await page.screenshot({ path: '/tmp/gif-frames/animated/frame_' + num + '.png', clip: { x: 0, y: 0, width: 1600, height: 1000 }, timeout: 10000 });
    await page.waitForTimeout(100);
  }
  console.log('60 frames captured');
  await browser.close();
})();
"
magick -delay 10 -loop 0 /tmp/gif-frames/animated/frame_*.png -resize 1200x -colors 128 -dither FloydSteinberg docs/diagrams/data-flow.gif
rm -rf /tmp/gif-frames
echo "Data Flow GIF generated"
```

## After generation
1. Report file sizes for all generated files
2. Verify the GIF files exist and are reasonable size (architecture ~100-200KB, data-flow ~3-8MB)
3. Suggest: "Open `docs/diagrams/export-gif.html` in a browser to preview both diagrams"

## LinkedIn Sharing Tips
- Upload GIFs directly to LinkedIn posts (they support animated GIFs)
- Recommended dimensions: 1200x627 for feed display
- The architecture GIF is static (single frame) — use the data-flow GIF for the animation effect
