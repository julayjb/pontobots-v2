/* ============================================================
   PontoBots v2 — ui.js
   Controlador de UI: tabs, formulários dinâmicos por schema,
   modais, toasts, sons, confirmações em conta real,
   binding com store.
   ============================================================ */

import { store } from './state.js';
import * as DerivAPI from './deriv-api.js';
import * as Charts from './charts.js';
import * as Engine from './bots-engine.js';
import { listBots, getBot, getBotSchema, defaultParams } from './bots-library.js';

// ──────────────────────────────────────────────────────────────
// Helpers de DOM
// ──────────────────────────────────────────────────────────────
const $  = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

function fmtMoney(v, currency = 'USD') {
  const n = parseFloat(v || 0);
  return n.toLocaleString('pt-BR', { style: 'currency', currency });
}
function fmtPct(v) { return (parseFloat(v || 0)).toFixed(1) + '%'; }
function fmtTime(ts) { return new Date(ts).toLocaleString('pt-BR', { hour12: false }); }

// ──────────────────────────────────────────────────────────────
// Toast / Modal / Sound
// ──────────────────────────────────────────────────────────────
function toast(message, type = 'info', duration = 4000) {
  const c = $('#toastContainer');
  if (!c) return;
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = message;
  c.appendChild(el);
  setTimeout(() => { el.style.opacity = 0; el.style.transform = 'translateX(120%)'; setTimeout(() => el.remove(), 300); }, duration);
}

function showModal({ title, body, footer }) {
  $('#genericModalTitle').textContent = title;
  $('#genericModalBody').innerHTML = body;
  $('#genericModalFooter').innerHTML = '';
  if (footer) $('#genericModalFooter').innerHTML = footer;
  $('#genericModal').dataset.show = 'true';
}

function closeModal() {
  $('#genericModal').dataset.show = 'false';
}

function confirmDialog({ title, message, confirmLabel = 'Confirmar', danger = false }) {
  return new Promise((resolve) => {
    showModal({
      title,
      body: `<p>${message}</p>`,
      footer: `
        <button class="secondary" id="confirmCancel">Cancelar</button>
        <button class="${danger ? '' : 'primary'}" id="confirmOk" ${danger ? 'style="border-color:#ff5f6d;color:#ff5f6d;background:#2a0e10;"' : ''}>${confirmLabel}</button>
      `,
    });
    $('#confirmOk').onclick = () => { closeModal(); resolve(true); };
    $('#confirmCancel').onclick = () => { closeModal(); resolve(false); };
  });
}

// Sons via Web Audio API (sem precisar de arquivos)
let audioCtx = null;
function playSound(type) {
  const prefs = store.get('preferences.sounds');
  if (!prefs[type] && type !== 'entry') return;
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.connect(g); g.connect(audioCtx.destination);
    const freqs = {
      entry: [440, 660], win: [660, 880], loss: [220, 110], stop: [110, 55], disconnect: [330, 220],
    };
    const [f1, f2] = freqs[type] || [440, 440];
    o.frequency.setValueAtTime(f1, audioCtx.currentTime);
    o.frequency.setValueAtTime(f2, audioCtx.currentTime + 0.1);
    g.gain.setValueAtTime(0.15, audioCtx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.3);
    o.start(); o.stop(audioCtx.currentTime + 0.3);
  } catch(e) {}
}

function notify(title, body) {
  const prefs = store.get('preferences');
  if (prefs.browserNotif && 'Notification' in window && Notification.permission === 'granted') {
    new Notification(title, { body });
  }
}

// ──────────────────────────────────────────────────────────────
// Tabs
// ──────────────────────────────────────────────────────────────
function initTabs() {
  $$('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const target = btn.dataset.tab;
      $$('.tab-btn').forEach(b => b.classList.remove('active'));
      $$('.tab-content').forEach(c => c.classList.remove('active'));
      btn.classList.add('active');
      $(`#tab-${target}`).classList.add('active');
      // Refresh charts on tab show
      if (target === 'dashboard') refreshDashboard();
      if (target === 'graficos') refreshChartTab();
      if (target === 'digitos') refreshDigitTab();
      if (target === 'bots') refreshBotsTab();
      if (target === 'trades') refreshTradesTab();
    });
  });
}

// ──────────────────────────────────────────────────────────────
// Risk modal
// ──────────────────────────────────────────────────────────────
function initRiskModal() {
  const accepted = store.get('riskAccepted');
  if (accepted) $('#riskModal').dataset.show = 'false';
  $('#riskAcceptBtn').addEventListener('click', () => {
    store.set('riskAccepted', true);
    $('#riskModal').dataset.show = 'false';
  });
}

// ──────────────────────────────────────────────────────────────
// Header — account pill & conn status
// ──────────────────────────────────────────────────────────────
function refreshHeader() {
  const session = store.get('session');
  const conn = store.get('connection');
  const pill = $('#accountPill');
  const label = $('.account-label', pill);
  const connStatus = $('#connStatus');
  const connDot = $('.conn-dot', connStatus);
  const connText = $('.conn-text', connStatus);
  const connPing = $('#connPing');

  if (session.activeAccountId) {
    const acc = session.accounts.find(a => a.account_id === session.activeAccountId);
    if (acc) {
      pill.dataset.mode = acc.isVirtual ? 'demo' : 'real';
      label.textContent = `${acc.account_id} ${acc.isVirtual ? '(DEMO)' : '(REAL)'} • ${fmtMoney(acc.balance, acc.currency)}`;
    }
  } else if (session.accounts.length) {
    pill.dataset.mode = 'offline';
    label.textContent = 'Escolha uma conta';
  } else {
    pill.dataset.mode = 'offline';
    label.textContent = 'Desconectado';
  }

  const pubState = conn.publicWsState;
  connDot.dataset.state = pubState === 'online' ? 'online' : pubState === 'reconnect' ? 'reconnect' : 'offline';
  connText.textContent = pubState === 'online' ? 'online' : pubState === 'reconnect' ? 'reconectando' : 'offline';
  connPing.textContent = conn.latencyMs ? `${conn.latencyMs}ms` : '';

  // Conexão tab
  const authMtd = session.authMethod ? ` (${session.authMethod === 'pat' ? 'PAT' : 'OAuth'})` : '';
  $('#connStatusDetail').textContent = pubState + authMtd;
  $('#latencyDetail').textContent = conn.latencyMs ? `${conn.latencyMs} ms` : '—';
  const activeAcc = session.accounts.find(a => a.account_id === session.activeAccountId);
  $('#activeAccountDetail').textContent = activeAcc
    ? `${activeAcc.account_id} (${activeAcc.isVirtual ? 'DEMO' : 'REAL'}) — ${fmtMoney(activeAcc.balance, activeAcc.currency)}`
    : '—';
}

