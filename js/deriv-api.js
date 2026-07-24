/* ============================================================
   PontoBots v2 — deriv-api.js
   Integração com a nova Deriv Options API.
   - OAuth 2.0 + PKCE (front-end puro)
   - OTP para abertura de WS autenticado
   - WebSocket público  (wss://api.derivws.com/trading/v1/options/ws/public)
   - WebSocket autenticado (URL dinâmica via OTP)
   - Reconexão com backoff exponencial + keep-alive (ping 30s)
   - Fila por req_id + forget/forget_all
   - bulk-purchase via PAT (REST)
   ============================================================ */

import { store } from './state.js';

// ──────────────────────────────────────────────────────────────
// CONFIG (validado contra https://developers.deriv.com/docs/ e /docs/workflows/)
//
// Regras de autenticação (confirmadas pela doc de Workflows):
//   - TODOS os REST autenticados exigem DOIS headers:
//       Authorization: Bearer ACCESS_TOKEN   (PAT ou JWT do OAuth)
//       Deriv-App-ID:   YOUR_APP_ID          (= client_id em apps OAuth)
//   - bulk-purchase (real|demo) é a EXCEÇÃO: só Deriv-App-ID no header,
//     PATs no body.accounts[].token; NÃO enviar Authorization: Bearer.
//   - O OTP retorna uma URL WS autenticada; conecte direto nela (não usar authorize via WS).
//   - WS público: wss://api.derivws.com/trading/v1/options/ws/public (sem auth).
// ──────────────────────────────────────────────────────────────

// Caminho base da aplicação (suporta / e /v2/ etc.)
// Ex.: https://pontobots.com/v2/ -> basePath = '/v2'  -> callback = '/v2/callback'
const _basePath = window.location.pathname.replace(/\/[^/]*$/, '');

const CONFIG = {
  // REST base
  restBase:         'https://api.derivws.com',
  // OAuth
  oauthAuthUrl:     'https://auth.deriv.com/oauth2/auth',
  oauthTokenUrl:    'https://auth.deriv.com/oauth2/token',
  clientId:         'YOUR_CLIENT_ID',
  redirectUri:      `${window.location.origin}${_basePath}/callback`,
  scope:            'trade',
  // WebSocket público (dados de mercado sem auth)
  publicWsUrl:      'wss://api.derivws.com/trading/v1/options/ws/public',
  // Endpoints REST específicos
  accountsUrl:      () => `${CONFIG.restBase}/trading/v1/options/accounts`,
  otpUrl:           (accountId) => `${CONFIG.restBase}/trading/v1/options/accounts/${accountId}/otp`,
  bulkPurchaseUrl:  (env /* 'real' | 'demo' */) => `${CONFIG.restBase}/trading/v1/options/contracts/bulk-purchase/${env}`,
  // Deriv App ID — em apps OAuth, equivale ao client_id (ver docs de Workflows)
  derivAppId:       'YOUR_CLIENT_ID',
  // Reconexão
  reconnectBaseMs:  1000,
  reconnectMaxMs:   30000,
  // Keep-alive
  pingIntervalMs:   30000,
};

// ──────────────────────────────────────────────────────────────
// PKCE utilities (RFC 7636)
// ──────────────────────────────────────────────────────────────
function randomString(len) {
  const arr = new Uint8Array(len);
  crypto.getRandomValues(arr);
  return Array.from(arr, b => b.toString(36).padStart(2, '0')).join('').slice(0, len);
}

