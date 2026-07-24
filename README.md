# ⟡ PontoBots v2

Plataforma web completa de trading manual e automatizado (bots) para a corretora [Deriv](https://deriv.com).

**Acesse:** https://julayjb.github.io/pontobots-v2/

## Funcionalidades

- 📊 **Dashboard** — KPIs de saldo, P&L diário/semanal/mensal, curva de equity
- 🔌 **Conexão** — OAuth 2.0 + PKCE com a Deriv
- 🌐 **Mercados** — Catálogo completo de símbolos (forex, sintéticos, cripto, commodities)
- 📈 **Gráficos** — Candlestick, linha e Heikin-Ashi com lightweight-charts
- 🔢 **Dígitos** — Estatística e heatmap de dígitos, compra de contratos digitais
- 🤖 **Bots** — Catálogo de bots automatizados (expansível), gestão financeira integrada
- 💰 **Gestão** — Martingale, Soros, Fibonacci, D'Alembert, stop loss/take profit
- 🛡️ **Virtual Loss** — Proteção contra perdas consecutivas
- 📋 **Trades & Logs** — Histórico completo

## Arquitetura

```
index.html              ← SPA (Single Page Application)
├── callback/index.html  ← Callback OAuth
├── css/styles.css       ← Estilos escuros (tema cyberpunk)
└── js/
    ├── main.js          ← Bootstrap
    ├── state.js         ← Estado global (observável)
    ├── deriv-api.js     ← Integração Deriv (OAuth + WS + REST)
    ├── bots-library.js  ← Catálogo de bots
    ├── bots-engine.js   ← Motor de automação
    ├── charts.js        ← Gráficos (lightweight-charts)
    └── ui.js            ← Interface completa
```

## Stack

- **Frontend:** HTML5 + CSS3 + JavaScript (ES Modules) — zero dependências de build
- **Gráficos:** [Lightweight Charts](https://github.com/tradingview/lightweight-charts) (TradingView)
- **Backend:** Deriv API (WebSocket + REST)
- **Auth:** OAuth 2.0 + PKCE (sem servidor intermediário)
- **Deploy:** GitHub Pages

## Desenvolvimento

```bash
# Servir localmente
python3 -m http.server 8080
# ou
npx serve
```

## Licença

MIT
