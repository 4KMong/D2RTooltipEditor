const DEFAULT_WIDTH = 800;
const DEFAULT_HEIGHT = 400;
const BAR_WIDTH = 188;
const BAR_HEIGHT = 7;

const canvas = document.getElementById('splashCanvas');
const context = canvas.getContext('2d', { alpha: false });
const invoke = window.__TAURI__?.core?.invoke || null;
const listen = window.__TAURI__?.event?.listen || null;

let progress = 0;
let splashImage = null;
let logicalWidth = DEFAULT_WIDTH;
let logicalHeight = DEFAULT_HEIGHT;

function clampProgress(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(100, Math.round(number))) : 0;
}

function resizeCanvas(width, height) {
  logicalWidth = Math.max(64, Math.round(Number(width) || DEFAULT_WIDTH));
  logicalHeight = Math.max(64, Math.round(Number(height) || DEFAULT_HEIGHT));
  const ratio = Math.max(1, window.devicePixelRatio || 1);
  canvas.style.width = `${logicalWidth}px`;
  canvas.style.height = `${logicalHeight}px`;
  canvas.width = Math.round(logicalWidth * ratio);
  canvas.height = Math.round(logicalHeight * ratio);
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
}

function drawSplash() {
  context.save();
  context.setTransform(window.devicePixelRatio || 1, 0, 0, window.devicePixelRatio || 1, 0, 0);
  context.clearRect(0, 0, logicalWidth, logicalHeight);
  context.fillStyle = '#000000';
  context.fillRect(0, 0, logicalWidth, logicalHeight);

  if (splashImage) {
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    context.drawImage(splashImage, 0, 0, logicalWidth, logicalHeight);
  }

  const barBounds = {
    x: logicalWidth - 236,
    y: logicalHeight - 27,
    width: BAR_WIDTH,
    height: BAR_HEIGHT,
  };
  const fillWidth = Math.max(0, Math.min(barBounds.width, barBounds.width * progress / 100));

  context.fillStyle = 'rgba(0, 0, 0, 0.470588)';
  context.fillRect(barBounds.x, barBounds.y, barBounds.width, barBounds.height);

  if (fillWidth > 0) {
    context.fillStyle = 'rgba(255, 241, 176, 0.823529)';
    context.fillRect(barBounds.x, barBounds.y, fillWidth, barBounds.height);
  }

  context.strokeStyle = 'rgba(255, 241, 176, 0.588235)';
  context.lineWidth = 1;
  context.strokeRect(barBounds.x + 0.5, barBounds.y + 0.5, barBounds.width - 1, barBounds.height - 1);

  const label = `${progress}%`;
  const labelX = barBounds.x + barBounds.width + 8;
  const labelY = barBounds.y - 5;
  context.font = '700 12px "Segoe UI", sans-serif';
  context.textBaseline = 'top';
  context.fillStyle = 'rgba(0, 0, 0, 0.627451)';
  context.fillText(label, labelX + 1, labelY + 1);
  context.fillStyle = 'rgb(255, 241, 176)';
  context.fillText(label, labelX, labelY);
  context.restore();
}

function setProgress(value) {
  progress = clampProgress(value);
  drawSplash();
}

function loadImage(source) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.decoding = 'async';
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('loading image failed'));
    image.src = source;
  });
}

async function loadSplashImage() {
  try {
    return await loadImage('./assets/loading.png');
  } catch (_) {
    if (!invoke) return null;
    try {
      const fallback = await invoke('read_startup_splash_image_data_url');
      return fallback ? await loadImage(fallback) : null;
    } catch (error) {
      console.warn('startup splash fallback image failed', error);
      return null;
    }
  }
}

async function initialize() {
  resizeCanvas(DEFAULT_WIDTH, DEFAULT_HEIGHT);
  drawSplash();

  if (listen) {
    try {
      await listen('ttedit-splash-progress', event => setProgress(event.payload));
    } catch (error) {
      console.warn('startup splash progress listener failed', error);
    }
  }

  if (invoke) {
    try {
      setProgress(await invoke('get_startup_splash_progress'));
    } catch (error) {
      console.warn('startup splash initial progress failed', error);
    }
  }

  splashImage = await loadSplashImage();
  if (splashImage) {
    resizeCanvas(splashImage.naturalWidth || DEFAULT_WIDTH, splashImage.naturalHeight || DEFAULT_HEIGHT);
    if (invoke) {
      try {
        await invoke('resize_startup_splash', { width: logicalWidth, height: logicalHeight });
      } catch (error) {
        console.warn('startup splash resize failed', error);
      }
    }
  }
  drawSplash();
}

document.addEventListener('contextmenu', event => event.preventDefault());
document.addEventListener('dragstart', event => event.preventDefault());
void initialize();
