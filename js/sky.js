// Physical sky cues from pixels (port of cloudapp/sky_cues.py) and video frame sampling.
//
// cloud_fraction: share of sky pixels that are cloud, by the red/blue ratio test used
//                 by ground-based sky imagers (clear sky scatters far more blue than red).
// base_darkness : how dark the cloudy pixels are (0 = bright white, 1 = black).

const RB_CLOUD = 0.72;
const MIN_VALID = 25;
const N = 256;

function grab(source, w, h, size = N) {
  const c = document.createElement("canvas");
  c.width = size; c.height = size;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(source, 0, 0, w, h, 0, 0, size, size);
  return ctx.getImageData(0, 0, size, size).data;
}

export function skyCues(source, w, h) {
  const px = grab(source, w, h);
  const mask = new Uint8Array(N * N);
  const cloudLum = [];
  let valid = 0;
  for (let i = 0, j = 0; i < N * N; i++, j += 4) {
    const r = px[j], g = px[j + 1], b = px[j + 2];
    const lum = 0.299 * r + 0.587 * g + 0.114 * b;
    if (lum <= MIN_VALID) continue;
    valid++;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    const sat = (mx - mn) / (mx + 1);
    if (r / (b + 1) > RB_CLOUD || (sat < 0.12 && lum > 120)) {
      mask[i] = 1;
      cloudLum.push(lum);
    }
  }
  const frac = cloudLum.length / Math.max(valid, 1);
  let darkness = 0;
  if (cloudLum.length > 50) {
    cloudLum.sort((a, b) => a - b);
    const m = cloudLum.length >> 1;
    const med = cloudLum.length % 2 ? cloudLum[m] : (cloudLum[m - 1] + cloudLum[m]) / 2;
    darkness = 1 - med / 255;
  }
  return { cloud_fraction: round3(frac), base_darkness: round3(darkness), mask };
}

// Vertical motion of cloudy pixels between two frames, in pixels of a 256 px frame.
// Negative means the cloud moved up the frame (growing tops, if the phone was held still).
// Block matching on 128 px greyscale with a sub-pixel parabola fit.
export function verticalMotion(prevSrc, nextSrc, w, h, mask256) {
  const S = 128, R = 5;
  const a = grey(grab(prevSrc, w, h, S)), b = grey(grab(nextSrc, w, h, S));
  const m = new Uint8Array(S * S);
  let cnt = 0;
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    if (mask256[(y * 2) * N + x * 2]) { m[y * S + x] = 1; cnt++; }
  }
  if (cnt < 50) return 0;
  const cost = [];
  for (let d = -R; d <= R; d++) {
    let s = 0, n = 0;
    for (let y = R; y < S - R; y++) for (let x = 0; x < S; x++) {
      if (!m[y * S + x]) continue;
      s += Math.abs(a[y * S + x] - b[(y + d) * S + x]);
      n++;
    }
    cost.push(n ? s / n : Infinity);
  }
  let k = cost.indexOf(Math.min(...cost));
  let sub = 0;
  if (k > 0 && k < cost.length - 1) {
    const c0 = cost[k - 1], c1 = cost[k], c2 = cost[k + 1];
    const den = c0 - 2 * c1 + c2;
    if (den > 1e-9) sub = 0.5 * (c0 - c2) / den;
  }
  return ((k - R) + sub) * (N / S); // in 256 px units
}

function grey(px) {
  const out = new Float32Array(px.length / 4);
  for (let i = 0, j = 0; i < out.length; i++, j += 4) out[i] = 0.299 * px[j] + 0.587 * px[j + 1] + 0.114 * px[j + 2];
  return out;
}

const round3 = (x) => Math.round(x * 1000) / 1000;

// Seek through a video file and return evenly spaced frames as canvases.
export async function sampleVideo(file, count = 12, onFrame) {
  const url = URL.createObjectURL(file);
  const v = document.createElement("video");
  v.muted = true; v.playsInline = true; v.preload = "auto"; v.src = url;
  await new Promise((res, rej) => {
    v.onloadedmetadata = res;
    v.onerror = () => rej(new Error("This video format cannot be read on this phone. Try recording again in the app."));
  });
  // some phones report duration only after a first seek
  if (!isFinite(v.duration)) { v.currentTime = 1e9; await once(v, "seeked"); }
  const dur = v.duration;
  if (!(dur > 1)) throw new Error("The video is too short. Record at least 10 seconds.");
  const frames = [];
  const W = v.videoWidth, H = v.videoHeight;
  const scale = Math.min(1, 720 / Math.max(W, H));
  for (let i = 0; i < count; i++) {
    const t = Math.min(dur - 0.05, (dur * i) / (count - 1));
    v.currentTime = t;
    await once(v, "seeked");
    const c = document.createElement("canvas");
    c.width = Math.round(W * scale); c.height = Math.round(H * scale);
    c.getContext("2d").drawImage(v, 0, 0, c.width, c.height);
    frames.push({ t, canvas: c });
    onFrame && onFrame(i + 1, count);
  }
  URL.revokeObjectURL(url);
  return { frames, duration: dur };
}

function once(el, ev) {
  return new Promise((res) => el.addEventListener(ev, res, { once: true }));
}

// least-squares slope
export function slope(xs, ys) {
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) { num += (xs[i] - mx) * (ys[i] - my); den += (xs[i] - mx) ** 2; }
  return den ? num / den : 0;
}

export function median(a) {
  const s = [...a].sort((x, y) => x - y), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
