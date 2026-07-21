/**
 * K线离线助手 — 主逻辑
 * 三类数据来源，全部离线存入 IndexedDB：
 *  1. 数据中心：云端 GitHub Actions 每日抓取（雅虎/东财/新浪/FRED），App 从同源 data/ 目录同步
 *  2. 加密货币：币安公开 API 浏览器直连（免密钥、支持跨域）
 *  3. CSV 导入：Wind/iFind 等终端导出的文件
 */
'use strict';

// 备用域名依次重试（不同网络环境可达性不同）
const API_HOSTS = [
  'https://data-api.binance.vision',
  'https://api.binance.com',
  'https://api1.binance.com',
  'https://api2.binance.com',
];
const BATCH_LIMIT = 1000; // 币安单次最多返回1000根

const INTERVAL_MS = {
  '1m': 60e3, '5m': 300e3, '15m': 900e3, '30m': 1800e3,
  '1h': 3600e3, '4h': 14400e3, '1d': 86400e3, '1w': 604800e3,
};
const INTERVAL_LABEL = {
  '1m': '1分', '5m': '5分', '15m': '15分', '30m': '30分',
  '1h': '1小时', '4h': '4小时', '1d': '日线', '1w': '周线',
};

// ---------------- IndexedDB ----------------
const DB_NAME = 'kline-offline';
let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore('datasets', { keyPath: 'key' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function dbGet(key) {
  return openDB().then(db => new Promise((res, rej) => {
    const r = db.transaction('datasets').objectStore('datasets').get(key);
    r.onsuccess = () => res(r.result || null);
    r.onerror = () => rej(r.error);
  }));
}

function dbPut(record) {
  return openDB().then(db => new Promise((res, rej) => {
    const tx = db.transaction('datasets', 'readwrite');
    tx.objectStore('datasets').put(record);
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  }));
}

function dbDelete(key) {
  return openDB().then(db => new Promise((res, rej) => {
    const tx = db.transaction('datasets', 'readwrite');
    tx.objectStore('datasets').delete(key);
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  }));
}

function dbGetAllMeta() {
  return openDB().then(db => new Promise((res, rej) => {
    const r = db.transaction('datasets').objectStore('datasets').getAll();
    r.onsuccess = () => res((r.result || []).map(d => ({
      key: d.key, symbol: d.symbol, interval: d.interval,
      name: d.name || d.symbol, type: d.type || 'ohlc',
      source: d.source || 'binance', file: d.file, category: d.category,
      count: d.candles.length,
      firstTime: d.candles.length ? d.candles[0][0] : 0,
      lastTime: d.candles.length ? d.candles[d.candles.length - 1][0] : 0,
      updatedAt: d.updatedAt,
    })));
    r.onerror = () => rej(r.error);
  }));
}

// ---------------- 币安数据下载 ----------------
class FatalError extends Error {}

async function fetchKlines(symbol, interval, startTime, endTime) {
  const params = `symbol=${symbol}&interval=${interval}&startTime=${startTime}&endTime=${endTime}&limit=${BATCH_LIMIT}`;
  let lastErr = null;
  for (const host of API_HOSTS) {
    try {
      const resp = await fetch(`${host}/api/v3/klines?${params}`, { signal: AbortSignal.timeout(15000) });
      if (resp.status === 400) {
        const body = await resp.json().catch(() => ({}));
        throw new FatalError(body.msg === 'Invalid symbol.' ? `交易对 ${symbol} 不存在` : (body.msg || '请求参数错误'));
      }
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const raw = await resp.json();
      // 只保留 [时间, 开, 高, 低, 收, 量]
      return raw.map(k => [k[0], +k[1], +k[2], +k[3], +k[4], +k[5]]);
    } catch (e) {
      if (e instanceof FatalError) throw e;
      lastErr = e;
    }
  }
  throw lastErr || new Error('网络请求失败');
}

/** 下载 [startTime, now] 范围的K线并与已有数据合并入库（增量） */
async function downloadBinance(symbol, interval, startTime, onProgress) {
  const key = `${symbol}_${interval}`;
  const existing = await dbGet(key);
  const step = INTERVAL_MS[interval];
  const now = Date.now();

  let from = startTime;
  if (existing && existing.candles.length) {
    const lastT = existing.candles[existing.candles.length - 1][0];
    if (startTime < existing.candles[0][0] - step) {
      await downloadRange(symbol, interval, startTime, existing.candles[0][0] - 1, onProgress, key);
    }
    from = lastT; // 从最后一根重下（该根可能未收盘）
  }
  await downloadRange(symbol, interval, from, now, onProgress, key);
  return dbGet(key);
}

async function downloadRange(symbol, interval, from, to, onProgress, key) {
  const step = INTERVAL_MS[interval];
  const totalBatches = Math.max(1, Math.ceil((to - from) / step / BATCH_LIMIT));
  let done = 0;
  let cursor = from;

  while (cursor <= to) {
    const batch = await fetchKlines(symbol, interval, cursor, to);
    done++;
    onProgress && onProgress(Math.min(done, totalBatches), totalBatches);
    if (!batch.length) break;
    await mergeCandles(key, symbol, interval, batch);
    const lastT = batch[batch.length - 1][0];
    if (batch.length < BATCH_LIMIT || lastT + step > to) break;
    cursor = lastT + step;
  }
}

async function mergeCandles(key, symbol, interval, newCandles) {
  const rec = (await dbGet(key)) || {
    key, symbol, interval, name: symbol, type: 'ohlc', source: 'binance',
    category: '加密货币', candles: [], updatedAt: 0,
  };
  const map = new Map(rec.candles.map(c => [c[0], c]));
  for (const c of newCandles) map.set(c[0], c);
  rec.candles = [...map.values()].sort((a, b) => a[0] - b[0]);
  rec.updatedAt = Date.now();
  await dbPut(rec);
}

// ---------------- 数据中心（云端抓取的静态数据） ----------------
let dcIndex = null; // data/index.json 内容

async function loadDataCenter() {
  const wrap = $('dc-list');
  if (!navigator.onLine) {
    wrap.innerHTML = '<p class="empty-hint">当前离线。已下载的数据在下方「已离线的数据」中查看。</p>';
    return;
  }
  try {
    const resp = await fetch(`data/index.json?_=${Date.now()}`);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    dcIndex = await resp.json();
    renderDataCenter();
  } catch (e) {
    console.warn('数据目录加载失败', e);
    wrap.innerHTML = '<p class="empty-hint">数据目录加载失败。请确认应用部署在含 data/ 目录的站点（GitHub Pages），且云端抓取已运行过。</p>';
  }
}

async function renderDataCenter() {
  if (!dcIndex) return;
  const saved = new Set((await dbGetAllMeta()).map(m => m.key));
  const wrap = $('dc-list');
  wrap.innerHTML = '';
  const byCat = new Map();
  for (const it of dcIndex.items) {
    if (!byCat.has(it.category)) byCat.set(it.category, []);
    byCat.get(it.category).push(it);
  }
  for (const [cat, items] of byCat) {
    const head = document.createElement('div');
    head.className = 'dc-cat';
    head.innerHTML = `<span>${cat}（${items.length}）</span>`;
    const btn = document.createElement('button');
    btn.className = 'btn-mini';
    btn.textContent = '本类全下';
    btn.addEventListener('click', () => downloadDcItems(items));
    head.appendChild(btn);
    wrap.appendChild(head);

    for (const it of items) {
      const row = document.createElement('div');
      row.className = 'dc-item';
      const d2 = new Date(it.lastTime);
      const isSaved = saved.has(`dc_${it.id}`);
      row.innerHTML = `
        <div>
          <div class="dc-name">${it.name}</div>
          <div class="dc-meta">${it.type === 'line' ? '序列' : '日K'} · ${it.count.toLocaleString()} 条 · 至 ${d2.getFullYear()}/${d2.getMonth() + 1}/${d2.getDate()}</div>
        </div>
        <button class="dc-btn ${isSaved ? 'saved' : ''}">${isSaved ? '✓ 已存' : '下载'}</button>`;
      row.querySelector('.dc-btn').addEventListener('click', () => downloadDcItems([it]));
      wrap.appendChild(row);
    }
  }
}

async function downloadDcItem(it) {
  const resp = await fetch(`data/${it.file}?_=${Date.now()}`);
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const j = await resp.json();
  await dbPut({
    key: `dc_${j.id}`, symbol: j.id, name: j.name, category: j.category,
    interval: j.interval || '1d', type: j.type, unit: j.unit || '',
    source: 'datacenter', file: it.file,
    candles: j.candles || j.points,
    updatedAt: Date.now(),
  });
}

async function downloadDcItems(items) {
  if (busy) return;
  if (!navigator.onLine) { toast('当前离线，无法下载'); return; }
  busy = true;
  let ok = 0, fail = 0;
  for (const it of items) {
    try {
      toast(`下载中 ${ok + fail + 1}/${items.length}：${it.name}`, 8000);
      await downloadDcItem(it);
      ok++;
    } catch (e) { console.error(e); fail++; }
  }
  busy = false;
  toast(fail ? `完成：${ok} 成功，${fail} 失败` : `✅ ${ok} 项已离线保存`);
  renderDataCenter();
  refreshList();
}

// ---------------- CSV 导入（Wind/iFind 等终端导出） ----------------
function parseCSV(text) {
  // 自动识别分隔符、日期列与数值列；支持 日期+OHLC[+量] 或 日期+单值
  const lines = text.replace(/^﻿/, '').split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) throw new Error('文件内容太少');
  const delim = (lines[0].match(/\t/g) || []).length >= 1 ? '\t' : ',';

  const parseDate = s => {
    s = s.trim().replace(/[""]/g, '');
    let m = s.match(/^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})/);
    if (m) return Date.UTC(+m[1], +m[2] - 1, +m[3]);
    m = s.match(/^(\d{4})(\d{2})(\d{2})$/);
    if (m) return Date.UTC(+m[1], +m[2] - 1, +m[3]);
    return null;
  };
  const parseNum = s => {
    const v = parseFloat(String(s).replace(/[",，\s]/g, ''));
    return isNaN(v) ? null : v;
  };

  const rows = [];
  for (const line of lines) {
    const cells = line.split(delim);
    const t = parseDate(cells[0]);
    if (t == null) continue; // 表头或无效行
    const nums = cells.slice(1).map(parseNum).filter(v => v != null);
    if (nums.length) rows.push([t, ...nums]);
  }
  if (rows.length < 2) throw new Error('未识别出「日期+数值」的数据行');
  rows.sort((a, b) => a[0] - b[0]);

  const minCols = Math.min(...rows.map(r => r.length - 1));
  if (minCols >= 4) {
    // 日期,开,高,低,收[,量]
    return { type: 'ohlc', candles: rows.map(r => [r[0], r[1], r[2], r[3], r[4], r[5] || 0]) };
  }
  return { type: 'line', candles: rows.map(r => [r[0], r[1]]) };
}

async function importCSVFiles(files) {
  let ok = 0;
  for (const file of files) {
    try {
      const text = await file.text();
      const { type, candles } = parseCSV(text);
      const defaultName = file.name.replace(/\.(csv|txt)$/i, '');
      const name = (prompt(`为「${file.name}」命名（${type === 'ohlc' ? 'K线' : '数据序列'}，${candles.length} 条）：`, defaultName) || defaultName).trim();
      // 周期推断：相邻时间差的中位数
      const gaps = [];
      for (let i = 1; i < Math.min(candles.length, 50); i++) gaps.push(candles[i][0] - candles[i - 1][0]);
      gaps.sort((a, b) => a - b);
      const gap = gaps[Math.floor(gaps.length / 2)] || 86400e3;
      const interval = gap < 3600e3 * 20 ? '1h' : '1d';
      await dbPut({
        key: `csv_${name}_${Date.now()}`, symbol: name, name, category: '导入数据',
        interval, type, unit: '', source: 'csv', candles, updatedAt: Date.now(),
      });
      ok++;
    } catch (e) {
      console.error(e);
      toast(`❌ ${file.name}：${e.message}`, 4000);
    }
  }
  if (ok) toast(`✅ 已导入 ${ok} 个文件`);
  refreshList();
}

// ---------------- UI 状态 ----------------
const $ = id => document.getElementById(id);
let selectedIntervals = new Set(['1h', '1d']);
let selectedDays = 365;
let chart = null;
let currentDataset = null;
let busy = false;

function toast(msg, ms = 2600) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.add('hidden'), ms);
}

