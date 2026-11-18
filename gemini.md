sasPrompt: Disposable Camera Web App
Build brief for a coding assistant · prepared November 18, 2026
How to use this document
Do the one-time setup in section 2 (about 15 minutes), then paste the prompt from section 3 into Claude Code or any coding assistant, along with the values it asks for. Section 4 is the checklist to verify the result before the event, and section 5 covers getting the photos onto your local drive or Google Drive afterwards.
1. Stack decision
The goal was reliable, free, and comfortable with 30 people at once. I checked current pricing, and it changed my earlier suggestion.
• Frontend: static HTML, CSS and JavaScript hosted on Cloudflare Pages, GitHub Pages or Netlify. Free, HTTPS included, no card needed.
• Photo storage: Supabase Storage on the free plan. No payment method required, 1 GB of file storage, 50 MB per file. Free projects pause after 7 days of inactivity, so create the project (or open it) within a week of the event.
• Capacity check: 30 guests × 24 photos × about 400 KB is roughly 290 MB, well under the 1 GB limit. Each photo is a small independent upload, so 30 people shooting at once is not a problem.
• Why not Firebase Storage: since February 2026 it requires the pay-as-you-go Blaze plan (a card on file), even for tiny usage.
• Why not Cloudflare R2: the free 10 GB is generous, but R2 needs a payment method to activate.
• Why not direct-to-Google-Drive: uploading needs a Google sign-in, which you don't want guests to do. Google Apps Script writing to a Drive folder works as a fallback, but its limit of about 30 simultaneous executions leaves no headroom.
• Open-source libraries: supabase-js (upload), piexifjs (writes EXIF metadata into JPEGs, MIT licence). Filters are hand-written canvas code with no dependency, because the simpler ctx.filter approach doesn't work reliably on iPhone Safari.
2. One-time setup (you do this)
1.  Create a free account and a new project at supabase.com. Choose the region nearest your guests.
2.  In the SQL editor, run the following. It creates a private bucket that only accepts JPEG files up to 5 MB, and lets the public key insert files but not list, read or delete them:
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('event-photos', 'event-photos', false, 5242880, array['image/jpeg']);

