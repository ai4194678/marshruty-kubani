/* ============================================================
   «Маршруты Кубани» — логика интерактивной карты
   Данные: data/points.geojson, data/region.geojson, data/scale.json
   (подготавливаются скриптом prepare_data.py из CSV Росстата, 2025)
   ============================================================ */

"use strict";

/* диагностика: собираем необработанные ошибки и даём доступ к карте из консоли */
window.__errors = [];
window.addEventListener("error", (e) => window.__errors.push(String(e.message)));
window.addEventListener("unhandledrejection", (e) =>
  window.__errors.push("rejection: " + String(e.reason && e.reason.message || e.reason)));

/* ---------------- палитра и константы ---------------- */

const PALETTE = [
  "#16324F", "#1B5C7A", "#00A6C7", "#00C2FF",
  "#A6E3E9", "#FFD166", "#FF9F43", "#FF6B35",
];
const BG = "#07111F";
const NO_DATA_COLOR = "#3D4E63";
const MAIN_METRIC = "Поездок на человека в год";

// Показатели, доступные для переключения (основной — первый)
const METRICS = [
  { key: MAIN_METRIC, short: "Поездок на человека в год", digits: 1, primary: true },
  { key: "Автобусов на 10 000 человек", short: "Автобусов на 10 тыс. жителей", digits: 1 },
  { key: "Автобусы, шт.", short: "Автобусы, шт.", digits: 0 },
  { key: "Пассажирооборот на человека, пасс-км", short: "Пасс-оборот на человека, пасс-км", digits: 0 },
];

const ROAD_CLASS_LABELS = {
  motorway: "автомагистраль",
  trunk: "магистральная дорога",
  primary: "главная дорога",
  secondary: "районная дорога",
  tertiary: "местная дорога",
};

/* ---------------- глобальное состояние ---------------- */

let map;
let scaleData = null;          // пороги шкал из scale.json
let pointsFC = null;           // points.geojson
let regionFC = null;           // region.geojson (может отсутствовать)
let currentMetric = MAIN_METRIC;
let selectedId = null;         // id выбранного НП
let hoverId = null;
let pulseRaf = null;           // id анимации пульсации
let initialBounds = null;

const $ = (id) => document.getElementById(id);

/* ---------------- форматирование ---------------- */

const fmtNum = (v, digits = 0) => {
  if (v === null || v === undefined || Number.isNaN(v)) return "—";
  return new Intl.NumberFormat("ru-RU", {
    minimumFractionDigits: 0,
    maximumFractionDigits: digits,
  }).format(v);
};

const fmtPop = (v) => {
  if (v === null || v === undefined) return "—";
  return new Intl.NumberFormat("ru-RU").format(Math.round(v)) + " чел.";
};

const norm = (s) => (s || "").toLowerCase().replace(/ё/g, "е").trim();

/* цвет по значению для UI (легенда, рейтинг, карточка) */
function colorForValue(metricKey, value) {
  const m = scaleData && scaleData.metrics && scaleData.metrics[metricKey];
  if (!m || value === null || value === undefined) return NO_DATA_COLOR;
  const breaks = m.breaks;
  let idx = breaks.findIndex((b) => value <= b);
  if (idx === -1) idx = breaks.length - 1;
  return PALETTE[Math.min(idx, PALETTE.length - 1)];
}

/* ---------------- цветовое выражение MapLibre ---------------- */

function colorExpression(metricKey) {
  const m = scaleData.metrics[metricKey];
  const stops = [];
  let prev = -Infinity;
  m.breaks.forEach((b, i) => {
    if (b > prev) stops.push(b, m.palette[i]);
    prev = b;
  });
  return ["interpolate", ["linear"], ["to-number", ["get", metricKey], 0], ...stops];
}

/* ============================================================
   ЗАГРУЗКА ДАННЫХ
   ============================================================ */

async function loadJSON(url) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`${url}: HTTP ${resp.status}`);
  return resp.json();
}

/* убираем null-свойства, чтобы фильтры ["has"] работали корректно,
   и присваиваем каждой точке стабильный id */
