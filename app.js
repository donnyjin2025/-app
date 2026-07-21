/**
 * K线离线助手 — 主逻辑
 * 数据源：币安公开行情 API（无需密钥，支持浏览器跨域）
 * 存储：IndexedDB，按「交易对+周期」为一条数据集记录
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
  // 只取元信息用于列表展示（避免整表数据进内存也无妨，数据集不会太多）
  return openDB().then(db => new Promise((res, rej) => {
    const r = db.transaction('datasets').objectStore('datasets').getAll();
    r.onsuccess = () => res((r.result || []).map(d => ({
      key: d.key, symbol: d.symbol, interval: d.interval,
      count: d.candles.length,
      firstTime: d.candles.length ? d.candles[0][0] : 0,
      lastTime: d.candles.length ? d.candles[d.candles.length - 1][0] : 0,
      updatedAt: d.updatedAt,
    })));
    r.onerror = () => rej(r.error);
  }));
}

// ---------------- 数据下载 ----------------
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

class FatalError extends Error {}

/**
 * 下载 [startTime, now] 范围的K线并与已有数据合并入库
 * onProgress(done, total) 以估算的批次数汇报进度
 */
async function downloadDataset(symbol, interval, startTime, onProgress) {
  const key = `${symbol}_${interval}`;
  const existing = await dbGet(key);
  const step = INTERVAL_MS[interval];
  const now = Date.now();

  // 增量：已有数据则只从最后一根之后开始补
  let from = startTime;
  if (existing && existing.candles.length) {
    const lastT = existing.candles[existing.candles.length - 1][0];
    // 若请求的起点早于已有的起点，仍需要往前补历史；简单起见分两段处理
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
  const rec = (await dbGet(key)) || { key, symbol, interval, candles: [], updatedAt: 0 };
  const map = new Map(rec.candles.map(c => [c[0], c]));
  for (const c of newCandles) map.set(c[0], c);
  rec.candles = [...map.values()].sort((a, b) => a[0] - b[0]);
  rec.updatedAt = Date.now();
  await dbPut(rec);
}

// ---------------- UI 状态 ----------------
const $ = id => document.getElementById(id);
let selectedSymbol = 'BTCUSDT';
let selectedIntervals = new Set(['1h', '1d']);
let selectedDays = 365;
let chart = null;
let currentDataset = null; // 当前图表页展示的数据集
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

// ---------------- 数据列表 ----------------
async function refreshList() {
  const list = await dbGetAllMeta();
  list.sort((a, b) => a.symbol === b.symbol
    ? INTERVAL_MS[a.interval] - INTERVAL_MS[b.interval]
    : a.symbol.localeCompare(b.symbol));
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
    item.innerHTML = `
      <div class="dataset-info">
        <div class="dataset-name">${m.symbol}<span class="interval-tag">${INTERVAL_LABEL[m.interval] || m.interval}</span></div>
        <div class="dataset-meta">${m.count.toLocaleString()} 根 · ${fmt(d1)} ~ ${fmt(d2)}</div>
      </div>
      <button class="dataset-del" aria-label="删除">🗑</button>`;
    item.querySelector('.dataset-info').addEventListener('click', () => openChart(m.key));
    item.querySelector('.dataset-del').addEventListener('click', async e => {
      e.stopPropagation();
      if (confirm(`删除 ${m.symbol} ${INTERVAL_LABEL[m.interval]} 的离线数据？`)) {
        await dbDelete(m.key);
        refreshList();
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

// ---------------- 下载操作 ----------------
async function handleDownload() {
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
      await downloadDataset(symbol, iv, startTime, (done, total) => {
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

/** 把所有已存数据集增量更新到最新 */
async function updateAll(silent) {
  if (busy) return;
  if (!navigator.onLine) { if (!silent) toast('当前离线，无法更新'); return; }
  const list = await dbGetAllMeta();
  if (!list.length) { if (!silent) toast('还没有可更新的数据'); return; }

  busy = true;
  const btn = $('update-all-btn');
  btn.disabled = true;
  let ok = 0, fail = 0;
  for (const m of list) {
    try {
      btn.textContent = `更新中 ${ok + fail + 1}/${list.length}`;
      await downloadDataset(m.symbol, m.interval, m.lastTime, null);
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
  $('chart-symbol').textContent = rec.symbol;
  const d1 = new Date(rec.candles[0][0]);
  const d2 = new Date(rec.candles[rec.candles.length - 1][0]);
  const fmt = d => `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
  $('chart-range').textContent = `${fmt(d1)} ~ ${fmt(d2)} · ${rec.candles.length.toLocaleString()} 根`;

  // 同一交易对已下载的其他周期，做成快捷切换
  const all = await dbGetAllMeta();
  const siblings = all.filter(m => m.symbol === rec.symbol)
    .sort((a, b) => INTERVAL_MS[a.interval] - INTERVAL_MS[b.interval]);
  const chipWrap = $('chart-interval-chips');
  chipWrap.innerHTML = '';
  for (const s of siblings) {
    const b = document.createElement('button');
    b.className = 'chip' + (s.key === key ? ' selected' : '');
    b.textContent = INTERVAL_LABEL[s.interval] || s.interval;
    b.addEventListener('click', () => { if (s.key !== key) openChart(s.key); });
    chipWrap.appendChild(b);
  }

  if (!chart) {
    chart = new KlineChart($('chart-canvas'), { onCrosshair: showOHLC });
  }
  chart.setData(rec.candles, rec.interval);
  showOHLC(null);
}

function showOHLC(info) {
  const el = $('ohlc-info');
  const rec = currentDataset;
  if (!rec) return;
  const c = info ? info.candle : rec.candles[rec.candles.length - 1];
  const [t, o, h, l, cl, v] = c;
  const chg = ((cl - o) / o * 100);
  const cls = chg >= 0 ? 'up' : 'down';
  const maStr = info && info.ma
    ? ` · MA7 <b>${info.ma[7] != null ? fmtPrice(info.ma[7]) : '-'}</b> MA25 <b>${info.ma[25] != null ? fmtPrice(info.ma[25]) : '-'}</b> MA99 <b>${info.ma[99] != null ? fmtPrice(info.ma[99]) : '-'}</b>`
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
    selectedSymbol = b.dataset.symbol;
    $('symbol-input').value = selectedSymbol;
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
  $('download-btn').addEventListener('click', handleDownload);
  $('update-all-btn').addEventListener('click', () => updateAll(false));
  $('back-btn').addEventListener('click', closeChart);
  window.addEventListener('online', () => { updateNetStatus(); updateAll(true); });
  window.addEventListener('offline', updateNetStatus);
  updateNetStatus();
  refreshList();

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