create policy "guests can upload photos"
on storage.objects for insert to anon
with check (bucket_id = 'event-photos');
3.  From Project Settings → API, copy the project URL and the anon public key. The anon key is designed to be public. Never put the service_role key in the website.
4.  Decide your event values: event name, event date (YYYY-MM-DD), and a short event ID (for example priya-wedding-2026).
5.  Create a free Cloudflare Pages, GitHub Pages or Netlify account for hosting.
3. The prompt (paste this)
You are building a small, reliable, zero-cost static web app that works like a disposable camera for one event. Guests scan a QR code, the page opens a camera viewfinder, they take a photo, review it, optionally pick a filter, confirm, and the photo uploads to Supabase Storage. Up to 30 guests may use it at the same time. There is no custom backend.
Values I will give you: SUPABASE_URL, SUPABASE_ANON_KEY, bucket name event-photos, EVENT_NAME, EVENT_DATE (YYYY-MM-DD), EVENT_ID.
Technical constraints
• Plain HTML, CSS and JavaScript (ES modules). No build step. Third-party libraries load from a CDN script tag pinned to an exact version: @supabase/supabase-js and piexifjs.
• Must work on iOS Safari (16+) and Android Chrome. HTTPS only (required for camera access).
• All settings live in one config.js: SUPABASE_URL, SUPABASE_ANON_KEY, BUCKET, EVENT_NAME, EVENT_DATE, EVENT_ID, MAX_SHOTS (0 means unlimited), MAX_LONG_EDGE (default 1600), JPEG_QUALITY (default 0.8).
• Files to produce: index.html, style.css, app.js, config.js, README.md, plus the scripts listed under Deliverables.
Look and feel
Plain camera app, nothing fancy. Full-screen black page. A live viewfinder fills the screen. A bottom bar has a large round white shutter button in the centre and a small flip-camera button (front and back) at one side. If MAX_SHOTS is set, show a small shots-remaining counter. Tap targets are at least 44 px. No logos, animations or decorative elements beyond a brief shutter flash.
Flow (three states)
1.  Camera: live viewfinder, shutter, flip.
2.  Review: the captured photo fills the screen. Show a horizontal strip of filter choices below it, with a live preview of the selected filter. Two clear buttons: Retake (discard and return to camera) and Use photo (confirm and upload). Nothing is uploaded until the guest taps Use photo.
3.  After confirming: show a short "Saved ✓" message and return straight to the camera while the upload continues in the background.
Camera handling
• Use getUserMedia with facingMode: environment by default, ideal resolution 1920×1080, and the playsinline, muted and autoplay attributes on the video element.
• If permission is denied or the camera is unavailable, show a plain-language message and fall back to <input type="file" accept="image/*" capture="environment">. Photos from the fallback must be orientation-corrected (for example createImageBitmap with imageOrientation: 'from-image').
• Stop the camera stream when the tab is hidden and restart it when the tab returns.
• Capture by drawing the video frame to a canvas, scaled so the longer edge is at most MAX_LONG_EDGE.
Filters
Implement 5 filters as pure canvas pixel operations (do not rely on ctx.filter, which Safari does not support reliably): Original, Black & White, Sepia, Vintage (warm tone, lifted blacks, light vignette and film grain) and Vivid (more contrast and saturation). The review preview may use a downscaled copy for speed, but the uploaded image applies the filter at full size.
Metadata (important)
Canvas export strips EXIF, so write it back with piexifjs after the final JPEG is produced. Every uploaded photo must contain:
• DateTimeOriginal: EVENT_DATE combined with the guest's real local capture time (HH:MM:SS), in EXIF format YYYY:MM:DD HH:MM:SS.
• DateTimeDigitized: same value as DateTimeOriginal.
• DateTime: the actual capture date and time.
• ImageDescription: EVENT_NAME – EVENT_DATE.
• UserComment: the EVENT_ID.
• Software: Disposable Camera Web App.
The photo must still sort correctly by date in Google Photos, Apple Photos and Windows Explorer.
Upload reliability
• Compress before upload (target roughly 300–500 KB per photo).
• Use unique file paths: EVENT_ID/EVENT_DATE_<ISO time>_<8 random chars>.jpg. Use upsert: false so nothing is ever overwritten.
• Put every confirmed photo in an IndexedDB queue first, then upload in the background with a concurrency of 2. Remove a photo from the queue only after the upload succeeds.
• On failure, retry with exponential backoff and jitter, and keep retrying when the connection returns. Queued photos must survive a page reload or an accidental tab close.
• Show a small status line such as "3 uploaded · 1 waiting". Never block the guest from taking the next photo.
• If MAX_SHOTS is set, count confirmed photos in localStorage and disable the shutter at the limit with a friendly message.
Security
The anon key is public by design. The bucket is private with an insert-only policy, a 5 MB limit and a JPEG-only restriction (already configured). The client must never list, read or delete bucket contents, and must never contain a service-role key.
Deliverables
1.  The app files above, ready to deploy to a static host.
2.  README.md: deploy steps for Cloudflare Pages and GitHub Pages, and how to change the event values.
3.  scripts/make-qr.mjs: Node script that takes the deployed URL and writes a high-resolution QR code PNG.
4.  scripts/download-all.mjs: Node script that reads SUPABASE_URL and the service-role key from environment variables (never committed) and downloads every photo for an EVENT_ID into a local ./photos folder, 5 at a time, skipping files already downloaded.
5.  scripts/load-test.mjs: Node script that simulates 30 guests uploading 400 KB JPEGs at the same time (several each) and reports success rate and slowest upload.
6.  A short test plan I can follow on a real iPhone and a real Android phone.
4. Acceptance checklist
Run these before the event, on a real iPhone and a real Android phone, not just a desktop browser.
• The QR code opens the page, and the camera permission prompt appears and works.
• Retake discards the photo and nothing is uploaded. Use photo uploads exactly once.
• All five filters visibly change the photo, and the uploaded file matches what the preview showed.
• Open an uploaded file with an EXIF viewer (for example exiftool photo.jpg) and confirm the event date, description and event ID are present.
• Switch the phone to airplane mode, take 3 photos, then turn the network back on. All 3 should arrive.
• Reload the page mid-upload. Queued photos still arrive.
• Run load-test.mjs against your Supabase project. Expect 100% success with no failed uploads.
• Check the Supabase dashboard storage usage afterward to confirm you are comfortably under 1 GB.
• Confirm the project is active (not paused) the day before the event.
5. After the event: getting the photos
• To your local drive: run scripts/download-all.mjs with your service-role key as an environment variable. Everything lands in ./photos. You can also download from the Supabase dashboard, though the script is faster for hundreds of files.
• To Google Drive: after downloading, drag the photos folder into Drive, or use the Drive desktop app to sync it. Keep a second copy in case.
• Keep the service-role key private. Use it only on your own computer, and rotate it if it is ever exposed.
Optional extras
• Burn a small date stamp into the corner of each photo, like film cameras do.
• A thank-you screen once a guest reaches their shot limit.
• A second QR code that links to a read-only gallery after the event.