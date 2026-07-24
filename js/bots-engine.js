/* ============================================================
   PontoBots v2 — bots-engine.js
   Motor de execução de bots. Ciclo de vida (start/pause/stop),
   gestão financeira (Martingale/Soros/Fibo/D'Alembert/fixed),
   Virtual Loss, integração com deriv-api, logging.
   ============================================================ */

import { store } from './state.js';
import * as DerivAPI from './deriv-api.js';
import { getBot } from './bots-library.js';

// ──────────────────────────────────────────────────────────────
// Classe de gestão financeira
// ──────────────────────────────────────────────────────────────
class MoneyManager {
  constructor(config, initialBalance) {
    this.config = config;
    this.initialStake = Math.max(config.minStake || 0.35, 0.35);
    this.balance = initialBalance || 0;
    this.initialBalance = initialBalance || 0;
    this.reset();
  }

  reset() {
    this.stake = this.initialStake;
    this.mgLevel = 0;
    this.sorosLevel = 0;
    this.fiboIndex = 0;
    this.dalBase = this.initialStake;
    this.consecutiveLosses = 0;
    this.consecutiveWins = 0;
    this.totalOps = 0;
    this.totalPnl = 0;
    this.cooldownUntil = 0;
    this.stopped = false;
    this.stopReason = null;
  }

  // Retorna o stake a ser usado na próxima operação
  currentStake() {
    const cfg = this.config;
    let stake = this.initialStake;
    switch (cfg.mode) {
      case 'martingale':
        stake = this.initialStake * Math.pow(cfg.martingale.mult, this.mgLevel);
        break;
      case 'soros':
        stake = this.sorosLevel === 0 ? this.initialStake : this._sorosStake();
        break;
      case 'fibonacci': {
        const seq = cfg.fibonacci.sequence.split(',').map(Number);
        const idx = Math.min(this.fiboIndex, seq.length - 1);
        stake = this.initialStake * seq[idx];
        break;
      }
      case 'dalembert':
        stake = this.dalBase + (this.consecutiveLosses - this.consecutiveWins) * cfg.dalembert.step;
        stake = Math.max(stake, cfg.minStake || 0.35);
        break;
      case 'fixed':
      default:
        stake = this.initialStake;
    }
    // Clamp
    stake = Math.max(stake, cfg.minStake || 0.35);
    stake = Math.min(stake, cfg.maxStake || 1000);
    return parseFloat(stake.toFixed(2));
  }

  _sorosStake() {
    // Stake atual = stake anterior + lucro anterior * reinvestPct
    return this._lastSorosStake || this.initialStake;
  }

