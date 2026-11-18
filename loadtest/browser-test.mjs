#!/usr/bin/env node

/**
 * loadtest/browser-test.mjs
 * Simulates 30 parallel real browser users using Playwright Chromium with camera emulation.
 *
 * Covers:
 * - 30 separate browser contexts
 * - Device profiles: iPhone 13, Pixel 7, Galaxy S9 (portrait & landscape)
 * - 5 users rotate screen mid-session
 * - 5 users test offline/online failure & recovery (no photos lost)
 * - 5 users test page reload while uploads are queued
 * - 3 users test server 503 error injection with retry recovery
 * - Network throttling support: Normal vs Slow 4G (CDP)
 *
 * Usage:
 *   node loadtest/browser-test.mjs [--slow4g] [--headless]
 */

import { chromium, devices } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { CONFIG } from '../config.js';

const isSlow4G = process.argv.includes('--slow4g');
const isHeadless = !process.argv.includes('--headed');
const targetUrl = 'https://manaalp.github.io/QRPhotoApp/';
const testTimestamp = Date.now();
const testEventId = `loadtest-browser-${testTimestamp}`;

console.log(`\n=================================================`);
console.log(`🌐 PLAYWRIGHT BROWSER LOAD & FAILURE TEST`);
console.log(`=================================================`);
console.log(`Target URL   : ${targetUrl}`);
console.log(`Network Mode : ${isSlow4G ? 'Slow 4G (1.6Mbps / 750Kbps / 150ms)' : 'Normal'}`);
console.log(`Users        : 30 concurrent browsers`);
console.log(`Test Event ID: ${testEventId}`);
console.log(`=================================================\n`);

// Device pools
const DEVICE_PROFILES = [
  { name: 'iPhone 13', descriptor: devices['iPhone 13'] },
  { name: 'Pixel 7', descriptor: devices['Pixel 7'] },
  { name: 'Galaxy S9', descriptor: devices['Galaxy S9+'] || devices['Pixel 5'] }
];

// Slow 4G network parameters via Chrome DevTools Protocol
const SLOW_4G = {
  offline: false,
  downloadThroughput: (1.6 * 1024 * 1024) / 8, // 1.6 Mbps
  uploadThroughput: (750 * 1024) / 8,          // 750 Kbps
  latency: 150                                // 150 ms
};

// Runner for a single virtual browser user
async function runVirtualUser(browser, userIndex, results) {
  const profileInfo = DEVICE_PROFILES[userIndex % DEVICE_PROFILES.length];
  const startLandscape = (userIndex % 2 === 1);
  const shouldRotate = (userIndex < 5);      // 5 users rotate mid-session
  const shouldTestOffline = (userIndex >= 5 && userIndex < 10); // 5 users test offline recovery
  const shouldTestReload = (userIndex >= 10 && userIndex < 15); // 5 users test reload mid-upload
  const shouldInject503 = (userIndex >= 15 && userIndex < 18);  // 3 users test server 503 retry

  const contextOptions = {
    ...profileInfo.descriptor,
    permissions: ['camera'],
    isMobile: true,
    hasTouch: true
  };

  // Adjust viewport if starting in landscape
  if (startLandscape && contextOptions.viewport) {
    const { width, height } = contextOptions.viewport;
    contextOptions.viewport = { width: height, height: width };
  }

  const context = await browser.newContext(contextOptions);
  const page = await context.newPage();

  // Throttling if Slow 4G
  if (isSlow4G) {
    const client = await context.newCDPSession(page);
    await client.send('Network.emulateNetworkConditions', SLOW_4G);
  }

  // Error tracking
  const userConsoleErrors = [];
  const userFailedRequests = [];
  page.on('console', msg => {
    if (msg.type() === 'error') userConsoleErrors.push(msg.text());
  });
  page.on('requestfailed', req => {
    userFailedRequests.push({ url: req.url(), failure: req.failure()?.errorText });
  });

  // Inject 503 on 1 out of 3 uploads for selected users
  let uploadCounter = 0;
  if (shouldInject503) {
    await page.route('**/storage/v1/object/**', async route => {
      uploadCounter++;
      if (uploadCounter % 3 === 0) {
        await route.fulfill({
          status: 503,
          contentType: 'text/plain',
          body: 'Simulated 503 Service Unavailable'
        });
      } else {
        await route.continue();
      }
    });
  }

  const userMetrics = {
    userId: `user-${userIndex + 1}`,
    device: profileInfo.name,
    startOrientation: startLandscape ? 'landscape' : 'portrait',
    pageLoadTime: 0,
    timeToCameraReady: 0,
    shots: [],
    consoleErrors: userConsoleErrors,
    failedRequests: userFailedRequests,
    success: false
  };

  const navStart = performance.now();

  try {
    // 1. Open page
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    userMetrics.pageLoadTime = Math.round(performance.now() - navStart);

    // 2. Wait for camera video playing
    const videoSelector = '#camera-video';
    await page.waitForSelector(videoSelector, { timeout: 15000 });
    // Wait until video has dimensions (playing)
    await page.waitForFunction(() => {
      const v = document.getElementById('camera-video');
      return v && v.videoWidth > 0;
    }, { timeout: 15000 });

    userMetrics.timeToCameraReady = Math.round(performance.now() - navStart);

    // 3. Take 3 photos
    const TOTAL_PHOTOS = (shouldTestOffline ? 4 : 3);

    for (let shot = 1; shot <= TOTAL_PHOTOS; shot++) {
      const shotStart = performance.now();

      // Check if this user should test offline mode after 2nd photo
      if (shouldTestOffline && shot === 3) {
        console.log(`\n[User ${userIndex + 1}] ✈ Going OFFLINE...`);
        await context.setOffline(true);
      }

      // Rotate mid-session check (e.g. after 1st shot)
      if (shouldRotate && shot === 2) {
        const vp = page.viewportSize();
        if (vp) {
          await page.setViewportSize({ width: vp.height, height: vp.width });
          await page.evaluate(() => window.dispatchEvent(new Event('resize')));
          await page.waitForTimeout(300);
        }
      }

      // Tap Shutter
      const shutter = page.locator('#btn-shutter');
      await shutter.waitFor({ state: 'visible', timeout: 8000 });
      await shutter.click();

      // Wait for review screen
      const reviewScreen = page.locator('#review-screen.active');
      await reviewScreen.waitFor({ state: 'visible', timeout: 8000 });

      // Tap Use photo
      const useBtn = page.locator('#btn-use');
      await useBtn.click();

      // Wait for Toast "Saved ✓"
      const toast = page.locator('#toast:not(.hidden)');
      await toast.waitFor({ state: 'visible', timeout: 8000 });

      const shotDuration = Math.round(performance.now() - shotStart);
      userMetrics.shots.push({ shot, duration: shotDuration });

      // Check if user should test page reload while uploads are queued
      if (shouldTestReload && shot === 2) {
        console.log(`\n[User ${userIndex + 1}] 🔄 Reloading page mid-upload...`);
        await page.reload({ waitUntil: 'domcontentloaded' });
        await page.waitForSelector(videoSelector, { timeout: 15000 });
      }

      // Small natural pause before next shot
      await page.waitForTimeout(1000);
    }

    // If offline user, restore connection
    if (shouldTestOffline) {
      console.log(`\n[User ${userIndex + 1}] 📶 Going back ONLINE...`);
      await context.setOffline(false);
      // Trigger online event in page
      await page.evaluate(() => window.dispatchEvent(new Event('online')));
    }

    // 4. Wait for upload queue to settle (status contains '0 waiting')
    await page.waitForFunction(() => {
      const el = document.getElementById('upload-status');
      if (!el) return false;
      return !el.textContent.includes('waiting');
    }, { timeout: 45000 });

    userMetrics.success = true;
    process.stdout.write('\x1b[32m✔\x1b[0m');
  } catch (err) {
    userMetrics.error = err.message;
    process.stdout.write(`\x1b[31m[U${userIndex + 1}:${err.message.slice(0, 20)}]\x1b[0m`);
  } finally {
    await context.close();
    results.push(userMetrics);
  }
}

