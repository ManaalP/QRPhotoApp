import { CONFIG } from './config.js';

// --- State Variables ---
let currentStream = null;
let currentFacingMode = 'environment';
let isTakingPhoto = false;
let isSwitchingCamera = false;
let cameraSettleTimer = null;
let canCapture = false;

// Zoom & Capabilities State
let currentTrack = null;
let trackCapabilities = null;
let imageCapture = null;
let currentZoom = 1;
let isTorchOn = false;
let isGridOn = false;

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
const btnFlash = document.getElementById('btn-flash');
const btnGrid = document.getElementById('btn-grid');
const gridOverlay = document.getElementById('grid-overlay');
const zoomControls = document.getElementById('zoom-controls');
const zoom1xBtn = document.getElementById('zoom-1x');
const zoom2xBtn = document.getElementById('zoom-2x');
const focusReticle = document.getElementById('focus-reticle');
const viewfinderAspectBox = document.getElementById('viewfinder-aspect-box');
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

// Sensor Debug DOM Elements (?debug=1)
const sensorDebugOverlay = document.getElementById('sensor-debug-overlay');
const dbgPlatform = document.getElementById('dbg-platform');
const dbgSource = document.getElementById('dbg-source');
const dbgAx = document.getElementById('dbg-ax');
const dbgAy = document.getElementById('dbg-ay');
const dbgAz = document.getElementById('dbg-az');
const dbgCalcAngle = document.getElementById('dbg-calc-angle');
const dbgHoldAngle = document.getElementById('dbg-hold-angle');
const dbgScreenAngle = document.getElementById('dbg-screen-angle');
const dbgCaptureRot = document.getElementById('dbg-capture-rot');
const dbgUiRot = document.getElementById('dbg-ui-rot');
const dbgSamples = document.getElementById('dbg-samples');

// ==========================================================================
// MOTION SENSOR ORIENTATION TRACKING (devicemotion / Accelerometer / screen)
// Automatically determines physical phone hold (0, 90, 180, 270) even when
// phone rotation lock is enabled.
// ==========================================================================
const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

let sensorPermissionRequested = false;
let sensorActive = false;
let genericSensor = null;
let lastKnownDeviceAngle = 0; // 0, 90, 180, 270
let candidateAngle = 0;
let candidateFirstSeen = 0;
let gravitySamples = [];
const GRAVITY_SAMPLE_SIZE = 5;
let sensorEventCount = 0;
let sensorFirstEventReceived = false;

// Debug mode flag (?debug=1)
const urlParams = new URLSearchParams(window.location.search);
const isDebugMode = urlParams.get('debug') === '1';

if (isDebugMode && sensorDebugOverlay) {
  sensorDebugOverlay.classList.remove('hidden');
  if (dbgPlatform) dbgPlatform.textContent = isIOS ? 'iOS (Safari)' : 'Android / Other';
}

function getScreenAngle() {
  if (window.screen && window.screen.orientation && typeof window.screen.orientation.angle === 'number') {
    return (window.screen.orientation.angle % 360 + 360) % 360;
  }
  if (typeof window.orientation === 'number') {
    return (window.orientation % 360 + 360) % 360;
  }
  return 0;
}

// Computes the rotation needed to render captured pixels upright
function getCaptureRotation(devicePhysicalAngle = lastKnownDeviceAngle) {
  const screenAngle = getScreenAngle();
  // If no motion sensor has ever reported, fall back to 0 (screen coordinate frame)
  if (!sensorFirstEventReceived) {
    return 0;
  }
  return ((devicePhysicalAngle - screenAngle) % 360 + 360) % 360;
}

// Angular difference considering circular wrap-around [-180, +180]
function angleDiff(a, b) {
  return Math.abs(((a - b + 540) % 360) - 180);
}