// ──────────────────────────────────────────────────────────────
// Conexão tab
// ──────────────────────────────────────────────────────────────
function initConexaoTab() {
  $('#oauthLoginBtn').addEventListener('click', () => DerivAPI.startOAuthLogin());

  // ── PAT Token ──
  const patInput = $('#patTokenInput');
  const patStatus = $('#patStatus');

  function setPatStatus(msg, type = '') {
    patStatus.textContent = msg;
    patStatus.style.color = type === 'error' ? '#ff5f6d' : type === 'ok' ? '#00c850' : '#8b949e';
  }

  $('#patConnectBtn').addEventListener('click', async () => {
    const pat = patInput.value.trim();
    if (!pat) { setPatStatus('Informe um PAT.', 'error'); return; }

    setPatStatus('Validando...');
    $('#patConnectBtn').disabled = true;

    const result = await DerivAPI.connectWithPat(pat);

    if (result.ok) {
      setPatStatus(`✅ Conectado — ${result.accounts.length} conta(s) encontrada(s).`, 'ok');
      patInput.value = ''; // limpa o campo por segurança
      refreshHeader();
      refreshAccounts();
      // Conecta WS público se ainda não estiver conectado
      DerivAPI.connectPublicWs();
    } else {
      setPatStatus(`❌ Falha: ${result.error}`, 'error');
    }

    $('#patConnectBtn').disabled = false;
  });

  $('#logoutBtn').addEventListener('click', async () => {
    const ok = await confirmDialog({
      title: 'Logout',
      message: 'Encerrar sessão? Tokens e conta ativa serão removidos deste navegador. Bots em execução serão parados.',
      confirmLabel: 'Logout',
      danger: true,
    });
    if (!ok) return;
    Engine.listRunningBots().forEach(b => Engine.stopBot(b.id));
    DerivAPI.disconnectAll();
    store.clearSession();
    store.resetVlCounters();
    refreshHeader();
    refreshAccounts();
    toast('Sessão encerrada.', 'info');
  });
}

async function refreshAccounts() {
  const tbody = $('#accountsTable tbody');
  const accounts = store.get('session.accounts') || [];
  if (!accounts.length) {
    tbody.innerHTML = '<tr class="empty-row"><td colspan="6">Nenhuma conta carregada. Faça login OAuth ou conecte via PAT.</td></tr>';
    return;
  }
  const active = store.get('session.activeAccountId');
  tbody.innerHTML = accounts.map(a => `
    <tr>
      <td><input type="radio" name="acc" ${a.account_id === active ? 'checked' : ''} value="${a.account_id}" /></td>
      <td>${a.account_id}</td>
      <td><span class="badge ${a.isVirtual ? 'badge-demo' : 'badge-real'}">${a.isVirtual ? 'DEMO' : 'REAL'}</span></td>
      <td>${a.currency}</td>
      <td>${fmtMoney(a.balance, a.currency)}</td>
      <td><button class="secondary" data-acc="${a.account_id}" style="padding:6px 12px;font-size:11px;margin:0;">Ativar</button></td>
    </tr>
  `).join('');

  $$('button[data-acc]', tbody).forEach(btn => {
    btn.addEventListener('click', async () => {
      const accId = btn.dataset.acc;
      const acc = accounts.find(a => a.account_id === accId);
      if (!acc) return;
      if (!acc.isVirtual) {
        const ok = await confirmDialog({
          title: 'Conta REAL',
          message: `Você está ativando a conta <strong>${accId}</strong> (REAL). Operações subsequentes serão com dinheiro real. Continuar?`,
          confirmLabel: 'Ativar conta real',
          danger: true,
        });
        if (!ok) return;
      }
      store.setActiveAccount(accId);
      await DerivAPI.connectAuthWs(accId);
      refreshHeader();
      toast(`Conta ${accId} ativada.`, 'ok');
    });
  });
}

// ──────────────────────────────────────────────────────────────
// Mercados tab
// ──────────────────────────────────────────────────────────────
function initMercadosTab() {
  $('#symbolSearch').addEventListener('input', renderSymbols);
  $('#symbolCategoryFilter').addEventListener('change', renderSymbols);
  $('#symbolFavFilter').addEventListener('change', renderSymbols);
}

function renderSymbols() {
  const tbody = $('#symbolsTable tbody');
  let symbols = store.get('symbols') || [];
  const search = ($('#symbolSearch')?.value || '').toLowerCase().trim();
  const cat = $('#symbolCategoryFilter')?.value || '';
  const favOnly = $('#symbolFavFilter')?.value === 'fav';
  const favs = store.get('favorites') || [];

  if (search) symbols = symbols.filter(s =>
    (s.symbol || '').toLowerCase().includes(search) ||
    (s.display_name || '').toLowerCase().includes(search)
  );
  if (cat) symbols = symbols.filter(s => s.market === cat);
  if (favOnly) symbols = symbols.filter(s => favs.includes(s.symbol));

  if (!symbols.length) {
    tbody.innerHTML = '<tr class="empty-row"><td colspan="7">Nenhum símbolo encontrado. Conecte o WS público.</td></tr>';
    return;
  }

  tbody.innerHTML = symbols.slice(0, 200).map(s => {
    const isFav = favs.includes(s.symbol);
    return `
      <tr>
        <td><span class="fav-star" data-sym="${s.symbol}" style="cursor:pointer;color:${isFav ? '#f1c94e' : '#4f5e77'};">${isFav ? '★' : '☆'}</span></td>
        <td>${s.symbol}</td>
        <td>${s.display_name}</td>
        <td>${s.market || '—'}</td>
        <td>${s.pip || '—'}</td>
        <td>${s.exchange_is_open ? 'Aberto' : 'Fechado'}</td>
        <td>${s.exchange_is_open ? '<span class="badge badge-win">aberto</span>' : '<span class="badge badge-loss">fechado</span>'}</td>
      </tr>
    `;
  }).join('');

  $$('.fav-star', tbody).forEach(el => el.addEventListener('click', () => {
    store.toggleFavorite(el.dataset.sym);
    renderSymbols();
  }));
}

// ──────────────────────────────────────────────────────────────
// Gráficos tab
// ──────────────────────────────────────────────────────────────
let chartCountdownTimer = null;
let currentTickSub = null;

async function refreshChartTab() {
  const symbols = store.get('symbols') || [];
  const sel = $('#chartSymbol');
  if (!sel.options.length && symbols.length) {
    sel.innerHTML = symbols.slice(0, 200).map(s =>
      `<option value="${s.symbol}">${s.display_name} (${s.symbol})</option>`
    ).join('');
    sel.value = store.get('charts.symbol') || 'R_100';
  }
  await loadChart();
}

async function loadChart() {
  const symbol = $('#chartSymbol').value;
  const granularity = parseInt($('#chartGranularity').value, 10);
  const count = parseInt($('#chartCount').value, 10);
  const style = $('#chartStyle').value;

  if (chartCountdownTimer) clearInterval(chartCountdownTimer);
  if (currentTickSub) { try { await currentTickSub.unsubscribe(); } catch(e) {} currentTickSub = null; }

  try {
    if (granularity === 0) {
      // Ticks
      const resp = await DerivAPI.fetchTicksHistory(symbol, { count, style: 'ticks' });
      if (resp.history) {
        const ticks = resp.history.times.map((t, i) => ({ epoch: t, quote: resp.history.prices[i] }));
        Charts.setTickData('mainChart', ticks);
      }
      currentTickSub = await DerivAPI.subscribeTicks(symbol, (tick) => {
        Charts.updateLastCandle('mainChart', { epoch: tick.epoch, open: tick.quote, high: tick.quote, low: tick.quote, close: tick.quote });
      });
    } else {
      const resp = await DerivAPI.fetchTicksHistory(symbol, { count, style: 'candles', granularity });
      if (resp.candles) {
        Charts.setData('mainChart', resp.candles, { style });
      }
      chartCountdownTimer = Charts.startCandleCountdown('candleCountdown', granularity);
    }
  } catch (e) {
    toast('Erro ao carregar gráfico: ' + e.message, 'error');
  }
}