  // Atualiza estado após uma operação
  update({ result, pnl, stakeUsed }) {
    const cfg = this.config;
    this.totalOps++;
    this.totalPnl += pnl;
    this.balance += pnl;

    if (result === 'win') {
      this.consecutiveWins++;
      this.consecutiveLosses = 0;
      switch (cfg.mode) {
        case 'martingale':
          this.mgLevel = 0;
          break;
        case 'soros': {
          this.sorosLevel++;
          const profit = stakeUsed * (cfg._payoutPct || 0.85);
          this._lastSorosStake = stakeUsed + profit * (cfg.soros.reinvestPct / 100);
          if (this.sorosLevel >= cfg.soros.maxLevels) {
            this.sorosLevel = 0;
            this._lastSorosStake = this.initialStake;
          }
          break;
        }
        case 'fibonacci':
          this.fiboIndex = Math.max(0, this.fiboIndex - 2);
          break;
        case 'dalembert':
          // Já tratado por consecutiveWins
          break;
      }
    } else if (result === 'loss') {
      this.consecutiveLosses++;
      this.consecutiveWins = 0;
      switch (cfg.mode) {
        case 'martingale':
          this.mgLevel++;
          if (this.mgLevel > cfg.martingale.maxLevels) {
            this.stopped = true;
            this.stopReason = `Martingale atingiu nível máximo (${cfg.martingale.maxLevels})`;
          }
          break;
        case 'soros':
          this.sorosLevel = 0;
          this._lastSorosStake = this.initialStake;
          break;
        case 'fibonacci':
          this.fiboIndex++;
          break;
      }
    }

    // Stops
    if (cfg.takeProfit > 0 && this.totalPnl >= cfg.takeProfit) {
      this.stopped = true;
      this.stopReason = `Take Profit atingido: ${this.totalPnl.toFixed(2)}`;
    }
    if (cfg.stopLoss > 0 && this.totalPnl <= -cfg.stopLoss) {
      this.stopped = true;
      this.stopReason = `Stop Loss atingido: ${this.totalPnl.toFixed(2)}`;
    }
    if (cfg.takeProfitPct > 0) {
      const pct = (this.totalPnl / this.initialBalance) * 100;
      if (pct >= cfg.takeProfitPct) {
        this.stopped = true;
        this.stopReason = `Take Profit % atingido: ${pct.toFixed(1)}%`;
      }
    }
    if (cfg.stopLossPct > 0) {
      const pct = (this.totalPnl / this.initialBalance) * 100;
      if (pct <= -cfg.stopLossPct) {
        this.stopped = true;
        this.stopReason = `Stop Loss % atingido: ${pct.toFixed(1)}%`;
      }
    }
    if (cfg.maxOpsPerSession > 0 && this.totalOps >= cfg.maxOpsPerSession) {
      this.stopped = true;
      this.stopReason = `Máximo de operações atingido (${cfg.maxOpsPerSession})`;
    }
    if (cfg.maxLosses > 0 && this.consecutiveLosses >= cfg.maxLosses) {
      this.stopped = true;
      this.stopReason = `Máximo de perdas consecutivas (${cfg.maxLosses})`;
    }
    if (this.stopped) {
      this.cooldownUntil = Date.now() + (cfg.cooldownSec || 0) * 1000;
    }
  }

  canOperate() {
    if (this.stopped) return false;
    if (Date.now() < this.cooldownUntil) return false;
    return true;
  }
}

// ──────────────────────────────────────────────────────────────
// Virtual Loss — lógica de decisão de conta
// ──────────────────────────────────────────────────────────────
class VirtualLossManager {
  constructor(config) {
    this.config = config;
  }

  // Decide em qual conta a próxima entrada deve ir
  // Retorna: { account: 'demo'|'real', reason: string }
  decideNextAccount() {
    const cfg = this.config;
    const c = store.get('virtualLoss.counters');

    if (cfg.mode === 'off') {
      // Sempre segue a conta ativa
      const activeType = store.get('session.activeAccountType') || 'demo';
      return { account: activeType, reason: 'VL desativado — segue conta ativa' };
    }

    if (cfg.mode === 'simple') {
      const n = cfg.simple.n;
      const crit = cfg.simple.criterion;
      // Se ainda não atingiu N virtuais, fica em demo
      if (c.virtualLosses < n) {
        return { account: 'demo', reason: `Aguardando ${n - c.virtualLosses} perda(s) virtual(is)` };
      }
      // Critério satisfeito: vai pra real
      return { account: 'real', reason: `${n} perdas virtuais atingidas — entrando na real` };
    }

    if (cfg.mode === 'intermarket') {
      // Contabiliza perdas virtuais seguidas; após N, vai pra real
      if (c.virtualLosses >= cfg.intermarket.n && c.realEntries < cfg.intermarket.maxRealConsecutive) {
        return { account: 'real', reason: `${c.virtualLosses} perda(s) virtual(is) → real` };
      }
      if (c.realEntries >= cfg.intermarket.maxRealConsecutive) {
        return { account: 'demo', reason: 'Máx. de entradas reais atingido — volta para demo' };
      }
      return { account: 'demo', reason: 'Aguardando critério' };
    }

    return { account: 'demo', reason: 'Modo desconhecido' };
  }

