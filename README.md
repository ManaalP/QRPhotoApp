# 📸 Disposable Camera Web App

A small, reliable, zero-cost static web app that acts like a disposable camera for events (weddings, parties, reunions). Guests scan a QR code on their phone, take photos with a simple retro camera interface, optionally pick a filter, and upload directly to private Supabase Storage in the background.

Works seamlessly on **iOS Safari (16+)** and **Android Chrome** with no build tools, no app store downloads, and zero ongoing server costs.

---

## 🛠️ 1. Quick Setup (Supabase)

1. Sign up for a free account at [supabase.com](https://supabase.com) and create a new project. Choose the region closest to your event location.
2. Open the **SQL Editor** in your Supabase dashboard and run the following script:

```sql
-- 1. Create a private bucket restricted to JPEGs under 5 MB
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('event-photos', 'event-photos', false, 5242880, array['image/jpeg']);

-- 2. Allow anonymous guests to upload without listing, reading, or deleting existing files
create policy "guests can upload photos"
on storage.objects for insert to anon
with check (bucket_id = 'event-photos');
```

3. Go to **Project Settings → API**:
   - Copy the **Project URL**.
   - Copy the **anon / public** key. *(Never put the service_role key into the client app).*

---

## ⚙️ 2. Configuration (`config.js`)

Open [config.js](file:///home/manaal/Projects/QRPhotoApp/config.js) and customize the values:

```javascript
export const CONFIG = {
  // Supabase Credentials
  SUPABASE_URL: "https://your-project.supabase.co",
  SUPABASE_ANON_KEY: "your-anon-public-key",
  BUCKET: "event-photos",

  // Event Details
  EVENT_NAME: "Sarah & Alex's Wedding",
  EVENT_DATE: "2026-11-18", // Format: YYYY-MM-DD
  EVENT_ID: "wedding-2026",

  // Camera & Image Constraints
  MAX_SHOTS: 0,             // 0 for unlimited, or e.g. 24 for classic film roll feel
  MAX_LONG_EDGE: 1600,      // Max width/height in px (keeps photos ~300-500 KB)
  JPEG_QUALITY: 0.8,        // Compression quality
  DATE_STAMP_ENABLED: true  // Vintage orange date stamp in bottom right
};
```

---

## 🚀 3. Deployment

Because this is a pure static web app (plain HTML, CSS, and ES modules), you can deploy it to any free static web hosting service in seconds. **HTTPS is required for mobile browsers to allow camera access.**

### Option A: Cloudflare Pages (Recommended)
1. Push this repository to GitHub or upload the folder directly via the Cloudflare dashboard.
2. Log into [dash.cloudflare.com](https://dash.cloudflare.com) → **Workers & Pages** → **Create application** → **Pages**.
3. Choose **Upload assets** or connect your Git repository.
4. Leave build settings empty (Build command: none, Output directory: root `/`).
5. Deploy. You will get a free `https://<app-name>.pages.dev` URL.

### Option B: GitHub Pages
1. Push this repository to a GitHub repository.
2. Go to **Settings** → **Pages**.
3. Under **Build and deployment**, select **Source: Deploy from a branch**.
4. Select `main` branch and `/ (root)` folder, then click **Save**.
5. Your app will be live at `https://<username>.github.io/<repo-name>/`.

### Option C: Netlify
1. Drag and drop this project directory into [app.netlify.com/drop](https://app.netlify.com/drop).
2. It goes live instantly with an HTTPS URL.

---

## 📦 4. Helper Scripts

First, install local dependencies for the utility scripts:
```bash
npm install
```

### 1. Generate High-Resolution QR Code
Generate a print-ready QR code pointing to your deployed site:
```bash
node scripts/make-qr.mjs https://my-event.pages.dev event-qr.png
```
You can print `event-qr.png` on table cards, welcome signs, or photo booths.

### 2. Load Testing (Simulate 30 Concurrent Guests)
Verify that your Supabase storage setup can comfortably handle 30 guests uploading photos simultaneously:
```bash
SUPABASE_URL="https://your-project.supabase.co" \
SUPABASE_ANON_KEY="your-anon-key" \
node scripts/load-test.mjs 30 2
```
This tests 30 simulated guests uploading 2 JPEGs (~400 KB each) at the exact same moment.

### 3. Downloading All Photos After the Event
To download all guest photos to your local computer into `./photos`:
```bash
SUPABASE_URL="https://your-project.supabase.co" \
SUPABASE_SERVICE_ROLE_KEY="your-secret-service-role-key" \
node scripts/download-all.mjs
```
- Skips files that have already been downloaded.
- Downloads 5 files concurrently.
- Once downloaded, you can drag `./photos` into Google Drive, Apple Photos, or Dropbox.
> ⚠️ **Security Warning**: The `service_role` key bypasses row-level security. Never commit it or share it. Use it only locally on your machine.

---

## 📋 5. Acceptance & Testing Plan

Follow these steps on a real iPhone and Android device before your event:

1. **Camera Permission & Viewfinder**:
   - Scan the QR code or open the HTTPS URL in Safari/Chrome.
   - Verify the browser camera permission dialog appears and accepting it starts the full-screen viewfinder.
   - Test the flip camera button (front and back).

2. **Capture & Review Flow**:
   - Tap the shutter button; verify the subtle white flash and the transition to the review screen.
   - Tap through the 5 filters: **Original**, **Black & White**, **Sepia**, **Vintage**, and **Vivid**. Confirm the preview updates immediately.
   - Tap **Retake**: confirm the photo is discarded and the camera viewfinder restarts without anything uploaded.
   - Take another photo and tap **Use photo**: confirm the screen displays "Saved ✓" and immediately returns to the camera.

3. **Background Upload & Offline Reliability**:
   - Put the phone in **Airplane Mode** (no Wi-Fi / cellular).
   - Take 3 photos and confirm each with **Use photo**.
   - Notice the status counter indicates e.g. `0 uploaded · 3 waiting`.
   - Close the browser tab or refresh the page.
   - Reopen the app: confirm the queue is persisted in IndexedDB.
   - Turn Airplane Mode off: observe the status counter update to `3 uploaded` automatically.

4. **EXIF Metadata Verification**:
   - Download a sample photo using `download-all.mjs` or from the Supabase dashboard.
   - Inspect with `exiftool photo.jpg` or an EXIF viewer:
     - `DateTimeOriginal` / `DateTime`: Event date and local capture time.
     - `ImageDescription`: `${CONFIG.EVENT_NAME} – ${CONFIG.EVENT_DATE}`.
     - `UserComment`: `${CONFIG.EVENT_ID}`.
     - `Software`: `Disposable Camera Web App`.
   - Import the photo into Google Photos or Apple Photos to verify correct chronological sorting.

5. **Shot Limit (if enabled)**:
   - Set `MAX_SHOTS: 3` in `config.js` for testing.
   - Take 3 photos. Confirm the counter counts down (`3 left`, `2 left`, `1 left`).
   - On the 3rd shot, verify the shutter disables and the "Film Finished!" thank-you modal appears.

6. **Event Day Readiness**:
   - Ensure your Supabase project is active (free projects pause after 7 days of inactivity; wake it up in the dashboard a day before the event).
