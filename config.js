// Disposable Camera App Configuration
// Replace these with your Supabase project details and event settings.

export const CONFIG = {
  // Supabase Credentials (Anon key is designed to be public)
  SUPABASE_URL: "https://dloiohsqvzwdbxrsnirx.supabase.co",
  SUPABASE_ANON_KEY: "sb_publishable_mw4XZbzeETXmXi1UEczNNw_0Pl4j3jO",
  BUCKET: "event-photos",

  // Event Details
  EVENT_NAME: "Our Celebration",
  EVENT_DATE: "2026-11-18", // Format: YYYY-MM-DD
  EVENT_ID: "celebration-2026",

  // Camera & Image Constraints
  MAX_SHOTS: 0, // 0 means unlimited, or positive integer (e.g. 24)
  MAX_LONG_EDGE: 2048, // High-res long edge (2048px preserves sharp details for photos)
  TARGET_KB: 500, // Target compression size around 500 KB to preserve full resolution
  JPEG_QUALITY: 0.85, // Starting compression quality (0.0 to 1.0)
  
  // Optional vintage date stamp in the bottom-right corner of the photo
  DATE_STAMP_ENABLED: true
};