function normalizePoints(fc) {
  fc.features.forEach((f, i) => {
    const props = f.properties;
    for (const k of Object.keys(props)) {
      if (props[k] === null || props[k] === undefined) delete props[k];
    }
    props.id = i;
    // человекочитаемый тип НП из сокращения (г, ст-ца, х, с, п, пгт, аул)
    const m = props["НП"].match(/^([а-яё-]+)\s+(.+)$/i);
    props["Тип"] = m ? m[1] : "";
    props["Название"] = m ? m[2] : props["НП"];
  });
  return fc;
}

async function loadAllData() {
  const tasks = [
    loadJSON("data/scale.json"),
    loadJSON("data/points.geojson"),
    loadJSON("data/region.geojson").catch(() => null),
  ];
  const [scale, points, region] = await Promise.all(tasks);
  return { scale, points, region };
}

/* ============================================================
   КАРТА
   ============================================================ */

function buildStyle() {
  const layers = [
    { id: "bg", type: "background", paint: { "background-color": BG } },
  ];

  // --- Вода (Чёрное и Азовское моря, реки, лиманы) — из векторных тайлов OSM
  layers.push({
    id: "water",
    type: "fill",
    source: "ofm",
    "source-layer": "water",
    paint: {
      "fill-color": "#0A1B2E",
      "fill-opacity": 0.85,
    },
  });
  layers.push({
    id: "waterway",
    type: "line",
    source: "ofm",
    "source-layer": "waterway",
    minzoom: 8,
    paint: {
      "line-color": "#0E2440",
      "line-width": ["interpolate", ["linear"], ["zoom"], 8, 0.5, 12, 2],
      "line-opacity": 0.8,
    },
  });

  // --- Государственные и региональные границы (OSM)
  layers.push({
    id: "boundary-lines",
    type: "line",
    source: "ofm",
    "source-layer": "boundary",
    filter: ["<=", ["get", "admin_level"], 4],
    paint: {
      "line-color": "#16324F",
      "line-width": ["case",
        ["==", ["get", "admin_level"], 2], 1.2,
        ["==", ["get", "admin_level"], 4], 0.8, 0.5],
      "line-opacity": 0.7,
    },
  });

  if (regionFC) {
    layers.push({
      id: "region-fill",
      type: "fill",
      source: "region",
      paint: { "fill-color": "#0A1A2E", "fill-opacity": 0.5 },
    });
  }

  // --- Местная дорожная сеть (фон, только при приближении)
  layers.push({
    id: "roads-minor",
    type: "line",
    source: "ofm",
    "source-layer": "transportation",
    minzoom: 9,
    filter: ["match", ["get", "class"],
      ["tertiary", "minor", "service"], true, false],
    paint: {
      "line-color": "#16324F",
      "line-width": ["interpolate", ["linear"], ["zoom"], 9, 0.5, 12, 1.6],
      "line-opacity": 0.9,
    },
  });

  // --- Крупные дороги (географический слой OSM через OpenFreeMap).
  // Это НЕ автобусные маршруты и не связь с показателем — только инфраструктура.
  layers.push({
    id: "roads-glow",
    type: "line",
    source: "ofm",
    "source-layer": "transportation",
    filter: ["match", ["get", "class"],
      ["motorway", "trunk", "primary", "secondary"], true, false],
    layout: { "line-cap": "round", "line-join": "round" },
    paint: {
      "line-color": "#00C2FF",
      "line-width": ["interpolate", ["linear"], ["zoom"], 5, 2.5, 10, 6, 13, 9],
      "line-blur": 3,
      "line-opacity": ["interpolate", ["linear"], ["zoom"], 5, 0.35, 9, 0.22],
    },
  });
  layers.push({
    id: "roads-core",
    type: "line",
    source: "ofm",
    "source-layer": "transportation",
    filter: ["match", ["get", "class"],
      ["motorway", "trunk", "primary", "secondary"], true, false],
    layout: { "line-cap": "round", "line-join": "round" },
    paint: {
      "line-color": "#3E82B4",
      "line-width": ["interpolate", ["linear"], ["zoom"], 5, 0.8, 10, 2.2, 13, 3.5],
      "line-opacity": 0.95,
    },
  });
  // подсветка дороги при наведении (все сегменты с тем же названием/номером)
  layers.push({
    id: "roads-highlight",
    type: "line",
    source: "ofm",
    "source-layer": "transportation",
    filter: ["==", ["get", "name"], "__none__"],
    layout: { "line-cap": "round", "line-join": "round" },
    paint: {
      "line-color": "#A6E3E9",
      "line-width": ["interpolate", ["linear"], ["zoom"], 5, 1.6, 10, 3.4, 13, 5],
      "line-opacity": 0.9,
    },
  });

  // --- Контур края: неоновое свечение поверх дорог
  if (regionFC) {
    layers.push({
      id: "region-glow",
      type: "line",
      source: "region",
      paint: {
        "line-color": "#00C2FF",
        "line-width": 4,
        "line-blur": 6,
        "line-opacity": 0.35,
      },
    });
    layers.push({
      id: "region-outline",
      type: "line",
      source: "region",
      paint: {
        "line-color": "#00C2FF",
        "line-width": 1.2,
        "line-opacity": 0.55,
      },
    });
  }

  // --- Подписи дорог и городов (OSM)
  layers.push({
    id: "road-labels",
    type: "symbol",
    source: "ofm",
    "source-layer": "transportation_name",
    minzoom: 10,
    layout: {
      "text-field": ["coalesce", ["get", "name"], ["get", "ref"], ""],
      "text-font": ["Noto Sans Regular"],
      "text-size": 10,
      "text-letter-spacing": 0.15,
      "symbol-placement": "line",
    },
    paint: {
      "text-color": "#5E7A96",
      "text-halo-color": BG,
      "text-halo-width": 1.2,
    },
  });
  layers.push({
    id: "city-labels",
    type: "symbol",
    source: "ofm",
    "source-layer": "place",
    filter: ["match", ["get", "class"], ["city", "town", "village"], true, false],
    layout: {
      "text-field": ["get", "name"],
      "text-font": ["Noto Sans Regular"],
      "text-size": ["interpolate", ["linear"], ["zoom"],
        7, ["case", ["==", ["get", "class"], "city"], 12, 10],
        12, ["case", ["==", ["get", "class"], "city"], 14, 11]],
      "text-letter-spacing": 0.2,
    },
    minzoom: 7,
    paint: {
      "text-color": "#7C93AB",
      "text-halo-color": BG,
      "text-halo-width": 1.4,
    },
  });

  // --- Точки населённых пунктов ---
  const radiusExpr = [
    "interpolate", ["linear"],
    ["sqrt", ["coalesce", ["get", "Население"], 1000]],
    25, 4.5, 70, 6, 200, 7.5, 960, 10,
  ];

  layers.push({
    id: "np-nodata",
    type: "circle",
    source: "points",
    filter: ["all", ["!", ["has", currentMetric]], ["has", "НП"]],
    paint: {
      "circle-color": NO_DATA_COLOR,
      "circle-radius": ["interpolate", ["linear"], ["zoom"], 6, 3.5, 12, 7],
      "circle-opacity": 0.55,
      "circle-stroke-color": "#24344A",
      "circle-stroke-width": 1,
    },
  });

  // неоновое свечение — цвет = значение показателя
  layers.push({
    id: "np-glow",
    type: "circle",
    source: "points",
    filter: ["has", currentMetric],
    paint: {
      "circle-color": colorExpression(currentMetric),
      "circle-radius": ["interpolate", ["linear"], ["zoom"], 6, 11, 12, 18],
      "circle-blur": 1,
      "circle-opacity": ["interpolate", ["linear"], ["zoom"], 6, 0.45, 12, 0.3],
    },
  });

  layers.push({
    id: "np-main",
    type: "circle",
    source: "points",
    filter: ["has", currentMetric],
    paint: {
      "circle-color": colorExpression(currentMetric),
      "circle-radius": ["interpolate", ["linear"], ["zoom"], 6, radiusExpr, 12, ["+", radiusExpr, 3]],
      "circle-opacity": 0.95,
      "circle-stroke-color": BG,
      "circle-stroke-width": ["case", ["boolean", ["feature-state", "hover"], false], 2.5, 1.6],
    },
  });

  // подписи НП при приближении
  layers.push({
    id: "np-labels",
    type: "symbol",
    source: "points",
    minzoom: 8,
    layout: {
      "text-field": ["get", "НП"],
      "text-font": ["Noto Sans Regular"],
      "text-size": 11,
      "text-offset": [0, 1.4],
      "text-anchor": "top",
      "text-justify": "center",
      "text-letter-spacing": 0.25,
    },
    paint: {
      "text-color": "#B9CCDF",
      "text-halo-color": BG,
      "text-halo-width": 1.4,
    },
  });

  // выделение выбранного НП
  layers.push({
    id: "np-selected",
    type: "circle",
    source: "selected",
    paint: {
      "circle-color": "transparent",
      "circle-radius": 13,
      "circle-stroke-color": "#FF6B35",
      "circle-stroke-width": 2.2,
      "circle-opacity": 0,
    },
  });

  const sources = {
    ofm: {
      type: "vector",
      tiles: ["https://tiles.openfreemap.org/planet/{z}/{x}/{y}.pbf"],
      attribution: "География и дороги: © OpenStreetMap contributors (тайлы OpenFreeMap)",
    },
  };
  if (regionFC) sources.region = { type: "geojson", data: regionFC };
  sources.points = { type: "geojson", data: pointsFC, promoteId: "id" };
  sources.selected = { type: "geojson", data: emptyFC() };

  return {
    version: 8,
    glyphs: "https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf",
    sources,
    layers,
  };
}

