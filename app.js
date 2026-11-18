import { CONFIG } from './config.js';

// --- State Variables ---
let currentStream = null;
let currentFacingMode = 'environment';
let isTakingPhoto = false;

// Images in memory during review
let capturedCanvas = null; // Full resolution canvas of raw captured frame
let previewCanvas = null;  // Downscaled canvas for fast review filtering
let selectedFilter = 'Original';

// IndexedDB database instance
let db = null;
const DB_NAME = 'DisposableCameraDB';
const DB_VERSION = 1;
const STORE_NAME = 'upload_queue';

// Supabase client instance (anon client)
let supabase = null;

// Shots count tracking
const SHOTS_STORAGE_KEY = `shots_taken_${CONFIG.EVENT_ID}`;

// DOM Elements
const screenCamera = document.getElementById('camera-screen');
const screenReview = document.getElementById('review-screen');
const video = document.getElementById('camera-video');
const shutterFlash = document.getElementById('shutter-flash');
const btnShutter = document.getElementById('btn-shutter');
const btnFlip = document.getElementById('btn-flip');
const reviewCanvas = document.getElementById('review-canvas');
const filterStrip = document.getElementById('filter-strip');
const btnRetake = document.getElementById('btn-retake');
const btnUse = document.getElementById('btn-use');
const uploadStatusEl = document.getElementById('upload-status');
const shotsCounterEl = document.getElementById('shots-counter');
const shotsRemainingEl = document.getElementById('shots-remaining');
const toastEl = document.getElementById('toast');
const fallbackInput = document.getElementById('fallback-file-input');
const cameraErrorEl = document.getElementById('camera-error');
const errorMessageEl = document.getElementById('error-message');
const btnFallbackCapture = document.getElementById('btn-fallback-capture');
const limitModal = document.getElementById('limit-modal');
const modalUploadStatus = document.getElementById('modal-upload-status');

// --- Filter Definitions ---
const FILTERS = ['Original', 'Black & White', 'Sepia', 'Vintage', 'Vivid'];

// Pure canvas pixel manipulation algorithms
function applyFilterToImageData(imageData, filterName) {
  if (filterName === 'Original') return imageData;
  
  const d = imageData.data;
  const len = d.length;
  const width = imageData.width;
  const height = imageData.height;

  if (filterName === 'Black & White') {
    // High contrast black & white
    for (let i = 0; i < len; i += 4) {
      // Standard luminance
      let gray = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      // Slight contrast boost
      gray = ((gray - 128) * 1.15) + 128;
      gray = Math.max(0, Math.min(255, gray));
      d[i] = gray;
      d[i + 1] = gray;
      d[i + 2] = gray;
    }
  } else if (filterName === 'Sepia') {
    // Classic warm sepia
    for (let i = 0; i < len; i += 4) {
      const r = d[i], g = d[i + 1], b = d[i + 2];
      d[i] = Math.min(255, (r * 0.393) + (g * 0.769) + (b * 0.189));
      d[i + 1] = Math.min(255, (r * 0.349) + (g * 0.686) + (b * 0.168));
      d[i + 2] = Math.min(255, (r * 0.272) + (g * 0.534) + (b * 0.131));
    }
  } else if (filterName === 'Vintage') {
    // Vintage film: warm golden highlights, lifted blacks (faded shadows), vignette, and subtle film grain
    const centerX = width / 2;
    const centerY = height / 2;
    const maxDist = Math.sqrt(centerX * centerX + centerY * centerY);

    for (let y = 0; y < height; y++) {
      const dy = y - centerY;
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 4;
        let r = d[i], g = d[i + 1], b = d[i + 2];

        // 1. Lift blacks (fade shadows like old film paper)
        r = r * 0.85 + 30;
        g = g * 0.85 + 20;
        b = b * 0.80 + 15;

        // 2. Warm golden tint
        r = r * 1.08;
        b = b * 0.90;

        // 3. Radial vignette
        const dx = x - centerX;
        const dist = Math.sqrt(dx * dx + dy * dy) / maxDist;
        // Vignette factor starts darkening at dist > 0.4
        const vignette = 1 - Math.max(0, dist - 0.4) * 0.5;
        r *= vignette;
        g *= vignette;
        b *= vignette;

        // 4. Subtle film grain
        const grain = (Math.random() - 0.5) * 16;
        r += grain;
        g += grain;
        b += grain;

        d[i] = Math.max(0, Math.min(255, r));
        d[i + 1] = Math.max(0, Math.min(255, g));
        d[i + 2] = Math.max(0, Math.min(255, b));
      }
    }
  } else if (filterName === 'Vivid') {
    // Punchy saturation and enhanced contrast
    const contrastFactor = 1.25;
    for (let i = 0; i < len; i += 4) {
      let r = d[i], g = d[i + 1], b = d[i + 2];

      // Contrast
      r = ((r - 128) * contrastFactor) + 128;
      g = ((g - 128) * contrastFactor) + 128;
      b = ((b - 128) * contrastFactor) + 128;

      // Saturation boost
      const gray = 0.299 * r + 0.587 * g + 0.114 * b;
      r = gray + 1.35 * (r - gray);
      g = gray + 1.35 * (g - gray);
      b = gray + 1.35 * (b - gray);

      d[i] = Math.max(0, Math.min(255, r));
      d[i + 1] = Math.max(0, Math.min(255, g));
      d[i + 2] = Math.max(0, Math.min(255, b));
    }
  }

  return imageData;
}

