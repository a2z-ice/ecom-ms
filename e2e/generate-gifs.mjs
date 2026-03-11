/**
 * Generate GIF files from architecture SVG diagrams.
 * Uses Playwright to render SVGs in a browser and capture frames,
 * then encodes them into animated GIFs using gif-encoder-2.
 *
 * Viewport sizes MUST match SVG viewBox dimensions exactly to avoid clipping.
 *   architecture.svg:       viewBox="0 0 1600 1100"
 *   data-flow-animated.svg: viewBox="0 0 1600 1000"
 *
 * Usage: node generate-gifs.mjs
 * Output: docs/diagrams/architecture.gif, docs/diagrams/data-flow.gif
 */
import { chromium } from 'playwright';
import GIFEncoder from 'gif-encoder-2';
import { PNG } from 'pngjs';
import { createWriteStream } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIAGRAMS_DIR = resolve(__dirname, '..', 'docs', 'diagrams');

async function captureFrames(page, svgPath, frameCount, intervalMs) {
  const fileUrl = `file://${resolve(svgPath)}`;
  await page.goto(fileUrl, { waitUntil: 'load' });
  await page.waitForTimeout(500);

  const frames = [];
  for (let i = 0; i < frameCount; i++) {
    const buffer = await page.screenshot({ type: 'png', timeout: 60000 });
    frames.push(buffer);
    if (i < frameCount - 1) {
      await page.waitForTimeout(intervalMs);
    }
    process.stdout.write(`\r  Frame ${i + 1}/${frameCount}`);
  }
  process.stdout.write('\n');
  return frames;
}

function pngBufferToRawPixels(pngBuffer) {
  const png = PNG.sync.read(pngBuffer);
  return { data: png.data, width: png.width, height: png.height };
}

async function createGif(frames, outputPath, delay) {
  const first = pngBufferToRawPixels(frames[0]);
  const encoder = new GIFEncoder(first.width, first.height, 'neuquant', true);
  encoder.setDelay(delay);
  encoder.setRepeat(0);
  encoder.setQuality(10);

  const stream = createWriteStream(outputPath);
  encoder.createReadStream().pipe(stream);
  encoder.start();

  for (const frame of frames) {
    const { data } = pngBufferToRawPixels(frame);
    encoder.addFrame(data);
  }

  encoder.finish();
  await new Promise((res) => stream.on('finish', res));
}

(async () => {
  console.log('=== BookStore Architecture GIF Generator ===\n');

  const browser = await chromium.launch();

  // --- 1. Architecture diagram (viewBox: 1600x1100) ---
  console.log('1. Architecture diagram (1600x1100)...');
  const archPage = await browser.newPage({ viewport: { width: 1600, height: 1100 } });
  const archFrames = await captureFrames(
    archPage,
    resolve(DIAGRAMS_DIR, 'architecture.svg'),
    1, 100,
  );
  await archPage.close();
  const archOutputPath = resolve(DIAGRAMS_DIR, 'architecture.gif');
  await createGif(archFrames, archOutputPath, 1000);
  console.log(`  -> ${archOutputPath}\n`);

  // --- 2. Animated data flow (viewBox: 1600x1000, 40 frames @ 150ms = 6s) ---
  console.log('2. Animated data flow diagram (1600x1000, 35 frames)...');
  const flowPage = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const flowFrames = await captureFrames(
    flowPage,
    resolve(DIAGRAMS_DIR, 'data-flow-animated.svg'),
    35,
    170,  // 170ms * 35 = ~6s loop
  );
  await flowPage.close();
  const flowOutputPath = resolve(DIAGRAMS_DIR, 'data-flow.gif');
  await createGif(flowFrames, flowOutputPath, 170);
  console.log(`  -> ${flowOutputPath}\n`);

  await browser.close();

  console.log('=== Done! ===');
  console.log(`  architecture.gif — 1600x1100 static`);
  console.log(`  data-flow.gif   — 1600x1000 animated (6s loop)`);
  console.log('\nLinkedIn tip: Upload GIFs directly — LinkedIn supports animated GIFs in posts.');
})();
