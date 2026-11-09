#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
«Маршруты Кубани» — подготовка данных для интерактивной карты.

Этапы:
1. Загрузка и проверка CSV (Росстат, 2025).
2. Проверка координат и основного показателя «Поездок на человека в год».
3. Формирование GeoJSON точек (data/points.geojson) со всеми показателями в свойствах.
4. Загрузка границы Краснодарского края (данные OSM) -> data/region.geojson.
5. Расчёт квантильных порогов цветовой шкалы -> data/scale.json.

Слой дорог: интерактивный слой крупных дорог OSM строится во frontend
из бесплатных векторных тайлов OpenFreeMap (openmaptiles, без ключа);
подсветка и атрибуты дорог берутся из тайлов. Автономного файла дорог
в проекте нет — см. README (раздел «Географические данные»).

Запуск:  python3 prepare_data.py [--no-download]
         --no-download: пропустить загрузку границы края
         (frontend корректно работает и без контура региона).
"""

import argparse
import json
import math
import pathlib
import sys
import urllib.request

import pandas as pd

# ---------------------------------------------------------------- константы

BASE_DIR = pathlib.Path(__file__).resolve().parent
DATA_DIR = BASE_DIR / "data"

CSV_PATH = DATA_DIR / "rosstat_2025.csv"
POINTS_OUT = DATA_DIR / "points.geojson"
REGION_OUT = DATA_DIR / "region.geojson"
SCALE_OUT = DATA_DIR / "scale.json"

# Граница Краснодарского края (данные OpenStreetMap, геометрия из публичного
# репозитория с региональными границами России)
REGION_URL = ("https://raw.githubusercontent.com/timurkanaz/Russia_geojson_OSM/"
              "master/GeoJson's/Regions/YUFO/"
              "%D0%9A%D1%80%D0%B0%D1%81%D0%BD%D0%BE%D0%B4%D0%B0%D1%80%D1%81%D0%BA%D0%B8%D0%B9%20"
              "%D0%BA%D1%80%D0%B0%D0%B9_Krasnodar%20region.geojson")

# Палитра из ТЗ (последовательная: холодные -> тёплые)
PALETTE = [
    "#16324F", "#1B5C7A", "#00A6C7", "#00C2FF",
    "#A6E3E9", "#FFD166", "#FF9F43", "#FF6B35",
]

# Квантильные пороги шкалы (соответствуют 8 цветам палитры)
SCALE_QUANTILES = [0.0, 0.14, 0.28, 0.43, 0.57, 0.71, 0.86, 1.0]

# Границы Краснодарского края для проверки координат (примерные)
LAT_MIN, LAT_MAX = 43.0, 47.5
LON_MIN, LON_MAX = 36.0, 42.5

REQUIRED_COLUMNS = [
    "НП", "ОКТМО", "Население", "Широта", "Долгота",
    "Автобусы, шт.", "Перевезено пассажиров, тыс. чел.",
    "Пассажирооборот, тыс. пасс-км", "Поездок на человека в год",
    "Автобусов на 10 000 человек", "Пассажирооборот на человека, пасс-км",
    "Как сопоставлено население", "Название в омонимах",
]

MAIN_METRIC = "Поездок на человека в год"

# ---------------------------------------------------------------- helpers

def log(msg: str) -> None:
    print(msg, flush=True)


def overpass_query(query: str, timeout: int = 180) -> dict:
    """(резерв) Выполняет запрос к Overpass API."""
    import urllib.parse
    url = "https://overpass-api.de/api/interpreter?data=" + urllib.parse.quote(query)
    req = urllib.request.Request(url, headers={"User-Agent": "marshruty-kubani/1.0"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def line_length_km(coords: list) -> float:
    """Геодезическая длина линии (км) по формуле гаверсинуса."""
    total = 0.0
    for (lon1, lat1), (lon2, lat2) in zip(coords, coords[1:]):
        p1, p2 = math.radians(lat1), math.radians(lat2)
        dphi = math.radians(lat2 - lat1)
        dl = math.radians(lon2 - lon1)
        a = math.sin(dphi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
        total += 2 * math.asin(math.sqrt(a)) * 6371.0
    return total


def simplify_ring(coords: list, tolerance: float) -> list:
    """Упрощение полилинии алгоритмом Дугласа–Пекера (без внешних зависимостей)."""
    if len(coords) < 3:
        return coords

    def point_line_dist(p, a, b):
        ax, ay = a; bx, by = b; px, py = p
        dx, dy = bx - ax, by - ay
        if dx == dy == 0:
            return math.hypot(px - ax, py - ay)
        t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)))
        return math.hypot(px - (ax + t * dx), py - (ay + t * dy))

    stack = [(0, len(coords) - 1)]
    keep = [False] * len(coords)
    keep[0] = keep[-1] = True
    while stack:
        lo, hi = stack.pop()
        if hi <= lo + 1:
            continue
        dmax, idx = 0.0, lo
        for i in range(lo + 1, hi):
            d = point_line_dist(coords[i], coords[lo], coords[hi])
            if d > dmax:
                dmax, idx = d, i
        if dmax > tolerance:
            keep[idx] = True
            stack.append((lo, idx))
            stack.append((idx, hi))
    return [c for c, k in zip(coords, keep) if k]


def simplify_polygon_geometry(geom: dict, tolerance: float) -> dict:
    """Упрощение Polygon/MultiPolygon (координаты в градусах)."""
    def simplify_poly(rings):
        outer = simplify_ring(rings[0], tolerance)
        holes = [simplify_ring(r, tolerance) for r in rings[1:]]
        return [outer] + holes

    if geom["type"] == "Polygon":
        return {"type": "Polygon", "coordinates": simplify_poly(geom["coordinates"])}
    if geom["type"] == "MultiPolygon":
        return {"type": "MultiPolygon",
                "coordinates": [simplify_poly(p) for p in geom["coordinates"]]}
    return geom


# ---------------------------------------------------------------- шаги

def step_load_csv() -> pd.DataFrame:
    log("\n[1/6] Загрузка CSV ...")
    df = pd.read_csv(CSV_PATH, encoding="utf-8-sig")
    missing = [c for c in REQUIRED_COLUMNS if c not in df.columns]
    if missing:
        raise SystemExit(f"В CSV отсутствуют обязательные столбцы: {missing}")
    log(f"  строк: {len(df)}, столбцов: {len(df.columns)}")
    dup = df["НП"].duplicated().sum()
    log(f"  дубликаты названий: {dup}")
    return df


def step_validate(df: pd.DataFrame) -> tuple:
    log("\n[2/6] Валидация координат и показателя ...")
    lat, lon = df["Широта"], df["Долгота"]
    has_geo = lat.notna() & lon.notna()
    bad_geo = df[has_geo & ((lat < LAT_MIN) | (lat > LAT_MAX) |
                            (lon < LON_MIN) | (lon > LON_MAX))]
    if not bad_geo.empty:
        log("  !! координаты вне границ края:")
        log(bad_geo[["НП", "Широта", "Долгота"]].to_string())
    else:
        log(f"  координаты валидны у {int(has_geo.sum())} НП (в границах края)")

    no_geo = df[~has_geo]
    if not no_geo.empty:
        log(f"  НП без координат ({len(no_geo)}): "
            + ", ".join(no_geo["НП"].tolist())
            + " — на карту не попадают")

    metric = df[MAIN_METRIC]
    ok = metric.notna()
    log(f"  «{MAIN_METRIC}»: заполнено у {int(ok.sum())} из {len(df)}; "
        f"min={metric.min():.2f}, медиана={metric.median():.2f}, max={metric.max():.2f}")
    if (ok & (metric <= 0)).any():
        log("  !! неположительные значения показателя")
    return has_geo, ok


def step_build_points(df: pd.DataFrame, has_geo: pd.Series) -> list:
    log("\n[3/6] Формирование points.geojson ...")
    features = []
    skipped = []
    for _, row in df[has_geo].iterrows():
        props = {
            "НП": str(row["НП"]),
            "ОКТМО": str(row["ОКТМО"]),
            "Население": None if pd.isna(row["Население"]) else float(row["Население"]),
            "Поездок на человека в год":
                None if pd.isna(row[MAIN_METRIC]) else round(float(row[MAIN_METRIC]), 2),
            "Автобусы, шт.":
                None if pd.isna(row["Автобусы, шт."]) else float(row["Автобусы, шт."]),
            "Перевезено пассажиров, тыс. чел.":
                None if pd.isna(row["Перевезено пассажиров, тыс. чел."])
                else round(float(row["Перевезено пассажиров, тыс. чел."]), 1),
            "Пассажирооборот, тыс. пасс-км":
                None if pd.isna(row["Пассажирооборот, тыс. пасс-км"])
                else round(float(row["Пассажирооборот, тыс. пасс-км"]), 1),
            "Автобусов на 10 000 человек":
                None if pd.isna(row["Автобусов на 10 000 человек"])
                else round(float(row["Автобусов на 10 000 человек"]), 1),
            "Пассажирооборот на человека, пасс-км":
                None if pd.isna(row["Пассажирооборот на человека, пасс-км"])
                else round(float(row["Пассажирооборот на человека, пасс-км"]), 1),
            "Как сопоставлено население": str(row["Как сопоставлено население"]),
            "Название в омонимах":
                "" if pd.isna(row["Название в омонимах"]) else str(row["Название в омонимах"]),
        }
        features.append({
            "type": "Feature",
            "geometry": {"type": "Point",
                         "coordinates": [round(float(row["Долгота"]), 7),
                                         round(float(row["Широта"]), 7)]},
            "properties": props,
        })
        # контроль связи точка <-> строка CSV
        if props["Название в омонимах"] and props["НП"] not in props["Название в омонимах"]:
            skipped.append(props["НП"])
    fc = {
        "type": "FeatureCollection",
        "name": "Населённые пункты Краснодарского края (Росстат, 2025)",
        "features": features,
    }
    DATA_DIR.mkdir(exist_ok=True)
    POINTS_OUT.write_text(json.dumps(fc, ensure_ascii=False), encoding="utf-8")
    log(f"  точек сохранено: {len(features)} -> {POINTS_OUT.relative_to(BASE_DIR)}")
    return features


def step_download_region() -> bool:
    log("\n[4/5] Загрузка границы Краснодарского края (данные OSM) ...")
    try:
        req = urllib.request.Request(REGION_URL,
                                     headers={"User-Agent": "marshruty-kubani/1.0"})
        with urllib.request.urlopen(req, timeout=120) as resp:
            raw = json.loads(resp.read().decode("utf-8"))
        feats = raw.get("features", [])
        if not feats:
            raise RuntimeError("граница не найдена")
        # источник содержит полигоны муниципальных районов края;
        # упрощаем каждый (~0.003° ≈ 350 м) и сохраняем все вместе —
        # вместе они дают контур края и границы районов
        out_features = []
        minx = miny = 999.0
        maxx = maxy = -999.0
        for f in feats:
            geom = simplify_polygon_geometry(f["geometry"], 0.003)
            name = f.get("properties", {}).get("district", "")
            out_features.append({
                "type": "Feature",
                "geometry": geom,
                "properties": {"district": name},
            })
            def rings(geom):
                if geom["type"] == "Polygon":
                    return [geom["coordinates"]]
                if geom["type"] == "MultiPolygon":
                    return geom["coordinates"]
                return []
            for ring in rings(geom):
                for c in ring[0]:
                    minx, maxx = min(minx, c[0]), max(maxx, c[0])
                    miny, maxy = min(miny, c[1]), max(maxy, c[1])
        fc = {
            "type": "FeatureCollection",
            "name": ("Границы муниципальных образований Краснодарского края "
                     "(© OpenStreetMap contributors)"),
            "bbox": [round(minx, 4), round(miny, 4), round(maxx, 4), round(maxy, 4)],
            "features": out_features,
        }
        REGION_OUT.write_text(json.dumps(fc, ensure_ascii=False), encoding="utf-8")
        size = REGION_OUT.stat().st_size / 1024
        log(f"  районов: {len(out_features)}, bbox края: "
            f"[{minx:.2f}, {miny:.2f}, {maxx:.2f}, {maxy:.2f}]")
        log(f"  сохранено ({size:.0f} КБ) -> {REGION_OUT.relative_to(BASE_DIR)}")
        return True
    except Exception as e:  # noqa: BLE001
        log(f"  не удалось загрузить границу: {e}")
        log("  карта будет построена без контура региона")
        return False


def step_build_scale(df: pd.DataFrame, has_geo: pd.Series) -> dict:
    log("\n[5/5] Расчёт квантильных цветовых шкал ...")
    switchable = [MAIN_METRIC, "Автобусов на 10 000 человек", "Автобусы, шт.",
                  "Пассажирооборот на человека, пасс-км"]
    metrics = {}
    for name in switchable:
        values = df.loc[has_geo, name].dropna()
        breaks = [round(float(b), 2) for b in values.quantile(SCALE_QUANTILES).tolist()]
        metrics[name] = {
            "breaks": breaks,
            "palette": PALETTE,
            "n": int(values.size),
        }
        log(f"  {name}: n={int(values.size)}, пороги={breaks}")
    scale = {
        "default_metric": MAIN_METRIC,
        "method": "квантильные пороги распределения показателя "
                  "(q = 0.00, 0.14, 0.28, 0.43, 0.57, 0.71, 0.86, 1.00)",
        "source": "Росстат, 2025",
        "no_data_color": "#3D4E63",
        "n_with_metric": int(df.loc[has_geo, MAIN_METRIC].notna().sum()),
        "n_without_metric": int(has_geo.sum() - df.loc[has_geo, MAIN_METRIC].notna().sum()),
        "metrics": metrics,
    }
    SCALE_OUT.write_text(json.dumps(scale, ensure_ascii=False, indent=2), encoding="utf-8")
    log(f"  -> {SCALE_OUT.relative_to(BASE_DIR)}")
    return scale


# ---------------------------------------------------------------- main

def main() -> None:
    parser = argparse.ArgumentParser(description="Подготовка данных «Маршруты Кубани»")
    parser.add_argument("--no-download", action="store_true",
                        help="не загружать границы/дороги из OSM")
    args = parser.parse_args()

    if not CSV_PATH.exists():
        # запасной вариант: исходный CSV рядом с проектом
        alt = BASE_DIR.parent / "краснодарский_край_транспорт_2025.csv"
        if alt.exists():
            DATA_DIR.mkdir(exist_ok=True)
            CSV_PATH.write_bytes(alt.read_bytes())
        else:
            raise SystemExit(f"Не найден CSV: {CSV_PATH}")

    df = step_load_csv()
    has_geo, has_metric = step_validate(df)
    step_build_points(df, has_geo)

    if args.no_download:
        log("\n--no-download: граница края пропущена")
        region_ok = False
    else:
        region_ok = step_download_region()

    step_build_scale(df, has_geo)

    log("\n=== Итог ===")
    log(f"Точки: {POINTS_OUT.name} | Шкала: {SCALE_OUT.name}")
    log(f"Граница края: {'есть' if region_ok else 'нет'}")
    log("Слой дорог строится во frontend из векторных тайлов OpenFreeMap (OSM).")
    log("Готово.")


if __name__ == "__main__":
    sys.exit(main())
