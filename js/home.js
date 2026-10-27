// Home screen: 12-hour rain chart, plain-language atmosphere readings, what to watch for,
// and the most recent observation. Thresholds are rough field guides, not fitted values.

const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------- 12-hour chart
export function renderHours(w) {
  const box = $("hoursChart");
  const s = (w.series || []).filter((x) => x.time);
  if (!s.length) { $("hours").hidden = true; return; }
  $("hours").hidden = false;
  const W = 360, H = 132, top = 18, bot = 102, left = 4, right = 4;
  const n = s.length, slot = (W - left - right) / n, bw = Math.min(18, slot - 6);
  const y = (p) => bot - (Math.max(0, p) / 100) * (bot - top);
  const peak = s.reduce((bi, x, i) => ((x.prob || 0) > (s[bi].prob || 0) ? i : bi), 0);
  let svg = "";
  for (const g of [50, 100]) {
    svg += `<line class="hgrid" x1="${left}" x2="${W - right}" y1="${y(g)}" y2="${y(g)}"/>`;
    svg += `<text class="hgl" x="${W - right}" y="${y(g) - 3}" text-anchor="end">${g}%</text>`;
  }
  svg += `<line class="hbase" x1="${left}" x2="${W - right}" y1="${bot}" y2="${bot}"/>`;
  s.forEach((x, i) => {
    const cx = left + slot * i + slot / 2;
    const p = x.prob ?? 0;
    const h = Math.max(2, bot - y(p));
    const r = Math.min(4, bw / 2, h / 2);
    // bar with rounded top, square base on the baseline
    const x0 = cx - bw / 2, y0 = bot - h;
    svg += `<path class="hbar" d="M${x0},${bot} V${y0 + r} Q${x0},${y0} ${x0 + r},${y0} H${x0 + bw - r} Q${x0 + bw},${y0} ${x0 + bw},${y0 + r} V${bot} Z"/>`;
    const hr = x.time.slice(11, 13);
    if (i % 3 === 0) svg += `<text class="hx" x="${cx}" y="${bot + 16}" text-anchor="middle">${hr}:00</text>`;
    if (x.temp !== null && i % 3 === 0) svg += `<text class="ht" x="${cx}" y="${bot + 29}" text-anchor="middle">${Math.round(x.temp)}°</text>`;
    // generous invisible hit target for the tooltip
    svg += `<rect class="hhit" x="${cx - slot / 2}" y="0" width="${slot}" height="${H}" data-i="${i}"/>`;
  });
  if ((s[peak].prob || 0) > 0) {
    const cx = left + slot * peak + slot / 2;
    svg += `<text class="hv" x="${cx}" y="${y(s[peak].prob) - 5}" text-anchor="middle">${Math.round(s[peak].prob)}%</text>`;
  }
  box.innerHTML = `<svg viewBox="0 0 ${W} ${H + 4}" role="img" aria-label="Rain chance for the next 12 hours, highest ${Math.round(s[peak].prob || 0)}% at ${s[peak].time.slice(11, 16)}">${svg}</svg>`;
  $("hoursTable").innerHTML = "<tr><th>Hour</th><th>Rain chance</th><th>Rain</th><th>Temp.</th></tr>" + s.map((x) =>
    `<tr><td>${x.time.slice(11, 16)}</td><td>${x.prob ?? "–"}%</td><td>${(x.mm ?? 0).toFixed(1)} mm</td><td>${x.temp === null ? "–" : Math.round(x.temp) + " °C"}</td></tr>`).join("");
  const tip = $("hoursTip");
  const show = (e) => {
    const t = e.target.closest(".hhit");
    if (!t) return;
    const x = s[+t.dataset.i];
    tip.textContent = `${x.time.slice(11, 16)}: rain chance ${x.prob ?? 0}%, ${(x.mm ?? 0).toFixed(1)} mm, ${x.temp === null ? "" : Math.round(x.temp) + " °C"}`;
    tip.hidden = false;
    box.querySelectorAll(".hbar").forEach((b, i) => b.classList.toggle("on", i === +t.dataset.i));
  };
  box.onpointermove = show;
  box.onpointerdown = show;
  box.onpointerleave = () => { tip.hidden = true; box.querySelectorAll(".hbar").forEach((b) => b.classList.remove("on")); };
}

