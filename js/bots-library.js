/* ============================================================
   PontoBots v2 — bots-library.js
   Catálogo de bots. Cada bot implementa a interface:

   {
     id:           string único
     nome:         string
     descricao:    string
     icone:        emoji
     simbolos:     string[] (símbolos recomendados)
     risco:        'low' | 'med' | 'high'
     schema:       array de campos p/ gerar formulário dinâmico
                   [{ key, label, type: 'number'|'select'|'text'|'checkbox',
                      default, min, max, step, options }]
     aoIniciar(ctx):              opcional
     aoReceberTick(ctx, tick):    opcional
     aoReceberCandle(ctx, candle): opcional
     aoResultadoContrato(ctx, r): opcional
   }

   Para adicionar um novo bot, basta adicionar um objeto ao
   array BOTS abaixo — a UI e o motor o detectam automaticamente.
   ============================================================ */

const BOTS = [

  // ────────────────────────────────────────────────────────────
  // 1. Médias Móveis — Cross (tendência)
  // ────────────────────────────────────────────────────────────
  {
    id: 'ma-cross',
    nome: 'MA Cross — Tendência',
    descricao: 'Cruza média rápida (9) com lenta (21). CALL quando rápida cruza acima da lenta; PUT quando cruza abaixo. Conservador, opera a favor da tendência.',
    icone: '📈',
    simbolos: ['R_75', 'R_100', '1HZ100V'],
    risco: 'low',
    schema: [
      { key: 'fastPeriod', label: 'Período MM rápida', type: 'number', default: 9, min: 2, max: 50, step: 1 },
      { key: 'slowPeriod', label: 'Período MM lenta', type: 'number', default: 21, min: 5, max: 200, step: 1 },
      { key: 'duration', label: 'Duração (ticks)', type: 'number', default: 5, min: 1, max: 10 },
      { key: 'cooldownTicks', label: 'Cooldown entre entradas (ticks)', type: 'number', default: 10, min: 0, max: 100 },
    ],

    _state: new Map(), // instanceId -> { lastFast, lastSlow, ticksSinceEntry }

    aoIniciar(ctx) {
      this._state.set(ctx.instanceId, { lastFast: null, lastSlow: null, ticksSinceEntry: 999, history: [] });
      ctx.log('Iniciado — aguardando ' + ctx.params.slowPeriod + ' ticks para primeira média.');
    },

    aoReceberTick(ctx, tick) {
      const st = this._state.get(ctx.instanceId);
      if (!st) return;
      st.history.push(parseFloat(tick.quote));
      if (st.history.length > ctx.params.slowPeriod + 5) st.history = st.history.slice(-ctx.params.slowPeriod - 5);

      const slowPeriod = ctx.params.slowPeriod;
      if (st.history.length < slowPeriod) return;

      const fast = this._sma(st.history, ctx.params.fastPeriod);
      const slow = this._sma(st.history, slowPeriod);

      st.ticksSinceEntry++;
      if (st.lastFast !== null && st.lastSlow !== null && st.ticksSinceEntry >= ctx.params.cooldownTicks) {
        const crossUp   = st.lastFast <= st.lastSlow && fast > slow;
        const crossDown = st.lastFast >= st.lastSlow && fast < slow;

        if (crossUp || crossDown) {
          st.ticksSinceEntry = 0;
          const contractType = crossUp ? 'CALL' : 'PUT';
          ctx.comprarContrato({
            contract_type: contractType,
            duration: ctx.params.duration,
            duration_unit: 't',
          }).catch(e => ctx.log('Falha na compra: ' + e.message, 'error'));
        }
      }
      st.lastFast = fast;
      st.lastSlow = slow;
    },

    aoResultadoContrato(ctx, r) {
      ctx.log(`Resultado: ${r.isWin ? 'WIN' : 'LOSS'} ${r.pnl >= 0 ? '+' : ''}${r.pnl}`);
    },

    _sma(arr, period) {
      const slice = arr.slice(-period);
      return slice.reduce((a, b) => a + b, 0) / slice.length;
    },
  },

  // ────────────────────────────────────────────────────────────
  // 2. Reversão em Dígitos — "Dígito Frio"
  // ────────────────────────────────────────────────────────────
  {
    id: 'digit-cold',
    nome: 'Dígito Frio — Reversão',
    descricao: 'Conta dígitos em janela deslizante. Quando um dígito não aparece há N ticks, aposta que ele vai sair (DIGITMATCH). Estratégia de regressão à média.',
    icone: '🎲',
    simbolos: ['R_10', 'R_25', 'R_50', 'R_75', 'R_100', '1HZ10V', '1HZ100V'],
    risco: 'med',
    schema: [
      { key: 'window', label: 'Janela de análise (ticks)', type: 'number', default: 50, min: 10, max: 500, step: 10 },
      { key: 'threshold', label: 'Ticks sem aparecer → entra', type: 'number', default: 15, min: 5, max: 50 },
      { key: 'stake', label: 'Stake (override)', type: 'number', default: 1, min: 0.35, step: 0.1 },
      { key: 'duration', label: 'Duração (ticks)', type: 'number', default: 1, min: 1, max: 5 },
    ],

    _state: new Map(),

    aoIniciar(ctx) {
      this._state.set(ctx.instanceId, { lastDigits: [], lastEntryTick: 0 });
      ctx.log('Pronto para analisar dígitos.');
    },

    aoReceberTick(ctx, tick) {
      const st = this._state.get(ctx.instanceId);
      if (!st || !tick.quote) return;
      const digit = parseInt(String(tick.quote).slice(-1), 10);
      if (isNaN(digit)) return;
      st.lastDigits.push(digit);
      if (st.lastDigits.length > ctx.params.window) st.lastDigits = st.lastDigits.slice(-ctx.params.window);

      if (st.lastDigits.length < ctx.params.window) return;
      if (Date.now() - st.lastEntryTick < 5000) return;

      // Conta há quantos ticks cada dígito não aparece
      const lastSeen = new Array(10).fill(-1);
      for (let i = 0; i < st.lastDigits.length; i++) {
        const d = st.lastDigits[st.lastDigits.length - 1 - i];
        if (lastSeen[d] === -1) lastSeen[d] = i;
      }
      // Dígito mais "frio" (mais tempo sem aparecer)
      let coldDigit = 0, coldTicks = -1;
      for (let d = 0; d < 10; d++) {
        if (lastSeen[d] > coldTicks) { coldTicks = lastSeen[d]; coldDigit = d; }
      }

      if (coldTicks >= ctx.params.threshold) {
        st.lastEntryTick = Date.now();
        ctx.log(`Dígito frio: ${coldDigit} (sem aparecer há ${coldTicks} ticks). Entrando.`);
        ctx.comprarContrato({
          contract_type: 'DIGITMATCH',
          duration: ctx.params.duration,
          duration_unit: 't',
          barrier: String(coldDigit),
        }, { stake: ctx.params.stake }).catch(e => ctx.log('Falha: ' + e.message, 'error'));
      }
    },

    aoResultadoContrato(ctx, r) {
      ctx.log(`Dígito: ${r.isWin ? 'ACERTOU' : 'ERROU'}`);
    },
  },

  // ────────────────────────────────────────────────────────────
  // 3. Odd/Even — Paridade
  // ────────────────────────────────────────────────────────────
  {
    id: 'odd-even-streak',
    nome: 'Odd/Even — Sequência',
    descricao: 'Após N dígitos pares (ou ímpares) consecutivos, aposta que o próximo será o oposto (reversão de paridade). Conservador, alta taxa de acerto.',
    icone: '⚖️',
    simbolos: ['R_10', 'R_25', 'R_50', 'R_75', 'R_100'],
    risco: 'low',
    schema: [
      { key: 'streakLen', label: 'Sequência mínima (N)', type: 'number', default: 4, min: 2, max: 10 },
      { key: 'duration', label: 'Duração (ticks)', type: 'number', default: 1, min: 1, max: 5 },
      { key: 'cooldownTicks', label: 'Cooldown (ticks)', type: 'number', default: 5, min: 0, max: 50 },
    ],

    _state: new Map(),

    aoIniciar(ctx) {
      this._state.set(ctx.instanceId, { lastDigits: [], ticksSinceEntry: 999 });
      ctx.log('Aguardando sequência de paridade...');
    },

    aoReceberTick(ctx, tick) {
      const st = this._state.get(ctx.instanceId);
      if (!st) return;
      const digit = parseInt(String(tick.quote).slice(-1), 10);
      if (isNaN(digit)) return;
      st.lastDigits.push(digit);
      if (st.lastDigits.length > 20) st.lastDigits = st.lastDigits.slice(-20);

      st.ticksSinceEntry++;
      if (st.lastDigits.length < ctx.params.streakLen) return;
      if (st.ticksSinceEntry < ctx.params.cooldownTicks) return;

      // Verifica os últimos N dígitos
      const recent = st.lastDigits.slice(-ctx.params.streakLen);
      const allOdd  = recent.every(d => d % 2 === 1);
      const allEven = recent.every(d => d % 2 === 0);

      if (allOdd || allEven) {
        st.ticksSinceEntry = 0;
        // Aposta no oposto
        const contractType = allOdd ? 'DIGITEVEN' : 'DIGITODD';
        ctx.log(`Sequência de ${ctx.params.streakLen} ${allOdd ? 'ímpares' : 'pares'} — entrando contrário.`);
        ctx.comprarContrato({
          contract_type: contractType,
          duration: ctx.params.duration,
          duration_unit: 't',
        }).catch(e => ctx.log('Falha: ' + e.message, 'error'));
      }
    },
  },

  // ────────────────────────────────────────────────────────────
  // 4. Martingale Clássico — CALL/PUT após N derrotas
  // ────────────────────────────────────────────────────────────
  {
    id: 'martingale-classic',
    nome: 'Martingale Clássico',
    descricao: 'Após N derrotas consecutivas na mesma direção, entra com Martingale. Aposta na reversão após sequência adversa. Aggressivo, exige stop loss bem definido.',
    icone: '⚡',
    simbolos: ['R_75', 'R_100', '1HZ75V', '1HZ100V'],
    risco: 'high',
    schema: [
      { key: 'lossesTrigger', label: 'Derrotas seguidas p/ entrar', type: 'number', default: 3, min: 1, max: 10 },
      { key: 'direction', label: 'Direção', type: 'select', default: 'CALL',
        options: [{ value: 'CALL', label: 'CALL (Rise)' }, { value: 'PUT', label: 'PUT (Fall)' }] },
      { key: 'duration', label: 'Duração (ticks)', type: 'number', default: 1, min: 1, max: 5 },
      { key: 'maxEntries', label: 'Máximo de entradas por sessão', type: 'number', default: 5, min: 1, max: 50 },
    ],

    _state: new Map(),

    aoIniciar(ctx) {
      this._state.set(ctx.instanceId, { consecutiveLosses: 0, entries: 0 });
      ctx.log('Aguardando sequência de derrotas...');
    },

    aoReceberTick(ctx, tick) {
      // Não age em tick — só após resultado
    },

    aoResultadoContrato(ctx, r) {
      const st = this._state.get(ctx.instanceId);
      if (!st) return;
      if (r.isWin) {
        st.consecutiveLosses = 0;
      } else {
        st.consecutiveLosses++;
        if (st.consecutiveLosses >= ctx.params.lossesTrigger && st.entries < ctx.params.maxEntries) {
          st.entries++;
          st.consecutiveLosses = 0; // reseta após entrada
          ctx.log(`${ctx.params.lossesTrigger} derrotas seguidas — entrando ${ctx.params.direction}.`);
          ctx.comprarContrato({
            contract_type: ctx.params.direction,
            duration: ctx.params.duration,
            duration_unit: 't',
          }).catch(e => ctx.log('Falha: ' + e.message, 'error'));
        } else if (st.entries >= ctx.params.maxEntries) {
          ctx.log('Máximo de entradas atingido.', 'warn');
          ctx.parar('Máximo de entradas atingido');
        }
      }
    },
  },

];

// ──────────────────────────────────────────────────────────────
// API pública
// ──────────────────────────────────────────────────────────────
export function listBots() {
  return BOTS.map(b => ({
    id: b.id, nome: b.nome, descricao: b.descricao, icone: b.icone,
    simbolos: b.simbolos, risco: b.risco, schema: b.schema,
  }));
}

export function getBot(id) {
  return BOTS.find(b => b.id === id);
}

export function getBotSchema(id) {
  const bot = getBot(id);
  return bot?.schema || [];
}

export function defaultParams(id) {
  const bot = getBot(id);
  if (!bot?.schema) return {};
  const params = {};
  for (const field of bot.schema) params[field.key] = field.default;
  return params;
}

// README inline para registrar novo bot (usado por ui.js em tooltip)
export const REGISTRATION_HELP = `
Para adicionar um novo bot:
1. Edite js/bots-library.js
2. Adicione um novo objeto ao array BOTS com id, nome, schema, e hooks
3. A UI e o motor detectam automaticamente
`;
