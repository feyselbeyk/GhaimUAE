// Rain likelihood for the next ~3 hours. Direct port of cloudapp/rain_score.py so the
// phone app and the desktop app give the same answer for the same inputs.
//
// 1. What the cloud is      -> classifier probabilities x rain propensity per sky type
// 2. How the cloud looks    -> cover fraction, base darkness, (video) growth trend
// 3. What the air is doing  -> Open-Meteo: precipitation probability and amount,
//                              CAPE / lifted index (instability), near-surface RH
// The weights are expert-set starting values, to be fitted against observed rain later.

export const CLASSES = ["cumulus", "altocumulus", "cirrus", "clearsky", "stratocumulus", "cumulonimbus", "mixed"];
export const NAMES = {
  cumulus: "Cumulus",
  altocumulus: "Altocumulus / Cirrocumulus",
  cirrus: "Cirrus / Cirrostratus",
  clearsky: "Clear sky",
  stratocumulus: "Stratocumulus / Stratus / Altostratus",
  cumulonimbus: "Cumulonimbus / Nimbostratus",
  mixed: "Mixed clouds",
};
export const CODES = {
  cumulus: "Cu", altocumulus: "Ac, Cc", cirrus: "Ci, Cs", clearsky: "Under 10% cloud",
  stratocumulus: "Sc, St, As", cumulonimbus: "Cb, Ns", mixed: "Several types",
};
export const BLURB = {
  cumulus: "Detached, heaped clouds with flat bases. Fair weather unless they keep growing upward.",
  altocumulus: "Mid-level rolls or patches of small rounded clouds. Rarely bring rain.",
  cirrus: "High, thin, wispy ice clouds. Dry, but a thickening veil can signal a front.",
  clearsky: "Almost no cloud overhead.",
  stratocumulus: "Grey layered or lumpy sheets. Drizzle or light rain at most.",
  cumulonimbus: "Rain-bearing cloud: thunderstorm towers or thick, dark rain layers.",
  mixed: "Several cloud types at once.",
};
export const PROPENSITY = {
  cumulonimbus: 0.85, stratocumulus: 0.25, cumulus: 0.15, mixed: 0.15,
  altocumulus: 0.08, cirrus: 0.03, clearsky: 0.0,
};
const CONVECTIVE = { cumulonimbus: 0.8, cumulus: 0.8, mixed: 0.4, altocumulus: 0.3, stratocumulus: 0.2 };

const OM_URL = "https://api.open-meteo.com/v1/forecast";
const GEO_URL = "https://geocoding-api.open-meteo.com/v1/search";
// Fetched for the next 12 hours (chart on the home screen); the rain estimate uses the first 3.
const HOURLY = ["precipitation_probability", "precipitation", "showers", "cape", "lifted_index",
  "convective_inhibition", "relative_humidity_2m", "temperature_2m", "dew_point_2m",
  "total_column_integrated_water_vapour", "wind_gusts_10m", "cloud_cover_low", "cloud_cover_mid",
  "temperature_850hPa", "temperature_500hPa", "dew_point_850hPa", "freezing_level_height"];
const CURRENT = ["precipitation", "weather_code", "relative_humidity_2m", "cloud_cover", "temperature_2m",
  "dew_point_2m", "wind_gusts_10m", "pressure_msl"];

const clip = (x, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, x));
const pct = (x) => `${Math.round(x * 100)}%`;

