import { CLASSES, NAMES, CODES, BLURB, PROPENSITY, fetchWeather, searchPlace, rainLikelihood, forecastOnly, levelOf } from "./rain.js";
import { loadModel, classify } from "./model.js";
import { skyCues, verticalMotion, sampleVideo, slope, median } from "./sky.js";
import { addObs, updateObs, allObs, deleteObs, photoBlob, exportZip } from "./log.js";

const VERSION = "2.1.0";
const $ = (id) => document.getElementById(id);
const LEVEL_VAR = { "Very low": "--water-0", Low: "--water-1", Moderate: "--water-2", High: "--water-3", "Very high": "--water-4" };
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } },
};

// ------------------------------------------------------------------ state
const DEFAULT_LOC = { label: "Al Ain, Abu Dhabi, United Arab Emirates", short: "Al Ain", lat: 24.2075, lon: 55.7447, gps: false };
let loc = store.get("skycast.loc", DEFAULT_LOC);
let weatherCache = null; // { key, at, data }
let current = null;      // observation being shown

// ------------------------------------------------------------------ tabs
function show(view) {
  for (const v of ["observe", "log", "about"]) {
    $(`view-${v}`).hidden = v !== view;
    const t = $(`tab-${v}`);
    if (v === view) t.setAttribute("aria-current", "page"); else t.removeAttribute("aria-current");
  }
  if (view === "log") renderLog();
  window.scrollTo({ top: 0 });
}
document.querySelectorAll(".tab").forEach((b) => b.addEventListener("click", () => {
  history.replaceState(null, "", b.dataset.view === "observe" ? location.pathname : `#${b.dataset.view}`);
  show(b.dataset.view);
}));
show(location.hash === "#log" ? "log" : location.hash === "#about" ? "about" : "observe");

// ------------------------------------------------------------------ toast
let toastT;
function toast(msg) {
  const t = $("toast");
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastT); toastT = setTimeout(() => { t.hidden = true; }, 2600);
}

// ------------------------------------------------------------------ location
function setPlaceLabel() { $("placeName").textContent = loc.gps ? `${loc.short} (GPS)` : loc.short; }
setPlaceLabel();

$("placeBtn").addEventListener("click", () => { $("placeErr").hidden = true; $("placeSheet").showModal(); $("placeQ").focus(); });

$("gpsBtn").addEventListener("click", () => {
  $("placeErr").hidden = true;
  if (!navigator.geolocation) return placeError("This browser cannot share its location. Search for a place instead.");
  $("gpsBtn").disabled = true;
  navigator.geolocation.getCurrentPosition(async (p) => {
    $("gpsBtn").disabled = false;
    const lat = p.coords.latitude, lon = p.coords.longitude;
    useLocation({ label: `${lat.toFixed(3)}, ${lon.toFixed(3)}`, short: "My location", lat, lon, gps: true });
    $("placeSheet").close();
  }, (e) => {
    $("gpsBtn").disabled = false;
    placeError(e.code === 1
      ? "Location access is turned off for this site. Allow it in the browser settings, or search for a place."
      : "The phone could not find its location. Try again outdoors, or search for a place.");
  }, { enableHighAccuracy: false, timeout: 15000, maximumAge: 600000 });
});

let searchT;
$("placeQ").addEventListener("input", () => {
  clearTimeout(searchT);
  const q = $("placeQ").value.trim();
  if (q.length < 2) { $("hits").replaceChildren(); return; }
  searchT = setTimeout(async () => {
    try {
      const hits = await searchPlace(q);
      $("hits").replaceChildren(...hits.map((h) => {
        const li = document.createElement("li");
        const b = document.createElement("button");
        b.type = "button"; b.textContent = h.label;
        b.addEventListener("click", () => { useLocation({ ...h, gps: false }); $("placeSheet").close(); });
        li.append(b); return li;
      }));
      if (!hits.length) placeError("No places match that name.");
      else $("placeErr").hidden = true;
    } catch { placeError("Place search needs an internet connection."); }
  }, 350);
});
function placeError(msg) { $("placeErr").textContent = msg; $("placeErr").hidden = false; }
function useLocation(l) {
  loc = l; store.set("skycast.loc", loc); setPlaceLabel(); weatherCache = null; refreshNow();
  toast(`Forecast location set to ${l.short}`);
}

// ------------------------------------------------------------------ forecast strip
async function getWeather(force = false) {
  const key = `${loc.lat.toFixed(2)},${loc.lon.toFixed(2)}`;
  if (!force && weatherCache && weatherCache.key === key && Date.now() - weatherCache.at < 15 * 60 * 1000) return weatherCache.data;
  const data = await fetchWeather(loc.lat, loc.lon);
  weatherCache = { key, at: Date.now(), data };
  return data;
}

