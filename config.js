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
  TARGET_KB: 800, // Target compression size around 800 KB to preserve full resolution
  JPEG_QUALITY: 0.9, // High-quality starting compression
  MIN_JPEG_QUALITY: 0.75, // Quality floor
  SETTLE_TIME_MS: 600, // Stream settle time after start/flip/focus before capturing

  // Anti-Abuse Rate Limiting (RTL)
  // Prevents automated spam / rapid bot clicking while allowing normal guests to take photos freely
  MIN_CAPTURE_INTERVAL_MS: 1500, // Minimum delay between shutter presses (1.5 seconds)
  MAX_BURST_PER_MINUTE: 10, // Maximum photos allowed in any rolling 60-second window
  RATE_LIMIT_COOLDOWN_SEC: 15, // Cooldown period if bursting over the limit
  
  // Optional vintage date stamp in the bottom-right corner of the photo
  DATE_STAMP_ENABLED: true
};