function emptyFC() {
  return { type: "FeatureCollection", features: [] };
}

function initMap() {
  map = new maplibregl.Map({
    container: "map",
    style: buildStyle(),
    center: [39.0, 45.2],
    zoom: 6.4,
    minZoom: 5.5,
    maxZoom: 14,
    attributionControl: { compact: true },
    dragRotate: false,
    pitchWithRotate: false,
  });
  window.__map = map; // отладочный доступ (тесты hover/проекций)
  map.touchZoomRotate.disableRotation();

  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
  map.addControl(new maplibregl.ScaleControl({ unit: "metric" }), "bottom-right");

  // кнопка сброса к исходному виду
  const resetButton = document.createElement("button");
  resetButton.className = "reset-view";
  resetButton.textContent = "Сбросить вид";
  resetButton.title = "Вернуть карту к исходному виду";
  resetButton.addEventListener("click", () => {
    if (initialBounds) map.fitBounds(initialBounds, { padding: 60, duration: 900 });
  });
  const resetContainer = document.createElement("div");
  resetContainer.className = "maplibregl-ctrl maplibregl-ctrl-group reset-view-wrap";
  resetContainer.appendChild(resetButton);
  map.addControl({ onAdd: () => resetContainer }, "top-right");

  map.on("load", () => {
    initialBounds = boundsFromData();
    map.fitBounds(initialBounds, { padding: 60, duration: 0 });
    attachMapInteractions();
    hideLoader();
  });

  map.on("style.load", () => { window.__styleLoaded = true; });
  map.on("error", (e) => {
    window.__errors.push("map: " + String(e && e.error && e.error.message || e));
  });

  map.on("error", (e) => {
    // некритичные ошибки тайлов не должны ломать интерфейс
    if (e && e.error && /Failed to fetch|NetworkError/i.test(String(e.error.message || ""))) {
      console.warn("Сетевая ошибка слоя:", e.error.message);
    }
  });
}