function updateNetStatus() {
  const online = navigator.onLine;
  $('net-status').classList.toggle('online', online);
  $('net-text').textContent = online ? '在线' : '离线（可查看已下载数据）';
}

// ---------------- 已离线数据列表 ----------------
async function refreshList() {
  const list = await dbGetAllMeta();
  const catOrder = ['国际商品', '国内期货', '股票指数', '个股', '国债收益率', '宏观数据', '加密货币', '导入数据'];
  list.sort((a, b) => {
    const ca = catOrder.indexOf(a.category), cb = catOrder.indexOf(b.category);
    if (ca !== cb) return (ca < 0 ? 99 : ca) - (cb < 0 ? 99 : cb);
    if (a.name !== b.name) return a.name.localeCompare(b.name, 'zh');
    return (INTERVAL_MS[a.interval] || 0) - (INTERVAL_MS[b.interval] || 0);
  });
  const wrap = $('dataset-list');
  wrap.innerHTML = '';
  if (!list.length) {
    wrap.innerHTML = '<p class="empty-hint">还没有离线数据。联网时先下载，飞机上就能随时查看。</p>';
  }
  for (const m of list) {
    const item = document.createElement('div');
    item.className = 'dataset-item';
    const d1 = new Date(m.firstTime), d2 = new Date(m.lastTime);
    const fmt = d => `${String(d.getFullYear()).slice(2)}/${d.getMonth() + 1}/${d.getDate()}`;
    const tag = m.type === 'line' ? '序列' : (INTERVAL_LABEL[m.interval] || m.interval);
    item.innerHTML = `
      <div class="dataset-info">
        <div class="dataset-name">${m.name}<span class="interval-tag">${tag}</span></div>
        <div class="dataset-meta">${m.count.toLocaleString()} 条 · ${fmt(d1)} ~ ${fmt(d2)}</div>
      </div>
      <button class="dataset-del" aria-label="删除">🗑</button>`;
    item.querySelector('.dataset-info').addEventListener('click', () => openChart(m.key));
    item.querySelector('.dataset-del').addEventListener('click', async e => {
      e.stopPropagation();
      if (confirm(`删除「${m.name}」的离线数据？`)) {
        await dbDelete(m.key);
        refreshList();
        renderDataCenter();
      }
    });
    wrap.appendChild(item);
  }
  updateStorageInfo();
}

