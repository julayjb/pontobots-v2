/* ============================================================
   PontoBots v2 — charts.js
   Wrapper de lightweight-charts para candles/line/heikin-ashi,
   overlays de granularidade, marcação de entradas/saídas,
   e gráfico de equity.
   ============================================================ */

import { store } from './state.js';

// Cache de charts ativos por container id
const chartInstances = new Map();

// ──────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────
function applyTheme(chart) {
  chart.applyOptions({
    layout: {
      background: { color: '#0f1117' },
      textColor: '#bdc4cc',
      fontFamily: "'JetBrains Mono', monospace",
    },
    grid: {
      vertLines: { color: '#1a1f28' },
      horzLines: { color: '#1a1f28' },
    },
    crosshair: {
      vertLine: { color: '#2f7cf0', width: 1, style: 2 },
      horzLine: { color: '#2f7cf0', width: 1, style: 2 },
    },
    timeScale: {
      borderColor: '#2a2f3a',
      timeVisible: true,
      secondsVisible: true,
    },
    rightPriceScale: { borderColor: '#2a2f3a' },
  });
}

// Cálculo de Heikin-Ashi
function toHeikinAshi(candles) {
  const result = [];
  let prevOpen = candles[0]?.open ?? 0;
  let prevClose = candles[0]?.close ?? 0;
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const close = (c.open + c.high + c.low + c.close) / 4;
    const open = i === 0 ? (c.open + c.close) / 2 : (prevOpen + prevClose) / 2;
    const high = Math.max(c.high, open, close);
    const low  = Math.min(c.low, open, close);
    result.push({ time: c.time, open, high, low, close });
    prevOpen = open;
    prevClose = close;
  }
  return result;
}

function candlesToLightweight(candles) {
  return candles.map(c => ({
    time: typeof c.epoch === 'number' ? c.epoch : c.time,
    open: parseFloat(c.open),
    high: parseFloat(c.high),
    low: parseFloat(c.low),
    close: parseFloat(c.close),
  }));
}

function ticksToLightweight(ticks) {
  return ticks.map(t => ({
    time: t.epoch,
    value: parseFloat(t.quote),
  }));
}

// ──────────────────────────────────────────────────────────────
// Criação / atualização de um gráfico de candles
// ──────────────────────────────────────────────────────────────
export function createCandleChart(containerId, { style = 'candlestick' } = {}) {
  const container = typeof containerId === 'string' ? document.getElementById(containerId) : containerId;
  if (!container) return null;

  // Limpar anterior se existir
  destroyChart(containerId);

  const chart = LightweightCharts.createChart(container, {
    width: container.clientWidth,
    height: container.clientHeight || 280,
    layout: { background: { color: '#0f1117' }, textColor: '#bdc4cc' },
  });
  applyTheme(chart);

  // Responsivo
  const resizeObs = new ResizeObserver(() => {
    chart.applyOptions({ width: container.clientWidth, height: container.clientHeight || 280 });
  });
  resizeObs.observe(container);

  let series;
  if (style === 'line') {
    series = chart.addLineSeries({ color: '#0ff', lineWidth: 2 });
  } else if (style === 'heikin-ashi') {
    series = chart.addCandlestickSeries({
      upColor: '#1fdb7a', downColor: '#ff5f6d',
      borderUpColor: '#1fdb7a', borderDownColor: '#ff5f6d',
      wickUpColor: '#1fdb7a', wickDownColor: '#ff5f6d',
    });
  } else {
    series = chart.addCandlestickSeries({
      upColor: '#1fdb7a', downColor: '#ff5f6d',
      borderUpColor: '#1fdb7a', borderDownColor: '#ff5f6d',
      wickUpColor: '#1fdb7a', wickDownColor: '#ff5f6d',
    });
  }

  const instance = {
    chart,
    series,
    style,
    pipSize: null,  // setado via setPricePrecision
    markers: [],
    overlaySeries: null,
    resizeObs,
    container,
  };
  chartInstances.set(containerId, instance);
  return instance;
}

export function destroyChart(containerId) {
  const inst = chartInstances.get(containerId);
  if (!inst) return;
  try {
    inst.resizeObs?.disconnect();
    inst.chart.remove();
  } catch(e) {}
  chartInstances.delete(containerId);
}

/** Aplica precisão decimal (pip_size) à série do gráfico */
export function setPricePrecision(containerId, pipSize) {
  const inst = chartInstances.get(containerId);
  if (!inst || pipSize == null) return;
  inst.pipSize = pipSize;
  const minMove = pipSize > 0 ? Math.pow(10, -pipSize) : 1;
  inst.series.applyOptions({
    priceFormat: {
      type: 'price',
      precision: pipSize,
      minMove,
    },
  });
}

export function setData(containerId, candles, { style } = {}) {
  let inst = chartInstances.get(containerId);
  if (!inst) {
    inst = createCandleChart(containerId, { style: style || 'candlestick' });
    if (!inst) return;
  }
  if (style && style !== inst.style) {
    // Reconstruir com novo estilo
    destroyChart(containerId);
    inst = createCandleChart(containerId, { style });
  }
  let data = candlesToLightweight(candles);
  if (inst.style === 'heikin-ashi') data = toHeikinAshi(data);
  if (inst.style === 'line') {
    inst.series.setData(data.map(d => ({ time: d.time, value: d.close })));
  } else {
    inst.series.setData(data);
  }
  inst.chart.timeScale().fitContent();
}

