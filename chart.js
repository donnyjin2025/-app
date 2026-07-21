/**
 * 零依赖 Canvas K线图表
 * 蜡烛图 + 成交量 + MA(7/25/99) + 十字光标，支持触摸拖动/双指缩放/滚轮缩放
 * OHLC 数据: [[time(ms), open, high, low, close, volume], ...] 按时间升序
 * 折线数据(type='line'，用于收益率/宏观序列): [[time(ms), value], ...]
 */
class KlineChart {
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.data = [];
    this.interval = '1d';
    // 视口：start = 第一根可见K线的索引（可为小数），count = 可见K线数量
    this.view = { start: 0, count: 100 };
    this.cross = null; // 十字光标对应的数据索引
    this.onCrosshair = opts.onCrosshair || (() => {});
    this.colors = {
      bg: '#0d1117', grid: '#21262d', text: '#8b949e',
      up: '#26a69a', down: '#ef5350',
      ma7: '#f0b90b', ma25: '#e056fd', ma99: '#2f81f7',
      cross: '#8b949e', crossLabelBg: '#30363d',
    };
    this.padRight = 62;   // 右侧价格轴宽度
    this.padBottom = 22;  // 底部时间轴高度

    this._bindEvents();
    this._resizeObserver = new ResizeObserver(() => this.resize());
    this._resizeObserver.observe(canvas.parentElement || canvas);
  }

  setData(data, interval, type = 'ohlc') {
    this.data = data;
    this.interval = interval;
    this.type = type;
    this.cross = null;
    this._computeMA();
    const count = Math.min(120, Math.max(30, data.length));
    this.view = { start: Math.max(0, data.length - count), count };
    this.resize();
  }

  _computeMA() {
    const d = this.data;
    this.ma = { 7: [], 25: [], 99: [] };
    if (this.type === 'line') return; // 折线序列不画均线
    const periods = [7, 25, 99];
    const sums = { 7: 0, 25: 0, 99: 0 };
    for (let i = 0; i < d.length; i++) {
      for (const p of periods) {
        sums[p] += d[i][4];
        if (i >= p) sums[p] -= d[i - p][4];
        this.ma[p].push(i >= p - 1 ? sums[p] / p : null);
      }
    }
  }

  _closeOf(c) { return this.type === 'line' ? c[1] : c[4]; }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.round(rect.width * dpr);
    this.canvas.height = Math.round(rect.height * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.w = rect.width;
    this.h = rect.height;
    this.render();
  }

  // ---------- 坐标换算 ----------
  _chartW() { return this.w - this.padRight; }
  _priceH() { return (this.h - this.padBottom) * (this.type === 'line' ? 0.96 : 0.72); }
  _volTop() { return (this.h - this.padBottom) * 0.75; }
  _volH() { return (this.h - this.padBottom) * 0.25; }

  _xOfIndex(i) {
    const bw = this._chartW() / this.view.count;
    return (i - this.view.start) * bw + bw / 2;
  }
  _indexOfX(x) {
    const bw = this._chartW() / this.view.count;
    return Math.round(x / bw - 0.5 + this.view.start);
  }

  // ---------- 渲染 ----------
  render() {
    const { ctx, w, h } = this;
    if (!w || !h) return;
    ctx.fillStyle = this.colors.bg;
    ctx.fillRect(0, 0, w, h);
    if (!this.data.length) return;

    this._clampView();
    const first = Math.max(0, Math.floor(this.view.start));
    const last = Math.min(this.data.length - 1, Math.ceil(this.view.start + this.view.count));

    // 可见范围的价格/成交量极值（含MA）
    let min = Infinity, max = -Infinity, volMax = 0;
    for (let i = first; i <= last; i++) {
      const c = this.data[i];
      if (this.type === 'line') {
        if (c[1] < min) min = c[1];
        if (c[1] > max) max = c[1];
        continue;
      }
      if (c[3] < min) min = c[3];
      if (c[2] > max) max = c[2];
      if (c[5] > volMax) volMax = c[5];
      for (const p of [7, 25, 99]) {
        const v = this.ma[p][i];
        if (v != null) { if (v < min) min = v; if (v > max) max = v; }
      }
    }
    if (!isFinite(min) || !isFinite(max)) return;
    const padY = (max - min) * 0.06 || max * 0.01 || 1;
    min -= padY; max += padY;
    this._priceMin = min; this._priceMax = max;

    const priceH = this._priceH();
    const yOfPrice = p => (max - p) / (max - min) * priceH + 8;
    this._yOfPrice = yOfPrice;

    this._drawGrid(min, max, yOfPrice, first, last);
    if (this.type === 'line') {
      this._drawLine(first, last, yOfPrice);
    } else {
      this._drawCandles(first, last, yOfPrice, volMax);
      this._drawMAs(first, last, yOfPrice);
    }
    this._drawLastPrice(yOfPrice);
    if (this.cross != null) this._drawCrosshair(yOfPrice);
  }

  _clampView() {
    const v = this.view;
    v.count = Math.max(10, Math.min(500, v.count));
    // 允许左右各留 1/3 屏空白
    const slack = v.count / 3;
    v.start = Math.max(-slack, Math.min(this.data.length - v.count + slack, v.start));
  }

  _drawGrid(min, max, yOfPrice, first, last) {
    const { ctx } = this;
    const cw = this._chartW();
    ctx.strokeStyle = this.colors.grid;
    ctx.fillStyle = this.colors.text;
    ctx.font = '10px sans-serif';
    ctx.lineWidth = 1;

    // 水平网格 + 价格标签
    const step = niceStep((max - min) / 5);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    for (let p = Math.ceil(min / step) * step; p <= max; p += step) {
      const y = yOfPrice(p);
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(cw, y);
      ctx.stroke();
      ctx.fillText(fmtPrice(p), cw + 4, y);
    }

    // 垂直网格 + 时间标签
    const labelEvery = Math.max(1, Math.round(this.view.count / 5));
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (let i = first; i <= last; i++) {
      if (i % labelEvery !== 0) continue;
      const x = this._xOfIndex(i);
      if (x < 0 || x > cw) continue;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, this.h - this.padBottom);
      ctx.stroke();
      ctx.fillText(fmtTime(this.data[i][0], this.interval), x, this.h - this.padBottom + 5);
    }
  }

  _drawCandles(first, last, yOfPrice, volMax) {
    const { ctx } = this;
    const bw = this._chartW() / this.view.count;
    const bodyW = Math.max(1, bw * 0.7);
    const volTop = this._volTop();
    const volH = this._volH();

    for (let i = first; i <= last; i++) {
      const [, o, hi, lo, c, vol] = this.data[i];
      const x = this._xOfIndex(i);
      const up = c >= o;
      ctx.strokeStyle = ctx.fillStyle = up ? this.colors.up : this.colors.down;

      // 影线
      ctx.beginPath();
      ctx.moveTo(x, yOfPrice(hi));
      ctx.lineTo(x, yOfPrice(lo));
      ctx.lineWidth = Math.max(1, bw * 0.08);
      ctx.stroke();

      // 实体
      const yO = yOfPrice(o), yC = yOfPrice(c);
      const top = Math.min(yO, yC);
      const hBody = Math.max(1, Math.abs(yO - yC));
      ctx.fillRect(x - bodyW / 2, top, bodyW, hBody);

      // 成交量
      if (volMax > 0) {
        const vh = vol / volMax * volH * 0.9;
        ctx.globalAlpha = 0.55;
        ctx.fillRect(x - bodyW / 2, volTop + volH - vh, bodyW, vh);
        ctx.globalAlpha = 1;
      }
    }
  }

  _drawLine(first, last, yOfPrice) {
    const { ctx } = this;
    const color = this.colors.ma99;
    // 面积填充
    const bottom = this.h - this.padBottom;
    ctx.beginPath();
    for (let i = first; i <= last; i++) {
      const x = this._xOfIndex(i), y = yOfPrice(this.data[i][1]);
      if (i === first) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    const grad = ctx.createLinearGradient(0, 0, 0, bottom);
    grad.addColorStop(0, 'rgba(47, 129, 247, 0.25)');
    grad.addColorStop(1, 'rgba(47, 129, 247, 0)');
    ctx.save();
    ctx.lineTo(this._xOfIndex(last), bottom);
    ctx.lineTo(this._xOfIndex(first), bottom);
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();
    ctx.restore();
    // 折线本体
    ctx.beginPath();
    for (let i = first; i <= last; i++) {
      const x = this._xOfIndex(i), y = yOfPrice(this.data[i][1]);
      if (i === first) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.6;
    ctx.stroke();
  }

  _drawMAs(first, last, yOfPrice) {
    const { ctx } = this;
    const cfg = [[7, this.colors.ma7], [25, this.colors.ma25], [99, this.colors.ma99]];
    ctx.lineWidth = 1.2;
    for (const [p, color] of cfg) {
      ctx.strokeStyle = color;
      ctx.beginPath();
      let started = false;
      for (let i = first; i <= last; i++) {
        const v = this.ma[p][i];
        if (v == null) continue;
        const x = this._xOfIndex(i), y = yOfPrice(v);
        if (!started) { ctx.moveTo(x, y); started = true; }
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
  }

  _drawLastPrice(yOfPrice) {
    const { ctx } = this;
    const lastCandle = this.data[this.data.length - 1];
    const price = this._closeOf(lastCandle);
    if (price < this._priceMin || price > this._priceMax) return;
    const y = yOfPrice(price);
    const cw = this._chartW();
    const prev = this.data.length > 1 ? this._closeOf(this.data[this.data.length - 2]) : price;
    const up = this.type === 'line' ? price >= prev : price >= lastCandle[1];
    ctx.strokeStyle = up ? this.colors.up : this.colors.down;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(cw, y);
    ctx.stroke();
    ctx.setLineDash([]);
    const label = fmtPrice(price);
    ctx.font = '10px sans-serif';
    ctx.fillStyle = up ? this.colors.up : this.colors.down;
    ctx.fillRect(cw, y - 8, this.padRight, 16);
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, cw + 4, y);
  }

  _drawCrosshair(yOfPrice) {
    const { ctx } = this;
    const i = this.cross;
    if (i < 0 || i >= this.data.length) return;
    const c = this.data[i];
    const x = this._xOfIndex(i);
    const y = yOfPrice(this._closeOf(c));
    const cw = this._chartW();

    ctx.strokeStyle = this.colors.cross;
    ctx.setLineDash([3, 3]);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, this.h - this.padBottom);
    ctx.moveTo(0, y);
    ctx.lineTo(cw, y);
    ctx.stroke();
    ctx.setLineDash([]);

    // 时间标签
    const label = fmtTimeFull(c[0], this.interval);
    ctx.font = '10px sans-serif';
    const tw = ctx.measureText(label).width + 10;
    let lx = Math.max(0, Math.min(cw - tw, x - tw / 2));
    ctx.fillStyle = this.colors.crossLabelBg;
    ctx.fillRect(lx, this.h - this.padBottom, tw, this.padBottom - 2);
    ctx.fillStyle = '#e6edf3';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, lx + tw / 2, this.h - this.padBottom / 2 - 1);

    // 价格标签
    ctx.fillStyle = this.colors.crossLabelBg;
    ctx.fillRect(cw, y - 8, this.padRight, 16);
    ctx.fillStyle = '#e6edf3';
    ctx.textAlign = 'left';
    ctx.fillText(fmtPrice(this._closeOf(c)), cw + 4, y);
  }

  // ---------- 交互 ----------
  _bindEvents() {
    const el = this.canvas;
    let dragging = false, lastX = 0, moved = false;
    let pinchDist = 0, pinchCount = 0, pinchCenterIdx = 0;

    const pos = e => {
      const r = el.getBoundingClientRect();
      const t = e.touches ? e.touches[0] : e;
      return { x: t.clientX - r.left, y: t.clientY - r.top };
    };
    const dist2 = e => {
      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      return Math.hypot(dx, dy);
    };

    el.addEventListener('pointerdown', e => {
      if (e.pointerType === 'touch') return; // 触摸走 touch 事件
      dragging = true; moved = false; lastX = e.clientX;
      el.setPointerCapture(e.pointerId);
    });
    el.addEventListener('pointermove', e => {
      if (e.pointerType === 'touch') return;
      if (dragging) {
        const dx = e.clientX - lastX;
        if (Math.abs(dx) > 2) moved = true;
        lastX = e.clientX;
        this._pan(dx);
      } else {
        this._setCross(this._indexOfX(pos(e).x));
      }
    });
    el.addEventListener('pointerup', e => {
      if (e.pointerType === 'touch') return;
      if (dragging && !moved) this._setCross(this._indexOfX(pos(e).x));
      dragging = false;
    });
    el.addEventListener('wheel', e => {
      e.preventDefault();
      const factor = e.deltaY > 0 ? 1.15 : 1 / 1.15;
      this._zoom(factor, this._indexOfX(pos(e).x));
    }, { passive: false });

    el.addEventListener('touchstart', e => {
      e.preventDefault();
      if (e.touches.length === 1) {
        dragging = true; moved = false; lastX = e.touches[0].clientX;
      } else if (e.touches.length === 2) {
        dragging = false;
        pinchDist = dist2(e);
        pinchCount = this.view.count;
        const r = el.getBoundingClientRect();
        const cx = (e.touches[0].clientX + e.touches[1].clientX) / 2 - r.left;
        pinchCenterIdx = this._indexOfX(cx);
      }
    }, { passive: false });
    el.addEventListener('touchmove', e => {
      e.preventDefault();
      if (e.touches.length === 1 && dragging) {
        const dx = e.touches[0].clientX - lastX;
        if (Math.abs(dx) > 3) moved = true;
        lastX = e.touches[0].clientX;
        this._pan(dx);
      } else if (e.touches.length === 2 && pinchDist > 0) {
        const scale = pinchDist / dist2(e);
        this._zoomTo(pinchCount * scale, pinchCenterIdx);
      }
    }, { passive: false });
    el.addEventListener('touchend', e => {
      if (e.touches.length === 0) {
        if (dragging && !moved) {
          const r = el.getBoundingClientRect();
          this._setCross(this._indexOfX(e.changedTouches[0].clientX - r.left));
        }
        dragging = false; pinchDist = 0;
      }
    });
  }

  _pan(dxPixels) {
    const bw = this._chartW() / this.view.count;
    this.view.start -= dxPixels / bw;
    this.render();
  }

  _zoom(factor, centerIdx) {
    this._zoomTo(this.view.count * factor, centerIdx);
  }

  _zoomTo(newCount, centerIdx) {
    newCount = Math.max(10, Math.min(500, newCount));
    const ratio = (centerIdx - this.view.start) / this.view.count;
    this.view.count = newCount;
    this.view.start = centerIdx - ratio * newCount;
    this.render();
  }

  _setCross(i) {
    if (i < 0 || i >= this.data.length) { this.cross = null; }
    else if (this.cross === i) { this.cross = null; }
    else { this.cross = i; }
    this.onCrosshair(this.cross != null ? { index: this.cross, candle: this.data[this.cross], ma: { 7: this.ma[7][this.cross], 25: this.ma[25][this.cross], 99: this.ma[99][this.cross] } } : null);
    this.render();
  }

  destroy() {
    this._resizeObserver.disconnect();
  }
}

// ---------- 格式化工具 ----------
function niceStep(rough) {
  const mag = Math.pow(10, Math.floor(Math.log10(rough)));
  const norm = rough / mag;
  let n;
  if (norm < 1.5) n = 1;
  else if (norm < 3.5) n = 2;
  else if (norm < 7.5) n = 5;
  else n = 10;
  return n * mag;
}

function fmtPrice(p) {
  if (p < 0) return '-' + fmtPrice(-p);
  if (p === 0) return '0';
  if (p >= 10000) return p.toLocaleString('en-US', { maximumFractionDigits: 0 });
  if (p >= 100) return p.toFixed(1);
  if (p >= 1) return p.toFixed(2);
  if (p >= 0.01) return p.toFixed(4);
  return p.toPrecision(4);
}

function fmtTime(ms, interval) {
  const d = new Date(ms);
  const isIntraday = /m|h/.test(interval);
  if (isIntraday) {
    return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }
  return `${String(d.getFullYear()).slice(2)}/${d.getMonth() + 1}/${d.getDate()}`;
}

function fmtTimeFull(ms, interval) {
  const d = new Date(ms);
  const date = `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
  if (/m|h/.test(interval)) {
    return `${date} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }
  return date;
}