async function updateStorageInfo() {
  const el = $('storage-info');
  try {
    if (navigator.storage && navigator.storage.estimate) {
      const est = await navigator.storage.estimate();
      const used = (est.usage / 1048576).toFixed(1);
      el.textContent = `本地已用存储约 ${used} MB`;
    }
  } catch (_) { el.textContent = ''; }
}

// ---------------- 币安下载操作 ----------------
async function handleBinanceDownload() {
  if (busy) return;
  const symbol = $('symbol-input').value.trim().toUpperCase();
  if (!symbol) { toast('请输入交易对'); return; }
  if (!selectedIntervals.size) { toast('请至少选择一个K线周期'); return; }
  if (!navigator.onLine) { toast('当前离线，无法下载'); return; }

  busy = true;
  const btn = $('download-btn');
  btn.disabled = true;
  $('download-progress').classList.remove('hidden');
  const startTime = Date.now() - selectedDays * 86400e3;
  const intervals = [...selectedIntervals].sort((a, b) => INTERVAL_MS[a] - INTERVAL_MS[b]);

  try {
    for (let i = 0; i < intervals.length; i++) {
      const iv = intervals[i];
      await downloadBinance(symbol, iv, startTime, (done, total) => {
        const frac = (i + done / total) / intervals.length;
        $('progress-fill').style.width = `${Math.round(frac * 100)}%`;
        $('progress-text').textContent = `${symbol} ${INTERVAL_LABEL[iv]}：第 ${done}/${total} 批`;
      });
    }
    $('progress-fill').style.width = '100%';
    toast(`✅ ${symbol} 下载完成，已离线保存`);
  } catch (e) {
    console.error(e);
    toast(e instanceof FatalError ? `❌ ${e.message}` : '❌ 下载失败，请检查网络后重试', 4000);
  } finally {
    busy = false;
    btn.disabled = false;
    setTimeout(() => $('download-progress').classList.add('hidden'), 1200);
    refreshList();
  }
}