function initGraficosTab() {
  $('#chartSymbol').addEventListener('change', loadChart);
  $('#chartGranularity').addEventListener('change', loadChart);
  $('#chartCount').addEventListener('change', loadChart);
  $('#chartStyle').addEventListener('change', loadChart);

  $('#callBtn').addEventListener('click', () => buyManual('CALL'));
  $('#putBtn').addEventListener('click', () => buyManual('PUT'));

  $$('.barrier-btn').forEach(btn => btn.addEventListener('click', () => {
    const inp = $('#manualBarrier');
    const delta = parseFloat(btn.dataset.delta);
    const cur = parseFloat(inp.value || '0');
    inp.value = (cur + delta).toFixed(2);
    updateProposal();
  }));

  ['manualStake', 'manualDurationValue', 'manualDurationType', 'manualContractType', 'manualBarrier'].forEach(id => {
    $('#' + id).addEventListener('input', updateProposal);
    $('#' + id).addEventListener('change', updateProposal);
  });
}

async function updateProposal() {
  try {
    const symbol = $('#chartSymbol').value;
    const contractType = $('#manualContractType').value;
    const stake = parseFloat($('#manualStake').value) || 1;
    const durType = $('#manualDurationType').value;
    const durValue = parseInt($('#manualDurationValue').value, 10);
    const durationUnit = { ticks: 't', seconds: 's', minutes: 'm', hours: 'h' }[durType];
    const barrier = $('#manualBarrier').value || undefined;
    const currency = store.get('session.accounts').find(a => a.account_id === store.get('session.activeAccountId'))?.currency || 'USD';

    const prop = await DerivAPI.proposal({
      contract_type: contractType, symbol, currency, amount: stake, basis: 'stake',
      duration: durValue, duration_unit: durationUnit, ...(barrier ? { barrier } : {}),
    });
    if (prop.proposal) {
      const payout = prop.proposal.payout - stake;
      $('#manualPayout').textContent = `${fmtMoney(payout, currency)} (${((payout/stake)*100).toFixed(1)}%)`;
    } else if (prop.error) {
      $('#manualPayout').textContent = '—';
    }
  } catch(e) { $('#manualPayout').textContent = '—'; }
}

async function buyManual(direction) {
  const session = store.get('session');
  if (!session.activeAccountId) { toast('Selecione uma conta ativa primeiro.', 'warn'); return; }
  const activeAcc = session.accounts.find(a => a.account_id === session.activeAccountId);
  if (!activeAcc.isVirtual) {
    const ok = await confirmDialog({
      title: 'Operação em conta REAL',
      message: `Você está em conta <strong>REAL (${session.activeAccountId})</strong>. Confirma a compra do contrato ${direction}?`,
      confirmLabel: 'Comprar',
      danger: true,
    });
    if (!ok) return;
  }

  const stake = parseFloat($('#manualStake').value) || 1;
  const durType = $('#manualDurationType').value;
  const durValue = parseInt($('#manualDurationValue').value, 10);
  const durationUnit = { ticks: 't', seconds: 's', minutes: 'm', hours: 'h' }[durType];
  const barrier = $('#manualBarrier').value || undefined;
  const symbol = $('#chartSymbol').value;

  const hedge = $('#hedgeToggle').checked;

  try {
    playSound('entry');
    if (hedge) {
      await Engine.manualBuy({ symbol, contractType: 'CALL', stake, duration: durValue, durationUnit, barrier });
      await Engine.manualBuy({ symbol, contractType: 'PUT',  stake, duration: durValue, durationUnit, barrier });
    } else {
      await Engine.manualBuy({ symbol, contractType: direction, stake, duration: durValue, durationUnit, barrier });
    }
    toast(`Contrato ${direction} enviado.`, 'ok');
    addManualLog(`Compra ${direction} ${symbol} • stake ${stake}`);
  } catch (e) {
    toast('Erro na compra: ' + e.message, 'error');
    addManualLog('Falha: ' + e.message, 'error');
  }
}

function addManualLog(msg, level = 'info') {
  const box = $('#manualLog');
  const e = document.createElement('div');
  e.className = 'log-entry ' + level;
  e.innerHTML = `<span class="ts">${new Date().toLocaleTimeString('pt-BR', { hour12: false })}</span>${msg}`;
  box.appendChild(e);
  box.scrollTop = box.scrollHeight;
}

// ──────────────────────────────────────────────────────────────
// Dígitos tab
// ──────────────────────────────────────────────────────────────
let digitSub = null;
let digitCounters = new Array(10).fill(0);
let digitSequence = [];

async function refreshDigitTab() {
  const symbols = store.get('symbols') || [];
  const sel = $('#digitSymbol');
  if (!sel.options.length && symbols.length) {
    sel.innerHTML = symbols.slice(0, 100).map(s =>
      `<option value="${s.symbol}">${s.display_name} (${s.symbol})</option>`
    ).join('');
    sel.value = 'R_100';
  }
  await loadDigitStats();
}

async function loadDigitStats() {
  if (digitSub) { try { await digitSub.unsubscribe(); } catch(e) {} digitSub = null; }
  const symbol = $('#digitSymbol').value;
  const window = parseInt($('#digitWindow').value, 10);
  try {
    const resp = await DerivAPI.fetchTicksHistory(symbol, { count: window, style: 'ticks' });
    if (resp.history) {
      digitCounters = new Array(10).fill(0);
      digitSequence = [];
      for (let i = 0; i < resp.history.prices.length; i++) {
        const d = parseInt(String(resp.history.prices[i]).slice(-1), 10);
        if (!isNaN(d)) { digitCounters[d]++; digitSequence.push(d); }
      }
      renderDigitHeatmap();
      renderDigitSequence();
    }
    digitSub = await DerivAPI.subscribeTicks(symbol, (tick) => {
      const d = parseInt(String(tick.quote).slice(-1), 10);
      if (isNaN(d)) return;
      digitCounters[d]++;
      digitSequence.push(d);
      if (digitSequence.length > 200) digitSequence = digitSequence.slice(-200);
      const w = parseInt($('#digitWindow').value, 10);
      if (digitSequence.length > w) {
        // remove o mais antigo da janela
        const old = digitSequence[digitSequence.length - w - 1];
        if (digitCounters[old] > 0) digitCounters[old]--;
      }
      renderDigitHeatmap();
      renderDigitSequence();
    });
  } catch (e) {
    toast('Erro ao carregar dígitos: ' + e.message, 'error');
  }
}

