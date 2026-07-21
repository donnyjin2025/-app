#!/usr/bin/env python3
"""
云端数据抓取脚本（仅用 Python 标准库，无需安装依赖）

读取 catalog.json，从 Yahoo Finance / 东方财富 / 新浪财经 / FRED 抓取
K线与宏观序列，写入 data/<id>.json 和清单 data/index.json。
由 GitHub Actions 每日定时执行，手机端 PWA 从 GitHub Pages 同步。

用法: python3 fetch_data.py [--only id1,id2]
"""
import json
import re
import sys
import time
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).parent
DATA_DIR = ROOT / "data"
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"


def http_get(url, referer=None, retries=3, ua=UA):
    headers = {"User-Agent": ua}
    if referer:
        headers["Referer"] = referer
    last = None
    for i in range(retries):
        try:
            req = urllib.request.Request(url, headers=headers)
            with urllib.request.urlopen(req, timeout=30) as r:
                return r.read().decode("utf-8", "replace")
        except Exception as e:  # noqa: BLE001
            last = e
            time.sleep(2 * (i + 1))
    raise last


def day_ms(datestr):
    """'2026-07-21' / '2026-07-21 00:00:00' -> 当天 UTC 毫秒时间戳"""
    d = datetime.strptime(datestr[:10], "%Y-%m-%d").replace(tzinfo=timezone.utc)
    return int(d.timestamp() * 1000)


# ---------------- 各数据源 ----------------

def fetch_yahoo(item):
    rng = item.get("range", "10y")
    url = (f"https://query1.finance.yahoo.com/v8/finance/chart/"
           f"{urllib.parse.quote(item['symbol'])}?range={rng}&interval=1d")
    j = json.loads(http_get(url))
    res = j["chart"]["result"][0]
    ts = res.get("timestamp") or []
    q = res["indicators"]["quote"][0]
    candles = []
    for i, t in enumerate(ts):
        o, h, l, c = q["open"][i], q["high"][i], q["low"][i], q["close"][i]
        if None in (o, h, l, c):
            continue
        v = q["volume"][i] or 0
        candles.append([t * 1000, round(o, 6), round(h, 6), round(l, 6), round(c, 6), v])
    return "ohlc", candles


def fetch_tencent(item):
    """腾讯行情：A股/指数日K（前复权）。单次上限约800根，按两年窗口翻页。"""
    sym = item["symbol"]
    start_year = int(item.get("start", "2005")[:4])
    end_year = datetime.now(timezone.utc).year
    seen = {}
    for y in range(start_year, end_year + 1, 2):
        url = ("https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?"
               f"param={sym},day,{y}-01-01,{y + 1}-12-31,800,qfq")
        j = json.loads(http_get(url))
        data = (j.get("data") or {}).get(sym) or {}
        rows = data.get("qfqday") or data.get("day") or []
        for r in rows:
            # 格式: [日期, 开, 收, 高, 低, 量]
            seen[r[0]] = [day_ms(r[0]), float(r[1]), float(r[3]), float(r[4]), float(r[2]), float(r[5])]
        time.sleep(0.3)
    candles = [seen[k] for k in sorted(seen)]
    return "ohlc", candles


def fetch_sina_futures(item):
    url = ("https://stock2.finance.sina.com.cn/futures/api/jsonp.php/var%20t=/"
           f"InnerFuturesNewService.getDailyKLine?symbol={item['symbol']}")
    text = http_get(url, referer="https://finance.sina.com.cn")
    m = re.search(r"\[.*\]", text, re.S)
    if not m:
        raise ValueError("sina 返回格式异常")
    rows = json.loads(m.group(0))
    candles = []
    for r in rows:
        candles.append([day_ms(r["d"]), float(r["o"]), float(r["h"]),
                        float(r["l"]), float(r["c"]), float(r.get("v") or 0)])
    return "ohlc", candles


def fetch_fred(item):
    # FRED 的 CDN 会拦截「浏览器 UA + 非浏览器指纹」的请求，用 curl UA 正常
    url = f"https://fred.stlouisfed.org/graph/fredgraph.csv?id={item['series']}"
    text = http_get(url, ua="curl/8.5.0")
    points = []
    for line in text.splitlines()[1:]:
        parts = line.split(",")
        if len(parts) < 2 or parts[1] in (".", ""):
            continue
        try:
            points.append([day_ms(parts[0]), float(parts[1])])
        except ValueError:
            continue
    if item.get("transform") == "yoy":  # 指数值转同比百分比（月度序列）
        points = [[p[0], round((p[1] / points[i - 12][1] - 1) * 100, 2)]
                  for i, p in enumerate(points) if i >= 12]
    return "line", points