// ---------------------------------------------------------------- readings
function verdicts(w) {
  const out = [];
  const base = w.cloud_base_m;
  if (base !== null) {
    out.push({
      label: "Cloud base", value: `${(base / 1000).toFixed(1)} km`,
      state: base > 2500 ? "dry" : base > 1200 ? "mid" : "wet",
      note: base > 2500 ? "High: rain from clouds may evaporate before it lands"
        : base > 1200 ? "Moderate: heavier showers reach the ground" : "Low: rain reaches the ground easily",
    });
  }
  if (w.pw_mm !== null) {
    out.push({
      label: "Water in the air", value: `${Math.round(w.pw_mm)} mm`,
      state: w.pw_mm < 18 ? "dry" : w.pw_mm < 32 ? "mid" : "wet",
      note: w.pw_mm < 18 ? "Dry column: little to rain out" : w.pw_mm < 32 ? "Some moisture available" : "Moist column: heavy showers possible",
    });
  }
  const cape = w.cape_max, cin = w.cin_at_cape_max;
  out.push({
    label: "Instability", value: `${Math.round(cape)} J/kg`,
    state: cape < 300 ? "dry" : cape < 1000 ? "mid" : "wet",
    note: (cape < 300 ? "Stable: storms unlikely" : cape < 1000 ? "Some instability" : "Unstable: storms can grow")
      + (cin !== null && cin >= 100 && cape >= 300 ? ", but capped by a warm layer aloft" : ""),
  });
  if (w.temp_now !== null && w.dew_now !== null) {
    out.push({
      label: "Temperature, dew point", value: `${Math.round(w.temp_now)}°, ${Math.round(w.dew_now)}°`,
      state: w.rh_now !== null && w.rh_now < 30 ? "dry" : "mid",
      note: `Humidity ${Math.round(w.rh_now ?? 0)}% at ground level`,
    });
  }
  if (w.lapse_850_500 !== null) {
    out.push({
      label: "Cooling with height", value: `${Math.round(w.lapse_850_500)} °C`,
      state: w.lapse_850_500 >= 30 ? "wet" : w.lapse_850_500 >= 26 ? "mid" : "dry",
      note: (w.lapse_850_500 >= 30 ? "Steep: favours tall, towering clouds" : w.lapse_850_500 >= 26 ? "Moderate" : "Gentle: clouds stay shallow")
        + " (1.5 to 5.5 km)",
    });
  }
  if (w.gust_max !== null) {
    out.push({
      label: "Wind gusts", value: `${Math.round(w.gust_max)} km/h`,
      state: w.gust_max >= 50 ? "wet" : "mid",
      note: w.gust_max >= 50 ? "Strong: blowing dust possible" : w.gust_max >= 30 ? "Breezy" : "Light",
    });
  }
  return out;
}

export function renderAtmosphere(w, lat, lon) {
  const v = verdicts(w);
  $("atmos").hidden = !v.length;
  $("readings").replaceChildren(...v.map((x) => {
    const d = document.createElement("div");
    d.className = `reading ${x.state}`;
    d.innerHTML = '<dt></dt><dd class="rv"></dd><dd class="rn"></dd>';
    d.children[0].textContent = x.label;
    d.children[1].textContent = x.value;
    d.children[2].textContent = x.note;
    return d;
  }));
  $("watchText").textContent = watchFor(w, lat, lon);
}

function nearHajar(lat, lon) {
  return lat > 22.5 && lat < 26.5 && lon > 55.4 && lon < 57.5;
}

export function watchFor(w, lat = 24.2, lon = 55.7) {
  const prob12 = w.prob_max_12h || 0, cape12 = w.cape_max_12h || 0;
  const capped = w.cin_at_cape_max !== null && w.cin_at_cape_max >= 100;
  const mountains = nearHajar(lat, lon) ? " over the Hajar Mountains to the east" : "";
  if (prob12 >= 40) {
    return `Forecast models give up to ${Math.round(prob12)}% chance of rain within 12 hours. Photograph darkening or towering clouds as they come, and tap "It's raining here now" if it starts.`;
  }
  if (cape12 >= 800 && !capped) {
    return `The air becomes unstable later today. Watch for clouds building tall${mountains}. If one starts towering, record a 30-second video: Ghaim checks whether it is growing.`;
  }
  if (w.cloud_base_m !== null && w.cloud_base_m > 2500 && (w.pw_mm ?? 0) < 20) {
    return "Dry, settled air. Any clouds that form are likely to stay high and dry, and showers would mostly evaporate before landing.";
  }
  return "Quiet conditions. If the sky changes, photograph it: every observation helps train Ghaim on UAE skies.";
}

// ---------------------------------------------------------------- last observation
export function renderLast(o, names, onRained) {
  const box = $("lastObs");
  if (!o) { box.hidden = true; return; }
  box.hidden = false;
  const ageH = (Date.now() - new Date(o.time_utc).getTime()) / 3.6e6;
  const when = ageH < 1 ? `${Math.max(1, Math.round(ageH * 60))} min ago`
    : ageH < 24 ? `${Math.round(ageH)} h ago` : `${Math.round(ageH / 24)} days ago`;
  if ($("lastImg").dataset.url) URL.revokeObjectURL($("lastImg").dataset.url);
  if (o.photo) { const u = URL.createObjectURL(o.photo); $("lastImg").src = u; $("lastImg").dataset.url = u; }
  $("lastName").textContent = names[o.observer_label || o.top];
  $("lastMeta").textContent = `${when}, rain chance ${Math.round(o.rain.score * 100)}%`;
  const ask = o.rained === null && ageH >= 3 && ageH < 48;
  $("lastAsk").hidden = !ask;
  $("lastDone").hidden = ask || o.rained === null;
  if (o.rained) $("lastDone").textContent = o.rained === "yes" ? "You recorded that it rained." : "You recorded that it stayed dry.";
  $("lastYes").onclick = () => onRained(o, "yes");
  $("lastNo").onclick = () => onRained(o, "no");
}
