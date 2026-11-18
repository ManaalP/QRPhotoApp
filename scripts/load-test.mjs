#!/usr/bin/env node

/**
 * scripts/load-test.mjs
 * Simulates 30 guests uploading ~400 KB JPEGs simultaneously (several uploads each).
 * Measures and reports success rate, concurrency behavior, and slowest upload times.
 *
 * Usage:
 *   SUPABASE_URL="https://xxx.supabase.co" SUPABASE_ANON_KEY="eyJ..." node scripts/load-test.mjs [guests] [shotsPerGuest]
 *   Or configure in config.js / .env
 */

import { createClient } from '@supabase/supabase-js';
import crypto from 'node:crypto';
import 'dotenv/config';

let defaultUrl = process.env.SUPABASE_URL;
let defaultAnonKey = process.env.SUPABASE_ANON_KEY;
let defaultBucket = process.env.BUCKET || 'event-photos';
let defaultEventId = process.env.EVENT_ID || 'load-test-sim';

try {
  const configModule = await import('../config.js');
  if (configModule.CONFIG) {
    if (!defaultUrl) defaultUrl = configModule.CONFIG.SUPABASE_URL;
    if (!defaultAnonKey) defaultAnonKey = configModule.CONFIG.SUPABASE_ANON_KEY;
    if (!process.env.BUCKET && configModule.CONFIG.BUCKET) defaultBucket = configModule.CONFIG.BUCKET;
  }
} catch (e) {}

const supabaseUrl = process.env.SUPABASE_URL || defaultUrl;
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY || defaultAnonKey;
const bucketName = process.env.BUCKET || defaultBucket;
const eventId = process.env.EVENT_ID || defaultEventId;

const NUM_GUESTS = parseInt(process.argv[2] || '30', 10);
const SHOTS_PER_GUEST = parseInt(process.argv[3] || '2', 10);

if (!supabaseUrl || !supabaseAnonKey || supabaseUrl.includes('your-project')) {
  console.error('\x1b[31mError: Please set SUPABASE_URL and SUPABASE_ANON_KEY in config.js or env variables.\x1b[0m');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: { persistSession: false }
});

// Generate a valid mock JPEG buffer of ~400KB
function generateMockJpegBuffer(targetBytes = 400 * 1024) {
  // Minimal JPEG header SOI (FF D8) + APP0 (FF E0) + DQT + SOF + SOS ... EOI (FF D9)
  // We produce a standard valid JPEG header prefix followed by binary padding and EOI trailer.
  const header = Buffer.from([
    0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01,
    0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xdb, 0x00, 0x43,
    0x00, 0x08, 0x06, 0x06, 0x07, 0x06, 0x05, 0x08, 0x07, 0x07, 0x07, 0x09,
    0x09, 0x08, 0x0a, 0x0c, 0x14, 0x0d, 0x0c, 0x0b, 0x0b, 0x0c, 0x19, 0x12,
    0x13, 0x0f, 0x14, 0x1d, 0x1a, 0x1f, 0x1e, 0x1d, 0x1a, 0x1c, 0x1c, 0x20,
    0x24, 0x2e, 0x27, 0x20, 0x22, 0x2c, 0x23, 0x1c, 0x1c, 0x28, 0x37, 0x29,
    0x2c, 0x30, 0x31, 0x34, 0x34, 0x34, 0x1f, 0x27, 0x39, 0x3d, 0x38, 0x32,
    0x3c, 0x2e, 0x33, 0x34, 0x32, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x10,
    0x00, 0x10, 0x01, 0x01, 0x11, 0x00, 0xff, 0xda, 0x00, 0x08, 0x01, 0x01,
    0x00, 0x00, 0x3f, 0x00
  ]);
  const trailer = Buffer.from([0xff, 0xd9]);

  const paddingLength = Math.max(0, targetBytes - header.length - trailer.length);
  // Fill padding with pseudo-random bytes
  const padding = crypto.randomBytes(paddingLength);
  // Ensure no rogue 0xFF 0xD9 or 0xFF inside simple entropy stream
  for (let i = 0; i < padding.length; i++) {
    if (padding[i] === 0xff) padding[i] = 0xfe;
  }

  return Buffer.concat([header, padding, trailer]);
}

