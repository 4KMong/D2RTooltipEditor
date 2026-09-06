const DONG_URL = './assets/dong.wav';
let audio = null;

function getAudio() {
  if (!audio) audio = new Audio(DONG_URL);
  return audio;
}

export function playDong() {
  try {
    const a = getAudio();
    a.pause();
    a.currentTime = 0;
    const p = a.play();
    if (p && typeof p.catch === 'function') p.catch(() => {});
  } catch (_) {}
}