async function sha256Base64Url(input) {
  const data = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return btoa(String.fromCharCode(...new Uint8Array(hash)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function buildPkce() {
  const verifier = randomString(64);
  const challenge = await sha256Base64Url(verifier);
  return { verifier, challenge };
}

// ──────────────────────────────────────────────────────────────
// Event emitter interno
// ──────────────────────────────────────────────────────────────
const listeners = new Map(); // event -> Set<fn>
function on(event, fn) {
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event).add(fn);
  return () => listeners.get(event).delete(fn);
}
function emit(event, payload) {
  const set = listeners.get(event);
  if (set) set.forEach(fn => { try { fn(payload); } catch(e){ console.error('deriv-api listener error:', e); } });
}

// ──────────────────────────────────────────────────────────────
// Estado interno
// ──────────────────────────────────────────────────────────────
let publicWs = null;
let authWs = null;
let publicReconnectAttempts = 0;
let authReconnectAttempts = 0;
let publicReconnectTimer = null;
let authReconnectTimer = null;
let publicPingTimer = null;
let authPingTimer = null;
let lastPingSent = 0;

// Subscriptions ativas (para reestabelecer após reconexão)
const activeSubscriptions = new Map(); // subId -> { ws: 'public'|'auth', msg, reqId }
// Callbacks pendentes por req_id
const pendingRequests = new Map(); // reqId -> { resolve, reject, ts }

let reqIdCounter = 1;
function nextReqId() { return reqIdCounter++; }

// ──────────────────────────────────────────────────────────────
// Logging helpers
// ──────────────────────────────────────────────────────────────
function logInfo(msg, meta)  { store.addLog('info',  msg, meta); }
function logWarn(msg, meta)  { store.addLog('warn',  msg, meta); }
function logError(msg, meta) { store.addLog('error', msg, meta); }

// ──────────────────────────────────────────────────────────────
// 1. OAuth 2.0 + PKCE
// ──────────────────────────────────────────────────────────────
export async function startOAuthLogin() {
  const state = randomString(16);
  const { verifier, challenge } = await buildPkce();

  // Persistir verifier + state para validação no callback
  sessionStorage.setItem('pontobots_oauth_state', state);
  sessionStorage.setItem('pontobots_oauth_verifier', verifier);

  const url = new URL(CONFIG.oauthAuthUrl);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', CONFIG.clientId);
  url.searchParams.set('redirect_uri', CONFIG.redirectUri);
  url.searchParams.set('scope', CONFIG.scope);
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');

  logInfo('Iniciando OAuth 2.0 + PKCE...', { redirect: CONFIG.redirectUri });
  window.location.href = url.toString();
}

export async function handleOAuthCallback() {
  // Esta função é chamada na página /callback
  const params = new URLSearchParams(window.location.search);
  const code = params.get('code');
  const state = params.get('state');
  const err = params.get('error');

  if (err) {
    logError(`OAuth retornou erro: ${err} — ${params.get('error_description') || ''}`);
    return { ok: false, error: err };
  }
  if (!code) return { ok: false, error: 'no_code' };

  const savedState = sessionStorage.getItem('pontobots_oauth_state');
  const verifier = sessionStorage.getItem('pontobots_oauth_verifier');
  if (!savedState || savedState !== state) {
    logError('OAuth state mismatch — abortando.');
    return { ok: false, error: 'state_mismatch' };
  }

  try {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: CONFIG.clientId,
      code,
      code_verifier: verifier,
      redirect_uri: CONFIG.redirectUri,
    });
    const resp = await fetch(CONFIG.oauthTokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    const data = await resp.json();
    if (!data.access_token) {
      logError('Token endpoint não retornou access_token', data);
      return { ok: false, error: 'no_token', data };
    }
    // Salvar na store (localStorage)
    store.setSession({
      accessToken: data.access_token,
      expiresAt: Date.now() + (data.expires_in || 3600) * 1000,
      accounts: [],
    });
    sessionStorage.removeItem('pontobots_oauth_state');
    sessionStorage.removeItem('pontobots_oauth_verifier');
    logInfo('OAuth 2.0 token obtido com sucesso.');
    return { ok: true };
  } catch (e) {
    logError('Falha ao trocar code por token: ' + e.message, { stack: e.stack });
    return { ok: false, error: e.message };
  }
}

// ──────────────────────────────────────────────────────────────
// 2. REST helpers (Bearer + Deriv-App-ID)
// TODOS os REST autenticados exigem ambos os headers (docs de Workflows).
// ──────────────────────────────────────────────────────────────
async function authedFetch(path, options = {}) {
  const token = store.get('session.accessToken');
  if (!token) throw new Error('Sem access_token. Faça login OAuth primeiro.');
  const headers = {
    'Authorization': `Bearer ${token}`,
    'Deriv-App-ID':  CONFIG.derivAppId,
    'Content-Type':  'application/json',
    ...(options.headers || {}),
  };
  const resp = await fetch(path.startsWith('http') ? path : `${CONFIG.restBase}${path}`, {
    ...options,
    headers,
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || data.error) {
    const msg = data.error?.message || data.error?.code || `HTTP ${resp.status}`;
    throw new Error(msg);
  }
  return data;
}

// ──────────────────────────────────────────────────────────────
// 3. Listar contas
// Resposta: { data: [ { account_id, balance, currency, account_type: 'demo'|'real', ... } ], meta: {...} }
// ──────────────────────────────────────────────────────────────
export async function listAccounts() {
  const data = await authedFetch(CONFIG.accountsUrl());
  // data.data é um ARRAY (não objeto com .accounts)
  const rawAccounts = Array.isArray(data?.data) ? data.data : (data?.data?.accounts || data?.accounts || []);
  const normalized = rawAccounts.map(a => ({
    account_id: a.account_id,
    currency: a.currency,
    balance: parseFloat(a.balance || 0),
    type: a.account_type === 'demo' ? 'demo' : 'real',
    isVirtual: a.account_type === 'demo',
  }));
  store.patch('session', { accounts: normalized });
  logInfo(`${normalized.length} contas listadas.`);
  return normalized;
}

// ──────────────────────────────────────────────────────────────
// 4. OTP — obter URL do WS autenticado
// ──────────────────────────────────────────────────────────────
async function fetchAuthWsUrl(accountId) {
  const data = await authedFetch(CONFIG.otpUrl(accountId), { method: 'POST' });
  const url = data?.data?.url || data?.url;
  if (!url) throw new Error('Resposta OTP não contém URL do WebSocket.');
  return url; // ex: wss://api.derivws.com/.../ws/real?otp=...
}

// ──────────────────────────────────────────────────────────────
// 5. WebSocket genérico
// ──────────────────────────────────────────────────────────────
function openWebSocket(url, { onMessage, onOpen, onClose, onError }) {
  const ws = new WebSocket(url);
  ws.onopen    = () => onOpen && onOpen();
  ws.onmessage = (e) => {
    try { onMessage && onMessage(JSON.parse(e.data)); }
    catch (err) { logError('Erro ao parsear mensagem WS:', { err }); }
  };
  ws.onclose   = (e) => onClose && onClose(e);
  ws.onerror   = (e) => onError && onError(e);
  return ws;
}

// ──────────────────────────────────────────────────────────────
// 6. WebSocket público (mercado: active_symbols, ticks, candles)
// ──────────────────────────────────────────────────────────────
export function connectPublicWs() {
  if (publicWs && (publicWs.readyState === WebSocket.OPEN || publicWs.readyState === WebSocket.CONNECTING)) return;
  store.patch('connection', { publicWsState: 'connecting' });
  logInfo('Conectando WS público...');

  publicWs = openWebSocket(CONFIG.publicWsUrl, {
    onOpen: () => {
      publicReconnectAttempts = 0;
      store.patch('connection', { publicWsState: 'online' });
      logInfo('WS público conectado.');
      // Reassinar subscriptions
      reestablishSubscriptions('public');
      // Ping keep-alive
      startPublicPing();
      emit('public:open');
      // Auto-buscar símbolos ativos assim que o WS público abre
      fetchActiveSymbols().catch(e => logError('Falha ao buscar active_symbols: ' + e.message));
    },
    onMessage: (msg) => {
      handleWsMessage(msg, 'public');
    },
    onClose: () => {
      stopPublicPing();
      store.patch('connection', { publicWsState: 'reconnect' });
      logWarn('WS público fechado. Reconectando...');
      schedulePublicReconnect();
      emit('public:close');
    },
    onError: () => {
      logError('Erro no WS público.');
    },
  });
}

function schedulePublicReconnect() {
  if (publicReconnectTimer) clearTimeout(publicReconnectTimer);
  const delay = Math.min(
    CONFIG.reconnectBaseMs * Math.pow(2, publicReconnectAttempts),
    CONFIG.reconnectMaxMs
  );
  publicReconnectAttempts++;
  publicReconnectTimer = setTimeout(() => connectPublicWs(), delay);
}

function startPublicPing() {
  stopPublicPing();
  publicPingTimer = setInterval(() => {
    if (publicWs && publicWs.readyState === WebSocket.OPEN) {
      lastPingSent = Date.now();
      publicWs.send(JSON.stringify({ ping: 1, req_id: nextReqId() }));
    }
  }, CONFIG.pingIntervalMs);
}
function stopPublicPing() {
  if (publicPingTimer) clearInterval(publicPingTimer);
  publicPingTimer = null;
}

// ──────────────────────────────────────────────────────────────
// 7. WebSocket autenticado (conta específica)
// ──────────────────────────────────────────────────────────────
export async function connectAuthWs(accountId) {
  // Fecha conexão anterior
  if (authWs) {
    try { authWs.close(); } catch(e) {}
    authWs = null;
  }

  if (!accountId) {
    const active = store.get('session.activeAccountId');
    if (!active) throw new Error('Nenhuma conta ativa selecionada.');
    accountId = active;
  }

  store.patch('connection', { authWsState: 'connecting' });
  logInfo(`Solicitando OTP para conta ${accountId}...`);

  let url;
  try {
    url = await fetchAuthWsUrl(accountId);
  } catch (e) {
    store.patch('connection', { authWsState: 'offline', lastError: e.message });
    logError('Falha ao obter OTP: ' + e.message);
    return;
  }

  logInfo('Conectando WS autenticado...');
  authWs = openWebSocket(url, {
    onOpen: () => {
      authReconnectAttempts = 0;
      store.patch('connection', { authWsState: 'online' });
      logInfo('WS autenticado conectado.');
      reestablishSubscriptions('auth');
      startAuthPing();
      emit('auth:open');
      // Solicita saldo inicial
      sendAuth({ balance: 1, subscribe: 1 }).catch(() => {});
    },
    onMessage: (msg) => handleWsMessage(msg, 'auth'),
    onClose: () => {
      stopAuthPing();
      store.patch('connection', { authWsState: 'reconnect' });
      logWarn('WS autenticado fechado. Solicitando novo OTP...');
      scheduleAuthReconnect(accountId);
      emit('auth:close');
    },
    onError: () => logError('Erro no WS autenticado.'),
  });
}

function scheduleAuthReconnect(accountId) {
  if (authReconnectTimer) clearTimeout(authReconnectTimer);
  const delay = Math.min(
    CONFIG.reconnectBaseMs * Math.pow(2, authReconnectAttempts),
    CONFIG.reconnectMaxMs
  );
  authReconnectAttempts++;
  authReconnectTimer = setTimeout(() => connectAuthWs(accountId), delay);
}

function startAuthPing() {
  stopAuthPing();
  authPingTimer = setInterval(() => {
    if (authWs && authWs.readyState === WebSocket.OPEN) {
      authWs.send(JSON.stringify({ ping: 1, req_id: nextReqId() }));
    }
  }, CONFIG.pingIntervalMs);
}
function stopAuthPing() {
  if (authPingTimer) clearInterval(authPingTimer);
  authPingTimer = null;
}

// ──────────────────────────────────────────────────────────────
// 8. Roteamento de mensagens
// ──────────────────────────────────────────────────────────────
function handleWsMessage(msg, wsType) {
  // Ping/pong — medir latência
  if (msg.pong || msg.msg_type === 'ping') {
    if (lastPingSent) {
      const latency = Date.now() - lastPingSent;
      store.patch('connection', { latencyMs: latency });
      lastPingSent = 0;
    }
    return;
  }

  // Resposta a request pendente
  if (msg.req_id && pendingRequests.has(msg.req_id)) {
    const pending = pendingRequests.get(msg.req_id);
    pendingRequests.delete(msg.req_id);
    if (msg.error) pending.reject(new Error(msg.error.message || msg.error.code));
    else pending.resolve(msg);
  }

  // Subscription stream
  if (msg.subscription && msg.subscription.id) {
    // Registrar subscription para reassinar depois
    activeSubscriptions.set(msg.subscription.id, {
      ws: wsType,
      msgType: msg.msg_type,
      raw: msg,
    });
  }

  // Roteamento por msg_type
  emit('message', { wsType, msg });
  if (msg.msg_type) emit(msg.msg_type, msg);
}

// ──────────────────────────────────────────────────────────────
// 9. Envio de mensagens (com req_id e fila de promises)
// ──────────────────────────────────────────────────────────────
function sendRaw(ws, payload, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      reject(new Error('WebSocket não está aberto.'));
      return;
    }
    const reqId = nextReqId();
    const fullPayload = { ...payload, req_id: reqId };
    pendingRequests.set(reqId, { resolve, reject, ts: Date.now() });
    ws.send(JSON.stringify(fullPayload));

    // Timeout
    setTimeout(() => {
      if (pendingRequests.has(reqId)) {
        pendingRequests.delete(reqId);
        reject(new Error('Timeout aguardando resposta da API.'));
      }
    }, timeoutMs);
  });
}