// Draw optional classic film camera date stamp on the canvas
function drawDateStamp(ctx, width, height) {
  if (!CONFIG.DATE_STAMP_ENABLED) return;

  const now = new Date();
  const year = String(now.getFullYear()).slice(-2);
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const dateStr = `'${year} ${month} ${day}`;

  const fontSize = Math.max(16, Math.round(width * 0.024));
  ctx.save();
  ctx.font = `bold ${fontSize}px "Courier New", Courier, monospace`;
  ctx.textAlign = 'right';
  ctx.textBaseline = 'bottom';
  
  const posX = width - fontSize * 1.2;
  const posY = height - fontSize * 1.2;

  // Vintage orange-amber LCD glow
  ctx.shadowColor = 'rgba(255, 69, 0, 0.8)';
  ctx.shadowBlur = fontSize * 0.4;
  ctx.fillStyle = '#ff7b00';
  ctx.fillText(dateStr, posX, posY);

  ctx.shadowBlur = 0;
  ctx.fillStyle = '#ffb347';
  ctx.fillText(dateStr, posX, posY);
  ctx.restore();
}

// --- IndexedDB Management ---
function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = (e) => {
      const dbInstance = e.target.result;
      if (!dbInstance.objectStoreNames.contains(STORE_NAME)) {
        const store = dbInstance.createObjectStore(STORE_NAME, { keyPath: 'id' });
        store.createIndex('status', 'status', { unique: false });
        store.createIndex('createdAt', 'createdAt', { unique: false });
      }
    };
    request.onsuccess = (e) => {
      db = e.target.result;
      resolve(db);
    };
    request.onerror = (e) => reject(e.target.error);
  });
}

function addToQueue(item) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const req = store.add(item);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

