#!/usr/bin/env node

/**
 * loadtest/upload-burst.mjs
 * Simulates 30 parallel users uploading photos to Supabase Storage.
 *
 * Scenarios:
 *   a) ramp  : users join over 60 seconds
 *   b) burst : all 30 start in the same second
 *   c) spike : 30 users upload 1 photo each at the exact same moment, repeated 3 times
 *
 * Usage:
 *   node loadtest/upload-burst.mjs [scenario] [users] [photosPerUser]
 *   Example: node loadtest/upload-burst.mjs burst 30 5
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import piexif from 'piexifjs';
import { CONFIG } from '../config.js';

// Configuration & Arguments
const scenario = (process.argv[2] || 'burst').toLowerCase();
const NUM_USERS = parseInt(process.argv[3] || '30', 10);
const PHOTOS_PER_USER = parseInt(process.argv[4] || (scenario === 'spike' ? '1' : '5'), 10);
const SPIKE_ROUNDS = scenario === 'spike' ? 3 : 1;

const testTimestamp = Date.now();
const testEventId = `loadtest-${testTimestamp}`;
const bucketName = CONFIG.BUCKET || 'event-photos';
const supabaseUrl = CONFIG.SUPABASE_URL;
const anonKey = CONFIG.SUPABASE_ANON_KEY;

// Total volume safety check (< 200 MB)
const totalUploadsPlanned = scenario === 'spike' 
  ? NUM_USERS * PHOTOS_PER_USER * SPIKE_ROUNDS
  : NUM_USERS * PHOTOS_PER_USER;
const estimatedBytes = totalUploadsPlanned * 750 * 1024; // ~750 KB per JPEG
const estimatedMB = Math.round(estimatedBytes / (1024 * 1024));

console.log(`\n=================================================`);
console.log(`🚀 LOAD TEST: Upload Burst (Scenario: ${scenario.toUpperCase()})`);
console.log(`=================================================`);
console.log(`Target URL       : ${supabaseUrl}`);
console.log(`Bucket           : ${bucketName}`);
console.log(`Event ID         : ${testEventId}`);
console.log(`Users (N)        : ${NUM_USERS}`);
console.log(`Photos/User      : ${PHOTOS_PER_USER}`);
if (scenario === 'spike') {
  console.log(`Spike Repetitions: ${SPIKE_ROUNDS} rounds`);
}
console.log(`Total Uploads    : ${totalUploadsPlanned} (~${estimatedMB} MB)`);
console.log(`=================================================`);

if (estimatedMB > 200) {
  console.error(`\x1b[31m⚠️ SAFETY WARNING: Planned data volume (~${estimatedMB} MB) exceeds 200 MB limit.\x1b[0m`);
  console.error(`Aborting to prevent quota exhaustion on free Supabase tier.`);
  process.exit(1);
}

// Generate realistic in-memory JPEG with EXIF (600 - 900 KB)
const TINY_JPEG_BASE = Buffer.from(
  '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=',
  'base64'
);

function generateRealisticJpeg(captureDate, targetSizeKb = 750) {
  const targetBytes = targetSizeKb * 1024;
  let needed = Math.max(0, targetBytes - TINY_JPEG_BASE.length);

  // Pad the JPEG using valid JPEG COM (comment) segments (0xFF, 0xFE, length_hi, length_lo, payload)
  const parts = [TINY_JPEG_BASE.subarray(0, 2)]; // 0xFF, 0xD8 (SOI)
  while (needed > 0) {
    const segLen = Math.min(needed - 4, 65000);
    if (segLen <= 0) break;
    const comHeader = Buffer.from([0xff, 0xfe, (segLen + 2) >> 8, (segLen + 2) & 0xff]);
    const comData = crypto.randomBytes(segLen);
    parts.push(comHeader, comData);
    needed -= (segLen + 4);
  }
  parts.push(TINY_JPEG_BASE.subarray(2)); // rest of valid JPEG markers & EOI
  const validPaddedJpeg = Buffer.concat(parts);

  let dataUrl = 'data:image/jpeg;base64,' + validPaddedJpeg.toString('base64');

  // Inject same EXIF metadata as app.js
  try {
    const pad = (n) => String(n).padStart(2, '0');
    const localTimeStr = `${pad(captureDate.getHours())}:${pad(captureDate.getMinutes())}:${pad(captureDate.getSeconds())}`;
    const eventDateFormatted = CONFIG.EVENT_DATE.replace(/-/g, ':');
    const dateTimeStr = `${eventDateFormatted} ${localTimeStr}`;

    const zeroth = {};
    const exif = {};
    zeroth[piexif.ImageIFD.Orientation] = 1;
    zeroth[piexif.ImageIFD.Make] = "Disposable Camera Web App";
    zeroth[piexif.ImageIFD.Software] = "Disposable Camera Web App";
    zeroth[piexif.ImageIFD.ImageDescription] = `${CONFIG.EVENT_NAME} – ${CONFIG.EVENT_DATE}`;
    zeroth[piexif.ImageIFD.DateTime] = dateTimeStr;

    exif[piexif.ExifIFD.DateTimeOriginal] = dateTimeStr;
    exif[piexif.ExifIFD.DateTimeDigitized] = dateTimeStr;
    exif[piexif.ExifIFD.UserComment] = testEventId;

    const exifObj = { "0th": zeroth, "Exif": exif };
    const exifBytes = piexif.dump(exifObj);
    dataUrl = piexif.insert(exifBytes, dataUrl);
  } catch (err) {
    console.warn("EXIF insertion warning:", err.message);
  }

  const base64Data = dataUrl.split(',')[1];
  return Buffer.from(base64Data, 'base64');
}

// Upload with exponential backoff & jitter (identical to app.js queue logic)
async function uploadWithRetry(filePath, buffer, maxRetries = 4) {
  let attempt = 0;
  const url = `${supabaseUrl}/storage/v1/object/${bucketName}/${filePath}`;

  while (attempt <= maxRetries) {
    const start = performance.now();
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${anonKey}`,
          'apikey': anonKey,
          'Content-Type': 'image/jpeg',
          'x-upsert': 'false' // exact match: upsert false
        },
        body: buffer
      });

      const elapsed = Math.round(performance.now() - start);

      if (res.ok) {
        return {
          success: true,
          status: res.status,
          duration: elapsed,
          bytes: buffer.length,
          retries: attempt,
          error: null
        };
      }

      // If rate limited or server error, retry with backoff
      const errorText = await res.text();
      attempt++;
      if (attempt > maxRetries) {
        return {
          success: false,
          status: res.status,
          duration: elapsed,
          bytes: buffer.length,
          retries: attempt - 1,
          error: `HTTP ${res.status}: ${errorText}`
        };
      }

      // Exponential backoff + jitter
      const backoffMs = Math.round(Math.pow(2, attempt) * 500 + Math.random() * 500);
      await new Promise(r => setTimeout(r, backoffMs));
    } catch (netErr) {
      const elapsed = Math.round(performance.now() - start);
      attempt++;
      if (attempt > maxRetries) {
        return {
          success: false,
          status: 0,
          duration: elapsed,
          bytes: buffer.length,
          retries: attempt - 1,
          error: netErr.message
        };
      }
      const backoffMs = Math.round(Math.pow(2, attempt) * 500 + Math.random() * 500);
      await new Promise(r => setTimeout(r, backoffMs));
    }
  }
}

// Simulated User Task
async function simulateUser(userId, numPhotos, delayBeforeStartMs, records) {
  if (delayBeforeStartMs > 0) {
    await new Promise(r => setTimeout(r, delayBeforeStartMs));
  }

  // User takes N photos with random 1-4s gap between photos
  for (let photoIdx = 1; photoIdx <= numPhotos; photoIdx++) {
    const now = new Date();
    const isoTime = now.toISOString().replace(/[:.]/g, '-');
    const rand = crypto.randomBytes(4).toString('hex');
    const filePath = `${testEventId}/${CONFIG.EVENT_DATE}_${isoTime}_${rand}.jpg`;

    // 600 - 900 KB random size
    const sizeKb = Math.floor(600 + Math.random() * 300);
    const jpegBuffer = generateRealisticJpeg(now, sizeKb);

    const record = await uploadWithRetry(filePath, jpegBuffer);
    record.userId = userId;
    record.photoIdx = photoIdx;
    record.filePath = filePath;
    record.timestamp = new Date().toISOString();
    records.push(record);

    if (record.success) {
      process.stdout.write('\x1b[32m.\x1b[0m');
    } else {
      process.stdout.write(`\x1b[31m[x:${record.error}]\x1b[0m`);
    }

    // Gap between photos: 1-4 seconds
    if (photoIdx < numPhotos) {
      const gapMs = Math.floor(1000 + Math.random() * 3000);
      await new Promise(r => setTimeout(r, gapMs));
    }
  }
}

// Main Runner
async function run() {
  const records = [];
  const testStart = performance.now();

  console.log(`Executing test scenario: ${scenario}...`);

  if (scenario === 'spike') {
    for (let round = 1; round <= SPIKE_ROUNDS; round++) {
      console.log(`\n--- Spike Round ${round}/${SPIKE_ROUNDS} (all ${NUM_USERS} simultaneous) ---`);
      const tasks = [];
      for (let u = 1; u <= NUM_USERS; u++) {
        tasks.push(simulateUser(`user-${round}-${u}`, 1, 0, records));
      }
      await Promise.all(tasks);
      if (round < SPIKE_ROUNDS) {
        console.log(`\nPausing 3s before next spike...`);
        await new Promise(r => setTimeout(r, 3000));
      }
    }
  } else if (scenario === 'ramp') {
    // 30 users join over 60 seconds (each user starts at u * (60s / 30) = u * 2000ms)
    const tasks = [];
    const stepMs = Math.floor(60000 / NUM_USERS);
    for (let u = 1; u <= NUM_USERS; u++) {
      const delayMs = (u - 1) * stepMs;
      tasks.push(simulateUser(`user-${u}`, PHOTOS_PER_USER, delayMs, records));
    }
    await Promise.all(tasks);
  } else {
    // 'burst': all 30 start in the exact same second
    const tasks = [];
    for (let u = 1; u <= NUM_USERS; u++) {
      tasks.push(simulateUser(`user-${u}`, PHOTOS_PER_USER, 0, records));
    }
    await Promise.all(tasks);
  }

  const totalTimeSec = ((performance.now() - testStart) / 1000).toFixed(2);
  const successes = records.filter(r => r.success);
  const failures = records.filter(r => !r.success);
  const firstAttemptSuccesses = records.filter(r => r.success && r.retries === 0);
  const retriedSuccesses = records.filter(r => r.success && r.retries > 0);

  const totalBytes = records.reduce((acc, r) => acc + (r.bytes || 0), 0);
  const totalMB = (totalBytes / (1024 * 1024)).toFixed(2);

  const durations = successes.map(r => r.duration).sort((a, b) => a - b);
  const p50 = durations[Math.floor(durations.length * 0.50)] || 0;
  const p95 = durations[Math.floor(durations.length * 0.95)] || 0;
  const maxLat = durations[durations.length - 1] || 0;

  // Errors grouped
  const errorMap = {};
  failures.forEach(f => {
    errorMap[f.error] = (errorMap[f.error] || 0) + 1;
  });

  console.log(`\n\n=================================================`);
  console.log(`📊 RESULTS TABLE (${scenario.toUpperCase()})`);
  console.log(`=================================================`);
  console.log(`Users                : ${NUM_USERS}`);
  console.log(`Uploads Attempted    : ${records.length}`);
  console.log(`Uploads Succeeded    : ${successes.length} (${((successes.length / records.length) * 100).toFixed(1)}%)`);
  console.log(`First-Attempt Success: ${firstAttemptSuccesses.length} (${((firstAttemptSuccesses.length / records.length) * 100).toFixed(1)}%)`);
  console.log(`Retried Successes    : ${retriedSuccesses.length}`);
  console.log(`Failed Uploads       : ${failures.length}`);
  console.log(`Total Data Uploaded  : ${totalMB} MB`);
  console.log(`Elapsed Wall Time    : ${totalTimeSec}s`);
  console.log(`Latency (p50)        : ${p50} ms`);
  console.log(`Latency (p95)        : ${p95} ms`);
  console.log(`Latency (Max)        : ${maxLat} ms`);
  if (failures.length > 0) {
    console.log(`Errors Grouped:`, errorMap);
  }
  console.log(`=================================================\n`);

  // Write results to loadtest/results/<timestamp>.json & .md
  const resultsDir = path.resolve(process.cwd(), 'loadtest/results');
  if (!fs.existsSync(resultsDir)) {
    fs.mkdirSync(resultsDir, { recursive: true });
  }

  const rawJsonPath = path.join(resultsDir, `${testTimestamp}.json`);
  const summaryMdPath = path.join(resultsDir, `${testTimestamp}.md`);

  const summaryData = {
    testTimestamp,
    testEventId,
    scenario,
    users: NUM_USERS,
    photosPerUser: PHOTOS_PER_USER,
    attempted: records.length,
    succeeded: successes.length,
    firstAttemptSucceeded: firstAttemptSuccesses.length,
    retried: retriedSuccesses.length,
    failed: failures.length,
    totalMB,
    totalTimeSec,
    latency: { p50, p95, max: maxLat },
    errorMap,
    records
  };

  fs.writeFileSync(rawJsonPath, JSON.stringify(summaryData, null, 2));

  const mdReport = `# Load Test Results - Scenario: ${scenario.toUpperCase()}
**Timestamp**: ${new Date(testTimestamp).toISOString()}  
**Test Event ID**: \`${testEventId}\`

| Metric | Result | Target / Threshold |
| :--- | :--- | :--- |
| **Total Users** | ${NUM_USERS} | 30 concurrent |
| **Uploads Attempted** | ${records.length} | - |
| **Success Rate** | ${((successes.length / records.length) * 100).toFixed(1)}% (${successes.length}/${records.length}) | 100% |
| **First-Attempt Success** | ${((firstAttemptSuccesses.length / records.length) * 100).toFixed(1)}% | ≥ 98% |
| **Retried & Succeeded** | ${retriedSuccesses.length} | 0 lost photos |
| **Failures** | ${failures.length} | 0 |
| **Latency p50** | ${p50} ms | - |
| **Latency p95** | ${p95} ms | < 8,000 ms |
| **Latency Max** | ${maxLat} ms | - |
| **Total Upload Volume** | ${totalMB} MB | < 200 MB |

### Errors
${Object.keys(errorMap).length === 0 ? "None. Zero HTTP 429 rate limits or 5xx server errors." : JSON.stringify(errorMap, null, 2)}
`;

  fs.writeFileSync(summaryMdPath, mdReport);
  console.log(`Saved raw data to: ${rawJsonPath}`);
  console.log(`Saved Markdown report to: ${summaryMdPath}`);
  console.log(`\nTo cleanup test event photos, run:`);
  console.log(`  node loadtest/cleanup.mjs ${testEventId}`);
}

run().catch(err => {
  console.error("Fatal test error:", err);
  process.exit(1);
});