function boundsFromData() {
  if (regionFC && regionFC.bbox) {
    const [x0, y0, x1, y1] = regionFC.bbox;
    return [[x0, y0], [x1, y1]];
  }
  const b = new maplibregl.LngLatBounds();
  pointsFC.features.forEach((f) => b.extend(f.geometry.coordinates));
  return b;
}

/* ============================================================
   ИНТЕРАКТИВНОСТЬ КАРТЫ
   ============================================================ */

const tooltip = $("map-tooltip");
const roadTooltip = $("road-tooltip");

function attachMapInteractions() {
  const pointLayers = ["np-main", "np-nodata"];

  /* --- наведение на точки --- */
  pointLayers.forEach((layer) => {
    map.on("mouseenter", layer, (e) => {
      map.getCanvas().style.cursor = "pointer";
      showPointTooltip(e.features[0], e.point);
      if (layer === "np-main") setHover(e.features[0].id, true);
    });
    map.on("mousemove", layer, (e) => {
      showPointTooltip(e.features[0], e.point);
      if (layer === "np-main" && e.features[0].id !== hoverId) {
        if (hoverId !== null) setHover(hoverId, false);
        setHover(e.features[0].id, true);
      }
    });
    map.on("mouseleave", layer, () => {
      map.getCanvas().style.cursor = "";
      tooltip.hidden = true;
      if (hoverId !== null) setHover(hoverId, false);
    });
  });

  /* --- клик по точке --- */
  ["np-main", "np-nodata"].forEach((layer) => {
    map.on("click", layer, (e) => {
      const f = e.features[0];
      if (f && f.properties && f.properties.id !== undefined) {
        selectPoint(f.properties.id, { fly: false });
      }
    });
  });

  /* --- клик по пустому месту: снять выделение --- */
  map.on("click", (e) => {
    const hit = map.queryRenderedFeatures(e.point, { layers: ["np-main", "np-nodata"] });
    if (!hit.length && selectedId !== null) {
      clearSelection();
    }
  });

  /* --- наведение на дороги: подсветка всей дороги + tooltip --- */
  ["roads-core", "roads-glow"].forEach((layer) => {
    map.on("mouseenter", layer, () => { map.getCanvas().style.cursor = "crosshair"; });
    map.on("mousemove", layer, (e) => {
      showRoadTooltip(e.point);
      const p = e.features[0].properties;
      // подсветить все сегменты с тем же названием (или номером) и классом
      if (p.name) {
        map.setFilter("roads-highlight",
          ["all", ["==", ["get", "class"], p.class], ["==", ["get", "name"], p.name]]);
      } else if (p.ref) {
        map.setFilter("roads-highlight",
          ["all", ["==", ["get", "class"], p.class], ["==", ["get", "ref"], p.ref]]);
      } else {
        map.setFilter("roads-highlight", ["==", ["get", "name"], "__none__"]);
      }
    });
    map.on("mouseleave", layer, () => {
      map.getCanvas().style.cursor = "";
      roadTooltip.hidden = true;
      map.setFilter("roads-highlight", ["==", ["get", "name"], "__none__"]);
    });
  });
}