function getPendingQueue() {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const req = store.getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

function removeFromQueue(id) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const req = store.delete(id);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

function updateQueueItem(item) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const req = store.put(item);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

// --- Shots Count Management ---
function getShotsCount() {
  return parseInt(localStorage.getItem(SHOTS_STORAGE_KEY) || '0', 10);
}

function incrementShotsCount() {
  const current = getShotsCount() + 1;
  localStorage.setItem(SHOTS_STORAGE_KEY, current.toString());
  updateShotsUI();
  return current;
}

function updateShotsUI() {
  if (CONFIG.MAX_SHOTS > 0) {
    shotsCounterEl.classList.remove('hidden');
    const count = getShotsCount();
    const remaining = Math.max(0, CONFIG.MAX_SHOTS - count);
    shotsRemainingEl.textContent = `${remaining} left`;

    if (count >= CONFIG.MAX_SHOTS) {
      btnShutter.disabled = true;
      limitModal.classList.remove('hidden');
    } else {
      btnShutter.disabled = false;
      limitModal.classList.add('hidden');
    }
  } else {
    shotsCounterEl.classList.add('hidden');
  }
}

// --- Background Upload Queue Manager ---
let isUploading = false;
let uploadedCount = parseInt(localStorage.getItem(`uploaded_count_${CONFIG.EVENT_ID}`) || '0', 10);

async function refreshUploadStatus() {
  if (!db) return;
  const pending = await getPendingQueue();
  const waitingCount = pending.length;
  
  const text = `${uploadedCount} uploaded${waitingCount > 0 ? ` · ${waitingCount} waiting` : ''}`;
  uploadStatusEl.textContent = text;
  if (modalUploadStatus) {
    modalUploadStatus.textContent = text;
  }
}

async function processUploadQueue() {
  if (isUploading || !db || !navigator.onLine) return;
  isUploading = true;

  try {
    const queue = await getPendingQueue();
    if (queue.length === 0) {
      isUploading = false;
      await refreshUploadStatus();
      return;
    }

    // Process with concurrency up to 2
    const CONCURRENCY = 2;
    const batch = queue.slice(0, CONCURRENCY);

    await Promise.all(batch.map(item => uploadSingleItem(item)));
  } catch (err) {
    console.error('Error processing upload queue:', err);
  } finally {
    isUploading = false;
    await refreshUploadStatus();

    // Check if more items remain
    const remaining = await getPendingQueue();
    if (remaining.length > 0 && navigator.onLine) {
      // Exponential backoff or slight delay before next chunk
      setTimeout(processUploadQueue, 600);
    }
  }
}

async function uploadSingleItem(item) {
  if (!supabase) {
    console.warn('Supabase client not initialized. Skipping upload.');
    return;
  }

  try {
    // Convert base64 dataURL back to Uint8Array/Blob
    const res = await fetch(item.dataUrl);
    const blob = await res.blob();

    // Upload to Supabase Storage with upsert: false
    const { data, error } = await supabase.storage
      .from(CONFIG.BUCKET)
      .upload(item.filePath, blob, {
        contentType: 'image/jpeg',
        upsert: false
      });

    if (error) {
      throw error;
    }

    // On success: remove from DB and increment count
    await removeFromQueue(item.id);
    uploadedCount++;
    localStorage.setItem(`uploaded_count_${CONFIG.EVENT_ID}`, uploadedCount.toString());
  } catch (err) {
    console.warn(`Upload failed for ${item.filePath}. Will retry. Reason:`, err.message || err);
    // Exponential backoff & retry tracking
    item.retries = (item.retries || 0) + 1;
    item.lastError = err.message || 'Network error';
    await updateQueueItem(item);
  }
}

// --- EXIF Metadata Injection ---
function injectExifMetadata(jpegDataUrl, captureDate) {
  if (typeof piexif === 'undefined') {
    console.warn('piexifjs not loaded, skipping EXIF insertion.');
    return jpegDataUrl;
  }

  try {
    // Format capture date/time:
    // DateTimeOriginal: EVENT_DATE combined with real local capture time (HH:MM:SS) -> YYYY:MM:DD HH:MM:SS
    const eventDateFormatted = CONFIG.EVENT_DATE.replace(/-/g, ':');
    const pad = (n) => String(n).padStart(2, '0');
    const localTimeStr = `${pad(captureDate.getHours())}:${pad(captureDate.getMinutes())}:${pad(captureDate.getSeconds())}`;
    const dateTimeOriginalStr = `${eventDateFormatted} ${localTimeStr}`;

    // Actual capture date/time
    const actYear = captureDate.getFullYear();
    const actMonth = pad(captureDate.getMonth() + 1);
    const actDay = pad(captureDate.getDate());
    const dateTimeStr = `${actYear}:${actMonth}:${actDay} ${localTimeStr}`;

    const zeroth = {};
    const exif = {};

    zeroth[piexif.ImageIFD.Make] = "Disposable Camera Web App";
    zeroth[piexif.ImageIFD.Software] = "Disposable Camera Web App";
    zeroth[piexif.ImageIFD.ImageDescription] = `${CONFIG.EVENT_NAME} – ${CONFIG.EVENT_DATE}`;
    zeroth[piexif.ImageIFD.DateTime] = dateTimeStr;

    exif[piexif.ExifIFD.DateTimeOriginal] = dateTimeOriginalStr;
    exif[piexif.ExifIFD.DateTimeDigitized] = dateTimeOriginalStr;
    exif[piexif.ExifIFD.UserComment] = CONFIG.EVENT_ID;

    const exifObj = { "0th": zeroth, "Exif": exif };
    const exifBytes = piexif.dump(exifObj);
    return piexif.insert(exifBytes, jpegDataUrl);
  } catch (e) {
    console.error('Error inserting EXIF metadata:', e);
    return jpegDataUrl;
  }
}

// --- Camera Handling ---
async function startCamera() {
  stopCamera();
  cameraErrorEl.classList.add('hidden');

  const constraints = {
    audio: false,
    video: {
      facingMode: { ideal: currentFacingMode },
      width: { ideal: 1920 },
      height: { ideal: 1080 }
    }
  };

  try {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error('Camera API not supported on this browser or connection is not secure (HTTPS required).');
    }

    currentStream = await navigator.mediaDevices.getUserMedia(constraints);
    video.srcObject = currentStream;
    await video.play();
  } catch (err) {
    console.warn('getUserMedia error, displaying fallback:', err);
    showCameraFallback(err.message || 'Camera permission denied or camera unavailable.');
  }
}