export async function searchPlace(name, count = 5) {
  const u = new URL(GEO_URL);
  u.search = new URLSearchParams({ name, count, language: "en" });
  const r = await fetch(u, { signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw new Error(`Place search failed (${r.status})`);
  const js = await r.json();
  return (js.results || []).map((p) => ({
    label: [p.name, p.admin1, p.country].filter(Boolean).join(", "),
    short: p.name, lat: p.latitude, lon: p.longitude,
  }));
}

export async function fetchWeather(lat, lon) {
  const u = new URL(OM_URL);
  u.search = new URLSearchParams({
    latitude: lat.toFixed(3), longitude: lon.toFixed(3), timezone: "auto",
    current: CURRENT.join(","), hourly: HOURLY.join(","), forecast_hours: 12,
  });
  const r = await fetch(u, { signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw new Error(`Open-Meteo answered ${r.status}`);
  return summariseWeather(await r.json());
}

const num = (v) => (v === null || v === undefined || Number.isNaN(v) ? null : v);
const r1 = (v) => (v === null ? null : Math.round(v * 10) / 10);

// hours: how many hourly steps count as "the next 3 hours" (current hour + 3)
export function summariseWeather(js, hours = 4) {
  const H = js.hourly || {}, c = js.current || {};
  const first = (k) => (H[k] || []).slice(0, hours).filter((v) => num(v) !== null);
  const mx = (k, d = 0) => (first(k).length ? Math.max(...first(k)) : d);
  const mn = (k) => (first(k).length ? Math.min(...first(k)) : null);
  const mean = (k) => (first(k).length ? first(k).reduce((a, b) => a + b, 0) / first(k).length : null);
  const at0 = (k) => num((H[k] || [])[0]);
  const t = num(c.temperature_2m) ?? at0("temperature_2m");
  const td = num(c.dew_point_2m) ?? at0("dew_point_2m");
  const capeIdx = (H.cape || []).slice(0, hours).reduce((bi, v, i, a) => (v > a[bi] ? i : bi), 0);
  const series = (H.time || []).map((tm, i) => ({
    time: tm, prob: num((H.precipitation_probability || [])[i]), mm: num((H.precipitation || [])[i]),
    temp: num((H.temperature_2m || [])[i]), cape: num((H.cape || [])[i]),
  }));
  return {
    time: c.time ?? null,
    temp_now: t,
    dew_now: td,
    precip_now_mm: c.precipitation || 0,
    weather_code: c.weather_code ?? null,
    rh_now: c.relative_humidity_2m ?? null,
    cloud_now: c.cloud_cover ?? null,
    gust_now: num(c.wind_gusts_10m),
    pressure_now: num(c.pressure_msl),
    precip_prob_max: first("precipitation_probability").length ? mx("precipitation_probability") : null,
    precip_sum_mm: Math.round(first("precipitation").reduce((a, b) => a + b, 0) * 100) / 100,
    showers_sum_mm: Math.round(first("showers").reduce((a, b) => a + b, 0) * 100) / 100,
    cape_max: mx("cape"),
    cin_at_cape_max: num((H.convective_inhibition || [])[capeIdx]),
    lifted_index_min: mn("lifted_index"),
    rh_mean: r1(mean("relative_humidity_2m")) ?? (c.relative_humidity_2m ?? null),
    pw_mm: r1(mean("total_column_integrated_water_vapour")),
    // lifting condensation level: about 125 m per degree of dew-point depression
    cloud_base_m: t !== null && td !== null ? Math.max(0, Math.round(125 * (t - td) / 50) * 50) : null,
    lapse_850_500: at0("temperature_850hPa") !== null && at0("temperature_500hPa") !== null
      ? r1(at0("temperature_850hPa") - at0("temperature_500hPa")) : null,
    dew_850: r1(at0("dew_point_850hPa")),
    freezing_level_m: at0("freezing_level_height"),
    gust_max: mx("wind_gusts_10m", null),
    low_cloud_max: mx("cloud_cover_low"),
    series,
    cape_max_12h: series.reduce((m, x) => Math.max(m, x.cape || 0), 0),
    prob_max_12h: series.reduce((m, x) => Math.max(m, x.prob || 0), 0),
  };
}

export function levelOf(score) {
  return score < 0.2 ? "Very low" : score < 0.4 ? "Low" : score < 0.6 ? "Moderate" : score < 0.8 ? "High" : "Very high";
}

// Forecast-only estimate, shown before any photo is taken.
export function forecastOnly(w) {
  const nwp = Math.max((w.precip_prob_max || 0) / 100, 1 - Math.exp(-(w.precip_sum_mm || 0)));
  return { score: clip(nwp), level: levelOf(clip(nwp)) };
}

export function rainLikelihood(probs, cues, weather = null, trend = null) {
  const reasons = [];
  const frac = cues.cloud_fraction, dark = cues.base_darkness;

  // 1. cloud type
  const typeTerm = CLASSES.reduce((s, k) => s + probs[k] * PROPENSITY[k], 0);
  const convective = clip(Object.entries(CONVECTIVE).reduce((s, [k, w]) => s + probs[k] * w, 0));
  const top = CLASSES.reduce((a, b) => (probs[b] > probs[a] ? b : a));

  // 2. appearance
  let look = clip(typeTerm + 0.35 * (dark - 0.35));
  // partial cloud cover lowers the odds, but a confident rain cloud keeps most of its weight
  // (a storm photographed with some blue sky beside it is still a storm)
  const rainCloud = probs.cumulonimbus || 0;
  look *= Math.max(Math.sqrt(clip(frac / 0.4)), clip(rainCloud * 0.85));
  // only the model decides "clear": thin cirrus can slip past the pixel test
  if ((probs.clearsky || 0) > 0.6 || (frac < 0.05 && (probs.clearsky || 0) > 0.3)) {
    look = 0;
    reasons.push("Almost no cloud in the frame.");
  } else if (dark > 0.55) {
    reasons.push("The cloud base looks dark and thick.");
  } else if (dark < 0.25 && typeTerm < 0.4) {
    reasons.push("The clouds look bright and thin.");
  }

  if (trend) {
    let growth = 0;
    if ((trend.darkness_per_min || 0) > 0.02) { growth += 0.06; reasons.push("The clouds darkened during the clip."); }
    if ((trend.fraction_per_min || 0) > 0.05) { growth += 0.04; reasons.push("Cloud cover increased during the clip."); }
    if ((trend.rise_px || 0) < -0.4 && convective > 0.4) {
      growth += 0.08; reasons.push("Cloud tops moved upward in the video, a sign of vertical growth.");
    }
    look = clip(look + growth);
  }
  reasons.unshift(`${NAMES[top]} (${pct(probs[top])} sure). This sky type brings rain about ${pct(PROPENSITY[top])} of the time.`);

  // 3. atmosphere
  let score, source;
  if (weather) {
    const pp = weather.precip_prob_max;
    const qpf = weather.precip_sum_mm || 0;
    const nwp = Math.max((pp || 0) / 100, 1 - Math.exp(-qpf / 1.0));
    const cape = weather.cape_max || 0;
    const li = weather.lifted_index_min;
    let inst = clip(cape / 1500) + (li !== null && li !== undefined && li < -2 ? 0.2 : 0);
    const cin = weather.cin_at_cape_max;
    const capped = cin !== null && cin !== undefined && cin >= 100;
    if (capped) inst *= 0.5; // a warm layer aloft holds storms back
    inst = clip(inst) * convective;
    const rh = weather.rh_mean;
    const pw = weather.pw_mm;
    // moisture: precipitable water when available (about 15 mm = very dry, 40 mm = very moist), else humidity
    const hum = pw !== null && pw !== undefined ? clip((pw - 15) / 25) : clip(((rh ?? 50) - 35) / 45);

    // Either the sky or the forecast can raise the chance (noisy-OR). The forecast cannot
    // cancel what the photo shows: global models (10-25 km grids) often miss the small,
    // short-lived convective storms typical of the UAE.
    const support = 0.35 * nwp + 0.15 * inst + 0.1 * hum;
    score = 1 - (1 - 0.9 * look) * (1 - support);
    const forecastDry = nwp < 0.05;
    if (forecastDry && look > 0.3) score *= 0.85; // a mild discount only

    if (pp !== null && pp !== undefined) {
      reasons.push(forecastDry && look > 0.5
        ? "Forecast models expect no rain here, but they often miss small storms. The sky in your photo counts for more."
        : `Forecast models give up to ${Math.round(pp)}% chance of rain in the next 3 hours (${qpf.toFixed(1)} mm expected).`);
    }
    if (cape >= 500 && !capped) reasons.push(`The air is unstable (CAPE ${Math.round(cape)} J/kg), which favours showers.`);
    if (cape >= 500 && capped) reasons.push(`The air is unstable, but a warm layer aloft (CIN ${Math.round(cin)} J/kg) is holding storms back.`);
    // evaporation (virga): likely when the cloud base is high above dry ground air and the base looks bright
    const base = weather.cloud_base_m;
    const highBase = base !== null && base !== undefined ? base > 2500 : (rh ?? 50) < 30;
    if (highBase && typeTerm > 0.3 && dark < 0.45) {
      score *= 0.85;
      reasons.push(base !== null && base !== undefined
        ? `The cloud base is about ${(base / 1000).toFixed(1)} km up in dry air: some rain may evaporate before it lands.`
        : `Dry air near the ground (humidity ${Math.round(rh)}%): some rain may evaporate before it lands.`);
    }
    if ((weather.precip_now_mm || 0) > 0.1 && typeTerm > 0.4) {
      score = Math.max(score, 0.85);
      reasons.push("Rain is already being reported here.");
    }
    source = "photo and forecast";
  } else {
    score = look;
    source = "photo only, no forecast data";
  }
  score = clip(score);
  return {
    score: Math.round(score * 1000) / 1000, level: levelOf(score), source, reasons, top,
    components: { cloud_type: typeTerm, appearance: look, convective_share: convective },
  };
}