export function sendPublic(payload, timeoutMs) {
  return sendRaw(publicWs, payload, timeoutMs);
}

export function sendAuth(payload, timeoutMs) {
  if (!authWs || authWs.readyState !== WebSocket.OPEN) {
    return Promise.reject(new Error('WS autenticado não conectado. Selecione uma conta.'));
  }
  return sendRaw(authWs, payload, timeoutMs);
}

// ──────────────────────────────────────────────────────────────
// 10. Reassinar subscriptions após reconexão
// ──────────────────────────────────────────────────────────────
function reestablishSubscriptions(wsType) {
  for (const [subId, sub] of activeSubscriptions.entries()) {
    if (sub.ws !== wsType) continue;
    // Reenvia o payload original (sem o subscription.id)
    if (wsType === 'public') sendPublic(sub.raw).catch(() => {});
    else sendAuth(sub.raw).catch(() => {});
  }
}

// ──────────────────────────────────────────────────────────────
// 11. forget / forget_all
// ──────────────────────────────────────────────────────────────
export async function forget(subscriptionId) {
  activeSubscriptions.delete(subscriptionId);
  return sendPublic({ forget: subscriptionId });
}

export async function forgetAll(...msgTypes) {
  // Remove subscriptions correspondentes
  for (const [id, sub] of [...activeSubscriptions.entries()]) {
    if (msgTypes.includes(sub.msgType)) activeSubscriptions.delete(id);
  }
  return sendPublic({ forget_all: msgTypes });
}