function stopCamera() {
  if (currentStream) {
    currentStream.getTracks().forEach(track => track.stop());
    currentStream = null;
  }
}

function showCameraFallback(msg) {
  errorMessageEl.textContent = msg;
  cameraErrorEl.classList.remove('hidden');
}

// Flip camera
btnFlip.addEventListener('click', () => {
  currentFacingMode = (currentFacingMode === 'environment') ? 'user' : 'environment';
  startCamera();
});

// Fallback trigger
btnFallbackCapture.addEventListener('click', () => {
  fallbackInput.click();
});

// Handle fallback file upload (e.g. if camera permission denied)
fallbackInput.addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;

  try {
    // Orientation-corrected image loading via createImageBitmap
    let imageBitmap;
    if (window.createImageBitmap) {
      imageBitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    } else {
      // Safari fallback for older engines
      imageBitmap = await new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = reject;
        img.src = URL.createObjectURL(file);
      });
    }

    // Scale to MAX_LONG_EDGE
    let w = imageBitmap.width;
    let h = imageBitmap.height;
    const maxEdge = CONFIG.MAX_LONG_EDGE || 1600;

    if (w > maxEdge || h > maxEdge) {
      if (w >= h) {
        h = Math.round((h * maxEdge) / w);
        w = maxEdge;
      } else {
        w = Math.round((w * maxEdge) / h);
        h = maxEdge;
      }
    }

    capturedCanvas = document.createElement('canvas');
    capturedCanvas.width = w;
    capturedCanvas.height = h;
    const ctx = capturedCanvas.getContext('2d');
    ctx.drawImage(imageBitmap, 0, 0, w, h);

    prepareReviewScreen();
  } catch (err) {
    alert('Failed to read image file: ' + err.message);
  } finally {
    fallbackInput.value = '';
  }
});