function setHover(id, on) {
  map.setFeatureState({ source: "points", id }, { hover: on });
  hoverId = on ? id : null;
}

function showPointTooltip(feature, point) {
  const p = feature.properties;
  const metricInfo = METRICS.find((m) => m.key === currentMetric);
  $("tooltip-name").textContent = p["НП"];
  const v = p[currentMetric];
  $("tooltip-value").textContent =
    v !== undefined ? fmtNum(v, metricInfo.digits) : "нет данных";
  $("tooltip-value").style.color = v !== undefined ? "" : NO_DATA_COLOR;
  $("tooltip-extra").textContent = p["Население"] ? `Население: ${fmtPop(p["Население"])}` : "";
  tooltip.hidden = false;
  positionTooltip(tooltip, point);
}

function positionTooltip(el, point) {
  const wrap = map.getContainer();
  const w = el.offsetWidth, h = el.offsetHeight;
  let x = point.x + 14, y = point.y - h - 10;
  if (x + w > wrap.clientWidth - 8) x = point.x - w - 14;
  if (y < 8) y = point.y + 16;
  el.style.left = x + "px";
  el.style.top = y + "px";
}

function showRoadTooltip(point) {
  const feats = map.queryRenderedFeatures(point, {
    layers: ["roads-core"],
  });
  if (!feats.length) { roadTooltip.hidden = true; return; }
  const p = feats[0].properties;
  const cls = ROAD_CLASS_LABELS[p.class] || "";
  const parts = [];
  if (p.name) parts.push(p.name);
  if (p.ref) parts.push(`(${p.ref})`);
  $("road-name").textContent = parts.length ? parts.join(" ") : "Дорога";
  const extra = [];
  if (cls) extra.push(cls);
  if (p.surface) extra.push(`покрытие: ${p.surface}`);
  $("road-extra").textContent = extra.join(" · ");
  roadTooltip.hidden = false;
  positionTooltip(roadTooltip, point);
}

/* --- пульсация выбранной точки --- */

