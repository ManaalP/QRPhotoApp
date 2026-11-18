import { CONFIG } from './config.js';

// --- State Variables ---
let currentStream = null;
let currentFacingMode = 'environment';
let isTakingPhoto = false;

// Images in memory during review
let capturedCanvas = null; // Full resolution canvas of raw captured frame
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
const cameraFilterStrip = document.getElementById('camera-filter-strip');
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
const FILTERS = [
  { name: 'Original', cssClass: 'filter-original' },
  { name: 'Black & White', cssClass: 'filter-bw' },
  { name: 'Sepia', cssClass: 'filter-sepia' },
  { name: 'Vintage', cssClass: 'filter-vintage' },
  { name: 'Vivid', cssClass: 'filter-vivid' }
];

function updateLiveViewfinderFilter() {
  const currentObj = FILTERS.find(f => f.name === selectedFilter) || FILTERS[0];
  // Remove all filter classes from video
  FILTERS.forEach(f => video.classList.remove(f.cssClass));
  video.classList.add(currentObj.cssClass);
}

// Pure canvas pixel manipulation algorithms for saved photo
function applyFilterToImageData(imageData, filterName) {
  if (filterName === 'Original') return imageData;
  
  const d = imageData.data;
  const len = d.length;
  const width = imageData.width;
  const height = imageData.height;

  if (filterName === 'Black & White') {
    for (let i = 0; i < len; i += 4) {
      let gray = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      gray = ((gray - 128) * 1.2) + 128;
      gray = Math.max(0, Math.min(255, gray));
      d[i] = gray;
      d[i + 1] = gray;
      d[i + 2] = gray;
    }
  } else if (filterName === 'Sepia') {
    for (let i = 0; i < len; i += 4) {
      const r = d[i], g = d[i + 1], b = d[i + 2];
      d[i] = Math.min(255, (r * 0.393) + (g * 0.769) + (b * 0.189));
      d[i + 1] = Math.min(255, (r * 0.349) + (g * 0.686) + (b * 0.168));
      d[i + 2] = Math.min(255, (r * 0.272) + (g * 0.534) + (b * 0.131));
    }
  } else if (filterName === 'Vintage') {
    const centerX = width / 2;
    const centerY = height / 2;
    const maxDist = Math.sqrt(centerX * centerX + centerY * centerY);

    for (let y = 0; y < height; y++) {
      const dy = y - centerY;
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 4;
        let r = d[i], g = d[i + 1], b = d[i + 2];

        // 1. Lift blacks (fade shadows like old film)
        r = r * 0.85 + 28;
        g = g * 0.85 + 20;
        b = b * 0.80 + 15;

        // 2. Warm golden tint
        r = r * 1.08;
        b = b * 0.90;

        // 3. Radial vignette
        const dx = x - centerX;
        const dist = Math.sqrt(dx * dx + dy * dy) / maxDist;
        const vignette = 1 - Math.max(0, dist - 0.4) * 0.45;
        r *= vignette;
        g *= vignette;
        b *= vignette;

        // 4. Subtle film grain
        const grain = (Math.random() - 0.5) * 14;
        r += grain;
        g += grain;
        b += grain;

        d[i] = Math.max(0, Math.min(255, r));
        d[i + 1] = Math.max(0, Math.min(255, g));
        d[i + 2] = Math.max(0, Math.min(255, b));
      }
    }
  } else if (filterName === 'Vivid') {
    const contrastFactor = 1.25;
    for (let i = 0; i < len; i += 4) {
      let r = d[i], g = d[i + 1], b = d[i + 2];

      r = ((r - 128) * contrastFactor) + 128;
      g = ((g - 128) * contrastFactor) + 128;
      b = ((b - 128) * contrastFactor) + 128;

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

// Draw classic film camera date stamp on the canvas
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

    const CONCURRENCY = 2;
    const batch = queue.slice(0, CONCURRENCY);

    await Promise.all(batch.map(item => uploadSingleItem(item)));
  } catch (err) {
    console.error('Error processing upload queue:', err);
  } finally {
    isUploading = false;
    await refreshUploadStatus();

    const remaining = await getPendingQueue();
    if (remaining.length > 0 && navigator.onLine) {
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
    const res = await fetch(item.dataUrl);
    const blob = await res.blob();

    const { data, error } = await supabase.storage
      .from(CONFIG.BUCKET)
      .upload(item.filePath, blob, {
        contentType: 'image/jpeg',
        upsert: false
      });

    if (error) {
      throw error;
    }

    await removeFromQueue(item.id);
    uploadedCount++;
    localStorage.setItem(`uploaded_count_${CONFIG.EVENT_ID}`, uploadedCount.toString());
  } catch (err) {
    console.warn(`Upload failed for ${item.filePath}. Will retry. Reason:`, err.message || err);
    item.retries = (item.retries || 0) + 1;
    item.lastError = err.message || 'Network error';
    await updateQueueItem(item);
  }
}

// --- EXIF Metadata Injection (Safe) ---
function injectExifMetadata(jpegDataUrl, captureDate) {
  if (typeof piexif === 'undefined' || !piexif.dump || !piexif.insert) {
    console.warn('piexifjs not loaded, skipping EXIF insertion.');
    return jpegDataUrl;
  }

  try {
    const eventDateFormatted = CONFIG.EVENT_DATE.replace(/-/g, ':');
    const pad = (n) => String(n).padStart(2, '0');
    const localTimeStr = `${pad(captureDate.getHours())}:${pad(captureDate.getMinutes())}:${pad(captureDate.getSeconds())}`;
    const dateTimeOriginalStr = `${eventDateFormatted} ${localTimeStr}`;

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
    console.warn('Error inserting EXIF metadata, proceeding with raw image:', e);
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
      throw new Error('Camera API not supported or requires secure HTTPS.');
    }

    currentStream = await navigator.mediaDevices.getUserMedia(constraints);
    video.srcObject = currentStream;
    await video.play();

    // Mirror only front camera preview
    if (currentFacingMode === 'user') {
      video.classList.add('mirror-preview');
    } else {
      video.classList.remove('mirror-preview');
    }

    updateLiveViewfinderFilter();
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

// Handle fallback file upload
fallbackInput.addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;

  try {
    let imageBitmap;
    if (window.createImageBitmap) {
      imageBitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    } else {
      imageBitmap = await new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = reject;
        img.src = URL.createObjectURL(file);
      });
    }

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

// Setup filter bar before taking photo
function setupFilterStrip() {
  cameraFilterStrip.innerHTML = '';
  FILTERS.forEach(f => {
    const pill = document.createElement('button');
    pill.className = `filter-pill ${f.name === selectedFilter ? 'active' : ''}`;
    pill.textContent = f.name;
    pill.setAttribute('role', 'radio');
    pill.setAttribute('aria-checked', f.name === selectedFilter ? 'true' : 'false');
    pill.addEventListener('click', () => {
      document.querySelectorAll('.filter-pill').forEach(el => {
        el.classList.remove('active');
        el.setAttribute('aria-checked', 'false');
      });
      pill.classList.add('active');
      pill.setAttribute('aria-checked', 'true');
      selectedFilter = f.name;
      updateLiveViewfinderFilter();
    });
    cameraFilterStrip.appendChild(pill);
  });
}

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

  stopCamera();
  prepareReviewScreen();
  isTakingPhoto = false;
});