async function refreshNow() {
  const where = (loc.gps ? "your location" : loc.short).replace(/ /g, "\u00A0");
  $("nowLine").textContent = `Loading the forecast for ${where}…`;
  $("nowSub").textContent = "";
  try {
    const w = await getWeather();
    const f = forecastOnly(w);
    const p = Math.round(f.score * 100);
    $("nowLine").textContent = p < 5
      ? `No rain expected in ${where} in the next 3 hours.`
      : `${p}% chance of rain in ${where} in the next 3 hours.`;
    const bits = [];
    if (w.temp_now !== null) bits.push(`${Math.round(w.temp_now)} °C`);
    if (w.rh_now !== null) bits.push(`humidity ${Math.round(w.rh_now)}%`);
    if (w.cloud_now !== null) bits.push(`cloud cover ${Math.round(w.cloud_now)}%`);
    $("nowSub").textContent = `${bits.join(", ")}. Forecast by Open-Meteo. Photograph the sky to check it against what you see.`;
  } catch {
    $("nowLine").textContent = "The forecast is not available offline.";
    $("nowSub").textContent = "Cloud recognition still works. The rain estimate will use the photo only.";
  }
}
refreshNow();

// ------------------------------------------------------------------ model
function modelStatus(t) { $("modelStatus").textContent = t; }
const modelReady = loadModel((p) => modelStatus(`Preparing the sky model for first use: ${Math.round(p * 100)}%`))
  .then(() => modelStatus(""))
  .catch(() => modelStatus("The sky model could not be loaded. The first start needs an internet connection."));

// ------------------------------------------------------------------ inputs
for (const id of ["inPhoto", "inVideo", "inGallery"]) {
  $(id).addEventListener("change", async (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = "";
    if (!file) return;
    if (file.type.startsWith("video/") || /\.(mov|mp4|m4v|webm|3gp)$/i.test(file.name)) analyseVideo(file);
    else analysePhoto(file);
  });
}

function busy(text) {
  $("error").hidden = true; $("result").hidden = true; $("capture").hidden = true;
  $("working").hidden = false; $("workingText").textContent = text;
}
function idle() { $("working").hidden = true; $("capture").hidden = false; }
function fail(msg) { idle(); $("error").textContent = msg; $("error").hidden = false; }

async function decode(file) {
  try {
    const bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
    return { src: bmp, w: bmp.width, h: bmp.height };
  } catch {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.src = url;
    await img.decode();
    return { src: img, w: img.naturalWidth, h: img.naturalHeight };
  }
}

async function weatherOrNull() {
  try { return await getWeather(); } catch { return null; }
}

async function analysePhoto(file) {
  busy("Reading the sky…");
  try {
    await modelReady;
    const { src, w, h } = await decode(file);
    const [probs, weather] = await Promise.all([classify(src, w, h), weatherOrNull()]);
    const cues = skyCues(src, w, h);
    const rain = rainLikelihood(probs, cues, weather);
    const photo = await photoBlob(src, w, h);
    await finish({ input: "photo", probs, cues, weather, rain, photo });
  } catch (err) {
    console.error(err);
    fail(err.message && err.message.startsWith("Could not") ? err.message
      : "This photo could not be read. Try taking it again with the camera button.");
  }
}

async function analyseVideo(file) {
  busy("Reading the video…");
  try {
    await modelReady;
    const { frames, duration } = await sampleVideo(file, 12, (i, n) => { $("workingText").textContent = `Reading the video: frame ${i} of ${n}`; });
    const weatherP = weatherOrNull();
    const per = [], fr = [], dk = [], rises = [];
    let prev = null;
    for (let i = 0; i < frames.length; i++) {
      $("workingText").textContent = `Analysing frame ${i + 1} of ${frames.length}`;
      const c = frames[i].canvas;
      per.push(await classify(c, c.width, c.height));
      const cue = skyCues(c, c.width, c.height);
      fr.push(cue.cloud_fraction); dk.push(cue.base_darkness);
      if (prev) rises.push(verticalMotion(prev, c, c.width, c.height, cue.mask));
      prev = c;
    }
    const probs = Object.fromEntries(CLASSES.map((k) => [k, per.reduce((s, p) => s + p[k], 0) / per.length]));
    const tMin = frames.map((f) => f.t / 60);
    const trend = {
      fraction_per_min: slope(tMin, fr), darkness_per_min: slope(tMin, dk),
      rise_px: rises.length ? median(rises) : 0, duration_s: duration,
    };
    const last = (a) => a.slice(-3).reduce((s, v) => s + v, 0) / Math.min(3, a.length);
    const cues = { cloud_fraction: last(fr), base_darkness: last(dk) };
    const weather = await weatherP;
    const rain = rainLikelihood(probs, cues, weather, trend);
    const mid = frames[Math.floor(frames.length / 2)].canvas;
    const photo = await photoBlob(mid, mid.width, mid.height);
    await finish({ input: "video", probs, cues, weather, rain, photo, trend });
  } catch (err) {
    console.error(err);
    fail(err.message || "This video could not be read.");
  }
}