function renderDigitHeatmap() {
  const total = digitCounters.reduce((a, b) => a + b, 0) || 1;
  const max = Math.max(...digitCounters);
  const min = Math.min(...digitCounters);
  const container = $('#digitHeatmap');
  container.innerHTML = '';
  for (let d = 0; d < 10; d++) {
    const pct = (digitCounters[d] / total) * 100;
    // Cor: verde para menos frequentes, vermelho para mais
    const norm = max === min ? 0.5 : (digitCounters[d] - min) / (max - min);
    const r = Math.round(31 + (255 - 31) * norm);
    const g = Math.round(219 - (219 - 95) * norm);
    const b = Math.round(122 - (122 - 109) * norm);
    const cell = document.createElement('div');
    cell.className = 'digit-cell';
    cell.style.borderColor = `rgb(${r},${g},${b})`;
    cell.innerHTML = `
      <div class="digit" style="color: rgb(${r},${g},${b});">${d}</div>
      <div class="pct">${pct.toFixed(1)}%</div>
      <div class="count">${digitCounters[d]}x</div>
    `;
    container.appendChild(cell);
  }
}

function renderDigitSequence() {
  const c = $('#digitSequence');
  c.innerHTML = '';
  const recent = digitSequence.slice(-30);
  const max = Math.max(...digitCounters);
  const min = Math.min(...digitCounters);
  recent.forEach(d => {
    const el = document.createElement('div');
    el.className = 'digit-seq-item';
    const norm = max === min ? 0.5 : (digitCounters[d] - min) / (max - min);
    if (norm < 0.3) el.classList.add('cold');
    else if (norm > 0.7) el.classList.add('hot');
    el.textContent = d;
    c.appendChild(el);
  });
}

function initDigitosTab() {
  $('#digitSymbol').addEventListener('change', loadDigitStats);
  $('#digitWindow').addEventListener('change', loadDigitStats);
  $('#digitBuyBtn').addEventListener('click', async () => {
    const session = store.get('session');
    if (!session.activeAccountId) { toast('Selecione uma conta.', 'warn'); return; }
    const stake = parseFloat($('#digitStake').value) || 1;
    const duration = parseInt($('#digitDuration').value, 10);
    const contractType = $('#digitContractType').value;
    const target = $('#digitTarget').value;
    const symbol = $('#digitSymbol').value;

    if (!session.accounts.find(a => a.account_id === session.activeAccountId)?.isVirtual) {
      const ok = await confirmDialog({ title: 'Conta REAL', message: 'Confirma compra em conta REAL?', confirmLabel: 'Comprar', danger: true });
      if (!ok) return;
    }
    playSound('entry');
    try {
      await Engine.manualBuy({
        symbol, contractType, stake, duration, durationUnit: 't',
        barrier: ['DIGITMATCH','DIGITDIFF','DIGITOVER','DIGITUNDER'].includes(contractType) ? target : undefined,
      });
      toast('Contrato de dígito enviado.', 'ok');
    } catch (e) {
      toast('Erro: ' + e.message, 'error');
    }
  });
}

// ──────────────────────────────────────────────────────────────
// Bots tab
// ──────────────────────────────────────────────────────────────
function initBotsTab() {
  const catalog = $('#botCatalog');
  const bots = listBots();
  catalog.innerHTML = bots.map(b => `
    <div class="bot-card" data-botid="${b.id}">
      <div class="bot-icon">${b.icone}</div>
      <div class="bot-name">${b.nome}</div>
      <div class="bot-desc">${b.descricao}</div>
      <div class="bot-meta">
        <span class="pill risk-${b.risco}">${b.risco === 'low' ? 'Baixo risco' : b.risco === 'med' ? 'Médio risco' : 'Alto risco'}</span>
        ${b.simbolos.slice(0, 2).map(s => `<span class="pill">${s}</span>`).join('')}
      </div>
    </div>
  `).join('');

  const botSelect = $('#botSelect');
  botSelect.innerHTML = bots.map(b => `<option value="${b.id}">${b.icone} ${b.nome}</option>`).join('');

  $$('.bot-card', catalog).forEach(card => card.addEventListener('click', () => {
    $$('.bot-card', catalog).forEach(c => c.classList.remove('active'));
    card.classList.add('active');
    botSelect.value = card.dataset.botid;
    renderBotParams();
  }));

  botSelect.addEventListener('change', renderBotParams);

  // Symbol dropdown
  const refresh = () => {
    const symbols = store.get('symbols') || [];
    const botSymbolSel = $('#botSymbol');
    if (symbols.length && !botSymbolSel.options.length) {
      botSymbolSel.innerHTML = symbols.slice(0, 100).map(s => `<option value="${s.symbol}">${s.display_name}</option>`).join('');
    }
  };
  refresh();
  // Tentar de novo quando a aba for aberta
  $('#botSymbol').addEventListener('focus', refresh);

  $('#botStartBtn').addEventListener('click', startBotFromForm);
}

function renderBotParams() {
  const botId = $('#botSelect').value;
  const schema = getBotSchema(botId);
  const container = $('#botParamsContainer');
  if (!schema.length) {
    container.innerHTML = '<div class="empty-hint">Este bot não tem parâmetros configuráveis.</div>';
    return;
  }
  const defaults = defaultParams(botId);
  container.innerHTML = '<div class="settings-grid">' + schema.map(f => {
    const val = defaults[f.key];
    if (f.type === 'select') {
      return `<div class="setting-group"><label>${f.label}</label>
        <select data-param="${f.key}">${f.options.map(o => `<option value="${o.value}" ${o.value === val ? 'selected' : ''}>${o.label}</option>`).join('')}</select></div>`;
    }
    if (f.type === 'checkbox') {
      return `<div class="setting-group"><label class="checkbox-row"><input type="checkbox" data-param="${f.key}" ${val ? 'checked' : ''} /> <span>${f.label}</span></label></div>`;
    }
    return `<div class="setting-group"><label>${f.label}</label>
      <input type="${f.type}" data-param="${f.key}" value="${val}" ${f.min != null ? `min="${f.min}"` : ''} ${f.max != null ? `max="${f.max}"` : ''} ${f.step != null ? `step="${f.step}"` : ''} /></div>`;
  }).join('') + '</div>';
}

async function startBotFromForm() {
  const session = store.get('session');
  if (!session.activeAccountId) { toast('Selecione uma conta ativa primeiro.', 'warn'); return; }

  const botId = $('#botSelect').value;
  const symbol = $('#botSymbol').value;
  const stake = parseFloat($('#botStake').value) || 1;
  const mmMode = $('#botMoneyMgmt').value;

  const params = {};
  $$('[data-param]', $('#botParamsContainer')).forEach(el => {
    const key = el.dataset.param;
    params[key] = el.type === 'checkbox' ? el.checked :
                  el.type === 'number' ? parseFloat(el.value) : el.value;
  });

  // Constroi moneyMgmt
  const mmBase = store.get('moneyMgmt');
  const moneyMgmt = { ...mmBase, mode: mmMode };

  const activeAcc = session.accounts.find(a => a.account_id === session.activeAccountId);
  if (!activeAcc.isVirtual) {
    const ok = await confirmDialog({
      title: 'Bot em conta REAL',
      message: `Iniciar bot <strong>${getBot(botId).nome}</strong> em conta <strong>REAL (${session.activeAccountId})</strong>?`,
      confirmLabel: 'Iniciar',
      danger: true,
    });
    if (!ok) return;
  }

  playSound('entry');
  const id = Engine.startBot({
    botId, symbol, params, moneyMgmt,
    initialBalance: activeAcc.balance,
    source: 'bot',
  });
  toast(`Bot "${getBot(botId).nome}" iniciado.`, 'ok');
}