// Process raw gravity components (ax, ay, az in m/s^2)
function processGravity(rawX, rawY, rawZ, sourceName = 'devicemotion') {
  if (rawX == null || rawY == null) return;
  sensorFirstEventReceived = true;
  sensorEventCount++;

  // In iOS DeviceMotionEvent, accelerationIncludingGravity signs are inverted
  // relative to Android Chrome standard coordinates.
  const normX = isIOS ? -rawX : rawX;
  const normY = isIOS ? -rawY : rawY;
  const normZ = rawZ != null ? (isIOS ? -rawZ : rawZ) : 0;

  // Moving average smoothing over last ~5 samples
  gravitySamples.push({ x: normX, y: normY, z: normZ });
  if (gravitySamples.length > GRAVITY_SAMPLE_SIZE) {
    gravitySamples.shift();
  }

  const avgX = gravitySamples.reduce((acc, s) => acc + s.x, 0) / gravitySamples.length;
  const avgY = gravitySamples.reduce((acc, s) => acc + s.y, 0) / gravitySamples.length;
  const avgZ = gravitySamples.reduce((acc, s) => acc + s.z, 0) / gravitySamples.length;

  const xyMagnitude = Math.hypot(avgX, avgY);
  const zMagnitude = Math.abs(avgZ);

  // If phone is nearly flat on a table (face up or face down: z dominating xy),
  // retain last known orientation to prevent erratic flips
  if (xyMagnitude < 1.8 && zMagnitude > 6.0) {
    updateDebugUI(avgX, avgY, avgZ, null, lastKnownDeviceAngle, sourceName);
    return;
  }

  // Physical angle from device natural frame:
  // Upright portrait: gravity pulls downward (+Y), angle = 0
  // Left landscape (rotated 90 deg clockwise): gravity pulls toward +X, angle = 90
  // Upside-down portrait: gravity pulls upward (-Y), angle = 180
  // Right landscape (rotated 90 deg counter-clockwise): gravity pulls toward -X, angle = 270
  let calculatedAngle = (Math.atan2(avgX, avgY) * 180 / Math.PI);
  calculatedAngle = (calculatedAngle % 360 + 360) % 360;

  // Snap to nearest 0, 90, 180, 270
  const immediateSnap = (Math.round(calculatedAngle / 90) * 90) % 360;

  // Hysteresis: only switch when rotated > 55 degrees from current orientation
  // and holds that orientation for at least ~150 ms
  const now = performance.now();
  const diffFromCurrent = angleDiff(calculatedAngle, lastKnownDeviceAngle);

  if (diffFromCurrent > 55) {
    if (candidateAngle !== immediateSnap) {
      candidateAngle = immediateSnap;
      candidateFirstSeen = now;
    } else if (now - candidateFirstSeen >= 150) {
      if (lastKnownDeviceAngle !== candidateAngle) {
        lastKnownDeviceAngle = candidateAngle;
        onDeviceHoldChanged(lastKnownDeviceAngle);
      }
    }
  } else {
    candidateAngle = lastKnownDeviceAngle;
  }

  updateDebugUI(avgX, avgY, avgZ, calculatedAngle, lastKnownDeviceAngle, sourceName);
}

function updateDebugUI(ax, ay, az, calcAngle, holdAngle, source) {
  if (!isDebugMode) return;
  const screenAngle = getScreenAngle();
  const captureRot = getCaptureRotation(holdAngle);
  const uiRot = (360 - captureRot) % 360;

  if (dbgSource) dbgSource.textContent = source;
  if (dbgAx) dbgAx.textContent = ax.toFixed(2);
  if (dbgAy) dbgAy.textContent = ay.toFixed(2);
  if (dbgAz) dbgAz.textContent = az.toFixed(2);
  if (dbgCalcAngle) dbgCalcAngle.textContent = calcAngle != null ? Math.round(calcAngle) : 'Flat';
  if (dbgHoldAngle) dbgHoldAngle.textContent = holdAngle;
  if (dbgScreenAngle) dbgScreenAngle.textContent = screenAngle;
  if (dbgCaptureRot) dbgCaptureRot.textContent = captureRot;
  if (dbgUiRot) dbgUiRot.textContent = uiRot;
  if (dbgSamples) dbgSamples.textContent = sensorEventCount;
}