function startPulse() {
  stopPulse();
  let t = 0;
  const tick = () => {
    t += 0.06;
    const r = 12 + Math.sin(t) * 3.5;
    if (map.getLayer("np-selected")) {
      map.setPaintProperty("np-selected", "circle-radius", r);
      map.setPaintProperty("np-selected", "circle-stroke-opacity", 0.7 + Math.sin(t) * 0.3);
    }
    pulseRaf = requestAnimationFrame(tick);
  };
  pulseRaf = requestAnimationFrame(tick);
}

function stopPulse() {
  if (pulseRaf) cancelAnimationFrame(pulseRaf);
  pulseRaf = null;
}

/* ============================================================
   ВЫБОР НП / КАРТОЧКА
   ============================================================ */

function findFeatureById(id) {
  return pointsFC.features.find((f) => f.properties.id === id);
}

function selectPoint(id, { fly = true } = {}) {
  selectedId = id;
  const f = findFeatureById(id);
  if (!f) return;

  map.getSource("selected").setData({ type: "FeatureCollection", features: [f] });
  startPulse();
  renderCard(f);
  if (fly) {
    map.flyTo({ center: f.geometry.coordinates, zoom: Math.max(map.getZoom(), 10.5), duration: 900 });
  }
  // на мобильных открываем панель, чтобы карточка была видна
  if (window.innerWidth <= 900) openSidebar();
  $("np-card").hidden = false;
  $("np-card").scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function clearSelection() {
  selectedId = null;
  stopPulse();
  map.getSource("selected").setData(emptyFC());
  $("np-card").hidden = true;
}

function typeLabel(shortType) {
  const dict = {
    "г": "город", "с": "село", "х": "хутор", "п": "посёлок",
    "пгт": "посёлок городского типа", "ст-ца": "станица", "аул": "аул",
  };
  return dict[shortType] || shortType || "населённый пункт";
}

function renderCard(f) {
  const p = f.properties;
  const m = METRICS.find((x) => x.key === currentMetric);
  const nameParts = p["НП"].match(/^([а-яё-]+)\s+(.+)$/i);
  $("card-type").textContent = typeLabel(nameParts ? nameParts[1] : "");
  $("card-name").textContent = nameParts ? nameParts[2] : p["НП"];

  $("card-metric-label").textContent = currentMetric + ", 2025";
  const v = p[currentMetric];
  $("card-metric-value").textContent = v !== undefined ? fmtNum(v, m.digits) : "нет данных";
  $("card-metric-value").style.color = v !== undefined ? colorForValue(currentMetric, v) : "var(--text-2)";
  $("card-metric-value").style.textShadow = v !== undefined ? `0 0 16px ${colorForValue(currentMetric, v)}66` : "none";
  $("card-metric-rank").textContent = rankText(p, currentMetric, v);
  $("card-metric-rank").style.color = v !== undefined ? "" : "var(--text-2)";

  const rows = [];
  const row = (label, raw, digits, unit) => {
    const has = raw !== undefined;
    rows.push([label, has ? fmtNum(raw, digits) + (unit || "") : null]);
  };
  row("Население", p["Население"], 0, " чел.");
  row("Автобусов, шт.", p["Автобусы, шт."], 0);
  row("Перевезено пассажиров, тыс. чел.", p["Перевезено пассажиров, тыс. чел."], 1);
  row("Пассажирооборот, тыс. пасс-км", p["Пассажирооборот, тыс. пасс-км"], 1);
  row("Автобусов на 10 000 человек", p["Автобусов на 10 000 человек"], 1);
  row("Пассажирооборот на человека, пасс-км", p["Пассажирооборот на человека, пасс-км"], 0);

  $("card-rows").innerHTML = rows.map(([label, val]) => `
    <div class="card__row">
      <dt>${label}</dt>
      <dd class="${val === null ? "is-empty" : ""}">${val === null ? "нет данных" : val}</dd>
    </div>`).join("");

  $("card-oktmo").textContent = p["ОКТМО"] || "—";
}

function rankText(props, metricKey, value) {
  if (value === undefined) return "Показатель в данных Росстата отсутствует";
  const sorted = pointsFC.features
    .filter((f) => f.properties[metricKey] !== undefined)
    .sort((a, b) => b.properties[metricKey] - a.properties[metricKey]);
  const pos = sorted.findIndex((f) => f.properties.id === props.id) + 1;
  return `${pos}-е место из ${sorted.length} НП с данными`;
}

/* ============================================================
   ЛЕГЕНДА
   ============================================================ */

function renderLegend() {
  const m = scaleData.metrics[currentMetric];
  const metricInfo = METRICS.find((x) => x.key === currentMetric);
  $("legend-title").textContent = `${currentMetric}, 2025`;
  $("legend-bar").style.background = `linear-gradient(90deg, ${m.palette.join(", ")})`;

  const ticks = $("legend-ticks");
  ticks.innerHTML = "";
  const tickDefs = [
    { pos: 0, v: m.breaks[0] },
    { pos: 43, v: m.breaks[3] },
    { pos: 71, v: m.breaks[5] },
    { pos: 100, v: m.breaks[7] },
  ];
  tickDefs.forEach((t) => {
    const span = document.createElement("span");
    span.className = "legend__tick";
    span.style.left = t.pos + "%";
    span.textContent = fmtNum(t.v, metricInfo.digits);
    ticks.appendChild(span);
  });

  $("legend-note").textContent =
    `Шкала: квантильные пороги (у ${m.n} НП есть значение)`;
}

/* ============================================================
   ПЕРЕКЛЮЧЕНИЕ ПОКАЗАТЕЛЯ
   ============================================================ */

function renderMetricSwitch() {
  const container = $("metric-switch");
  container.innerHTML = "";
  METRICS.forEach((m) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.setAttribute("role", "radio");
    btn.className = "metric-switch__option" + (m.key === currentMetric ? " metric-switch__option--active" : "");
    btn.innerHTML = `<span class="metric-switch__radio"></span><span>${m.short}</span>`;
    btn.addEventListener("click", () => setMetric(m.key));
    container.appendChild(btn);
  });
}

