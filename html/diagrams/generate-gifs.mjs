#!/usr/bin/env node
/**
 * Generate GIF files from SVG diagrams using Playwright.
 *
 * - architecture.gif: single-frame static screenshot
 * - data-flow.gif: multi-frame animated GIF capturing SVG animations
 * - ha-postgres-debezium.gif: animated HA PostgreSQL + Debezium CDC diagram
 * - ha-failover.gif: animated failover sequence diagram
 *
 * Usage: node html/diagrams/generate-gifs.mjs
 * Requires: playwright (from e2e/node_modules), ImageMagick (brew install imagemagick)
 */

import { chromium } from '../../e2e/node_modules/playwright-core/index.mjs';
import { execSync } from 'child_process';
import { readFileSync, writeFileSync, unlinkSync, existsSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIAGRAMS_DIR = __dirname;

// Check if ffmpeg and gifsicle are available for animated GIF
function hasCommand(cmd) {
  try { execSync(`which ${cmd}`, { stdio: 'pipe' }); return true; } catch { return false; }
}

async function generateArchitectureGif() {
  console.log('Generating architecture.gif...');
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1600, height: 1100 } });

  const svgPath = resolve(DIAGRAMS_DIR, 'architecture.svg');
  await page.goto(`file://${svgPath}`);
  await page.waitForTimeout(500);

  const pngPath = resolve(DIAGRAMS_DIR, 'architecture.png');
  await page.screenshot({ path: pngPath, type: 'png' });
  await browser.close();

  // Convert PNG to GIF
  if (hasCommand('sips') && hasCommand('magick')) {
    // Use ImageMagick if available
    execSync(`magick "${pngPath}" "${resolve(DIAGRAMS_DIR, 'architecture.gif')}"`, { stdio: 'pipe' });
  } else if (hasCommand('sips')) {
    // macOS sips can convert to gif
    const gifPath = resolve(DIAGRAMS_DIR, 'architecture.gif');
    execSync(`sips -s format gif "${pngPath}" --out "${gifPath}"`, { stdio: 'pipe' });
  } else {
    console.log('  No converter found. PNG saved, please convert manually.');
  }

  if (existsSync(pngPath)) unlinkSync(pngPath);
  console.log('  architecture.gif generated.');
}

async function generateDataFlowGif() {
  console.log('Generating data-flow.gif (animated)...');

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });

  const svgPath = resolve(DIAGRAMS_DIR, 'data-flow-animated.svg');
  await page.goto(`file://${svgPath}`);
  await page.waitForTimeout(1000); // Let animations start

  const tmpDir = resolve(DIAGRAMS_DIR, '_gif_frames');
  if (!existsSync(tmpDir)) mkdirSync(tmpDir);

  // Capture frames over 6 seconds (covers longest animation cycle)
  const TOTAL_DURATION_MS = 6000;
  const FRAME_INTERVAL_MS = 100; // 10 fps
  const frameCount = Math.floor(TOTAL_DURATION_MS / FRAME_INTERVAL_MS);

  console.log(`  Capturing ${frameCount} frames at ${1000/FRAME_INTERVAL_MS} fps...`);
  for (let i = 0; i < frameCount; i++) {
    const framePath = resolve(tmpDir, `frame_${String(i).padStart(4, '0')}.png`);
    await page.screenshot({ path: framePath, type: 'png' });
    await page.waitForTimeout(FRAME_INTERVAL_MS);
  }
  await browser.close();

  const gifPath = resolve(DIAGRAMS_DIR, 'data-flow.gif');

  // Try different tools to assemble animated GIF
  if (hasCommand('magick')) {
    console.log('  Assembling with ImageMagick...');
    execSync(
      `magick -delay 10 -loop 0 "${tmpDir}/frame_*.png" -layers Optimize "${gifPath}"`,
      { stdio: 'pipe', timeout: 120000 }
    );
  } else if (hasCommand('ffmpeg')) {
    console.log('  Assembling with ffmpeg...');
    const palettePath = resolve(tmpDir, 'palette.png');
    execSync(
      `ffmpeg -y -framerate 10 -i "${tmpDir}/frame_%04d.png" -vf "palettegen=max_colors=128" "${palettePath}"`,
      { stdio: 'pipe', timeout: 60000 }
    );
    execSync(
      `ffmpeg -y -framerate 10 -i "${tmpDir}/frame_%04d.png" -i "${palettePath}" -lavfi "paletteuse=dither=bayer:bayer_scale=3" "${gifPath}"`,
      { stdio: 'pipe', timeout: 120000 }
    );
    if (existsSync(palettePath)) unlinkSync(palettePath);
  } else if (hasCommand('sips')) {
    // sips cannot make animated GIFs, use first frame as static fallback
    console.log('  No animated GIF tool found. Using sips for single-frame fallback...');
    execSync(
      `sips -s format gif "${tmpDir}/frame_0000.png" --out "${gifPath}"`,
      { stdio: 'pipe' }
    );
    console.log('  WARNING: data-flow.gif is NOT animated (install ImageMagick: brew install imagemagick)');
  }

  // Optimize with gifsicle if available
  if (hasCommand('gifsicle') && existsSync(gifPath)) {
    console.log('  Optimizing with gifsicle...');
    const optimizedPath = gifPath + '.opt';
    try {
      execSync(`gifsicle -O3 --lossy=80 "${gifPath}" -o "${optimizedPath}"`, { stdio: 'pipe' });
      unlinkSync(gifPath);
      execSync(`mv "${optimizedPath}" "${gifPath}"`, { stdio: 'pipe' });
    } catch { /* gifsicle optimization is optional */ }
  }

  // Cleanup frames
  for (let i = 0; i < frameCount; i++) {
    const framePath = resolve(tmpDir, `frame_${String(i).padStart(4, '0')}.png`);
    if (existsSync(framePath)) unlinkSync(framePath);
  }
  try { execSync(`rmdir "${tmpDir}"`, { stdio: 'pipe' }); } catch { /* may not be empty */ }

  console.log('  data-flow.gif generated.');
}