// Native camera UI feedback: Rotate icons/labels to stay upright with phone hold
function onDeviceHoldChanged(deviceHoldAngle) {
  const captureRot = getCaptureRotation(deviceHoldAngle);
  // UI icons counter-rotate so they appear upright to user
  const uiRotation = (360 - captureRot) % 360;
  applyUIRotation(uiRotation);
}

function applyUIRotation(degrees) {
  // Rotate specific icons and pills without changing their layout box or parent position
  const rotatables = [
    btnFlip?.querySelector('svg'),
    btnFlash?.querySelector('svg'),
    btnGrid?.querySelector('svg'),
    zoom1xBtn,
    zoom2xBtn,
    shotsCounterEl,
    uploadStatusEl
  ];

  rotatables.forEach(el => {
    if (!el) return;
    el.classList.add('sensor-rotatable');
    el.style.transform = degrees === 0 ? '' : `rotate(${degrees}deg)`;
  });

  // Rotate filter pills inside strip
  const filterPills = cameraFilterStrip?.querySelectorAll('.filter-pill');
  if (filterPills) {
    const isLandscape = window.matchMedia('(orientation: landscape)').matches;
    filterPills.forEach(pill => {
      pill.classList.add('sensor-rotatable');
      // If page is in CSS landscape, filter pills already have rotate(180deg) via CSS
      if (isLandscape) {
        pill.style.transform = `rotate(${180 + degrees}deg)`;
      } else {
        pill.style.transform = degrees === 0 ? '' : `rotate(${degrees}deg)`;
      }
    });
  }
}

// Devicemotion listener
function handleDeviceMotion(e) {
  const g = e.accelerationIncludingGravity;
  if (g && (g.x != null || g.y != null)) {
    processGravity(g.x, g.y, g.z, 'devicemotion');
  }
}

// Deviceorientation fallback (beta / gamma) if devicemotion provides no data
function handleDeviceOrientation(e) {
  if (sensorFirstEventReceived) return; // devicemotion has higher priority
  if (e.beta == null || e.gamma == null) return;

  // Approximate gravity vector from Euler angles:
  // gamma = left/right tilt [-90, 90]
  // beta = front/back tilt [-180, 180]
  const degToRad = Math.PI / 180;
  const b = e.beta * degToRad;
  const g = e.gamma * degToRad;

  const x = Math.sin(g);
  const y = Math.sin(b) * Math.cos(g);
  const z = Math.cos(b) * Math.cos(g);

  processGravity(x * 9.8, y * 9.8, z * 9.8, 'deviceorientation');
}

// Start motion sensor listeners
function startMotionSensors() {
  if (sensorActive) return;
  sensorActive = true;

  window.addEventListener('devicemotion', handleDeviceMotion, { passive: true });
  window.addEventListener('deviceorientation', handleDeviceOrientation, { passive: true });

  // Optional Generic Sensor API (Chrome Android)
  if ('Accelerometer' in window && !genericSensor) {
    try {
      genericSensor = new window.Accelerometer({ frequency: 20 });
      genericSensor.addEventListener('reading', () => {
        if (genericSensor && genericSensor.x != null) {
          processGravity(genericSensor.x, genericSensor.y, genericSensor.z, 'Accelerometer');
        }
      });
      genericSensor.start();
    } catch (e) {
      // Permission or secure context error, devicemotion will handle it
    }
  }
}

// Stop motion sensor listeners
function stopMotionSensors() {
  sensorActive = false;
  window.removeEventListener('devicemotion', handleDeviceMotion);
  window.removeEventListener('deviceorientation', handleDeviceOrientation);
  if (genericSensor) {
    try { genericSensor.stop(); } catch (e) {}
  }
}

// iOS Safari 13+ permission request from user gesture (first tap anywhere)
async function requestSensorPermissionIfNeeded() {
  if (sensorPermissionRequested) return;
  sensorPermissionRequested = true;

  if (typeof DeviceMotionEvent !== 'undefined' && typeof DeviceMotionEvent.requestPermission === 'function') {
    try {
      const response = await DeviceMotionEvent.requestPermission();
      if (response === 'granted') {
        startMotionSensors();
      } else {
        console.warn('DeviceMotion permission denied by user, using screen orientation fallback.');
      }
    } catch (err) {
      console.warn('DeviceMotionEvent.requestPermission error:', err);
    }
  } else {
    // Non-iOS or older browser where permissions are granted by default
    startMotionSensors();
  }
}