function refreshBotsTab() {
  renderBotsRunningPanel();
}

function renderBotsRunningPanel() {
  const panel = $('#botsRunningPanel');
  const bots = store.get('runningBots') || [];
  if (!bots.length) {
    panel.innerHTML = '<div class="empty-hint">Nenhum bot em execução.</div>';
    return;
  }
  panel.innerHTML = bots.map(b => `
    <div class="bot-run-card ${b.state === 'paused' ? 'paused' : ''}" data-id="${b.id}">
      <div>
        <div class="br-name">${b.nome}</div>
        <div class="br-meta">${b.symbol} • ${b.params.duration || '—'} ticks</div>
      </div>
      <div class="br-stat"><span class="lbl">Status</span><span class="status-pill ${b.state}">${b.state}</span></div>
      <div class="br-stat"><span class="lbl">Ops</span>${b.stats.ops} (${b.stats.wins}W/${b.stats.losses}L)</div>
      <div class="br-stat"><span class="lbl">P&L</span><span class="${b.stats.pnl >= 0 ? 'positive' : 'negative'}">${b.stats.pnl >= 0 ? '+' : ''}${b.stats.pnl.toFixed(2)}</span></div>
      <div class="br-actions">
        ${b.state === 'running' ? `<button class="secondary" data-act="pause" data-id="${b.id}">⏸</button>` : ''}
        ${b.state === 'paused'  ? `<button class="secondary" data-act="resume" data-id="${b.id}">▶</button>` : ''}
        <button class="secondary" data-act="stop" data-id="${b.id}" style="border-color:#ff5f6d;color:#ff5f6d;">⏹</button>
      </div>
    </div>
  `).join('');

  $$('button[data-act]', panel).forEach(btn => btn.addEventListener('click', () => {
    const id = btn.dataset.id;
    const act = btn.dataset.act;
    if (act === 'pause') Engine.pauseBot(id);
    if (act === 'resume') Engine.resumeBot(id);
    if (act === 'stop') Engine.stopBot(id);
  }));
}

// ──────────────────────────────────────────────────────────────
// Gestão financeira tab
// ──────────────────────────────────────────────────────────────
function initGestaoTab() {
  const mmModeSel = $('#mmMode');
  function refreshMmFields() {
    const mode = mmModeSel.value;
    $$('[data-mm]').forEach(el => {
      el.style.display = el.dataset.mm === mode ? '' : 'none';
    });
  }
  mmModeSel.addEventListener('change', refreshMmFields);
  refreshMmFields();

  // Carregar do store
  const mm = store.get('moneyMgmt');
  $('#mmMode').value = mm.mode;
  $('#mmMartMult').value = mm.martingale.mult;
  $('#mmMartLevels').value = mm.martingale.maxLevels;
  $('#mmSorosPct').value = mm.soros.reinvestPct;
  $('#mmSorosLevels').value = mm.soros.maxLevels;
  $('#mmFiboSeq').value = mm.fibonacci.sequence;
  $('#mmDalStep').value = mm.dalembert.step;
  $('#mmTP').value = mm.takeProfit;
  $('#mmSL').value = mm.stopLoss;
  $('#mmTPpct').value = mm.takeProfitPct;
  $('#mmSLpct').value = mm.stopLossPct;
  $('#mmMaxOps').value = mm.maxOpsPerSession;
  $('#mmMaxLosses').value = mm.maxLosses;
  $('#mmCooldown').value = mm.cooldownSec;
  $('#mmMinStake').value = mm.minStake;
  $('#mmMaxStake').value = mm.maxStake;
  refreshMmFields();

  $('#saveGestaoBtn').addEventListener('click', () => {
    const newMm = {
      mode: $('#mmMode').value,
      martingale: { mult: parseFloat($('#mmMartMult').value), maxLevels: parseInt($('#mmMartLevels').value, 10) },
      soros: { reinvestPct: parseFloat($('#mmSorosPct').value), maxLevels: parseInt($('#mmSorosLevels').value, 10) },
      fibonacci: { sequence: $('#mmFiboSeq').value },
      dalembert: { step: parseFloat($('#mmDalStep').value) },
      takeProfit: parseFloat($('#mmTP').value),
      stopLoss: parseFloat($('#mmSL').value),
      takeProfitPct: parseFloat($('#mmTPpct').value),
      stopLossPct: parseFloat($('#mmSLpct').value),
      maxOpsPerSession: parseInt($('#mmMaxOps').value, 10),
      maxLosses: parseInt($('#mmMaxLosses').value, 10),
      cooldownSec: parseInt($('#mmCooldown').value, 10),
      minStake: parseFloat($('#mmMinStake').value),
      maxStake: parseFloat($('#mmMaxStake').value),
    };
    store.set('moneyMgmt', newMm);
    toast('Configurações de gestão salvas.', 'ok');
  });

  $('#resetGestaoBtn').addEventListener('click', async () => {
    const ok = await confirmDialog({ title: 'Restaurar padrão', message: 'Reverter todas as configurações para o padrão?', confirmLabel: 'Restaurar' });
    if (!ok) return;
    localStorage.removeItem('pontobots_v2_state_v1');
    location.reload();
  });
}

