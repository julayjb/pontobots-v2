/* ============================================================
   PontoBots v2 — state.js
   Store global com padrão pub/sub (event emitter).
   Persistência seletiva em localStorage.
   ============================================================ */

const STORAGE_KEY = 'pontobots_v2_state_v1';

const defaultState = {
  // Sessão
  session: {
    accessToken: null,    // OAuth Bearer token ou PAT
    authMethod: null,     // 'oauth' | 'pat' | null
    tokenType: 'Bearer',
    expiresAt: 0,
    accounts: [],         // [{ account_id, currency, balance, type: 'demo'|'real', isVirtual }]
    activeAccountId: null,
    activeAccountType: null, // 'demo' | 'real'
  },

  // Conexão
  connection: {
    publicWsState: 'offline',     // offline | connecting | online | reconnect
    authWsState: 'offline',
    latencyMs: 0,
    lastError: null,
  },

  // Mercados
  symbols: [],
  favorites: [],                  // [symbol]
  symbolCategories: {},

  // Gráficos
  charts: {
    symbol: 'R_100',
    granularity: 60,
    count: 100,
    style: 'candlestick',
    overlays: [],
  },

  // Gestão financeira
  moneyMgmt: {
    mode: 'fixed',
    martingale: { mult: 2.0, maxLevels: 5 },
    soros: { reinvestPct: 100, maxLevels: 3 },
    fibonacci: { sequence: '1,1,2,3,5,8,13' },
    dalembert: { step: 1.0 },
    takeProfit: 10,
    stopLoss: 5,
    takeProfitPct: 0,
    stopLossPct: 0,
    maxOpsPerSession: 50,
    maxLosses: 5,
    cooldownSec: 60,
    minStake: 0.35,
    maxStake: 100,
  },

  // Virtual Loss
  virtualLoss: {
    mode: 'off',                  // off | simple | intermarket
    simple: { n: 3, criterion: 'after_n', returnAfterReal: 'yes' },
    intermarket: { n: 2, returnOnLoss: 'yes', maxRealConsecutive: 2 },
    counters: {
      virtualLosses: 0,
      realEntries: 0,
      realLossesStreak: 0,
      nextAccount: 'demo',
    },
  },

  // Bots em execução
  runningBots: [],                // [{ id, botId, symbol, state, stats }]

  // Trades
  trades: [],

  // Logs
  logs: [],

  // Preferências
  preferences: {
    lang: 'pt-BR',
    theme: 'dark',
    sounds: { entry: true, win: true, loss: true, stop: true, disconnect: true },
    browserNotif: false,
  },

  // PATs para compra em lote
  bulkAccounts: [],               // [{ account_id, pat }]

  // Risk modal já aceito
  riskAccepted: false,
};

class Store {
  constructor() {
    this.state = this._loadFromStorage();
    this._listeners = new Map(); // event -> Set<fn>
  }