// Trigger sensor permission on first user interaction anywhere in the app
function setupSensorGestureTrigger() {
  const trigger = () => {
    requestSensorPermissionIfNeeded();
    window.removeEventListener('touchstart', trigger, true);
    window.removeEventListener('click', trigger, true);
  };
  window.addEventListener('touchstart', trigger, { capture: true, passive: true });
  window.addEventListener('click', trigger, { capture: true, passive: true });
}


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

        // 1. Lift blacks (fade shadows)
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

// Draw vintage film camera date stamp on the canvas
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

// --- EXIF Metadata Injection (Orientation 1) ---
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

    // Standard EXIF fields + Orientation 1 (upright)
    zeroth[piexif.ImageIFD.Orientation] = 1;
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

// --- Camera Capabilities & Controls Setup ---
async function checkDeviceCameraCount() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const videoInputs = devices.filter(d => d.kind === 'videoinput');
    if (videoInputs.length <= 1) {
      btnFlip.classList.add('hidden');
    } else {
      btnFlip.classList.remove('hidden');
    }
  } catch (e) {
    console.warn('Could not enumerate camera devices:', e);
  }
}

function refreshCameraFeatures(track) {
  if (!track || !track.getCapabilities) {
    btnFlash.classList.add('hidden');
    zoomControls.classList.add('hidden');
    return;
  }

  try {
    trackCapabilities = track.getCapabilities();

    // 1. Continuous autofocus & exposure by default
    const constraints = {};
    const adv = {};
    if (trackCapabilities.focusMode && trackCapabilities.focusMode.includes('continuous')) {
      adv.focusMode = 'continuous';
    }
    if (trackCapabilities.exposureMode && trackCapabilities.exposureMode.includes('continuous')) {
      adv.exposureMode = 'continuous';
    }
    if (Object.keys(adv).length > 0) {
      constraints.advanced = [adv];
      track.applyConstraints(constraints).catch(() => {});
    }

    // 2. Torch (Flash)
    if (trackCapabilities.torch) {
      btnFlash.classList.remove('hidden');
      isTorchOn = false;
      btnFlash.classList.remove('active');
    } else {
      btnFlash.classList.add('hidden');
      isTorchOn = false;
    }

    // 3. Zoom
    if (trackCapabilities.zoom && trackCapabilities.zoom.max > 1) {
      zoomControls.classList.remove('hidden');
      currentZoom = 1;
      updateZoomButtons();
      track.applyConstraints({ advanced: [{ zoom: 1 }] }).catch(() => {});
    } else {
      zoomControls.classList.add('hidden');
    }

    // 4. ImageCapture setup
    if ('ImageCapture' in window) {
      try {
        imageCapture = new window.ImageCapture(track);
      } catch (e) {
        imageCapture = null;
      }
    } else {
      imageCapture = null;
    }
  } catch (e) {
    console.warn('Error evaluating track capabilities:', e);
  }
}

function updateZoomButtons() {
  zoom1xBtn.classList.toggle('active', currentZoom === 1);
  zoom2xBtn.classList.toggle('active', currentZoom === 2);
}

// Zoom button handlers
zoom1xBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  setCameraZoom(1);
});

zoom2xBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  setCameraZoom(2);
});

async function setCameraZoom(level) {
  if (!currentTrack || !trackCapabilities || !trackCapabilities.zoom) return;
  const target = Math.min(level, trackCapabilities.zoom.max || 1);
  try {
    await currentTrack.applyConstraints({ advanced: [{ zoom: target }] });
    currentZoom = level;
    updateZoomButtons();
  } catch (e) {
    console.warn('Failed to apply zoom:', e);
  }
}

// Flash (Torch) button handler
btnFlash.addEventListener('click', async (e) => {
  e.stopPropagation();
  if (!currentTrack || !trackCapabilities || !trackCapabilities.torch) return;
  try {
    const nextState = !isTorchOn;
    await currentTrack.applyConstraints({ advanced: [{ torch: nextState }] });
    isTorchOn = nextState;
    btnFlash.classList.toggle('active', isTorchOn);
  } catch (e) {
    console.warn('Torch toggle failed:', e);
  }
});