  // Atualiza contadores após resultado
  applyResult({ account, result }) {
    const cfg = this.config;
    const c = store.get('virtualLoss.counters');

    if (account === 'demo') {
      if (result === 'loss') {
        store.updateVlCounters({ virtualLosses: c.virtualLosses + 1 });
      } else if (result === 'win' && cfg.mode === 'simple' && cfg.simple.criterion === 'after_win') {
        store.updateVlCounters({ virtualLosses: cfg.simple.n }); // força ir pra real
      }
    } else if (account === 'real') {
      const newRealEntries = c.realEntries + 1;
      const updates = { realEntries: newRealEntries };
      if (result === 'loss') {
        updates.realLossesStreak = c.realLossesStreak + 1;
        if (cfg.mode === 'intermarket' && cfg.intermarket.returnOnLoss === 'yes') {
          updates.virtualLosses = 0;
          updates.realEntries = 0;
        }
      } else {
        updates.realLossesStreak = 0;
      }
      store.updateVlCounters(updates);
    }
  }

  resetAfterReal({ result } = {}) {
    const cfg = this.config;
    if (cfg.mode === 'simple') {
      const ret = cfg.simple.returnAfterReal;
      if (ret === 'yes' || (ret === 'on_loss' && result === 'loss')) {
        store.updateVlCounters({ virtualLosses: 0, realEntries: 0 });
      }
    }
  }
}

// ──────────────────────────────────────────────────────────────
// Instância de execução de bot
// ──────────────────────────────────────────────────────────────
class BotRunner {
  constructor({ id, botId, symbol, params, moneyMgmt, initialBalance, source = 'bot' }) {
    this.id = id;
    this.botId = botId;
    this.bot = getBot(botId);
    if (!this.bot) throw new Error(`Bot "${botId}" não encontrado no catálogo.`);

    this.symbol = symbol;
    this.params = params || {};
    this.source = source;
    this.state = 'stopped'; // stopped | running | paused
    this.stats = { ops: 0, wins: 0, losses: 0, pnl: 0, currentStake: 0, lastResult: null };
    this.lastTick = null;
    this.lastCandle = null;
    this.tickSub = null;
    this.candleSub = null;
    this.candles = [];
    this.ticks = [];

    this.mm = new MoneyManager(moneyMgmt, initialBalance);
    this.vl = new VirtualLossManager(store.get('virtualLoss'));
    this.openContracts = new Map(); // contractId -> info
  }

  async start() {
    if (this.state === 'running') return;
    this.state = 'running';
    store.addLog('info', `Bot "${this.bot.nome}" iniciado em ${this.symbol}.`);
    store.updateRunningBot(this.id, { state: this.state });

    // Chama hook de início do bot
    const ctx = this._buildContext();
    try {
      if (this.bot.aoIniciar) await this.bot.aoIniciar(ctx);
    } catch (e) {
      store.addLog('error', `Erro em aoIniciar do bot ${this.bot.nome}: ${e.message}`);
    }

    // Subscrever ticks
    try {
      this.tickSub = await DerivAPI.subscribeTicks(this.symbol, (tick) => this._onTick(tick));
    } catch (e) {
      store.addLog('error', `Falha ao subscrever ticks: ${e.message}`);
    }
  }

  pause() {
    if (this.state !== 'running') return;
    this.state = 'paused';
    store.addLog('info', `Bot "${this.bot.nome}" pausado.`);
    store.updateRunningBot(this.id, { state: this.state });
  }

  async resume() {
    if (this.state !== 'paused') return;
    this.state = 'running';
    store.addLog('info', `Bot "${this.bot.nome}" retomado.`);
    store.updateRunningBot(this.id, { state: this.state });
  }

  async stop() {
    this.state = 'stopped';
    store.addLog('info', `Bot "${this.bot.nome}" parado.`);
    if (this.tickSub) await this.tickSub.unsubscribe();
    if (this.candleSub) await this.candleSub.unsubscribe();
    this.tickSub = null;
    this.candleSub = null;
    store.updateRunningBot(this.id, { state: this.state });
    store.removeRunningBot(this.id);
  }

  async _onTick(tick) {
    this.lastTick = tick;
    this.ticks.push(tick);
    if (this.ticks.length > 500) this.ticks = this.ticks.slice(-500);

    if (this.state !== 'running') return;
    if (!this.mm.canOperate()) {
      if (this.mm.stopped) {
        store.addLog('warn', `Bot ${this.bot.nome} parado: ${this.mm.stopReason}`);
        await this.stop();
      }
      return;
    }

    // Atualiza stats
    this.stats.currentStake = this.mm.currentStake();
    store.updateRunningBot(this.id, { stats: { ...this.stats } });

    const ctx = this._buildContext();
    try {
      if (this.bot.aoReceberTick) await this.bot.aoReceberTick(ctx, tick);
    } catch (e) {
      store.addLog('error', `Erro em aoReceberTick do bot ${this.bot.nome}: ${e.message}`);
    }
  }

