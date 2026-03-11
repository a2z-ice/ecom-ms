#!/usr/bin/env node
/**
 * Generate GIFs from HA animated SVGs using Playwright + ImageMagick.
 * Usage: node docs/diagrams/generate-ha-gifs.mjs
 */
import { chromium } from '../../e2e/node_modules/playwright/index.mjs';
import { existsSync, mkdirSync, rmSync } from 'fs';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIAGRAMS_DIR = __dirname;
const TMP_DIR = join(__dirname, '_tmp_frames');
const FRAME_COUNT = 80;  // 8-second loop at 10fps
const FRAME_INTERVAL = 100; // ms between frames

const svgs = [
  {
    file: 'ha-postgres-debezium-animated.svg',
    output: 'ha-postgres-debezium',
    width: 1600,
    height: 1100,
  },
  {
    file: 'ha-failover-animated.svg',
    output: 'ha-failover',
    width: 1600,
    height: 900,
  },
];

async function generateGif(browser, svg) {
  const frameDir = join(TMP_DIR, svg.output);
  if (existsSync(frameDir)) rmSync(frameDir, { recursive: true });
  mkdirSync(frameDir, { recursive: true });

  const svgPath = `file://${join(DIAGRAMS_DIR, svg.file)}`;
  console.log(`  Opening ${svg.file}...`);

  const page = await browser.newPage({
    viewport: { width: svg.width, height: svg.height },
  });
  await page.goto(svgPath, { waitUntil: 'networkidle' });

  // Let animations start
  await page.waitForTimeout(500);

  console.log(`  Capturing ${FRAME_COUNT} frames...`);
  for (let i = 0; i < FRAME_COUNT; i++) {
    const framePath = join(frameDir, `frame_${String(i).padStart(4, '0')}.png`);
    await page.screenshot({ path: framePath, type: 'png' });
    if (i < FRAME_COUNT - 1) await page.waitForTimeout(FRAME_INTERVAL);
    if ((i + 1) % 20 === 0) console.log(`    ${i + 1}/${FRAME_COUNT} frames`);
  }

  // Also save a static PNG
  const pngPath = join(DIAGRAMS_DIR, `${svg.output}.png`);
  await page.screenshot({ path: pngPath, type: 'png' });
  console.log(`  Saved ${svg.output}.png`);

  await page.close();

  // Assemble GIF with ImageMagick
  const gifPath = join(DIAGRAMS_DIR, `${svg.output}.gif`);
  console.log(`  Assembling GIF...`);
  try {
    execSync(
      `convert -delay 10 -loop 0 ${frameDir}/frame_*.png -layers Optimize "${gifPath}"`,
      { stdio: 'pipe' }
    );
    console.log(`  Saved ${svg.output}.gif`);
  } catch (e) {
    console.log(`  ImageMagick failed, trying magick...`);
    try {
      execSync(
        `magick -delay 10 -loop 0 ${frameDir}/frame_*.png -layers Optimize "${gifPath}"`,
        { stdio: 'pipe' }
      );
      console.log(`  Saved ${svg.output}.gif`);
    } catch (e2) {
      console.error(`  Failed to create GIF: ${e2.message}`);
    }
  }

  // Cleanup frames
  rmSync(frameDir, { recursive: true });
}

async function main() {
  mkdirSync(TMP_DIR, { recursive: true });

  console.log('Launching browser...');
  const browser = await chromium.launch({ headless: true });

  for (const svg of svgs) {
    console.log(`\nGenerating: ${svg.output}`);
    await generateGif(browser, svg);
  }

  await browser.close();
  if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true });

  // Copy GIFs to webpage/diagrams/
  const webpageDiagrams = join(DIAGRAMS_DIR, '../../webpage/diagrams');
  if (existsSync(webpageDiagrams)) {
    for (const svg of svgs) {
      const gif = join(DIAGRAMS_DIR, `${svg.output}.gif`);
      const png = join(DIAGRAMS_DIR, `${svg.output}.png`);
      if (existsSync(gif)) {
        execSync(`cp "${gif}" "${webpageDiagrams}/"`);
        console.log(`Copied ${svg.output}.gif to webpage/diagrams/`);
      }
      if (existsSync(png)) {
        execSync(`cp "${png}" "${webpageDiagrams}/"`);
      }
    }
  }

  console.log('\nDone!');
}

main().catch(console.error);