/** 把所有已存数据集更新到最新（币安增量 / 数据中心重取；CSV 导入不动） */
async function updateAll(silent) {
  if (busy) return;
  if (!navigator.onLine) { if (!silent) toast('当前离线，无法更新'); return; }
  const list = (await dbGetAllMeta()).filter(m => m.source !== 'csv');
  if (!list.length) { if (!silent) toast('还没有可更新的数据'); return; }

  busy = true;
  const btn = $('update-all-btn');
  btn.disabled = true;
  let ok = 0, fail = 0;
  for (const m of list) {
    try {
      btn.textContent = `更新中 ${ok + fail + 1}/${list.length}`;
      if (m.source === 'datacenter') {
        await downloadDcItem({ file: m.file || `${m.symbol}.json` });
      } else {
        await downloadBinance(m.symbol, m.interval, m.lastTime, null);
      }
      ok++;
    } catch (e) {
      console.error('update failed', m.key, e);
      fail++;
    }
  }
  busy = false;
  btn.disabled = false;
  btn.textContent = '🔄 全部更新';
  refreshList();
  if (!silent || fail) toast(fail ? `更新完成：${ok} 成功，${fail} 失败` : `✅ ${ok} 组数据已更新到最新`);
}

// ---------------- 图表页 ----------------
async function openChart(key) {
  const rec = await dbGet(key);
  if (!rec || !rec.candles.length) { toast('数据为空'); return; }
  currentDataset = rec;

  $('home-view').classList.add('hidden');
  $('chart-view').classList.remove('hidden');
  $('chart-symbol').textContent = rec.name || rec.symbol;
  const d1 = new Date(rec.candles[0][0]);
  const d2 = new Date(rec.candles[rec.candles.length - 1][0]);
  const fmt = d => `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
  $('chart-range').textContent = `${fmt(d1)} ~ ${fmt(d2)} · ${rec.candles.length.toLocaleString()} 条`;

  // 币安数据：同一交易对的不同周期做快捷切换；其他来源隐藏
  const chipWrap = $('chart-interval-chips');
  chipWrap.innerHTML = '';
  if ((rec.source || 'binance') === 'binance') {
    const all = await dbGetAllMeta();
    const siblings = all.filter(m => m.source === 'binance' && m.symbol === rec.symbol)
      .sort((a, b) => INTERVAL_MS[a.interval] - INTERVAL_MS[b.interval]);
    for (const s of siblings) {
      const b = document.createElement('button');
      b.className = 'chip' + (s.key === key ? ' selected' : '');
      b.textContent = INTERVAL_LABEL[s.interval] || s.interval;
      b.addEventListener('click', () => { if (s.key !== key) openChart(s.key); });
      chipWrap.appendChild(b);
    }
  }

  if (!chart) {
    chart = new KlineChart($('chart-canvas'), { onCrosshair: showOHLC });
  }
  chart.setData(rec.candles, rec.interval, rec.type || 'ohlc');
  showOHLC(null);
}

function showOHLC(info) {
  const el = $('ohlc-info');
  const rec = currentDataset;
  if (!rec) return;
  const c = info ? info.candle : rec.candles[rec.candles.length - 1];
  const idx = info ? info.index : rec.candles.length - 1;

  if ((rec.type || 'ohlc') === 'line') {
    const prev = idx > 0 ? rec.candles[idx - 1][1] : c[1];
    const diff = c[1] - prev;
    const cls = diff >= 0 ? 'up' : 'down';
    el.innerHTML =
      `${fmtTimeFull(c[0], rec.interval)} ${info ? '' : '(最新)'} · ` +
      `${rec.name}：<b class="${cls}">${fmtPrice(c[1])}${rec.unit || ''}</b> ` +
      `<span class="${cls}">较前值 ${diff >= 0 ? '+' : ''}${fmtPrice(Math.abs(diff) < 1 ? +diff.toFixed(4) : +diff.toFixed(2))}</span>`;
    return;
  }

  const [t, o, h, l, cl, v] = c;
  const chg = ((cl - o) / o * 100);
  const cls = chg >= 0 ? 'up' : 'down';
  const maStr = info && info.ma && info.ma[7] != null
    ? ` · MA7 <b>${fmtPrice(info.ma[7])}</b> MA25 <b>${info.ma[25] != null ? fmtPrice(info.ma[25]) : '-'}</b> MA99 <b>${info.ma[99] != null ? fmtPrice(info.ma[99]) : '-'}</b>`
    : '';
  el.innerHTML =
    `${fmtTimeFull(t, rec.interval)} ${info ? '' : '(最新)'} · ` +
    `开 <b>${fmtPrice(o)}</b> 高 <b>${fmtPrice(h)}</b> 低 <b>${fmtPrice(l)}</b> 收 <b class="${cls}">${fmtPrice(cl)}</b> ` +
    `<span class="${cls}">${chg >= 0 ? '+' : ''}${chg.toFixed(2)}%</span> · 量 <b>${fmtVol(v)}</b>${maStr}`;
}

function fmtVol(v) {
  if (v >= 1e9) return (v / 1e9).toFixed(2) + 'B';
  if (v >= 1e6) return (v / 1e6).toFixed(2) + 'M';
  if (v >= 1e3) return (v / 1e3).toFixed(2) + 'K';
  return v.toFixed(2);
}

function closeChart() {
  $('chart-view').classList.add('hidden');
  $('home-view').classList.remove('hidden');
  currentDataset = null;
}

// ---------------- 初始化 ----------------
function initChips() {
  $('symbol-chips').addEventListener('click', e => {
    const b = e.target.closest('.chip');
    if (!b) return;
    $('symbol-input').value = b.dataset.symbol;
    [...$('symbol-chips').children].forEach(c => c.classList.toggle('selected', c === b));
  });
  $('interval-chips').addEventListener('click', e => {
    const b = e.target.closest('.chip');
    if (!b) return;
    const iv = b.dataset.interval;
    if (selectedIntervals.has(iv)) { selectedIntervals.delete(iv); b.classList.remove('selected'); }
    else { selectedIntervals.add(iv); b.classList.add('selected'); }
  });
  $('range-chips').addEventListener('click', e => {
    const b = e.target.closest('.chip');
    if (!b) return;
    selectedDays = +b.dataset.days;
    [...$('range-chips').children].forEach(c => c.classList.toggle('selected', c === b));
  });
}

function init() {
  initChips();
  $('download-btn').addEventListener('click', handleBinanceDownload);
  $('update-all-btn').addEventListener('click', () => updateAll(false));
  $('back-btn').addEventListener('click', closeChart);
  $('dc-download-all-btn').addEventListener('click', () => {
    if (dcIndex) downloadDcItems(dcIndex.items);
    else toast('数据目录尚未加载');
  });
  $('import-csv-btn').addEventListener('click', () => $('csv-file-input').click());
  $('csv-file-input').addEventListener('change', e => {
    if (e.target.files.length) importCSVFiles([...e.target.files]);
    e.target.value = '';
  });
  window.addEventListener('online', () => { updateNetStatus(); loadDataCenter(); updateAll(true); });
  window.addEventListener('offline', updateNetStatus);
  updateNetStatus();
  refreshList();
  loadDataCenter();

  // 联网打开时自动把已有数据更新到最新
  if (navigator.onLine) setTimeout(() => updateAll(true), 800);

  // 注册 Service Worker，让应用本身离线可用
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(e => console.warn('SW 注册失败', e));
  }
  // 申请持久化存储，降低系统自动清理离线数据的概率
  if (navigator.storage && navigator.storage.persist) {
    navigator.storage.persist().catch(() => {});
  }
}

init();