// --- Shutter & Capture ---
btnShutter.addEventListener('click', () => {
  if (isTakingPhoto) return;
  if (CONFIG.MAX_SHOTS > 0 && getShotsCount() >= CONFIG.MAX_SHOTS) {
    updateShotsUI();
    return;
  }

  isTakingPhoto = true;

  // Flash animation
  shutterFlash.classList.add('flashing');
  setTimeout(() => shutterFlash.classList.remove('flashing'), 120);

  // Capture current video frame
  const vw = video.videoWidth;
  const vh = video.videoHeight;

  if (!vw || !vh) {
    isTakingPhoto = false;
    return;
  }

  let w = vw;
  let h = vh;
  const maxEdge = CONFIG.MAX_LONG_EDGE || 1600;

  if (w > maxEdge || h > maxEdge) {
    if (w >= h) {
      h = Math.round((h * maxEdge) / w);
      w = maxEdge;
    } else {
      w = Math.round((w * maxEdge) / h);
      h = maxEdge;
    }
  }

  capturedCanvas = document.createElement('canvas');
  capturedCanvas.width = w;
  capturedCanvas.height = h;
  const ctx = capturedCanvas.getContext('2d');
  ctx.drawImage(video, 0, 0, w, h);

  // Pause camera preview during transition
  stopCamera();

  prepareReviewScreen();
  isTakingPhoto = false;
});

// --- Review Screen & Filtering ---
function prepareReviewScreen() {
  selectedFilter = 'Original';

  // Render filter buttons
  filterStrip.innerHTML = '';
  FILTERS.forEach(f => {
    const pill = document.createElement('button');
    pill.className = `filter-pill ${f === selectedFilter ? 'active' : ''}`;
    pill.textContent = f;
    pill.setAttribute('role', 'radio');
    pill.setAttribute('aria-checked', f === selectedFilter ? 'true' : 'false');
    pill.addEventListener('click', () => {
      document.querySelectorAll('.filter-pill').forEach(el => {
        el.classList.remove('active');
        el.setAttribute('aria-checked', 'false');
      });
      pill.classList.add('active');
      pill.setAttribute('aria-checked', 'true');
      selectedFilter = f;
      renderReviewPreview();
    });
    filterStrip.appendChild(pill);
  });

  // Downscaled canvas for rapid preview rendering
  const PREVIEW_MAX = 720;
  let pw = capturedCanvas.width;
  let ph = capturedCanvas.height;
  if (pw > PREVIEW_MAX || ph > PREVIEW_MAX) {
    if (pw >= ph) {
      ph = Math.round((ph * PREVIEW_MAX) / pw);
      pw = PREVIEW_MAX;
    } else {
      pw = Math.round((pw * PREVIEW_MAX) / ph);
      ph = PREVIEW_MAX;
    }
  }

  previewCanvas = document.createElement('canvas');
  previewCanvas.width = pw;
  previewCanvas.height = ph;
  const pctx = previewCanvas.getContext('2d');
  pctx.drawImage(capturedCanvas, 0, 0, pw, ph);

  // Setup review canvas size
  reviewCanvas.width = pw;
  reviewCanvas.height = ph;

  renderReviewPreview();

  // Show review screen
  screenCamera.classList.remove('active');
  screenReview.classList.add('active');
}

function renderReviewPreview() {
  if (!previewCanvas) return;
  const ctx = reviewCanvas.getContext('2d');
  ctx.drawImage(previewCanvas, 0, 0);

  if (selectedFilter !== 'Original') {
    const imgData = ctx.getImageData(0, 0, reviewCanvas.width, reviewCanvas.height);
    applyFilterToImageData(imgData, selectedFilter);
    ctx.putImageData(imgData, 0, 0);
  }

  drawDateStamp(ctx, reviewCanvas.width, reviewCanvas.height);
}

// Retake button
btnRetake.addEventListener('click', () => {
  capturedCanvas = null;
  previewCanvas = null;
  screenReview.classList.remove('active');
  screenCamera.classList.add('active');
  startCamera();
});