// ──────────────────────────────────────────────────────────────
// 12. API de alto nível
// ──────────────────────────────────────────────────────────────

/** Lista símbolos ativos — request: { active_symbols: 'brief' } (sem product_type) */
export async function fetchActiveSymbols() {
  const resp = await sendPublic({ active_symbols: 'brief' });
  if (resp.active_symbols) {
    // Normaliza campos: a nova API usa underlying_symbol / underlying_symbol_name / pip_size
    const normalized = resp.active_symbols.map(s => ({
      ...s,
      //Compat: cria aliases para os nomes legados para a UI funcionar
      symbol: s.underlying_symbol || s.symbol,
      display_name: s.underlying_symbol_name || s.display_name,
      pip: s.pip_size ?? s.pip,
      exchange_is_open: !!s.exchange_is_open,
    }));
    store.set('symbols', normalized, { persist: true });
    emit('symbols:loaded', normalized);
    return normalized;
  }
  return [];
}

/** Histórico de ticks (sem adjust_start_time — não existe na nova API) */
export async function fetchTicksHistory(symbol, { count = 100, style = 'candles', granularity = 60, subscribe = false } = {}) {
  const payload = {
    ticks_history: symbol,
    count,
    end: 'latest',
    style,
  };
  if (granularity && style === 'candles') payload.granularity = granularity;
  if (subscribe) payload.subscribe = 1;
  return sendPublic(payload);
}