  async _onCandle(candle) {
    this.lastCandle = candle;
    this.candles.push(candle);
    if (this.candles.length > 200) this.candles = this.candles.slice(-200);
    if (this.state !== 'running') return;

    const ctx = this._buildContext();
    try {
      if (this.bot.aoReceberCandle) await this.bot.aoReceberCandle(ctx, candle);
    } catch (e) {
      store.addLog('error', `Erro em aoReceberCandle: ${e.message}`);
    }
  }

  _buildContext() {
    return {
      botId: this.botId,
      instanceId: this.id,
      symbol: this.symbol,
      params: this.params,
      stats: this.stats,
      ticks: this.ticks,
      candles: this.candles,
      lastTick: this.lastTick,
      lastCandle: this.lastCandle,
      moneyMgmt: this.mm.config,
      currentStake: () => this.mm.currentStake(),
      // Compra de contrato
      comprarContrato: async (contractParams, options = {}) => this._comprarContrato(contractParams, options),
      // Log
      log: (msg, level = 'info') => store.addLog(level, `[${this.bot.nome}] ${msg}`),
      // Parar bot
      parar: (reason) => { this.mm.stopped = true; this.mm.stopReason = reason; },
    };
  }

  async _comprarContrato(contractParams, options = {}) {
    if (this.state !== 'running') throw new Error('Bot não está em execução.');

    // Decide conta via VL
    const { account: targetAccount, reason } = this.vl.decideNextAccount();
    const activeType = store.get('session.activeAccountType') || 'demo';

    // Se VL está em demo e a conta ativa é real — simulamos a operação (virtual)
    const isVirtual = (targetAccount === 'demo' && activeType === 'real') || options.virtual;

    const stake = options.stake || this.mm.currentStake();
    this.stats.currentStake = stake;

    store.addLog('info', `[${this.bot.nome}] Entrada ${contractParams.contract_type} em ${this.symbol} | stake=${stake} | ${isVirtual ? 'VIRTUAL' : 'REAL'} | ${reason}`);

    if (isVirtual) {
      // Simular resultado — busca payout via proposal mas não compra
      return this._simulateContract(contractParams, stake, targetAccount);
    }

    // Compra real via WS autenticado
    try {
      const proposalParams = {
        contract_type: contractParams.contract_type,
        symbol: this.symbol,
        currency: store.get('session.accounts').find(a => a.account_id === store.get('session.activeAccountId'))?.currency || 'USD',
        amount: stake,
        basis: 'stake',
        duration: contractParams.duration,
        duration_unit: contractParams.duration_unit,
        ...(contractParams.barrier ? { barrier: contractParams.barrier } : {}),
      };
      const prop = await DerivAPI.proposal(proposalParams);
      if (prop.error) throw new Error(prop.error.message);
      const buy = await DerivAPI.buyContract(prop.proposal.id, prop.proposal.ask_price);
      if (buy.error) throw new Error(buy.error.message);

      // Subscreve atualizações do contrato
      const contractId = buy.buy?.contract_id;
      if (contractId) {
        DerivAPI.subscribeOpenContract(contractId, (update) => this._onContractUpdate(update, stake, targetAccount, contractParams));
      }

      this.stats.ops++;
      store.updateRunningBot(this.id, { stats: { ...this.stats } });
      store.addTrade({
        symbol: this.symbol,
        contract: contractParams.contract_type,
        stake,
        result: 'pending',
        pnl: 0,
        account: targetAccount,
        source: this.source,
        botId: this.botId,
        contractId,
      });
      return { contractId, isVirtual: false };
    } catch (e) {
      store.addLog('error', `[${this.bot.nome}] Falha na compra: ${e.message}`);
      throw e;
    }
  }