  /* -------- Persistência -------- */
  _loadFromStorage() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return this._deepClone(defaultState);
      const parsed = JSON.parse(raw);
      // Merge superficial com defaults (não migra arrays/objetos profundos)
      return { ...this._deepClone(defaultState), ...parsed,
        session: { ...defaultState.session, ...(parsed.session || {}) },
        connection: { ...defaultState.connection, ...(parsed.connection || {}) },
        moneyMgmt: { ...defaultState.moneyMgmt, ...(parsed.moneyMgmt || {}) },
        virtualLoss: { ...defaultState.virtualLoss, ...(parsed.virtualLoss || {}),
          counters: { ...defaultState.virtualLoss.counters, ...((parsed.virtualLoss||{}).counters||{}) } },
        preferences: { ...defaultState.preferences, ...(parsed.preferences || {}),
          sounds: { ...defaultState.preferences.sounds, ...((parsed.preferences||{}).sounds||{}) } },
      };
    } catch (e) {
      console.warn('Falha ao carregar estado, resetando:', e);
      return this._deepClone(defaultState);
    }
  }

  _saveToStorage() {
    try {
      // Nunca salvar OTPs — não há OTPs no estado de qualquer forma
      const persistable = { ...this.state };
      // Remover coisas voláteis
      delete persistable.connection;
      localStorage.setItem(STORAGE_KEY, JSON.stringify(persistable));
    } catch (e) {
      console.warn('Falha ao salvar estado:', e);
    }
  }

  _deepClone(o) { return JSON.parse(JSON.stringify(o)); }

  /* -------- Pub/Sub -------- */
  on(event, fn) {
    if (!this._listeners.has(event)) this._listeners.set(event, new Set());
    this._listeners.get(event).add(fn);
    return () => this._listeners.get(event).delete(fn);
  }

  emit(event, payload) {
    const set = this._listeners.get(event);
    if (set) set.forEach(fn => { try { fn(payload); } catch(e) { console.error('Listener error:', e); } });
    // Wildcard
    const wildcard = this._listeners.get('*');
    if (wildcard) wildcard.forEach(fn => { try { fn({ event, payload }); } catch(e){} });
  }

  /* -------- Getters -------- */
  get(path) {
    return path.split('.').reduce((acc, k) => (acc == null ? acc : acc[k]), this.state);
  }

  /* -------- Setters -------- */
  set(path, value, { persist = true, silent = false } = {}) {
    const keys = path.split('.');
    const lastKey = keys.pop();
    const target = keys.reduce((acc, k) => {
      if (acc[k] == null) acc[k] = {};
      return acc[k];
    }, this.state);
    target[lastKey] = value;
    if (persist) this._saveToStorage();
    if (!silent) this.emit('change:' + path, value);
    this.emit('change', { path, value });
  }

  patch(path, partial, { persist = true } = {}) {
    const keys = path.split('.');
    const target = keys.reduce((acc, k) => {
      if (acc[k] == null) acc[k] = {};
      return acc[k];
    }, this.state);
    Object.assign(target, partial);
    if (persist) this._saveToStorage();
    this.emit('change:' + path, target);
    this.emit('change', { path, value: target });
  }

  /* -------- Actions específicas -------- */
  addTrade(trade) {
    this.state.trades.unshift({ ...trade, id: trade.id || this._genId(), timestamp: trade.timestamp || Date.now() });
    if (this.state.trades.length > 5000) this.state.trades = this.state.trades.slice(0, 5000);
    this._saveToStorage();
    this.emit('trades:added', this.state.trades[0]);
    this.emit('change', { path: 'trades', value: this.state.trades });
  }

  addLog(level, message, meta = {}) {
    const entry = {
      id: this._genId(),
      ts: Date.now(),
      level, // info | warn | error
      message,
      ...meta,
    };
    this.state.logs.unshift(entry);
    if (this.state.logs.length > 1000) this.state.logs = this.state.logs.slice(0, 1000);
    // Logs não persistem (apenas em memória)
    this.emit('logs:added', entry);
  }

  clearLogs() {
    this.state.logs = [];
    this.emit('logs:cleared');
  }

  /* -------- Session -------- */
  setSession({ accessToken, expiresAt, accounts }) {
    this.state.session.accessToken = accessToken;
    this.state.session.expiresAt = expiresAt || (Date.now() + 3600 * 1000);
    if (accounts) this.state.session.accounts = accounts;
    this._saveToStorage();
    this.emit('session:changed', this.state.session);
  }

  clearSession() {
    this.state.session = this._deepClone(defaultState.session);
    this._saveToStorage();
    this.emit('session:changed', this.state.session);
  }

  setActiveAccount(accountId) {
    const acc = this.state.session.accounts.find(a => a.account_id === accountId);
    if (!acc) return;
    this.state.session.activeAccountId = accountId;
    this.state.session.activeAccountType = acc.isVirtual ? 'demo' : 'real';
    this._saveToStorage();
    this.emit('session:activeAccount', acc);
  }

  /* -------- Bots -------- */
  addRunningBot(bot) {
    this.state.runningBots.push(bot);
    this.emit('bots:changed', this.state.runningBots);
  }

  updateRunningBot(id, partial) {
    const idx = this.state.runningBots.findIndex(b => b.id === id);
    if (idx >= 0) {
      this.state.runningBots[idx] = { ...this.state.runningBots[idx], ...partial };
      this.emit('bots:changed', this.state.runningBots);
      this.emit('bots:updated', this.state.runningBots[idx]);
    }
  }

  removeRunningBot(id) {
    this.state.runningBots = this.state.runningBots.filter(b => b.id !== id);
    this.emit('bots:changed', this.state.runningBots);
  }

  /* -------- Virtual Loss counters -------- */
  updateVlCounters(partial) {
    Object.assign(this.state.virtualLoss.counters, partial);
    this._saveToStorage();
    this.emit('vl:changed', this.state.virtualLoss);
  }

  resetVlCounters() {
    this.state.virtualLoss.counters = this._deepClone(defaultState.virtualLoss.counters);
    this._saveToStorage();
    this.emit('vl:changed', this.state.virtualLoss);
  }

  /* -------- Favorites -------- */
  toggleFavorite(symbol) {
    const idx = this.state.favorites.indexOf(symbol);
    if (idx >= 0) this.state.favorites.splice(idx, 1);
    else this.state.favorites.push(symbol);
    this._saveToStorage();
    this.emit('favorites:changed', this.state.favorites);
  }

  /* -------- Bulk PAT -------- */
  addBulkAccount(account_id, pat) {
    this.state.bulkAccounts.push({ account_id, pat });
    this._saveToStorage();
    this.emit('bulkAccounts:changed', this.state.bulkAccounts);
  }

  removeBulkAccount(idx) {
    this.state.bulkAccounts.splice(idx, 1);
    this._saveToStorage();
    this.emit('bulkAccounts:changed', this.state.bulkAccounts);
  }

  /* -------- Utils -------- */
  _genId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  getAll() { return this.state; }

  resetAll() {
    localStorage.removeItem(STORAGE_KEY);
    this.state = this._deepClone(defaultState);
    this.emit('reset');
  }
}

export const store = new Store();
export default store;