function setMetric(key) {
  if (key === currentMetric || !scaleData.metrics[key]) return;
  currentMetric = key;

  const expr = colorExpression(key);
  if (map.getLayer("np-main")) {
    map.setPaintProperty("np-main", "circle-color", expr);
    map.setFilter("np-main", ["has", key]);
    map.setFilter("np-glow", ["has", key]);
    map.setFilter("np-nodata", ["all", ["!", ["has", key]], ["has", "НП"]]);
    map.setPaintProperty("np-glow", "circle-color", expr);
  }

  $("header-metric").textContent = METRICS.find((m) => m.key === key).short;
  renderLegend();
  renderMetricSwitch();
  renderRating();

  if (selectedId !== null) {
    const f = findFeatureById(selectedId);
    if (f) renderCard(f);
  }
}

/* ============================================================
   РЕЙТИНГ
   ============================================================ */

let ratingMode = "top"; // top | bottom

function sortedByMetric(metricKey) {
  return pointsFC.features
    .filter((f) => f.properties[metricKey] !== undefined)
    .sort((a, b) => b.properties[metricKey] - a.properties[metricKey]);
}

function renderRating() {
  const list = $("rating-list");
  const sorted = sortedByMetric(currentMetric);
  const m = METRICS.find((x) => x.key === currentMetric);
  const items = ratingMode === "top" ? sorted.slice(0, 10) : sorted.slice(-10).reverse();

  list.innerHTML = "";
  items.forEach((f) => {
    const p = f.properties;
    const color = colorForValue(currentMetric, p[currentMetric]);
    const li = document.createElement("li");
    li.className = "rating__item";
    li.innerHTML = `
      <span class="rating__dot" style="background:${color}; box-shadow: 0 0 8px ${color}88"></span>
      <span class="rating__name">${p["НП"]}</span>
      <span class="rating__value">${fmtNum(p[currentMetric], m.digits)}</span>`;
    li.addEventListener("click", () => selectPoint(p.id, { fly: true }));
    list.appendChild(li);
  });

  $("rating-note").textContent =
    `Из ${sorted.length} НП со значением «${currentMetric}». ` +
    `Клик — перейти к точке на карте.`;
}

