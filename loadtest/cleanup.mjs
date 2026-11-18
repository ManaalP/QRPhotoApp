#!/usr/bin/env node

/**
 * loadtest/cleanup.mjs
 * Deletes all files uploaded under a specific test event prefix.
 *
 * Safety:
 * - Refuses to run if prefix does not begin with "loadtest-"
 * - Never prints secret keys
 *
 * Usage:
 *   SUPABASE_SERVICE_KEY="your-secret-key" node loadtest/cleanup.mjs <test-event-id>
 */

import { createClient } from '@supabase/supabase-js';
import { CONFIG } from '../config.js';
import 'dotenv/config';

const testEventId = process.argv[2];
const serviceKey = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!testEventId) {
  console.error('\x1b[31mError: Target event prefix is required.\x1b[0m');
  console.log('Usage: SUPABASE_SERVICE_KEY="..." node loadtest/cleanup.mjs <test-event-id>');
  process.exit(1);
}

// Critical safety check: prefix must strictly start with 'loadtest-'
if (!testEventId.startsWith('loadtest-')) {
  console.error(`\x1b[31m⛔ SAFETY ERROR: Target ID "${testEventId}" does not start with "loadtest-".\x1b[0m`);
  console.error('To protect real event photos, cleanup only operates on folders starting with "loadtest-".');
  process.exit(1);
}

if (!serviceKey) {
  console.error('\x1b[31mError: SUPABASE_SERVICE_KEY environment variable is required for cleanup.\x1b[0m');
  process.exit(1);
}

const supabase = createClient(CONFIG.SUPABASE_URL, serviceKey, {
  auth: { persistSession: false }
});

const bucketName = CONFIG.BUCKET || 'event-photos';

async function cleanup() {
  console.log(`\n🧹 Starting cleanup for folder: "${testEventId}" in bucket "${bucketName}"...`);

  let allFiles = [];
  let page = 0;
  const limit = 100;

  while (true) {
    const { data, error } = await supabase.storage
      .from(bucketName)
      .list(testEventId, {
        limit,
        offset: page * limit
      });

    if (error) {
      console.error('Failed to list files:', error);
      process.exit(1);
    }

    if (!data || data.length === 0) break;
    allFiles = allFiles.concat(data);
    if (data.length < limit) break;
    page++;
  }

  if (allFiles.length === 0) {
    console.log(`No files found under "${testEventId}". Folder is already clean.`);
    return;
  }

  console.log(`Found ${allFiles.length} file(s) to delete.`);

  // Delete in batches of 100
  const pathsToDelete = allFiles.map(f => `${testEventId}/${f.name}`);
  const BATCH_SIZE = 100;
  let totalDeleted = 0;

  for (let i = 0; i < pathsToDelete.length; i += BATCH_SIZE) {
    const batch = pathsToDelete.slice(i, i + BATCH_SIZE);
    const { data, error } = await supabase.storage.from(bucketName).remove(batch);
    if (error) {
      console.error(`Error deleting batch starting at index ${i}:`, error.message);
    } else {
      totalDeleted += (data ? data.length : batch.length);
    }
  }

  console.log(`\x1b[32m✔ Cleanup complete: ${totalDeleted} file(s) deleted under "${testEventId}".\x1b[0m\n`);
}

cleanup().catch(console.error);