// ──────────────────────────────────────────────────────────────
// Virtual Loss tab
// ──────────────────────────────────────────────────────────────
function initVlTab() {
  $$('.vl-mode-btn').forEach(btn => btn.addEventListener('click', () => {
    $$('.vl-mode-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    const mode = btn.dataset.vlmode;
    $('#vlParamsSimple').style.display = mode === 'simple' ? '' : 'none';
    $('#vlParamsInter').style.display  = mode === 'intermarket' ? '' : 'none';
    refreshVlStatus();
  }));

  // Carregar do store
  const vl = store.get('virtualLoss');
  $$('.vl-mode-btn').forEach(b => b.classList.toggle('active', b.dataset.vlmode === vl.mode));
  $('#vlParamsSimple').style.display = vl.mode === 'simple' ? '' : 'none';
  $('#vlParamsInter').style.display  = vl.mode === 'intermarket' ? '' : 'none';
  $('#vlSimpleN').value = vl.simple.n;
  $('#vlSimpleCriterion').value = vl.simple.criterion;
  $('#vlSimpleReturn').value = vl.simple.returnAfterReal;
  $('#vlInterN').value = vl.intermarket.n;
  $('#vlInterReturn').value = vl.intermarket.returnOnLoss;
  $('#vlInterMaxReal').value = vl.intermarket.maxRealConsecutive;

  $('#saveVlBtn').addEventListener('click', () => {
    const mode = $('.vl-mode-btn.active').dataset.vlmode;
    store.set('virtualLoss', {
      mode,
      simple: {
        n: parseInt($('#vlSimpleN').value, 10),
        criterion: $('#vlSimpleCriterion').value,
        returnAfterReal: $('#vlSimpleReturn').value,
      },
      intermarket: {
        n: parseInt($('#vlInterN').value, 10),
        returnOnLoss: $('#vlInterReturn').value,
        maxRealConsecutive: parseInt($('#vlInterMaxReal').value, 10),
      },
      counters: store.get('virtualLoss.counters'),
    });
    toast('Virtual Loss salvo.', 'ok');
    refreshVlStatus();
  });

  refreshVlStatus();
}

function refreshVlStatus() {
  const vl = store.get('virtualLoss');
  const el = $('#vlNextAccount');
  const detail = $('#vlStatusDetail');
  if (vl.mode === 'off') {
    el.textContent = store.get('session.activeAccountType')?.toUpperCase() || 'CONTA ATIVA';
    el.className = 'vl-status-value ' + (store.get('session.activeAccountType') === 'real' ? 'real' : 'demo');
    detail.textContent = 'VL desativado — operações seguem diretamente para a conta ativa.';
  } else if (vl.mode === 'simple') {
    const c = vl.counters;
    if (c.virtualLosses < vl.simple.n) {
      el.textContent = 'DEMO (virtual)';
      el.className = 'vl-status-value demo';
      detail.textContent = `${c.virtualLosses}/${vl.simple.n} perdas virtuais — faltam ${vl.simple.n - c.virtualLosses} para entrar na real.`;
    } else {
      el.textContent = 'REAL';
      el.className = 'vl-status-value real';
      detail.textContent = `Critério atingido — próxima entrada vai para a conta REAL.`;
    }
  } else if (vl.mode === 'intermarket') {
    const c = vl.counters;
    if (c.virtualLosses >= vl.intermarket.n && c.realEntries < vl.intermarket.maxRealConsecutive) {
      el.textContent = 'REAL';
      el.className = 'vl-status-value real';
      detail.textContent = `${c.virtualLosses} perdas virtuais → entra na real (${c.realEntries}/${vl.intermarket.maxRealConsecutive}).`;
    } else {
      el.textContent = 'DEMO (virtual)';
      el.className = 'vl-status-value demo';
      detail.textContent = `Aguardando ${vl.intermarket.n} perdas virtuais (atual: ${c.virtualLosses}).`;
    }
  }
}

// ──────────────────────────────────────────────────────────────
// Trades & Logs tab
// ──────────────────────────────────────────────────────────────
function initTradesTab() {
  $('#exportCsvBtn').addEventListener('click', exportCsv);
  ['tradesFrom', 'tradesTo', 'tradesSymbolFilter', 'tradesSourceFilter', 'tradesResultFilter'].forEach(id =>
    $('#' + id).addEventListener('change', refreshTradesTab));

  $('#clearLogsBtn').addEventListener('click', () => { store.clearLogs(); refreshLogs(); });
  ['logFilterInfo', 'logFilterWarn', 'logFilterError'].forEach(id =>
    $('#' + id).addEventListener('change', refreshLogs));
}

function refreshTradesTab() {
  const tbody = $('#tradesTable tbody');
  let trades = store.get('trades') || [];

  const from = $('#tradesFrom')?.value;
  const to = $('#tradesTo')?.value;
  const symF = $('#tradesSymbolFilter')?.value;
  const srcF = $('#tradesSourceFilter')?.value;
  const resF = $('#tradesResultFilter')?.value;

  // Popular filtro de símbolos
  const symSel = $('#tradesSymbolFilter');
  const syms = [...new Set(trades.map(t => t.symbol))];
  if (symSel.options.length <= 1) {
    symSel.innerHTML = '<option value="">Todos</option>' + syms.map(s => `<option value="${s}">${s}</option>`).join('');
  }

  if (from) trades = trades.filter(t => new Date(t.timestamp) >= new Date(from));
  if (to)   trades = trades.filter(t => new Date(t.timestamp) <= new Date(to + 'T23:59:59'));
  if (symF) trades = trades.filter(t => t.symbol === symF);
  if (srcF) trades = trades.filter(t => t.source === srcF);
  if (resF) trades = trades.filter(t => t.result === resF);

  if (!trades.length) {
    tbody.innerHTML = '<tr class="empty-row"><td colspan="9">Nenhum trade registrado.</td></tr>';
    return;
  }

  tbody.innerHTML = trades.slice(0, 200).map(t => `
    <tr>
      <td>${fmtTime(t.timestamp)}</td>
      <td>${t.symbol}</td>
      <td>${t.contract}</td>
      <td>${t.stake}</td>
      <td>${t.payout ? t.payout.toFixed(2) : '—'}</td>
      <td><span class="badge ${t.result === 'win' ? 'badge-win' : t.result === 'loss' ? 'badge-loss' : ''}">${t.result || '—'}</span></td>
      <td class="${t.pnl > 0 ? 'positive' : t.pnl < 0 ? 'negative' : ''}">${t.pnl >= 0 ? '+' : ''}${t.pnl?.toFixed(2) || '0.00'}</td>
      <td><span class="badge ${t.virtual || t.account === 'demo' ? 'badge-demo' : 'badge-real'}">${t.virtual || t.account === 'demo' ? 'DEMO' : 'REAL'}</span></td>
      <td>${t.source}${t.botId ? ' / ' + t.botId : ''}</td>
    </tr>
  `).join('');
}

function refreshLogs() {
  const box = $('#logsConsole');
  if (!box) return;
  const showInfo = $('#logFilterInfo')?.checked ?? true;
  const showWarn = $('#logFilterWarn')?.checked ?? true;
  const showError = $('#logFilterError')?.checked ?? true;
  const logs = store.get('logs') || [];
  box.innerHTML = logs.filter(l =>
    (l.level === 'info' && showInfo) ||
    (l.level === 'warn' && showWarn) ||
    (l.level === 'error' && showError)
  ).slice(0, 300).map(l =>
    `<div class="log-entry ${l.level === 'info' ? '' : l.level}">
      <span class="ts">${fmtTime(l.ts)}</span>${l.message}
    </div>`
  ).join('');
  box.scrollTop = 0;
}

function exportCsv() {
  const trades = store.get('trades') || [];
  const header = ['timestamp', 'symbol', 'contract', 'stake', 'result', 'pnl', 'account', 'source', 'botId'];
  const rows = trades.map(t => [t.timestamp, t.symbol, t.contract, t.stake, t.result, t.pnl, t.account, t.source, t.botId || '']);
  const csv = [header.join(','), ...rows.map(r => r.join(','))].join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `pontobots-trades-${Date.now()}.csv`;
  a.click();
  URL.revokeObjectURL(url);
  toast('CSV exportado.', 'ok');
}

// ──────────────────────────────────────────────────────────────
// Avançado tab
// ──────────────────────────────────────────────────────────────
function initAvancadoTab() {
  $('#advProposalBtn').addEventListener('click', async () => {
    const out = $('#advResult');
    out.innerHTML = '<div class="log-entry">📡 Solicitando proposal...</div>';
    try {
      const prop = await DerivAPI.proposal({
        contract_type: $('#advContractType').value,
        symbol: $('#advSymbol').value,
        currency: $('#advCurrency').value,
        amount: parseFloat($('#advAmount').value),
        basis: $('#advBasis').value,
        duration: parseInt($('#advDuration').value, 10),
        duration_unit: $('#advDurationUnit').value,
        ...($('#advBarrier').value ? { barrier: $('#advBarrier').value } : {}),
      });
      out.innerHTML = `<div class="log-entry ok">✓ Payout: ${prop.proposal?.payout} • Ask: ${prop.proposal?.ask_price} • Spot: ${prop.proposal?.spot}</div>`;
    } catch (e) {
      out.innerHTML = `<div class="log-entry error">✗ ${e.message}</div>`;
    }
  });

  $('#advBuyBtn').addEventListener('click', async () => {
    const ok = await confirmDialog({ title: 'Compra direta', message: 'Confirma compra do contrato com os parâmetros informados?', confirmLabel: 'Comprar', danger: true });
    if (!ok) return;
    const out = $('#advResult');
    try {
      const buy = await DerivAPI.buyDirect({
        contract_type: $('#advContractType').value,
        underlying_symbol: $('#advSymbol').value,
        currency: $('#advCurrency').value,
        amount: parseFloat($('#advAmount').value),
        basis: $('#advBasis').value,
        duration: parseInt($('#advDuration').value, 10),
        duration_unit: $('#advDurationUnit').value,
        ...($('#advBarrier').value ? { barrier: $('#advBarrier').value } : {}),
      }, parseFloat($('#advAmount').value));
      out.innerHTML = `<div class="log-entry ok">✓ Contrato ${buy.buy?.contract_id} comprado.</div>`;
    } catch (e) {
      out.innerHTML = `<div class="log-entry error">✗ ${e.message}</div>`;
    }
  });

  // Bulk PAT
  $('#bulkAddRowBtn').addEventListener('click', () => {
    showModal({
      title: 'Adicionar conta para bulk-purchase',
      body: `
        <div class="settings-grid">
          <div class="setting-group"><label>account_id</label><input type="text" id="newBulkAcc" placeholder="CR123456" /></div>
          <div class="setting-group"><label>PAT (token)</label><input type="text" id="newBulkPat" placeholder="Personal Access Token" /></div>
        </div>
      `,
      footer: `<button class="secondary" id="bulkCancel">Cancelar</button><button class="primary" id="bulkAdd">Adicionar</button>`,
    });
    $('#bulkAdd').onclick = () => {
      const acc = $('#newBulkAcc').value.trim();
      const pat = $('#newBulkPat').value.trim();
      if (!acc || !pat) return;
      store.addBulkAccount(acc, pat);
      renderBulkAccounts();
      closeModal();
    };
    $('#bulkCancel').onclick = closeModal;
  });

  $('#bulkPurchaseBtn').addEventListener('click', async () => {
    const env = $('#bulkEnv').value;
    const cp = {
      contract_type: $('#bulkContractType').value,
      underlying_symbol: $('#bulkSymbol').value,
      currency: $('#bulkCurrency').value,
      amount: parseFloat($('#bulkAmount').value),
      basis: $('#bulkBasis').value,
      duration: parseInt($('#bulkDuration').value, 10),
      duration_unit: $('#bulkDurationUnit').value,
    };
    const accs = store.get('bulkAccounts');
    if (!accs.length) { toast('Cadastre contas primeiro.', 'warn'); return; }
    const ok = await confirmDialog({
      title: `Compra em lote (${env.toUpperCase()})`,
      message: `Disparar ${cp.contract_type} ${cp.underlying_symbol} ${cp.duration}${cp.duration_unit} em ${accs.length} conta(s)?`,
      confirmLabel: 'Disparar',
      danger: env === 'real',
    });
    if (!ok) return;
    const out = $('#bulkResult');
    out.innerHTML = '<div class="log-entry">📡 Disparando...</div>';
    try {
      const resp = await DerivAPI.bulkPurchase(env, cp, accs);
      out.innerHTML = `<div class="log-entry ok">✓ Compra em lote processada.</div>`;
      console.log('bulk response', resp);
    } catch (e) {
      out.innerHTML = `<div class="log-entry error">✗ ${e.message}</div>`;
    }
  });

  renderBulkAccounts();
}

function renderBulkAccounts() {
  const tbody = $('#bulkAccountsTable tbody');
  const accs = store.get('bulkAccounts');
  if (!accs.length) {
    tbody.innerHTML = '<tr class="empty-row"><td colspan="3">Nenhuma conta cadastrada.</td></tr>';
    return;
  }
  tbody.innerHTML = accs.map((a, i) => `
    <tr>
      <td>${a.account_id}</td>
      <td><code>${a.pat.slice(0, 8)}...${a.pat.slice(-4)}</code></td>
      <td><button class="secondary" data-rm="${i}" style="padding:6px 12px;font-size:11px;margin:0;border-color:#ff5f6d;color:#ff5f6d;">Remover</button></td>
    </tr>
  `).join('');
  $$('button[data-rm]', tbody).forEach(b => b.addEventListener('click', () => {
    store.removeBulkAccount(parseInt(b.dataset.rm, 10));
    renderBulkAccounts();
  }));
}

// ──────────────────────────────────────────────────────────────
// Config tab
// ──────────────────────────────────────────────────────────────
function initConfigTab() {
  const prefs = store.get('preferences');
  $('#cfgLang').value = prefs.lang;
  $('#cfgTheme').value = prefs.theme;
  $('#cfgSoundEntry').checked = prefs.sounds.entry;
  $('#cfgSoundWin').checked = prefs.sounds.win;
  $('#cfgSoundLoss').checked = prefs.sounds.loss;
  $('#cfgSoundStop').checked = prefs.sounds.stop;
  $('#cfgSoundDisconnect').checked = prefs.sounds.disconnect;
  $('#cfgBrowserNotif').checked = prefs.browserNotif;

  $('#cfgSaveBtn').addEventListener('click', () => {
    store.set('preferences', {
      lang: $('#cfgLang').value,
      theme: $('#cfgTheme').value,
      sounds: {
        entry: $('#cfgSoundEntry').checked,
        win: $('#cfgSoundWin').checked,
        loss: $('#cfgSoundLoss').checked,
        stop: $('#cfgSoundStop').checked,
        disconnect: $('#cfgSoundDisconnect').checked,
      },
      browserNotif: $('#cfgBrowserNotif').checked,
    });
    document.body.dataset.theme = $('#cfgTheme').value;
    toast('Preferências salvas.', 'ok');
  });

  $('#cfgExportBtn').addEventListener('click', () => {
    const data = JSON.stringify({
      moneyMgmt: store.get('moneyMgmt'),
      virtualLoss: store.get('virtualLoss'),
      preferences: store.get('preferences'),
      favorites: store.get('favorites'),
      bulkAccounts: store.get('bulkAccounts'),
    }, null, 2);
    const blob = new Blob([data], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `pontobots-presets-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
    toast('Presets exportados.', 'ok');
  });

  $('#cfgImportBtn').addEventListener('click', () => $('#cfgImportFile').click());
  $('#cfgImportFile').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result);
        if (data.moneyMgmt) store.set('moneyMgmt', data.moneyMgmt);
        if (data.virtualLoss) store.set('virtualLoss', data.virtualLoss);
        if (data.preferences) store.set('preferences', data.preferences);
        if (data.favorites) store.set('favorites', data.favorites);
        if (data.bulkAccounts) store.set('bulkAccounts', data.bulkAccounts);
        toast('Presets importados.', 'ok');
        setTimeout(() => location.reload(), 1000);
      } catch (e) { toast('Erro ao importar: ' + e.message, 'error'); }
    };
    reader.readAsText(file);
  });
}

// ──────────────────────────────────────────────────────────────
// Dashboard
// ──────────────────────────────────────────────────────────────
function refreshDashboard() {
  const session = store.get('session');
  const trades = store.get('trades') || [];

  // Saldo
  const activeAcc = session.accounts.find(a => a.account_id === session.activeAccountId);
  if (activeAcc) {
    $('#kpiBalance').textContent = fmtMoney(activeAcc.balance, activeAcc.currency);
    $('#kpiBalance').className = 'kpi-value';
    $('#kpiBalanceSub').textContent = `${activeAcc.account_id} (${activeAcc.isVirtual ? 'DEMO' : 'REAL'})`;
  } else {
    $('#kpiBalance').textContent = '—';
    $('#kpiBalanceSub').textContent = 'sem conta ativa';
  }

  // P&L dia / semana / mês
  const now = Date.now();
  const dayAgo = now - 86400000;
  const weekAgo = now - 7 * 86400000;
  const monthAgo = now - 30 * 86400000;
  const sum = (arr) => arr.reduce((a, t) => a + (t.pnl || 0), 0);
  const pnlDay = sum(trades.filter(t => t.timestamp > dayAgo && t.result !== 'pending'));
  const pnlWeek = sum(trades.filter(t => t.timestamp > weekAgo && t.result !== 'pending'));
  const pnlMonth = sum(trades.filter(t => t.timestamp > monthAgo && t.result !== 'pending'));

  const setPnl = (id, v) => {
    const el = $(id);
    el.textContent = (v >= 0 ? '+' : '') + v.toFixed(2);
    el.className = 'kpi-value ' + (v > 0 ? 'positive' : v < 0 ? 'negative' : '');
  };
  setPnl('#kpiPnlDay', pnlDay);
  setPnl('#kpiPnlWeek', pnlWeek);
  setPnl('#kpiPnlMonth', pnlMonth);

  // Bots ativos
  $('#kpiBots').textContent = (store.get('runningBots') || []).filter(b => b.state === 'running').length;

  // Equity
  Charts.renderEquityCurve('equityChart', trades.filter(t => t.result !== 'pending'));

  // Bots em execução (mini lista)
  const bots = store.get('runningBots') || [];
  const list = $('#activeBotsList');
  if (!bots.length) {
    list.innerHTML = '<div class="empty-hint">Nenhum bot rodando.</div>';
  } else {
    list.innerHTML = bots.map(b => `
      <div class="bot-mini">
        <span class="name">${b.nome}</span>
        <span class="stat">${b.stats.ops} ops • <span class="${b.stats.pnl >= 0 ? 'positive' : 'negative'}">${b.stats.pnl >= 0 ? '+' : ''}${b.stats.pnl.toFixed(2)}</span></span>
      </div>
    `).join('');
  }

  // Últimas operações
  const tbody = $('#recentTradesTable tbody');
  if (!trades.length) {
    tbody.innerHTML = '<tr class="empty-row"><td colspan="7">Nenhuma operação registrada.</td></tr>';
  } else {
    tbody.innerHTML = trades.slice(0, 10).map(t => `
      <tr>
        <td>${fmtTime(t.timestamp)}</td>
        <td>${t.symbol}</td>
        <td>${t.contract}</td>
        <td>${t.stake}</td>
        <td><span class="badge ${t.result === 'win' ? 'badge-win' : t.result === 'loss' ? 'badge-loss' : ''}">${t.result || '—'}</span></td>
        <td class="${t.pnl > 0 ? 'positive' : t.pnl < 0 ? 'negative' : ''}">${t.pnl >= 0 ? '+' : ''}${t.pnl?.toFixed(2) || '0.00'}</td>
        <td>${t.source}${t.botId ? ' / ' + t.botId.slice(0, 12) : ''}</td>
      </tr>
    `).join('');
  }
}

// ──────────────────────────────────────────────────────────────
// Bindings do store
// ──────────────────────────────────────────────────────────────
function initStoreBindings() {
  store.on('session:changed', refreshHeader);
  store.on('session:activeAccount', refreshHeader);
  store.on('change:connection', refreshHeader);
  store.on('change:symbols', () => { renderSymbols(); refreshChartTab(); refreshDigitTab(); });
  store.on('change:favorites', renderSymbols);
  store.on('bots:changed', () => { renderBotsRunningPanel(); refreshDashboard(); });
  store.on('trades:added', () => { refreshDashboard(); refreshTradesTab(); });
  store.on('trades:updated', () => { refreshDashboard(); refreshTradesTab(); });
  store.on('logs:added', refreshLogs);
  store.on('logs:cleared', refreshLogs);
  store.on('change:virtualLoss', refreshVlStatus);
  store.on('change:bulkAccounts', renderBulkAccounts);

  // Sounds de eventos de log
  store.on('logs:added', (entry) => {
    if (entry.message?.includes('WIN')) playSound('win');
    if (entry.message?.includes('LOSS')) playSound('loss');
    if (entry.message?.includes('STOP') || entry.message?.includes('stop')) playSound('stop');
    if (entry.message?.includes('desconect') || entry.message?.includes('fechado')) playSound('disconnect');
  });
}

// ──────────────────────────────────────────────────────────────
// Init
// ──────────────────────────────────────────────────────────────
export function initUI() {
  document.body.dataset.theme = store.get('preferences.theme') || 'dark';
  initTabs();
  initRiskModal();
  initConexaoTab();
  initMercadosTab();
  initGraficosTab();
  initDigitosTab();
  initBotsTab();
  initGestaoTab();
  initVlTab();
  initTradesTab();
  initAvancadoTab();
  initConfigTab();
  initStoreBindings();

  refreshHeader();
  refreshDashboard();
  refreshTradesTab();
  refreshLogs();
  renderBulkAccounts();
  renderBotParams();

  // Conectar WS público automaticamente (busca active_symbols ao abrir)
  DerivAPI.connectPublicWs();

  // Se houver token salvo, restaurar sessão: listar contas e reconectar WS auth
  const token = store.get('session.accessToken');
  if (token) {
    DerivAPI.listAccounts()
      .then(async (accounts) => {
        refreshAccounts();
        // Se já havia uma conta ativa selecionada, reabrir WS autenticado
        const activeId = store.get('session.activeAccountId');
        if (activeId && accounts.find(a => a.account_id === activeId)) {
          try { await DerivAPI.connectAuthWs(activeId); }
          catch (e) { console.warn('Falha ao reconectar WS auth:', e.message); }
        }
      })
      .catch(e => {
        console.warn('Token expirado ou inválido:', e.message);
        toast('Sessão expirada. Faça login novamente.', 'warn');
        store.clearSession();
        refreshHeader();
        refreshAccounts();
      });
  } else {
    refreshAccounts();
  }
}