export function setTickData(containerId, ticks) {
  let inst = chartInstances.get(containerId);
  if (!inst) {
    inst = createCandleChart(containerId, { style: 'line' });
    if (!inst) return;
  }
  const data = ticksToLightweight(ticks);
  if (inst.series.seriesType?.() === 'Line') {
    inst.series.setData(data);
  } else {
    // Reconstruir como line
    destroyChart(containerId);
    inst = createCandleChart(containerId, { style: 'line' });
    inst.series.setData(data);
  }
  inst.chart.timeScale().fitContent();
}

// Atualiza incrementalmente última vela
export function updateLastCandle(containerId, candle) {
  const inst = chartInstances.get(containerId);
  if (!inst) return;
  const point = {
    time: candle.epoch || candle.time,
    open: parseFloat(candle.open),
    high: parseFloat(candle.high),
    low: parseFloat(candle.low),
    close: parseFloat(candle.close),
  };
  if (inst.style === 'heikin-ashi') {
    // Simplificado: para HA, recalcularia do histórico — apenas usa o ponto
    inst.series.update(point);
  } else if (inst.style === 'line') {
    inst.series.update({ time: point.time, value: point.close });
  } else {
    inst.series.update(point);
  }
}

// ──────────────────────────────────────────────────────────────
// Marcadores (entradas/saídas)
// ──────────────────────────────────────────────────────────────
export function addEntryMarker(containerId, { time, type = 'entry', result }) {
  const inst = chartInstances.get(containerId);
  if (!inst) return;
  inst.markers.push({
    time,
    position: type === 'entry' ? 'belowBar' : 'aboveBar',
    color: result === 'win' ? '#1fdb7a' : result === 'loss' ? '#ff5f6d' : '#0ff',
    shape: type === 'entry' ? 'arrowUp' : 'arrowDown',
    text: type === 'entry' ? '▶' : (result === 'win' ? 'W' : result === 'loss' ? 'L' : '⏹'),
  });
  inst.series.setMarkers(inst.markers);
}

export function clearMarkers(containerId) {
  const inst = chartInstances.get(containerId);
  if (!inst) return;
  inst.markers = [];
  inst.series.setMarkers([]);
}

// ──────────────────────────────────────────────────────────────
// Equity curve (line chart simples)
// ──────────────────────────────────────────────────────────────
export function renderEquityCurve(containerId, trades) {
  let inst = chartInstances.get(containerId);
  if (!inst) {
    inst = createCandleChart(containerId, { style: 'line' });
    if (!inst) return;
  }
  // Verifica se a série atual é line; se não, recria
  if (inst.style !== 'line') {
    destroyChart(containerId);
    inst = createCandleChart(containerId, { style: 'line' });
  }
  // Acumula P&L por tempo
  let cumulative = 0;
  const points = [{ time: Math.floor(Date.now() / 1000) - 86400, value: 0 }];
  // Ordena por timestamp
  const sorted = [...trades].sort((a, b) => a.timestamp - b.timestamp);
  for (const t of sorted) {
    cumulative += (t.pnl || 0);
    points.push({ time: Math.floor(t.timestamp / 1000), value: parseFloat(cumulative.toFixed(2)) });
  }
  inst.series.setData(points);
  inst.series.applyOptions({ color: cumulative >= 0 ? '#1fdb7a' : '#ff5f6d', lineWidth: 2 });
  inst.chart.timeScale().fitContent();
}

// ──────────────────────────────────────────────────────────────
// Overlay de granularidade diferente
// ──────────────────────────────────────────────────────────────
export function addOverlay(containerId, candles, { color = '#bb86fc' } = {}) {
  const inst = chartInstances.get(containerId);
  if (!inst) return;
  if (inst.overlaySeries) {
    try { inst.chart.removeSeries(inst.overlaySeries); } catch(e) {}
  }
  inst.overlaySeries = inst.chart.addLineSeries({ color, lineWidth: 1, lineStyle: 2 });
  inst.overlaySeries.setData(candlesToLightweight(candles).map(c => ({ time: c.time, value: c.close })));
}

export function removeOverlay(containerId) {
  const inst = chartInstances.get(containerId);
  if (!inst || !inst.overlaySeries) return;
  try { inst.chart.removeSeries(inst.overlaySeries); } catch(e) {}
  inst.overlaySeries = null;
}

// ──────────────────────────────────────────────────────────────
// Countdown até fechamento da próxima vela
// ──────────────────────────────────────────────────────────────
export function startCandleCountdown(elementId, granularitySec) {
  const el = typeof elementId === 'string' ? document.getElementById(elementId) : elementId;
  if (!el) return null;
  const update = () => {
    const now = Date.now();
    const next = Math.ceil(now / 1000 / granularitySec) * granularitySec;
    const diff = next - Math.floor(now / 1000);
    const mm = String(Math.floor(diff / 60)).padStart(2, '0');
    const ss = String(diff % 60).padStart(2, '0');
    el.textContent = `${mm}:${ss}`;
  };
  update();
  return setInterval(update, 1000);
}