/** Subscrever ticks em tempo real */
export async function subscribeTicks(symbol, onTick) {
  const resp = await sendPublic({ ticks: symbol, subscribe: 1 });
  if (resp.subscription) {
    const subId = resp.subscription.id;
    const off = on('tick', (msg) => {
      if (msg.tick && msg.tick.symbol === symbol) onTick(msg.tick);
    });
    // Aplica o primeiro tick imediatamente
    if (resp.tick) onTick(resp.tick);
    return { unsubscribe: async () => { off(); await forget(subId); }, subId };
  }
}

/** Subscrever candles em streaming */
export async function subscribeCandles(symbol, granularity, onCandle) {
  const resp = await sendPublic({
    ticks_history: symbol,
    style: 'candles',
    granularity,
    count: 100,
    subscribe: 1,
  });
  if (resp.subscription) {
    const subId = resp.subscription.id;
    const off = on('ohlc', (msg) => {
      if (msg.ohlc && msg.ohlc.symbol === symbol) onCandle(msg.ohlc);
    });
    return { unsubscribe: async () => { off(); await forget(subId); }, subId, initialCandles: resp.candles || [] };
  }
}

/**
 * Proposal (cotação de contrato).
 * A nova API usa 'underlying_symbol' (não 'symbol') no request de proposal.
 * Aceita ambos para compatibilidade: se caller passar 'symbol', renomeia.
 */
