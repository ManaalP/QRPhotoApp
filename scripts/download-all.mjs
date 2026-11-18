#!/usr/bin/env node

/**
 * scripts/download-all.mjs
 * Downloads all photos for an EVENT_ID from Supabase Storage into ./photos
 * Concurrency: 5 at a time, skipping already downloaded files.
 *
 * Environment variables:
 *   SUPABASE_URL (e.g. https://xyz.supabase.co)
 *   SUPABASE_SERVICE_ROLE_KEY (Secret service role key - never commit or expose on frontend!)
 *   EVENT_ID (optional, defaults to config.js or env)
 *   BUCKET (optional, defaults to 'event-photos')
 *
 * Usage:
 *   SUPABASE_URL="https://xxx.supabase.co" SUPABASE_SERVICE_ROLE_KEY="eyJ..." node scripts/download-all.mjs
 *   Or create a local .env file.
 */

import { createClient } from '@supabase/supabase-js';
import fs from 'node:fs';
import path from 'node:path';
import 'dotenv/config';

// Try reading defaults from config.js if not provided in env
let defaultEventId = process.env.EVENT_ID;
let defaultBucket = process.env.BUCKET || 'event-photos';

try {
  const configModule = await import('../config.js');
  if (configModule.CONFIG) {
    if (!defaultEventId) defaultEventId = configModule.CONFIG.EVENT_ID;
    if (!process.env.BUCKET && configModule.CONFIG.BUCKET) defaultBucket = configModule.CONFIG.BUCKET;
  }
} catch (e) {
  // config.js not found or unparseable, continue with env
}

const supabaseUrl = process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const eventId = process.env.EVENT_ID || defaultEventId;
const bucketName = process.env.BUCKET || defaultBucket;

if (!supabaseUrl || !serviceRoleKey) {
  console.error('\x1b[31mError: Missing required environment variables.\x1b[0m');
  console.error('Please define:');
  console.error('  SUPABASE_URL');
  console.error('  SUPABASE_SERVICE_ROLE_KEY');
  console.error('\nExample:');
  console.error('  SUPABASE_URL="https://xxx.supabase.co" SUPABASE_SERVICE_ROLE_KEY="sb_secret_..." node scripts/download-all.mjs\n');
  process.exit(1);
}

if (!eventId) {
  console.error('\x1b[31mError: EVENT_ID is not defined in env or config.js.\x1b[0m');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, serviceRoleKey, {
  auth: { persistSession: false }
});

const outputDir = path.resolve(process.cwd(), 'photos');

// Helper to list all files recursively or with pagination in the folder
async function listAllFiles(folder) {
  let allFiles = [];
  let page = 0;
  const limit = 100;

  while (true) {
    const { data, error } = await supabase.storage
      .from(bucketName)
      .list(folder, {
        limit,
        offset: page * limit,
        sortBy: { column: 'name', order: 'asc' }
      });

    if (error) throw error;
    if (!data || data.length === 0) break;

    // Supabase list returns both files and placeholders
    const files = data.filter(item => item.id !== null && item.metadata);
    allFiles = allFiles.concat(files);

    if (data.length < limit) break;
    page++;
  }

  return allFiles;
}

// Download a single file
async function downloadFile(item, index, total) {
  const remotePath = `${eventId}/${item.name}`;
  const localFilePath = path.join(outputDir, item.name);

  // Skip if already exists and has non-zero size
  if (fs.existsSync(localFilePath)) {
    const stats = fs.statSync(localFilePath);
    if (stats.size > 0) {
      console.log(`[${index + 1}/${total}] ⏩ Skipping (already exists): ${item.name}`);
      return;
    }
  }

  try {
    const { data, error } = await supabase.storage
      .from(bucketName)
      .download(remotePath);

    if (error) throw error;

    const buffer = Buffer.from(await data.arrayBuffer());
    fs.writeFileSync(localFilePath, buffer);
    console.log(`[${index + 1}/${total}] ✔ Downloaded: ${item.name} (${Math.round(buffer.length / 1024)} KB)`);
  } catch (err) {
    console.error(`[${index + 1}/${total}] ✖ Failed to download ${item.name}:`, err.message);
  }
}

// Concurrency pool runner
async function runConcurrent(items, concurrency, fn) {
  let index = 0;
  const total = items.length;

  const workers = Array.from({ length: concurrency }, async () => {
    while (index < total) {
      const currentIndex = index++;
      await fn(items[currentIndex], currentIndex, total);
    }
  });

  await Promise.all(workers);
}

async function main() {
  console.log(`\n📷 Connecting to Supabase storage...`);
  console.log(`   Bucket   : ${bucketName}`);
  console.log(`   Event ID : ${eventId}`);
  console.log(`   Target   : ${outputDir}\n`);

  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  try {
    const files = await listAllFiles(eventId);
    console.log(`Found ${files.length} photo(s) in folder "${eventId}".\n`);

    if (files.length === 0) {
      console.log('No photos found for this event.');
      return;
    }

    const CONCURRENCY = 5;
    await runConcurrent(files, CONCURRENCY, downloadFile);

    console.log(`\n\x1b[32m✔ All downloads finished. Photos are saved in:\x1b[0m ${outputDir}\n`);
  } catch (err) {
    console.error('\x1b[31mError during download:\x1b[0m', err.message || err);
    process.exit(1);
  }
}

main();