// Grid button handler
btnGrid.addEventListener('click', (e) => {
  e.stopPropagation();
  isGridOn = !isGridOn;
  gridOverlay.classList.toggle('hidden', !isGridOn);
  btnGrid.classList.toggle('active', isGridOn);
});

// --- Tap To Focus with Normalized Mapping ---
viewfinderAspectBox.addEventListener('click', async (e) => {
  // Avoid focus trigger when clicking zoom buttons
  if (e.target.closest('#zoom-controls')) return;

  const rect = viewfinderAspectBox.getBoundingClientRect();
  const clickX = e.clientX - rect.left;
  const clickY = e.clientY - rect.top;

  // Show visual focus reticle square
  focusReticle.style.left = `${clickX}px`;
  focusReticle.style.top = `${clickY}px`;
  focusReticle.classList.remove('hidden');

  // Re-trigger animation
  focusReticle.style.animation = 'none';
  void focusReticle.offsetHeight;
  focusReticle.style.animation = '';

  setTimeout(() => {
    focusReticle.classList.add('hidden');
  }, 1200);

  // Settle capture timer so tap doesn't take blurry photo mid-focus
  canCapture = false;
  btnShutter.disabled = true;
  clearTimeout(cameraSettleTimer);
  cameraSettleTimer = setTimeout(() => {
    canCapture = true;
    btnShutter.disabled = false;
  }, CONFIG.SETTLE_TIME_MS || 600);

  // Hardware focus if supported (e.g. Android Chrome)
  if (currentTrack && trackCapabilities && trackCapabilities.focusMode) {
    try {
      let normX = clickX / rect.width;
      let normY = clickY / rect.height;

      // Handle front camera preview mirror
      if (currentFacingMode === 'user') {
        normX = 1 - normX;
      }

      const adv = {};
      if (trackCapabilities.focusMode.includes('single-shot')) {
        adv.focusMode = 'single-shot';
      } else if (trackCapabilities.focusMode.includes('manual')) {
        adv.focusMode = 'manual';
      }

      if (trackCapabilities.pointsOfInterest) {
        adv.pointsOfInterest = [{ x: normX, y: normY }];
      }

      if (Object.keys(adv).length > 0) {
        await currentTrack.applyConstraints({ advanced: [adv] });

        // Restore continuous autofocus after ~3s
        setTimeout(() => {
          if (currentTrack && trackCapabilities.focusMode && trackCapabilities.focusMode.includes('continuous')) {
            currentTrack.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }).catch(() => {});
          }
        }, 3000);
      }
    } catch (err) {
      console.warn('Tap to focus applyConstraints error (ignored):', err);
    }
  }
});