// --- Review Screen ---
function prepareReviewScreen() {
  // Render review canvas with the selected filter applied
  reviewCanvas.width = capturedCanvas.width;
  reviewCanvas.height = capturedCanvas.height;
  const ctx = reviewCanvas.getContext('2d');
  ctx.drawImage(capturedCanvas, 0, 0);

  if (selectedFilter !== 'Original') {
    const imgData = ctx.getImageData(0, 0, reviewCanvas.width, reviewCanvas.height);
    applyFilterToImageData(imgData, selectedFilter);
    ctx.putImageData(imgData, 0, 0);
  }

  drawDateStamp(ctx, reviewCanvas.width, reviewCanvas.height);

  screenCamera.classList.remove('active');
  screenReview.classList.add('active');
}

// Retake button
btnRetake.addEventListener('click', () => {
  capturedCanvas = null;
  screenReview.classList.remove('active');
  screenCamera.classList.add('active');
  startCamera();
});

// Toast notification
function showToast(text) {
  toastEl.textContent = text;
  toastEl.classList.remove('hidden');
  setTimeout(() => {
    toastEl.classList.add('hidden');
  }, 1600);
}

function randomString(length = 8) {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let res = '';
  for (let i = 0; i < length; i++) {
    res += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return res;
}

// Use photo button (Confirm & Enqueue with adaptive ~500KB compression)
btnUse.addEventListener('click', async () => {
  if (!capturedCanvas) return;

  const captureDate = new Date();

  // Compress to target ~500 KB to preserve full resolution without bloat
  const targetBytes = (CONFIG.TARGET_KB || 500) * 1024;
  let quality = CONFIG.JPEG_QUALITY || 0.85;
  let dataUrl = reviewCanvas.toDataURL('image/jpeg', quality);

  // Approximate byte size of base64 data
  const base64Len = dataUrl.length - 'data:image/jpeg;base64,'.length;
  let approxBytes = Math.round((base64Len * 3) / 4);

  // If initial export exceeds target by more than 15%, step quality down gradually
  if (approxBytes > targetBytes * 1.15) {
    const qualities = [0.80, 0.75, 0.70];
    for (const q of qualities) {
      const candidateUrl = reviewCanvas.toDataURL('image/jpeg', q);
      const cLen = candidateUrl.length - 'data:image/jpeg;base64,'.length;
      const cBytes = Math.round((cLen * 3) / 4);
      dataUrl = candidateUrl;
      approxBytes = cBytes;
      if (approxBytes <= targetBytes * 1.15) break;
    }
  }

  // Inject EXIF metadata
  dataUrl = injectExifMetadata(dataUrl, captureDate);

  // Unique upload path: EVENT_ID/EVENT_DATE_<ISO time>_<8 random chars>.jpg
  const isoTime = captureDate.toISOString().replace(/[:.]/g, '-');
  const rand = randomString(8);
  const filePath = `${CONFIG.EVENT_ID}/${CONFIG.EVENT_DATE}_${isoTime}_${rand}.jpg`;

  const queueItem = {
    id: `photo_${Date.now()}_${rand}`,
    filePath,
    dataUrl,
    createdAt: Date.now(),
    retries: 0
  };

  await addToQueue(queueItem);
  incrementShotsCount();

  // Return straight to camera
  capturedCanvas = null;
  screenReview.classList.remove('active');
  screenCamera.classList.add('active');
  showToast('Saved ✓');

  if (CONFIG.MAX_SHOTS > 0 && getShotsCount() >= CONFIG.MAX_SHOTS) {
    updateShotsUI();
  } else {
    startCamera();
  }

  await refreshUploadStatus();
  processUploadQueue();
});

// --- Page Visibility & Lifecycle Handling ---
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    stopCamera();
  } else {
    if (screenCamera.classList.contains('active')) {
      if (CONFIG.MAX_SHOTS === 0 || getShotsCount() < CONFIG.MAX_SHOTS) {
        startCamera();
      }
    }
    processUploadQueue();
  }
});

window.addEventListener('online', () => {
  processUploadQueue();
});

// --- Orientation & Resize Handling without page reload ---
function handleViewportOrOrientationChange() {
  // Ensure video is playing and not stalled on orientation switch
  if (video && video.srcObject && video.paused && screenCamera.classList.contains('active')) {
    video.play().catch(() => {});
  }
}

window.addEventListener('resize', handleViewportOrOrientationChange);
window.addEventListener('orientationchange', () => {
  setTimeout(handleViewportOrOrientationChange, 150);
});

// --- Initialize App ---
async function init() {
  if (window.supabase && CONFIG.SUPABASE_URL && CONFIG.SUPABASE_ANON_KEY) {
    try {
      supabase = window.supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY);
    } catch (e) {
      console.error('Failed to create Supabase client:', e);
    }
  }

  await openDatabase();

  setupFilterStrip();
  updateShotsUI();
  await refreshUploadStatus();
  processUploadQueue();

  if (CONFIG.MAX_SHOTS === 0 || getShotsCount() < CONFIG.MAX_SHOTS) {
    startCamera();
  }
}

init();