async function simulateGuest(guestIndex, totalShots, results) {
  const sampleJpeg = generateMockJpegBuffer(400 * 1024);

  for (let shot = 1; shot <= totalShots; shot++) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const rand = crypto.randomBytes(4).toString('hex');
    const fileName = `${eventId}/guest_${guestIndex}_shot_${shot}_${timestamp}_${rand}.jpg`;

    const start = performance.now();
    try {
      const { data, error } = await supabase.storage
        .from(bucketName)
        .upload(fileName, sampleJpeg, {
          contentType: 'image/jpeg',
          upsert: false
        });

      const elapsed = Math.round(performance.now() - start);

      if (error) {
        results.push({ success: false, elapsed, error: error.message, guestIndex, shot });
        process.stdout.write('\x1b[31m✖\x1b[0m');
      } else {
        results.push({ success: true, elapsed, guestIndex, shot });
        process.stdout.write('\x1b[32m.\x1b[0m');
      }
    } catch (err) {
      const elapsed = Math.round(performance.now() - start);
      results.push({ success: false, elapsed, error: err.message, guestIndex, shot });
      process.stdout.write('\x1b[31m✖\x1b[0m');
    }
  }
}

async function runLoadTest() {
  const totalUploads = NUM_GUESTS * SHOTS_PER_GUEST;
  console.log(`\n=================================================`);
  console.log(`🚀 Supabase Storage Load Test`);
  console.log(`=================================================`);
  console.log(`Target URL        : ${supabaseUrl}`);
  console.log(`Bucket            : ${bucketName}`);
  console.log(`Simulated Guests  : ${NUM_GUESTS}`);
  console.log(`Shots per Guest   : ${SHOTS_PER_GUEST}`);
  console.log(`Total Uploads     : ${totalUploads} (~${Math.round((totalUploads * 400) / 1024)} MB)`);
  console.log(`Concurrency       : ${NUM_GUESTS} parallel connections`);
  console.log(`-------------------------------------------------\nProgress: `);

  const results = [];
  const overallStart = performance.now();

  // Launch all guests concurrently
  const guestTasks = [];
  for (let i = 1; i <= NUM_GUESTS; i++) {
    guestTasks.push(simulateGuest(i, SHOTS_PER_GUEST, results));
  }

  await Promise.all(guestTasks);

  const overallElapsed = ((performance.now() - overallStart) / 1000).toFixed(2);
  const successes = results.filter(r => r.success);
  const failures = results.filter(r => !r.success);
  const successRate = ((successes.length / totalUploads) * 100).toFixed(1);

  const times = successes.map(r => r.elapsed).sort((a, b) => a - b);
  const minTime = times[0] || 0;
  const maxTime = times[times.length - 1] || 0;
  const avgTime = times.length ? Math.round(times.reduce((a, b) => a + b, 0) / times.length) : 0;
  const p95Time = times[Math.floor(times.length * 0.95)] || 0;

  console.log(`\n\n=================================================`);
  console.log(`📊 Load Test Summary`);
  console.log(`=================================================`);
  console.log(`Total Time Taken  : ${overallElapsed}s`);
  console.log(`Success Rate      : ${successRate}% (${successes.length}/${totalUploads})`);
  if (failures.length > 0) {
    console.log(`\x1b[31mFailed Uploads    : ${failures.length}\x1b[0m`);
    console.log(`Sample Error      : ${failures[0].error}`);
  }
  console.log(`Fastest Upload    : ${minTime} ms`);
  console.log(`Average Upload    : ${avgTime} ms`);
  console.log(`95th Percentile   : ${p95Time} ms`);
  console.log(`Slowest Upload    : ${maxTime} ms`);
  console.log(`=================================================\n`);

  if (failures.length > 0) {
    process.exit(1);
  }
}

runLoadTest();