// --- Camera Stream Lifecycle ---
async function startCamera() {
  stopCamera();
  cameraErrorEl.classList.add('hidden');

  // Disable shutter until stream settles (~600ms) to ensure sharp focus
  canCapture = false;
  btnShutter.disabled = true;

  // High-resolution stream constraints with ideal values only (no forced aspect ratio)
  const constraints = {
    audio: false,
    video: {
      facingMode: { ideal: currentFacingMode },
      width: { ideal: 4096 },
      height: { ideal: 3072 }
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

    currentTrack = currentStream.getVideoTracks()[0];
    refreshCameraFeatures(currentTrack);
    await checkDeviceCameraCount();

    // Settle camera timer before allowing capture
    clearTimeout(cameraSettleTimer);
    cameraSettleTimer = setTimeout(() => {
      canCapture = true;
      if (CONFIG.MAX_SHOTS === 0 || getShotsCount() < CONFIG.MAX_SHOTS) {
        btnShutter.disabled = false;
      }
    }, CONFIG.SETTLE_TIME_MS || 600);

  } catch (err) {
    console.warn('getUserMedia error, displaying fallback:', err);
    showCameraFallback(err.message || 'Camera permission denied or camera unavailable.');
  }
}

function stopCamera() {
  if (currentStream) {
    currentStream.getTracks().forEach(track => track.stop());
    currentStream = null;
    currentTrack = null;
    imageCapture = null;
  }
}

function showCameraFallback(msg) {
  errorMessageEl.textContent = msg;
  cameraErrorEl.classList.remove('hidden');
}

// --- Flip Camera Button (Fix E: Robust look & behavior) ---
btnFlip.addEventListener('click', async () => {
  if (isSwitchingCamera) return;
  isSwitchingCamera = true;

  // Spin animation
  btnFlip.classList.add('spinning');
  btnFlip.disabled = true;
  btnShutter.disabled = true;
  canCapture = false;

  const previousFacingMode = currentFacingMode;
  const targetFacingMode = (previousFacingMode === 'environment') ? 'user' : 'environment';

  // Stop every track of current stream first (critical on iOS Safari)
  stopCamera();

  try {
    // Try exact constraint first, then fallback to ideal
    let stream = null;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: { exact: targetFacingMode },
          width: { ideal: 4096 },
          height: { ideal: 3072 }
        }
      });
    } catch (e) {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: { ideal: targetFacingMode },
          width: { ideal: 4096 },
          height: { ideal: 3072 }
        }
      });
    }

    currentFacingMode = targetFacingMode;
    currentStream = stream;
    video.srcObject = currentStream;
    await video.play();

    // Mirror only front camera preview
    if (currentFacingMode === 'user') {
      video.classList.add('mirror-preview');
    } else {
      video.classList.remove('mirror-preview');
    }

    updateLiveViewfinderFilter();
    currentTrack = currentStream.getVideoTracks()[0];
    refreshCameraFeatures(currentTrack);

    // Settle camera timer
    clearTimeout(cameraSettleTimer);
    cameraSettleTimer = setTimeout(() => {
      canCapture = true;
      if (CONFIG.MAX_SHOTS === 0 || getShotsCount() < CONFIG.MAX_SHOTS) {
        btnShutter.disabled = false;
      }
    }, CONFIG.SETTLE_TIME_MS || 600);

  } catch (err) {
    console.warn("Couldn't switch camera, reverting to previous:", err);
    showToast("Couldn't switch camera");
    currentFacingMode = previousFacingMode;
    await startCamera();
  } finally {
    setTimeout(() => {
      btnFlip.classList.remove('spinning');
      btnFlip.disabled = false;
      isSwitchingCamera = false;
    }, 280);
  }
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
    const maxEdge = CONFIG.MAX_LONG_EDGE || 2048;

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
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
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
    pill.id = `filter-pill-${f.name.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase()}`;
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
      centerActiveFilterPill(pill, true);
    });
    cameraFilterStrip.appendChild(pill);
  });

  // Center 'Original' on startup
  requestAnimationFrame(() => {
    const activePill = cameraFilterStrip.querySelector('.filter-pill.active');
    if (activePill) centerActiveFilterPill(activePill, false);
  });
}

function centerActiveFilterPill(pill, smooth = true) {
  if (!pill || !cameraFilterStrip) return;
  const isLandscape = window.matchMedia('(orientation: landscape)').matches;
  if (!isLandscape) {
    // Horizontal center
    const stripWidth = cameraFilterStrip.clientWidth;
    const pillOffset = pill.offsetLeft;
    const pillWidth = pill.clientWidth;
    const scrollTarget = pillOffset - (stripWidth / 2) + (pillWidth / 2);
    cameraFilterStrip.scrollTo({
      left: scrollTarget,
      behavior: smooth ? 'smooth' : 'auto'
    });
  } else {
    // Vertical center
    const stripHeight = cameraFilterStrip.clientHeight;
    const pillOffset = pill.offsetTop;
    const pillHeight = pill.clientHeight;
    const scrollTarget = pillOffset - (stripHeight / 2) + (pillHeight / 2);
    cameraFilterStrip.scrollTo({
      top: scrollTarget,
      behavior: smooth ? 'smooth' : 'auto'
    });
  }
}