_em_yield_cache = None

def fetch_em_yield(item):
    """东方财富 中美国债收益率表（一次抓全表，多序列共用缓存）"""
    global _em_yield_cache
    if _em_yield_cache is None:
        rows = []
        for page in range(1, 80):
            url = ("https://datacenter.eastmoney.com/api/data/get?"
                   f"type=RPTA_WEB_TREASURYYIELD&sty=ALL&st=SOLAR_DATE&sr=1&p={page}&ps=500")
            j = json.loads(http_get(url))
            batch = (j.get("result") or {}).get("data") or []
            rows.extend(batch)
            if len(batch) < 500:
                break
        _em_yield_cache = rows
    points = []
    for r in _em_yield_cache:
        v = r.get(item["field"])
        if v is None:
            continue
        points.append([day_ms(r["SOLAR_DATE"]), float(v)])
    points.sort(key=lambda p: p[0])
    return "line", points


def fetch_em_macro(item):
    url = ("https://datacenter-web.eastmoney.com/api/data/v1/get?"
           f"reportName={item['report']}&columns=ALL&pageSize=500&pageNumber=1&"
           "sortColumns=REPORT_DATE&sortTypes=-1")
    j = json.loads(http_get(url))
    rows = (j.get("result") or {}).get("data") or []
    points = []
    for r in rows:
        v = r.get(item["field"])
        if v in (None, "", "-"):
            continue
        points.append([day_ms(r["REPORT_DATE"]), float(v)])
    points.sort(key=lambda p: p[0])
    return "line", points


FETCHERS = {
    "yahoo": fetch_yahoo,
    "tencent": fetch_tencent,
    "sina_futures": fetch_sina_futures,
    "fred": fetch_fred,
    "em_yield": fetch_em_yield,
    "em_macro": fetch_em_macro,
}


def main():
    only = None
    if "--only" in sys.argv:
        only = set(sys.argv[sys.argv.index("--only") + 1].split(","))

    catalog = json.loads((ROOT / "catalog.json").read_text(encoding="utf-8"))
    DATA_DIR.mkdir(exist_ok=True)
    index_items, failures = [], []

    for item in catalog["series"]:
        if only and item["id"] not in only:
            continue
        try:
            dtype, rows = FETCHERS[item["src"]](item)
            if not rows:
                raise ValueError("空数据")
            out = {
                "id": item["id"], "name": item["name"], "category": item["category"],
                "type": dtype, "source": item["src"], "interval": "1d",
                "unit": item.get("unit", ""),
                "updatedAt": int(time.time() * 1000),
                ("candles" if dtype == "ohlc" else "points"): rows,
            }
            (DATA_DIR / f"{item['id']}.json").write_text(
                json.dumps(out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
            index_items.append({
                "id": item["id"], "name": item["name"], "category": item["category"],
                "type": dtype, "unit": item.get("unit", ""), "interval": "1d",
                "count": len(rows), "firstTime": rows[0][0], "lastTime": rows[-1][0],
                "file": f"{item['id']}.json",
            })
            print(f"✅ {item['id']:12s} {item['name']:12s} {len(rows)} 条")
        except Exception as e:  # noqa: BLE001
            failures.append(f"{item['id']}: {e}")
            print(f"❌ {item['id']:12s} {item['name']:12s} {e}")
        time.sleep(0.4)  # 对数据源友好

    # 与既有清单合并：本次没抓（--only 之外）或抓失败但数据文件仍在的条目保留，
    # 避免个别源临时故障导致条目从清单里消失
    merged = {}
    idx_path = DATA_DIR / "index.json"
    if idx_path.exists():
        for old in json.loads(idx_path.read_text(encoding="utf-8")).get("items", []):
            if (DATA_DIR / old["file"]).exists():
                merged[old["id"]] = old
    for it in index_items:
        merged[it["id"]] = it
    order = {s["id"]: n for n, s in enumerate(catalog["series"])}
    items = sorted(merged.values(), key=lambda x: order.get(x["id"], 999))
    idx_path.write_text(json.dumps({
        "generatedAt": int(time.time() * 1000),
        "items": items,
    }, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"\n完成：{len(index_items)} 成功，{len(failures)} 失败")
    for f in failures:
        print("  失败:", f)
    # 只要有一半以上成功就算通过（个别源临时故障不阻塞整体更新）
    sys.exit(0 if index_items and len(failures) < len(index_items) else 1)


if __name__ == "__main__":
    main()