function localIso(d) {
  const off = -d.getTimezoneOffset(), s = off >= 0 ? "+" : "-", a = Math.abs(off);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}${s}${p(a / 60 | 0)}:${p(a % 60)}`;
}

async function finish(r) {
  const now = new Date();
  const top = r.rain.top;
  current = {
    id: `${now.getTime()}`, time: localIso(now), time_utc: now.toISOString(),
    lat: loc.lat, lon: loc.lon, place: loc.gps ? "GPS" : loc.label, gps: !!loc.gps,
    input: r.input, top, probs: r.probs, rain: { score: r.rain.score, level: r.rain.level, source: r.rain.source, reasons: r.rain.reasons },
    cues: { cloud_fraction: round3(r.cues.cloud_fraction), base_darkness: round3(r.cues.base_darkness) },
    trend: r.trend || null, weather: r.weather, photo: r.photo, observer_label: null, rained: null, app_version: VERSION,
  };
  try { await addObs(current); updateCount(); } catch { /* storage full or blocked: still show the result */ }
  renderResult(current, r.rain);
  idle(); $("capture").hidden = true; $("result").hidden = false;
  $("result").scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
}
const round3 = (x) => Math.round(x * 1000) / 1000;

// ------------------------------------------------------------------ result view
function buildGauge() {
  const g = $("gauge");
  const top = 14, bot = 204, H = bot - top;
  const y = (v) => bot - v * H;
  const ticks = [0.2, 0.4, 0.6, 0.8].map((v) => `<line x1="37" x2="44" y1="${y(v)}" y2="${y(v)}"/>`).join("");
  const labels = [["Very high", 0.9], ["High", 0.7], ["Moderate", 0.5], ["Low", 0.3], ["Very low", 0.1]]
    .map(([t, v]) => `<text x="47" y="${y(v) + 3}">${t}</text>`).join("");
  g.innerHTML = `<title id="gaugeTitle">Rain gauge</title>
    <defs><clipPath id="tube"><rect x="6" y="${top}" width="30" height="${H}" rx="9"/></clipPath></defs>
    <rect class="g-glass" x="6" y="${top}" width="30" height="${H}" rx="9"/>
    <g clip-path="url(#tube)"><rect class="g-water" id="gWater" x="6" y="${bot}" width="30" height="0"/></g>
    <rect class="g-rim" x="6" y="${top}" width="30" height="${H}" rx="9"/>
    <g class="g-ticks">${ticks}${labels}</g>`;
  return (score) => {
    const w = $("gWater");
    const h = Math.max(4, score * H);
    requestAnimationFrame(() => { w.setAttribute("y", bot - h); w.setAttribute("height", h); });
  };
}
const fillGauge = buildGauge();

function renderResult(o, rain) {
  const url = URL.createObjectURL(o.photo);
  $("shotImg").src = url;
  const clear = o.top === "clearsky";
  const shownTop = o.top;
  $("kindName").textContent = NAMES[shownTop];
  $("kindCodes").textContent = `${CODES[shownTop]}${o.input === "video" ? ", from a video" : ""}`;
  $("kindBlurb").textContent = BLURB[shownTop];
  $("lowConf").hidden = clear || o.probs[o.top] >= 0.4;

  const sorted = CLASSES.map((k) => [k, o.probs[k]]).sort((a, b) => b[1] - a[1]).slice(0, 3);
  $("alts").replaceChildren(...sorted.map(([k, p]) => {
    const d = document.createElement("div");
    d.className = "alt";
    d.innerHTML = `<span></span><span class="p">${Math.round(p * 100)}%</span><span class="bar"><i style="width:${(p * 100).toFixed(1)}%"></i></span>`;
    d.firstChild.textContent = NAMES[k];
    return d;
  }));

  const varName = LEVEL_VAR[rain.level];
  $("result").style.setProperty("--water", `var(${varName})`);
  $("rainLevel").textContent = rain.level;
  $("rainPct").textContent = `${Math.round(rain.score * 100)}%`;
  $("rainSrc").textContent = `Based on the ${rain.source}.`;
  $("reasons").replaceChildren(...rain.reasons.map((t) => { const li = document.createElement("li"); li.textContent = t; return li; }));
  fillGauge(rain.score);

  const w = o.weather || {};
  const facts = [
    ["Cloud cover in the frame", `${Math.round(o.cues.cloud_fraction * 100)}%`],
    ["Cloud base darkness", `${Math.round(o.cues.base_darkness * 100)}%`],
  ];
  if (o.trend) {
    facts.push(["Video length", `${Math.round(o.trend.duration_s)} s`]);
    facts.push(["Cover change per minute", signed(o.trend.fraction_per_min * 100, "%")]);
    facts.push(["Darkening per minute", signed(o.trend.darkness_per_min * 100, "%")]);
    facts.push(["Vertical motion of cloud", `${o.trend.rise_px < 0 ? "upward" : "downward"} ${Math.abs(o.trend.rise_px).toFixed(1)} px per step`]);
  }
  if (o.weather) {
    facts.push(["Forecast rain chance, 3 h", w.precip_prob_max === null ? "not given" : `${Math.round(w.precip_prob_max)}%`]);
    facts.push(["Forecast rainfall, 3 h", `${(w.precip_sum_mm || 0).toFixed(1)} mm`]);
    facts.push(["Instability (CAPE)", `${Math.round(w.cape_max || 0)} J/kg`]);
    facts.push(["Lifted index", w.lifted_index_min === null ? "not given" : w.lifted_index_min.toFixed(1)]);
    facts.push(["Humidity, 3 h mean", w.rh_mean === null ? "not given" : `${Math.round(w.rh_mean)}%`]);
  } else {
    facts.push(["Forecast", "not available"]);
  }
  facts.push(["Location", o.gps ? `${o.lat.toFixed(3)}, ${o.lon.toFixed(3)}` : loc.label]);
  $("facts").replaceChildren(...facts.flatMap(([k, v]) => {
    const dt = document.createElement("dt"), dd = document.createElement("dd");
    dt.textContent = k; dd.textContent = v; return [dt, dd];
  }));

  $("rainNowBtn").setAttribute("aria-pressed", String(!!o.raining_now));

  // feedback
  $("fbMain").hidden = false; $("fbPick").hidden = true; $("fbDone").hidden = true;
  $("fbYes").setAttribute("aria-pressed", "false"); $("fbNo").setAttribute("aria-pressed", "false");
}
const signed = (v, u) => `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(1)}${u}`;

$("fbYes").addEventListener("click", () => labelCurrent(current.top));
$("fbNo").addEventListener("click", () => {
  $("fbNo").setAttribute("aria-pressed", "true");
  $("fbPick").replaceChildren(...CLASSES.filter((k) => k !== current.top).map((k) => {
    const b = document.createElement("button");
    b.type = "button"; b.className = "chip"; b.textContent = NAMES[k];
    b.addEventListener("click", () => labelCurrent(k));
    return b;
  }));
  $("fbPick").hidden = false;
});
async function labelCurrent(k) {
  if (!current) return;
  current.observer_label = k;
  try { await updateObs(current.id, { observer_label: k }); } catch { /* ignore */ }
  $("fbMain").hidden = true; $("fbPick").hidden = true;
  $("fbDone").textContent = `Saved as ${NAMES[k]}. Thank you.`;
  $("fbDone").hidden = false;
}

// Ground truth from the observer: it is raining at the moment of the photo.
$("rainNowBtn").addEventListener("click", async () => {
  if (!current) return;
  const on = $("rainNowBtn").getAttribute("aria-pressed") !== "true";
  $("rainNowBtn").setAttribute("aria-pressed", String(on));
  current.raining_now = on;
  current.rained = on ? "yes" : current.rained === "yes" ? null : current.rained;
  try { await updateObs(current.id, { raining_now: on, rained: current.rained }); } catch { /* ignore */ }
  if (on) {
    $("result").style.setProperty("--water", "var(--water-4)");
    $("rainLevel").textContent = "Raining now";
    $("rainPct").textContent = "";
    $("rainSrc").textContent = `Reported by you. SkyCast estimated ${Math.round(current.rain.score * 100)}% from the ${current.rain.source}.`;
    fillGauge(1);
    toast("Saved: raining now. Thank you, this helps train SkyCast.");
  } else {
    renderResult(current, current.rain);
  }
});

$("again").addEventListener("click", () => {
  $("result").hidden = true; $("capture").hidden = false; current = null;
  window.scrollTo({ top: 0, behavior: "smooth" });
});

// ------------------------------------------------------------------ log
async function updateCount() {
  try {
    const n = (await allObs()).length;
    $("logCount").textContent = n; $("logCount").hidden = n === 0;
  } catch { /* IndexedDB unavailable */ }
}
updateCount();

const fmt = new Intl.DateTimeFormat(undefined, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const urls = [];
async function renderLog() {
  urls.splice(0).forEach((u) => URL.revokeObjectURL(u));
  let list = [];
  try { list = await allObs(); } catch { /* ignore */ }
  $("logEmpty").hidden = list.length > 0;
  $("exportBtn").hidden = list.length === 0;
  $("logList").replaceChildren(...list.map((o) => {
    const li = document.createElement("li");
    li.className = "obs";
    const img = document.createElement("img");
    img.alt = "";
    if (o.photo) { const u = URL.createObjectURL(o.photo); urls.push(u); img.src = u; }
    const body = document.createElement("div");
    const shown = o.observer_label || o.top;
    const h3 = document.createElement("h3");
    h3.textContent = NAMES[shown] + (o.observer_label && o.observer_label !== o.top ? " (corrected)" : "");
    const meta = document.createElement("p");
    meta.className = "meta";
    meta.textContent = `${fmt.format(new Date(o.time_utc))}, ${o.input}, rain chance ${Math.round(o.rain.score * 100)}%`;
    const pill = document.createElement("span");
    pill.className = "pill"; pill.textContent = o.rain.level;
    pill.style.setProperty("--water", `var(${LEVEL_VAR[o.rain.level]})`);
    meta.append(" ", pill);

    const row = document.createElement("div");
    row.className = "row";
    const q = document.createElement("span");
    q.className = "q";
    q.textContent = "Did it rain within 3 hours?";
    row.append(q);
    for (const [val, txt] of [["yes", "Yes"], ["no", "No"]]) {
      const b = document.createElement("button");
      b.type = "button"; b.className = "chip"; b.textContent = txt;
      b.setAttribute("aria-pressed", String(o.rained === val));
      b.addEventListener("click", async () => {
        const next = o.rained === val ? null : val;
        await updateObs(o.id, { rained: next }); o.rained = next;
        row.querySelectorAll(".chip").forEach((c) => c.setAttribute("aria-pressed", String(c === b && next !== null)));
      });
      row.append(b);
    }
    const del = document.createElement("button");
    del.type = "button"; del.className = "del"; del.textContent = "Delete";
    let armed = false;
    del.addEventListener("click", async () => {
      if (!armed) { armed = true; del.textContent = "Tap again to delete"; setTimeout(() => { armed = false; del.textContent = "Delete"; }, 3000); return; }
      await deleteObs(o.id); li.remove(); updateCount(); toast("Observation deleted");
      if (!$("logList").children.length) { $("logEmpty").hidden = false; $("exportBtn").hidden = true; }
    });
    row.append(del);
    body.append(h3, meta, row);
    li.append(img, body);
    return li;
  }));
}

$("exportBtn").addEventListener("click", async () => {
  $("exportBtn").disabled = true;
  try {
    const blob = await exportZip();
    const name = `skycast-log-${new Date().toISOString().slice(0, 10)}.zip`;
    const file = new File([blob], name, { type: "application/zip" });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file], title: "SkyCast log" }); return; } catch (e) { if (e.name === "AbortError") return; }
    }
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    toast("Log exported");
  } catch (e) {
    console.error(e); toast("The export failed. Try again.");
  } finally { $("exportBtn").disabled = false; }
});

// ------------------------------------------------------------------ about
$("typesList").replaceChildren(...CLASSES.flatMap((k) => {
  const dt = document.createElement("dt"), dd = document.createElement("dd");
  dt.textContent = `${NAMES[k]} (${CODES[k]})`;
  dd.textContent = `${BLURB[k]} Rain about ${Math.round(PROPENSITY[k] * 100)}% of the time.`;
  return [dt, dd];
}));
$("version").textContent = `Version ${VERSION}. Sky model 2.0: EfficientNet-B0, 7 sky types, 256 px.`;

let installEvt = null;
addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); installEvt = e; $("installBtn").hidden = false; });
$("installBtn").addEventListener("click", async () => {
  if (!installEvt) return;
  installEvt.prompt();
  await installEvt.userChoice; installEvt = null; $("installBtn").hidden = true;
});

// ------------------------------------------------------------------ offline support
if ("serviceWorker" in navigator && location.protocol !== "file:") {
  addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
}

// expose for automated tests
window.__skycast = { classify, skyCues, rainLikelihood, levelOf };
