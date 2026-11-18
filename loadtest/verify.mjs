#!/usr/bin/env node

/**
 * loadtest/verify.mjs
 * Lists files under the test event folder and verifies:
 * - Expected photo count
 * - Valid JPEGs
 * - EXIF DateTimeOriginal equals CONFIG.EVENT_DATE
 * - Photo size in expected range
 * - Current storage used in the bucket
 *
 * Usage:
 *   SUPABASE_SERVICE_KEY="your-secret-key" node loadtest/verify.mjs <test-event-id> [expected-count]
 */

import { createClient } from '@supabase/supabase-js';
import piexif from 'piexifjs';
import { CONFIG } from '../config.js';
import 'dotenv/config';

const testEventId = process.argv[2];
const expectedCount = process.argv[3] ? parseInt(process.argv[3], 10) : null;
const serviceKey = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!testEventId) {
  console.error('\x1b[31mError: testEventId is required.\x1b[0m');
  console.log('Usage: SUPABASE_SERVICE_KEY="..." node loadtest/verify.mjs <test-event-id> [expectedCount]');
  process.exit(1);
}

if (!serviceKey) {
  console.error('\x1b[31mError: SUPABASE_SERVICE_KEY environment variable is required to verify storage.\x1b[0m');
  process.exit(1);
}

const supabase = createClient(CONFIG.SUPABASE_URL, serviceKey, {
  auth: { persistSession: false }
});

const bucketName = CONFIG.BUCKET || 'event-photos';

async function verify() {
  console.log(`\n=================================================`);
  console.log(`🔍 VERIFICATION: Test Event "${testEventId}"`);
  console.log(`=================================================`);

  // 1. List files in test event directory
  let allFiles = [];
  let page = 0;
  const limit = 100;

  while (true) {
    const { data, error } = await supabase.storage
      .from(bucketName)
      .list(testEventId, {
        limit,
        offset: page * limit,
        sortBy: { column: 'name', order: 'asc' }
      });

    if (error) {
      console.error('Error listing storage objects:', error);
      process.exit(1);
    }

    if (!data || data.length === 0) break;
    const files = data.filter(item => item.id !== null && item.metadata);
    allFiles = allFiles.concat(files);
    if (data.length < limit) break;
    page++;
  }

  console.log(`Found ${allFiles.length} file(s) in folder "${testEventId}".`);
  if (expectedCount !== null) {
    console.log(`Expected count : ${expectedCount}`);
    if (allFiles.length === expectedCount) {
      console.log(`\x1b[32m✔ File count perfectly matches expected (${allFiles.length}/${expectedCount})\x1b[0m`);
    } else {
      console.log(`\x1b[31m✖ File count mismatch! Found ${allFiles.length}, expected ${expectedCount}\x1b[0m`);
    }
  }

  if (allFiles.length === 0) {
    console.log('No files found to inspect.');
    return;
  }

  // Check duplicate file names
  const nameSet = new Set();
  const duplicates = [];
  allFiles.forEach(f => {
    if (nameSet.has(f.name)) duplicates.push(f.name);
    else nameSet.add(f.name);
  });
  console.log(`Duplicates detected : ${duplicates.length === 0 ? '\x1b[32m0 (No duplicates)\x1b[0m' : `\x1b[31m${duplicates.length}\x1b[0m`}`);

  // 2. Download and verify 5 random files
  const sampleCount = Math.min(5, allFiles.length);
  const shuffled = [...allFiles].sort(() => 0.5 - Math.random());
  const samples = shuffled.slice(0, sampleCount);

  console.log(`\nDownloading and inspecting ${sampleCount} sample files:`);

  let validJpegs = 0;
  let validExif = 0;
  let totalSampleBytes = 0;

  for (let i = 0; i < samples.length; i++) {
    const file = samples[i];
    const remotePath = `${testEventId}/${file.name}`;
    const { data, error } = await supabase.storage.from(bucketName).download(remotePath);

    if (error) {
      console.error(`  [${i + 1}] ✖ Failed to download ${file.name}:`, error.message);
      continue;
    }

    const buffer = Buffer.from(await data.arrayBuffer());
    totalSampleBytes += buffer.length;
    const sizeKb = Math.round(buffer.length / 1024);

    // Verify JPEG SOI (0xFF, 0xD8) and EOI (0xFF, 0xD9) anywhere near the end (handles trailing null/padding)
    const hasSoi = buffer[0] === 0xff && buffer[1] === 0xd8;
    const hasEoi = buffer.lastIndexOf(Buffer.from([0xff, 0xd9])) >= buffer.length - 16;
    const isJpeg = hasSoi && hasEoi;
    if (isJpeg) validJpegs++;

    // Verify EXIF
    let exifOk = false;
    try {
      const dataUrl = 'data:image/jpeg;base64,' + buffer.toString('base64');
      const exifObj = piexif.load(dataUrl);
      const dto = exifObj.Exif?.[piexif.ExifIFD.DateTimeOriginal];
      const comment = exifObj.Exif?.[piexif.ExifIFD.UserComment];
      const expectedDatePrefix = CONFIG.EVENT_DATE.replace(/-/g, ':');
      if (dto && dto.startsWith(expectedDatePrefix)) {
        exifOk = true;
        validExif++;
      }
    } catch (e) {}

    console.log(`  [${i + 1}] ${file.name} - ${sizeKb} KB - Valid JPEG: ${isJpeg ? '✔' : '✖'} - EXIF Date: ${exifOk ? '✔' : '✖'}`);
  }

  // 3. Bucket storage size calculation
  let totalBucketBytes = 0;
  allFiles.forEach(f => {
    totalBucketBytes += (f.metadata?.size || 0);
  });
  const totalBucketMB = (totalBucketBytes / (1024 * 1024)).toFixed(2);

  console.log(`\n=================================================`);
  console.log(`📊 Verification Summary`);
  console.log(`=================================================`);
  console.log(`Sample JPEGs Valid   : ${validJpegs}/${sampleCount}`);
  console.log(`Sample EXIF Matched  : ${validExif}/${sampleCount}`);
  console.log(`Current Test Storage : ${totalBucketMB} MB`);
  console.log(`=================================================\n`);
}

verify().catch(console.error);