async function generateAnimatedSvgGif(svgFile, gifFile, width, height, durationMs = 6000) {
  console.log(`Generating ${gifFile} (animated)...`);

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width, height } });

  const svgPath = resolve(DIAGRAMS_DIR, svgFile);
  await page.goto(`file://${svgPath}`);
  await page.waitForTimeout(1000);

  const tmpDir = resolve(DIAGRAMS_DIR, `_gif_frames_${gifFile.replace('.gif', '')}`);
  if (!existsSync(tmpDir)) mkdirSync(tmpDir);

  const FRAME_INTERVAL_MS = 100;
  const frameCount = Math.floor(durationMs / FRAME_INTERVAL_MS);

  // Also capture a PNG snapshot
  const pngPath = resolve(DIAGRAMS_DIR, gifFile.replace('.gif', '.png'));
  await page.screenshot({ path: pngPath, type: 'png' });

  console.log(`  Capturing ${frameCount} frames at ${1000/FRAME_INTERVAL_MS} fps...`);
  for (let i = 0; i < frameCount; i++) {
    const framePath = resolve(tmpDir, `frame_${String(i).padStart(4, '0')}.png`);
    await page.screenshot({ path: framePath, type: 'png' });
    await page.waitForTimeout(FRAME_INTERVAL_MS);
  }
  await browser.close();

  const gifPath = resolve(DIAGRAMS_DIR, gifFile);

  if (hasCommand('magick')) {
    console.log('  Assembling with ImageMagick...');
    execSync(
      `magick -delay 10 -loop 0 "${tmpDir}/frame_*.png" -layers Optimize "${gifPath}"`,
      { stdio: 'pipe', timeout: 120000 }
    );
  } else if (hasCommand('ffmpeg')) {
    console.log('  Assembling with ffmpeg...');
    const palettePath = resolve(tmpDir, 'palette.png');
    execSync(
      `ffmpeg -y -framerate 10 -i "${tmpDir}/frame_%04d.png" -vf "palettegen=max_colors=128" "${palettePath}"`,
      { stdio: 'pipe', timeout: 60000 }
    );
    execSync(
      `ffmpeg -y -framerate 10 -i "${tmpDir}/frame_%04d.png" -i "${palettePath}" -lavfi "paletteuse=dither=bayer:bayer_scale=3" "${gifPath}"`,
      { stdio: 'pipe', timeout: 120000 }
    );
    if (existsSync(palettePath)) unlinkSync(palettePath);
  } else if (hasCommand('sips')) {
    console.log('  No animated GIF tool found. Using sips for single-frame fallback...');
    execSync(`sips -s format gif "${tmpDir}/frame_0000.png" --out "${gifPath}"`, { stdio: 'pipe' });
    console.log(`  WARNING: ${gifFile} is NOT animated (install ImageMagick: brew install imagemagick)`);
  }

  if (hasCommand('gifsicle') && existsSync(gifPath)) {
    console.log('  Optimizing with gifsicle...');
    const optimizedPath = gifPath + '.opt';
    try {
      execSync(`gifsicle -O3 --lossy=80 "${gifPath}" -o "${optimizedPath}"`, { stdio: 'pipe' });
      unlinkSync(gifPath);
      execSync(`mv "${optimizedPath}" "${gifPath}"`, { stdio: 'pipe' });
    } catch { /* optional */ }
  }

  // Cleanup frames
  for (let i = 0; i < frameCount; i++) {
    const framePath = resolve(tmpDir, `frame_${String(i).padStart(4, '0')}.png`);
    if (existsSync(framePath)) unlinkSync(framePath);
  }
  try { execSync(`rmdir "${tmpDir}"`, { stdio: 'pipe' }); } catch { /* may not be empty */ }

  console.log(`  ${gifFile} + ${gifFile.replace('.gif', '.png')} generated.`);
}

async function main() {
  const target = process.argv[2]; // optional: 'ha', 'arch', 'flow', or omit for all

  try {
    if (!target || target === 'arch') {
      await generateArchitectureGif();
    }
    if (!target || target === 'flow') {
      await generateDataFlowGif();
    }
    if (!target || target === 'ha') {
      await generateAnimatedSvgGif('ha-postgres-debezium-animated.svg', 'ha-postgres-debezium.gif', 1700, 1150, 8000);
      await generateAnimatedSvgGif('ha-failover-animated.svg', 'ha-failover.gif', 1600, 1100, 10000);
    }
    console.log('\nDone! GIF files regenerated.');
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }
}

main();