// --- High-Resolution Photo Capture (ImageCapture with Video Fallback) ---
btnShutter.addEventListener('click', async () => {
  if (isTakingPhoto || !canCapture) return;
  if (CONFIG.MAX_SHOTS > 0 && getShotsCount() >= CONFIG.MAX_SHOTS) {
    updateShotsUI();
    return;
  }

  isTakingPhoto = true;

  // Shutter flash animation
  shutterFlash.classList.add('flashing');
  setTimeout(() => shutterFlash.classList.remove('flashing'), 120);

  try {
    let sourceBitmap = null;

    // 1. Try ImageCapture API if available
    if (imageCapture && typeof imageCapture.takePhoto === 'function') {
      try {
        let photoSettings = {};
        if (typeof imageCapture.getPhotoCapabilities === 'function') {
          const caps = await imageCapture.getPhotoCapabilities();
          if (caps && caps.imageWidth && caps.imageHeight) {
            photoSettings = {
              imageWidth: caps.imageWidth.max,
              imageHeight: caps.imageHeight.max
            };
          }
        }
        const blob = await imageCapture.takePhoto(photoSettings);
        sourceBitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' });
      } catch (err) {
        console.warn('ImageCapture failed, falling back to video frame draw:', err);
        sourceBitmap = null;
      }
    }

    // 2. Freeze current physical device hold and capture rotation at the exact moment of capture
    const frozenDeviceHold = lastKnownDeviceAngle;
    const captureRotation = getCaptureRotation(frozenDeviceHold);

    // Determine target aspect ratio of the viewfinder (3:4 in portrait, 4:3 in landscape)
    const isLandscape = window.matchMedia('(orientation: landscape)').matches;
    const targetAspect = isLandscape ? (4 / 3) : (3 / 4);

    let rawW, rawH;
    if (sourceBitmap) {
      rawW = sourceBitmap.width;
      rawH = sourceBitmap.height;
    } else {
      rawW = video.videoWidth;
      rawH = video.videoHeight;
    }

    if (!rawW || !rawH) {
      isTakingPhoto = false;
      return;
    }

    // Crop source frame to match the exact 3:4 or 4:3 viewfinder framing (WYSIWYG)
    const rawAspect = rawW / rawH;
    let cropX = 0, cropY = 0, cropW = rawW, cropH = rawH;

    if (rawAspect > targetAspect) {
      // Source is wider than target aspect ratio: crop horizontally
      cropW = Math.round(rawH * targetAspect);
      cropX = Math.round((rawW - cropW) / 2);
    } else {
      // Source is taller than target aspect ratio: crop vertically
      cropH = Math.round(rawW / targetAspect);
      cropY = Math.round((rawH - cropH) / 2);
    }

    // Scale to MAX_LONG_EDGE
    let finalW = cropW;
    let finalH = cropH;
    const maxEdge = CONFIG.MAX_LONG_EDGE || 2048;

    if (finalW > maxEdge || finalH > maxEdge) {
      if (finalW >= finalH) {
        finalH = Math.round((finalH * maxEdge) / finalW);
        finalW = maxEdge;
      } else {
        finalW = Math.round((finalW * maxEdge) / finalH);
        finalH = maxEdge;
      }
    }

    // Step A: Draw cropped, mirrored (if front camera) source image onto an unrotated intermediate canvas
    const baseCanvas = document.createElement('canvas');
    baseCanvas.width = finalW;
    baseCanvas.height = finalH;
    const bCtx = baseCanvas.getContext('2d');
    bCtx.imageSmoothingEnabled = true;
    bCtx.imageSmoothingQuality = 'high';

    // Front camera mirror consistency: mirror horizontally in viewfinder space
    if (currentFacingMode === 'user') {
      bCtx.translate(finalW, 0);
      bCtx.scale(-1, 1);
    }

    if (sourceBitmap) {
      bCtx.drawImage(sourceBitmap, cropX, cropY, cropW, cropH, 0, 0, finalW, finalH);
    } else {
      bCtx.drawImage(video, cropX, cropY, cropW, cropH, 0, 0, finalW, finalH);
    }

    // Step B: Draw onto capturedCanvas rotated by captureRotation so pixels are physically UPRIGHT
    capturedCanvas = document.createElement('canvas');
    if (captureRotation === 90 || captureRotation === 270) {
      // 90 or 270 degree rotation swaps canvas dimensions
      capturedCanvas.width = finalH;
      capturedCanvas.height = finalW;
    } else {
      capturedCanvas.width = finalW;
      capturedCanvas.height = finalH;
    }

    const cCtx = capturedCanvas.getContext('2d');
    cCtx.imageSmoothingEnabled = true;
    cCtx.imageSmoothingQuality = 'high';

    if (captureRotation !== 0) {
      // Translate to canvas center, rotate, and draw baseCanvas centered
      cCtx.translate(capturedCanvas.width / 2, capturedCanvas.height / 2);
      cCtx.rotate((captureRotation * Math.PI) / 180);
      cCtx.drawImage(baseCanvas, -finalW / 2, -finalH / 2);
    } else {
      cCtx.drawImage(baseCanvas, 0, 0);
    }

    stopCamera();
    prepareReviewScreen();
  } catch (err) {
    console.error('Error during photo capture:', err);
  } finally {
    isTakingPhoto = false;
  }
});