  async _simulateContract(contractParams, stake, account) {
    // Simula resultado baseado em proposal + aleatório (quando VL está em demo e conta ativa é real)
    // Em produção, idealmente teria uma conta demo ativa de fato — aqui simulamos o resultado
    return new Promise((resolve) => {
      // Sorteio pseudo-aleatório com payout médio
      const payoutPct = 0.85;
      const isWin = Math.random() < 0.5; // 50% base; bots podem sobrescrever com lógica própria
      const pnl = isWin ? parseFloat((stake * payoutPct).toFixed(2)) : -stake;

      // Atualiza VL e MM
      this.vl.applyResult({ account, result: isWin ? 'win' : 'loss' });
      this.mm.update({ result: isWin ? 'win' : 'loss', pnl, stakeUsed: stake });

      // Atualiza stats
      this.stats.ops++;
      if (isWin) this.stats.wins++; else this.stats.losses++;
      this.stats.pnl = parseFloat((this.stats.pnl + pnl).toFixed(2));
      this.stats.lastResult = isWin ? 'win' : 'loss';

      store.updateRunningBot(this.id, { stats: { ...this.stats } });
      store.addTrade({
        symbol: this.symbol,
        contract: contractParams.contract_type,
        stake,
        result: isWin ? 'win' : 'loss',
        pnl,
        account: 'demo',
        source: this.source,
        botId: this.botId,
        virtual: true,
      });
      store.addLog(isWin ? 'info' : 'warn', `[${this.bot.nome}] Resultado VIRTUAL: ${isWin ? 'WIN' : 'LOSS'} ${pnl >= 0 ? '+' : ''}${pnl}`);

      // Hook de resultado do bot
      if (this.bot.aoResultadoContrato) {
        try {
          this.bot.aoResultadoContrato(this._buildContext(), { isWin, pnl, stake, isVirtual: true });
        } catch (e) {
          store.addLog('error', `Erro em aoResultadoContrato: ${e.message}`);
        }
      }

      // Se parou por stop, encerra
      if (this.mm.stopped) {
        store.addLog('warn', `[${this.bot.nome}] STOP: ${this.mm.stopReason}`);
        this.stop();
      }

      resolve({ isVirtual: true, isWin, pnl });
    });
  }

  async _onContractUpdate(update, stake, account, contractParams) {
    if (update.is_sold) {
      const isWin = update.status === 'won';
      const pnl = parseFloat(update.profit);
      // Atualiza VL e MM
      this.vl.applyResult({ account, result: isWin ? 'win' : 'loss' });
      this.mm.update({ result: isWin ? 'win' : 'loss', pnl, stakeUsed: stake });

      // Stats
      this.stats.ops++;
      if (isWin) this.stats.wins++; else this.stats.losses++;
      this.stats.pnl = parseFloat((this.stats.pnl + pnl).toFixed(2));
      this.stats.lastResult = isWin ? 'win' : 'loss';
      store.updateRunningBot(this.id, { stats: { ...this.stats } });

      // Atualiza trade no histórico
      const trades = store.get('trades');
      const t = trades.find(t => t.contractId === update.contract_id);
      if (t) {
        Object.assign(t, { result: isWin ? 'win' : 'loss', pnl, soldAt: Date.now() });
        store.emit('trades:updated', t);
      }

      store.addLog(isWin ? 'info' : 'warn', `[${this.bot.nome}] Resultado: ${isWin ? 'WIN' : 'LOSS'} ${pnl >= 0 ? '+' : ''}${pnl}`);

      // Hook
      if (this.bot.aoResultadoContrato) {
        try {
          this.bot.aoResultadoContrato(this._buildContext(), { isWin, pnl, stake, isVirtual: false });
        } catch (e) {
          store.addLog('error', `Erro em aoResultadoContrato: ${e.message}`);
        }
      }

      // VL reset se necessário
      this.vl.resetAfterReal({ result: isWin ? 'win' : 'loss' });

      // Stop check
      if (this.mm.stopped) {
        store.addLog('warn', `[${this.bot.nome}] STOP: ${this.mm.stopReason}`);
        await this.stop();
      }
    }
  }
}

// ──────────────────────────────────────────────────────────────
// Engine — registry de instâncias ativas
// ──────────────────────────────────────────────────────────────
const runners = new Map(); // instanceId -> BotRunner

