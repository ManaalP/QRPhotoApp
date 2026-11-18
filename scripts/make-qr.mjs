#!/usr/bin/env node

/**
 * scripts/make-qr.mjs
 * Takes a target URL and writes a high-resolution QR code PNG image.
 * 
 * Usage:
 *   node scripts/make-qr.mjs <url> [output-path]
 *   node scripts/make-qr.mjs https://my-event.pages.dev event-qr.png
 */

import QRCode from 'qrcode';
import fs from 'node:fs';
import path from 'node:path';

const url = process.argv[2];
const outputPath = process.argv[3] || 'event-qr.png';

if (!url) {
  console.error('\x1b[31mError: URL argument is required.\x1b[0m');
  console.log('\nUsage:');
  console.log('  node scripts/make-qr.mjs <url> [output-path]');
  console.log('Example:');
  console.log('  node scripts/make-qr.mjs https://my-event.pages.dev qr.png\n');
  process.exit(1);
}

async function generateQR() {
  try {
    const resolvedPath = path.resolve(process.cwd(), outputPath);
    const options = {
      errorCorrectionLevel: 'H',
      type: 'png',
      quality: 0.95,
      margin: 2,
      scale: 12, // High resolution (e.g. ~1200x1200px+ for crisp prints)
      color: {
        dark: '#000000',
        light: '#FFFFFF'
      }
    };

    await QRCode.toFile(resolvedPath, url, options);
    console.log(`\x1b[32m✔ High-resolution QR code created successfully!\x1b[0m`);
    console.log(`  Target URL : ${url}`);
    console.log(`  Output file: ${resolvedPath}`);
  } catch (err) {
    console.error('\x1b[31mFailed to generate QR code:\x1b[0m', err.message);
    process.exit(1);
  }
}

generateQR();