// --- Review Screen ---
function prepareReviewScreen() {
  reviewCanvas.width = capturedCanvas.width;
  reviewCanvas.height = capturedCanvas.height;
  const ctx = reviewCanvas.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
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

// Use photo button (Confirm & Enqueue with high-res ~800KB target compression)
btnUse.addEventListener('click', async () => {
  if (!capturedCanvas) return;

  const captureDate = new Date();

  // Compress to target ~800 KB to preserve full resolution (floor: 0.75 quality)
  const targetBytes = (CONFIG.TARGET_KB || 800) * 1024;
  let quality = CONFIG.JPEG_QUALITY || 0.90;
  let dataUrl = reviewCanvas.toDataURL('image/jpeg', quality);

  const base64Len = dataUrl.length - 'data:image/jpeg;base64,'.length;
  let approxBytes = Math.round((base64Len * 3) / 4);

  // If initial export exceeds target by more than 15%, step quality down gradually to floor 0.75
  if (approxBytes > targetBytes * 1.15) {
    const qualitySteps = [0.85, 0.80, 0.75];
    for (const q of qualitySteps) {
      const candidateUrl = reviewCanvas.toDataURL('image/jpeg', q);
      const cLen = candidateUrl.length - 'data:image/jpeg;base64,'.length;
      const cBytes = Math.round((cLen * 3) / 4);
      dataUrl = candidateUrl;
      approxBytes = cBytes;
      if (approxBytes <= targetBytes * 1.15) break;
    }
  }

  // Inject EXIF metadata with upright orientation (1)
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
    stopMotionSensors();
  } else {
    if (screenCamera.classList.contains('active')) {
      if (CONFIG.MAX_SHOTS === 0 || getShotsCount() < CONFIG.MAX_SHOTS) {
        startCamera();
      }
    }
    if (sensorPermissionRequested) {
      startMotionSensors();
    }
    processUploadQueue();
  }
});

window.addEventListener('beforeunload', () => {
  stopCamera();
  stopMotionSensors();
});

window.addEventListener('online', () => {
  processUploadQueue();
});

// --- Orientation & Resize Handling without page reload ---
function handleViewportOrOrientationChange() {
  if (video && video.srcObject && video.paused && screenCamera.classList.contains('active')) {
    video.play().catch(() => {});
  }
  const activePill = cameraFilterStrip.querySelector('.filter-pill.active');
  if (activePill) centerActiveFilterPill(activePill, false);

  // Update UI rotation immediately with new screen angle
  onDeviceHoldChanged(lastKnownDeviceAngle);
}

window.addEventListener('resize', handleViewportOrOrientationChange);
window.addEventListener('orientationchange', () => {
  setTimeout(handleViewportOrOrientationChange, 150);
});

// --- Initialize App ---
async function init() {
  setupSensorGestureTrigger();
  // Always register motion listeners (if permission API is required, requestPermission will activate on first touch)
  startMotionSensors();

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