export function startBot({ botId, symbol, params, moneyMgmt, initialBalance, source }) {
  const id = `bot_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const runner = new BotRunner({ id, botId, symbol, params, moneyMgmt, initialBalance, source });
  runners.set(id, runner);

  store.addRunningBot({
    id,
    botId,
    nome: runner.bot.nome,
    symbol,
    state: 'stopped',
    stats: runner.stats,
    params,
  });

  runner.start();
  return id;
}

export function pauseBot(id) {
  const r = runners.get(id);
  if (r) r.pause();
}

export function resumeBot(id) {
  const r = runners.get(id);
  if (r) r.resume();
}

export function stopBot(id) {
  const r = runners.get(id);
  if (r) { r.stop(); runners.delete(id); }
}

export function getRunner(id) {
  return runners.get(id);
}

export function listRunningBots() {
  return Array.from(runners.values());
}

// ──────────────────────────────────────────────────────────────
// Helpers para trading manual (usa mesma infraestrutura)
// ──────────────────────────────────────────────────────────────
export async function manualBuy({ symbol, contractType, stake, duration, durationUnit, barrier, source = 'manual' }) {
  const mm = new MoneyManager(store.get('moneyMgmt'), 0);
  const vl = new VirtualLossManager(store.get('virtualLoss'));
  const { account: targetAccount, reason } = vl.decideNextAccount();
  const activeType = store.get('session.activeAccountType') || 'demo';
  const isVirtual = (targetAccount === 'demo' && activeType === 'real');

  store.addLog('info', `[Manual] Entrada ${contractType} em ${symbol} | stake=${stake} | ${isVirtual ? 'VIRTUAL' : 'REAL'} | ${reason}`);

  if (isVirtual) {
    // Simula
    return new Promise((resolve) => {
      const isWin = Math.random() < 0.5;
      const pnl = isWin ? parseFloat((stake * 0.85).toFixed(2)) : -stake;
      vl.applyResult({ account: targetAccount, result: isWin ? 'win' : 'loss' });
      store.addTrade({
        symbol, contract: contractType, stake, result: isWin ? 'win' : 'loss',
        pnl, account: 'demo', source, virtual: true,
      });
      store.addLog(isWin ? 'info' : 'warn', `[Manual] Resultado VIRTUAL: ${isWin ? 'WIN' : 'LOSS'} ${pnl >= 0 ? '+' : ''}${pnl}`);
      resolve({ isVirtual: true, isWin, pnl });
    });
  }

  // Compra real
  const currency = store.get('session.accounts').find(a => a.account_id === store.get('session.activeAccountId'))?.currency || 'USD';
  const prop = await DerivAPI.proposal({
    contract_type: contractType, symbol, currency, amount: stake, basis: 'stake',
    duration, duration_unit: durationUnit, ...(barrier ? { barrier } : {}),
  });
  const buy = await DerivAPI.buyContract(prop.proposal.id, prop.proposal.ask_price);
  const contractId = buy.buy?.contract_id;

  // Subscreve atualizações
  DerivAPI.subscribeOpenContract(contractId, (update) => {
    if (update.is_sold) {
      const isWin = update.status === 'won';
      const pnl = parseFloat(update.profit);
      vl.applyResult({ account: targetAccount, result: isWin ? 'win' : 'loss' });
      vl.resetAfterReal({ result: isWin ? 'win' : 'loss' });
      const trades = store.get('trades');
      const t = trades.find(t => t.contractId === contractId);
      if (t) {
        Object.assign(t, { result: isWin ? 'win' : 'loss', pnl, soldAt: Date.now() });
        store.emit('trades:updated', t);
      }
      store.addLog(isWin ? 'info' : 'warn', `[Manual] Resultado: ${isWin ? 'WIN' : 'LOSS'} ${pnl >= 0 ? '+' : ''}${pnl}`);
    }
  });

  store.addTrade({
    symbol, contract: contractType, stake, result: 'pending', pnl: 0,
    account: targetAccount, source, contractId,
  });

  return { contractId, isVirtual: false };
}

export { MoneyManager, VirtualLossManager };