// Show brief toast
function showToast(text) {
  toastEl.textContent = text;
  toastEl.classList.remove('hidden');
  setTimeout(() => {
    toastEl.classList.add('hidden');
  }, 1600);
}

// Generate random string
function randomString(length = 8) {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let res = '';
  for (let i = 0; i < length; i++) {
    res += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return res;
}

// Use photo button (Confirm & Enqueue)
btnUse.addEventListener('click', async () => {
  if (!capturedCanvas) return;

  const captureDate = new Date();

  // 1. Render full size image with chosen filter
  const fullCanvas = document.createElement('canvas');
  fullCanvas.width = capturedCanvas.width;
  fullCanvas.height = capturedCanvas.height;
  const fctx = fullCanvas.getContext('2d');
  fctx.drawImage(capturedCanvas, 0, 0);

  if (selectedFilter !== 'Original') {
    const fullData = fctx.getImageData(0, 0, fullCanvas.width, fullCanvas.height);
    applyFilterToImageData(fullData, selectedFilter);
    fctx.putImageData(fullData, 0, 0);
  }

  // Draw date stamp on full upload image
  drawDateStamp(fctx, fullCanvas.width, fullCanvas.height);

  // 2. Export JPEG with target quality
  const jpegQuality = CONFIG.JPEG_QUALITY || 0.8;
  let dataUrl = fullCanvas.toDataURL('image/jpeg', jpegQuality);

  // 3. Inject EXIF metadata
  dataUrl = injectExifMetadata(dataUrl, captureDate);

  // 4. Build unique upload path: EVENT_ID/EVENT_DATE_<ISO time>_<8 random chars>.jpg
  const isoTime = captureDate.toISOString().replace(/[:.]/g, '-');
  const rand = randomString(8);
  const filePath = `${CONFIG.EVENT_ID}/${CONFIG.EVENT_DATE}_${isoTime}_${rand}.jpg`;

  // 5. Add to IndexedDB upload queue
  const queueItem = {
    id: `photo_${Date.now()}_${rand}`,
    filePath,
    dataUrl,
    createdAt: Date.now(),
    retries: 0
  };

  await addToQueue(queueItem);

  // 6. Update counts and shot limits
  incrementShotsCount();

  // 7. Instant UX: return to camera and show toast
  capturedCanvas = null;
  previewCanvas = null;
  screenReview.classList.remove('active');
  screenCamera.classList.add('active');
  showToast('Saved ✓');

  // Check if camera should restart or if limit is reached
  if (CONFIG.MAX_SHOTS > 0 && getShotsCount() >= CONFIG.MAX_SHOTS) {
    updateShotsUI();
  } else {
    startCamera();
  }

  // 8. Trigger background upload
  await refreshUploadStatus();
  processUploadQueue();
});

// --- Page Visibility & Lifecycle Handling ---
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    stopCamera();
  } else {
    // Only resume camera if we are on the camera screen and not over limit
    if (screenCamera.classList.contains('active')) {
      if (CONFIG.MAX_SHOTS === 0 || getShotsCount() < CONFIG.MAX_SHOTS) {
        startCamera();
      }
    }
    // Also trigger queue processing on wake
    processUploadQueue();
  }
});

// Reconnection trigger
window.addEventListener('online', () => {
  processUploadQueue();
});

// --- Initialize App ---
async function init() {
  // Initialize Supabase Client
  if (window.supabase && CONFIG.SUPABASE_URL && CONFIG.SUPABASE_ANON_KEY) {
    try {
      supabase = window.supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY);
    } catch (e) {
      console.error('Failed to create Supabase client:', e);
    }
  }

  // Initialize DB
  await openDatabase();

  // Update UI & shots counter
  updateShotsUI();
  await refreshUploadStatus();

  // Start upload queue processor if pending items exist
  processUploadQueue();

  // Start camera if under shot limit
  if (CONFIG.MAX_SHOTS === 0 || getShotsCount() < CONFIG.MAX_SHOTS) {
    startCamera();
  }
}

init();
