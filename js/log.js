// Observation log kept on the phone (IndexedDB). Each record holds the photo, time, place,
// prediction, rain estimate, the observer's correction and whether it rained afterwards.
// Export packs everything into a zip: observations.csv + photos/, ready to become a
// labelled UAE dataset for fine-tuning and for fitting the rain weights.
/* global JSZip */
import { CLASSES } from "./rain.js";

const DB = "skycast", STORE = "observations";
let dbp = null;

function db() {
  if (dbp) return dbp;
  dbp = new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE, { keyPath: "id" });
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  return dbp;
}

function tx(mode, fn) {
  return db().then((d) => new Promise((res, rej) => {
    const t = d.transaction(STORE, mode);
    const out = fn(t.objectStore(STORE));
    t.oncomplete = () => res(out && "result" in out ? out.result : out);
    t.onerror = () => rej(t.error);
  }));
}

export const addObs = (o) => tx("readwrite", (s) => s.put(o));
export const updateObs = async (id, patch) => {
  const o = await getObs(id);
  if (!o) return;
  Object.assign(o, patch);
  return addObs(o);
};
export const getObs = (id) => tx("readonly", (s) => s.get(id));
export const deleteObs = (id) => tx("readwrite", (s) => s.delete(id));
export async function allObs() {
  const list = await tx("readonly", (s) => s.getAll());
  return (list || []).sort((a, b) => b.time.localeCompare(a.time));
}

export async function photoBlob(source, w, h, maxSide = 1024) {
  const s = Math.min(1, maxSide / Math.max(w, h));
  const c = document.createElement("canvas");
  c.width = Math.round(w * s); c.height = Math.round(h * s);
  c.getContext("2d").drawImage(source, 0, 0, c.width, c.height);
  return new Promise((res) => c.toBlob(res, "image/jpeg", 0.85));
}

const csvCell = (v) => {
  if (v === null || v === undefined) return "";
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export async function exportZip() {
  const list = await allObs();
  const zip = new JSZip();
  const head = ["id", "time_local", "time_utc", "lat", "lon", "place", "input", "predicted", "confidence",
    "observer_label", "rained_within_3h", "raining_at_photo", "rain_score", "rain_level", "rain_source",
    "cloud_fraction", "base_darkness", ...CLASSES.map((c) => `p_${c}`),
    "om_precip_prob_max", "om_precip_sum_mm", "om_showers_sum_mm", "om_cape_max", "om_cin", "om_lifted_index_min",
    "om_rh_mean", "om_pw_mm", "om_temp", "om_dew_point", "om_cloud_base_m", "om_lapse_850_500", "om_dew_850",
    "om_gust_max", "om_pressure", "photo"];
  const rows = [head.join(",")];
  for (const o of list) {
    const label = o.observer_label || "";
    const fname = o.photo ? `photos/${o.id}_${label || "unlabelled"}.jpg` : "";
    if (o.photo) zip.file(fname, o.photo);
    const w = o.weather || {};
    rows.push([o.id, o.time, o.time_utc, o.lat?.toFixed(5), o.lon?.toFixed(5), o.place, o.input, o.top,
      o.probs?.[o.top]?.toFixed(3), label, o.rained ?? "", o.raining_now ? "yes" : "", o.rain?.score, o.rain?.level, o.rain?.source,
      o.cues?.cloud_fraction, o.cues?.base_darkness, ...CLASSES.map((c) => o.probs?.[c]?.toFixed(4)),
      w.precip_prob_max, w.precip_sum_mm, w.showers_sum_mm, w.cape_max, w.cin_at_cape_max, w.lifted_index_min,
      w.rh_mean, w.pw_mm, w.temp_now, w.dew_now, w.cloud_base_m, w.lapse_850_500, w.dew_850,
      w.gust_max, w.pressure_now, fname].map(csvCell).join(","));
  }
  zip.file("observations.csv", rows.join("\n"));
  zip.file("README.txt", [
    "SkyCast observation log",
    "",
    "observations.csv : one row per photo or video",
    "  predicted        : sky type from the app",
    "  observer_label   : the sky type the observer confirmed or corrected (empty = not checked)",
    "  rained_within_3h : yes / no as reported by the observer later",
    "  raining_at_photo : yes if the observer tapped \"It's raining here now\"",
    "  p_*              : model probabilities for the 7 GCD sky types",
    "  om_*             : Open-Meteo forecast values used for the rain estimate",
    "photos/          : the photos (video: the middle frame), named <id>_<observer_label>.jpg",
  ].join("\n"));
  return zip.generateAsync({ type: "blob" });
}