function initRatingTabs() {
  $("rating-tabs").addEventListener("click", (e) => {
    const btn = e.target.closest(".rating__tab");
    if (!btn) return;
    ratingMode = btn.dataset.mode;
    document.querySelectorAll(".rating__tab").forEach((b) =>
      b.classList.toggle("rating__tab--active", b === btn));
    renderRating();
  });
}

/* ============================================================
   ПОИСК
   ============================================================ */

function initSearch() {
  const input = $("search-input");
  const results = $("search-results");

  input.addEventListener("input", () => {
    const q = norm(input.value);
    if (q.length < 1) { results.hidden = true; return; }
    const matches = pointsFC.features
      .map((f) => {
        const name = norm(f.properties["НП"]);
        const plain = norm(f.properties["Название"]);
        let score = -1;
        if (plain.startsWith(q)) score = 0;
        else if (name.startsWith(q)) score = 1;
        else if (plain.includes(q) || name.includes(q)) score = 2;
        return { f, score };
      })
      .filter((x) => x.score >= 0)
      .sort((a, b) =>
        a.score - b.score ||
        (b.f.properties["Население"] || 0) - (a.f.properties["Население"] || 0))
      .slice(0, 8);

    results.innerHTML = "";
    if (!matches.length) {
      const li = document.createElement("li");
      li.className = "search__empty";
      li.textContent = "Ничего не найдено";
      results.appendChild(li);
    } else {
      const m = METRICS.find((x) => x.key === currentMetric);
      matches.forEach(({ f }) => {
        const p = f.properties;
        const li = document.createElement("li");
        li.className = "search__item";
        const v = p[currentMetric];
        li.innerHTML = `
          <span class="search__item-name">${p["НП"]}</span>
          <span class="search__item-value">${v !== undefined ? fmtNum(v, m.digits) : "нет данных"}</span>`;
        li.addEventListener("click", () => {
          results.hidden = true;
          input.value = p["НП"];
          input.blur();
          selectPoint(p.id, { fly: true });
        });
        results.appendChild(li);
      });
    }
    results.hidden = false;
  });

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      const first = results.querySelector(".search__item");
      if (first) first.click();
    }
    if (e.key === "Escape") results.hidden = true;
  });

  document.addEventListener("click", (e) => {
    if (!e.target.closest(".search")) results.hidden = true;
  });
}

/* ============================================================
   МОБИЛЬНАЯ ПАНЕЛЬ
   ============================================================ */

function openSidebar() {
  $("sidebar").classList.add("sidebar--open");
  $("sidebar-toggle-text").textContent = "Скрыть";
}
function closeSidebar() {
  $("sidebar").classList.remove("sidebar--open");
  $("sidebar-toggle-text").textContent = "Панель";
}

function initSidebarToggle() {
  $("sidebar-toggle").addEventListener("click", () => {
    const isOpen = $("sidebar").classList.contains("sidebar--open");
    isOpen ? closeSidebar() : openSidebar();
  });
  $("sidebar-close").addEventListener("click", closeSidebar);
  $("card-close").addEventListener("click", clearSelection);
}

/* ============================================================
   ЗАПУСК
   ============================================================ */

function hideLoader() {
  const l = $("loader");
  l.classList.add("loader--hidden");
  setTimeout(() => l.remove(), 500);
}

function showLoaderError(msg) {
  const l = $("loader");
  if (!l) return;
  l.querySelector(".loader__pulse").style.display = "none";
  l.querySelector(".loader__text").textContent = msg;
}

async function boot() {
  try {
    const { scale, points, region } = await loadAllData();
    scaleData = scale;
    // страховка: палитра из ТЗ, если scale.json её не содержит
    for (const k of Object.keys(scaleData.metrics)) {
      scaleData.metrics[k].palette = scaleData.metrics[k].palette || PALETTE;
    }
    pointsFC = normalizePoints(points);
    regionFC = region;
  } catch (err) {
    console.error(err);
    showLoaderError(
      "Не удалось загрузить данные (data/*.geojson). " +
      "Запустите prepare_data.py и откройте сайт через локальный веб-сервер.");
    return;
  }

  initMap();
  renderLegend();
  renderMetricSwitch();
  renderRating();
  initRatingTabs();
  initSearch();
  initSidebarToggle();

  if (window.maplibregl) {
    // дождаться карты не требуется: слои будут обновлены после load
  }
}

boot();