export async function proposal(params) {
  const { symbol, ...rest } = params;
  if (symbol && !rest.underlying_symbol) rest.underlying_symbol = symbol;
  return sendPublic({ proposal: 1, ...rest });
}

/** Comprar contrato (via WS autenticado) */
export async function buyContract(proposalId, price, options = {}) {
  return sendAuth({ buy: proposalId, price, ...options });
}

/** Comprar contrato direto (sem proposal prévia) */
export async function buyDirect(contractParams, stake) {
  // proposal + buy em sequência
  const prop = await proposal({ ...contractParametersToProposal(contractParams), amount: stake });
  if (prop.error) throw new Error(prop.error.message);
  return buyContract(prop.proposal.id, prop.proposal.ask_price);
}

function contractParametersToProposal(p) {
  return {
    contract_type: p.contract_type,
    underlying_symbol: p.underlying_symbol || p.symbol,
    currency: p.currency,
    amount: p.amount,
    basis: p.basis,
    duration: p.duration,
    duration_unit: p.duration_unit,
    ...(p.barrier ? { barrier: p.barrier } : {}),
  };
}

/** Saldo da conta ativa */
export async function fetchBalance() {
  return sendAuth({ balance: 1, subscribe: 1 });
}

/** Portfólio de contratos abertos */
export async function fetchPortfolio() {
  return sendAuth({ portfolio: 1 });
}

/** Vender contrato aberto */
export async function sellContract(contractId, price = 0) {
  return sendAuth({ sell: contractId, price });
}

/** Subscrever a atualizações de contrato aberto */
export async function subscribeOpenContract(contractId, onUpdate) {
  const resp = await sendAuth({ proposal_open_contract: 1, contract_id: contractId, subscribe: 1 });
  if (resp.subscription) {
    const off = on('proposal_open_contract', (msg) => {
      if (msg.proposal_open_contract && msg.proposal_open_contract.contract_id == contractId) {
        onUpdate(msg.proposal_open_contract);
      }
    });
    return { unsubscribe: async () => { off(); await forget(resp.subscription.id); } };
  }
}

// ──────────────────────────────────────────────────────────────
// 13. Compra em lote via PAT (REST)
// ──────────────────────────────────────────────────────────────
export async function bulkPurchase(env, contractParameters, accounts) {
  // env: 'real' | 'demo'
  // accounts: [{ account_id, token }]
  const body = {
    contract_parameters: contractParameters,
    accounts: accounts.map(a => ({ token: a.token, account_id: a.account_id })),
  };
  logInfo(`Disparando compra em lote (${env}) para ${accounts.length} conta(s).`);

  const resp = await fetch(CONFIG.bulkPurchaseUrl(env), {
    method: 'POST',
    headers: {
      'Deriv-App-ID': CONFIG.derivAppId,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || data.error) {
    const msg = data.error?.message || data.error?.code || `HTTP ${resp.status}`;
    logError('bulk-purchase falhou: ' + msg);
    throw new Error(msg);
  }
  logInfo('Compra em lote processada.');
  return data;
}

// ──────────────────────────────────────────────────────────────
// 14. Logout / desconexão total
// ──────────────────────────────────────────────────────────────
export function disconnectAll() {
  stopPublicPing();
  stopAuthPing();
  if (publicReconnectTimer) clearTimeout(publicReconnectTimer);
  if (authReconnectTimer) clearTimeout(authReconnectTimer);
  if (publicWs) try { publicWs.close(); } catch(e) {}
  if (authWs)   try { authWs.close(); } catch(e) {}
  publicWs = null;
  authWs = null;
  activeSubscriptions.clear();
  pendingRequests.clear();
  store.patch('connection', { publicWsState: 'offline', authWsState: 'offline' });
}

// ──────────────────────────────────────────────────────────────
// 15. Export de eventos
// ──────────────────────────────────────────────────────────────
export const events = { on, emit };
export { CONFIG };