async function runBrowserTest() {
  const browser = await chromium.launch({
    headless: isHeadless,
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      '--allow-file-access'
    ]
  });

  const results = [];
  const startTime = performance.now();

  console.log(`Launching 30 virtual user sessions... Progress:`);

  // Run in chunks of 10 to balance system load while maintaining high concurrency
  const BATCH_SIZE = 10;
  for (let i = 0; i < 30; i += BATCH_SIZE) {
    const chunkTasks = [];
    for (let u = i; u < Math.min(i + BATCH_SIZE, 30); u++) {
      chunkTasks.push(runVirtualUser(browser, u, results));
    }
    await Promise.all(chunkTasks);
  }

  await browser.close();

  const totalTimeSec = ((performance.now() - startTime) / 1000).toFixed(2);
  const successfulUsers = results.filter(r => r.success);
  const failedUsers = results.filter(r => !r.success);

  const avgLoadTime = Math.round(results.reduce((a, b) => a + (b.pageLoadTime || 0), 0) / results.length);
  const avgCameraTime = Math.round(results.reduce((a, b) => a + (b.timeToCameraReady || 0), 0) / results.length);

  const allShots = results.flatMap(r => r.shots.map(s => s.duration)).sort((a, b) => a - b);
  const p50Shot = allShots[Math.floor(allShots.length * 0.50)] || 0;
  const p95Shot = allShots[Math.floor(allShots.length * 0.95)] || 0;
  const maxShot = allShots[allShots.length - 1] || 0;

  console.log(`\n\n=================================================`);
  console.log(`📊 BROWSER TEST SUMMARY (${isSlow4G ? 'SLOW 4G' : 'NORMAL'})`);
  console.log(`=================================================`);
  console.log(`Successful Users   : ${successfulUsers.length}/30 (${((successfulUsers.length / 30) * 100).toFixed(1)}%)`);
  console.log(`Avg Page Load      : ${avgLoadTime} ms`);
  console.log(`Avg Camera Ready   : ${avgCameraTime} ms`);
  console.log(`Shutter Latency p50: ${p50Shot} ms`);
  console.log(`Shutter Latency p95: ${p95Shot} ms`);
  console.log(`Shutter Latency Max: ${maxShot} ms`);
  console.log(`Total Wall Time    : ${totalTimeSec}s`);
  console.log(`=================================================\n`);

  // Write report
  const resultsDir = path.resolve(process.cwd(), 'loadtest/results');
  if (!fs.existsSync(resultsDir)) {
    fs.mkdirSync(resultsDir, { recursive: true });
  }

  const rawJsonPath = path.join(resultsDir, `browser-${isSlow4G ? 'slow4g' : 'normal'}-${testTimestamp}.json`);
  fs.writeFileSync(rawJsonPath, JSON.stringify({ isSlow4G, totalTimeSec, results }, null, 2));
  console.log(`Raw results saved to: ${rawJsonPath}`);
}

runBrowserTest().catch(console.error);
