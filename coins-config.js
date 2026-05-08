// DMS — coins-config.js (shared source of truth)
//
// Per-coin sizing, fees, exchange routing, and manual-trade detection threshold.
// Imported by bot.js, daily-report.js, and backtester/config.js so a maxNotional
// change here propagates everywhere — eliminates the v5.17 GOLD drift bug where
// daily-report.js mis-classified $300–$525 GOLD trades because it still had the
// pre-v5.17 cap of $500.
//
// Edit only this file when adjusting:
//   - maxNotional caps
//   - per-coin minRR / minStopPct / feeEst
//   - exchange or apiSym mappings
//   - isHIP3 flag
//
// Version notes (mirror bot.js changelog for the values most likely to drift):
//   v5.17 (2026-05-06): GOLD maxNotional 500 → 300, feeEst 0.10 → 0.12.
//   v5.5  (2026-04-16): HYPE maxNotional 200 → 100; SP500 minRR 1.5 → 1.2.
//   v5.3  (2026-04-13): BTC re-enabled at $200 (was 0).

const COINS = {
  bitcoin:     { id:'bitcoin',     label:'BTC',    apiSym:'BTCUSDT',    asset:'BTC',        exchange:'binance',     minRR: 1.0, feeEst: 0.05, minStopPct: 0.007, maxNotional: 200, isHIP3: false },
  hyperliquid: { id:'hyperliquid', label:'HYPE',   apiSym:'HYPEUSDT',   asset:'HYPE',       exchange:'bybit',       minRR: 1.0, feeEst: 0.05, minStopPct: 0.005, maxNotional: 100, isHIP3: false },
  sp500:       { id:'sp500',       label:'S&P500', apiSym:'xyz:SP500',  asset:'xyz:SP500',  exchange:'hyperliquid', minRR: 1.2, feeEst: 0.10, minStopPct: 0.005, maxNotional: 500, isHIP3: true  },
  gold:        { id:'gold',        label:'GOLD',   apiSym:'xyz:GOLD',   asset:'xyz:GOLD',   exchange:'hyperliquid', minRR: 1.5, feeEst: 0.12, minStopPct: 0.005, maxNotional: 300, isHIP3: true  },
};

// Tag a fill as MANUAL when its opening notional > maxNotional × this multiplier.
// Bot hard-blocks at 1.10×, so anything > 1.05× cannot have been bot-generated.
// bot.js still respects an env override (process.env.MANUAL_NOTIONAL_MULT); this
// is the default both bot.js and daily-report.js fall back to.
const MANUAL_NOTIONAL_MULT = 1.05;

// Convenience: { 'BTC':200, 'HYPE':100, 'xyz:SP500':500, 'xyz:GOLD':300 }
// Used by daily-report.js for per-asset cap lookup.
const MAX_NOTIONAL_BY_ASSET = Object.fromEntries(
  Object.values(COINS).map(c => [c.asset, c.maxNotional])
);

module.exports = { COINS, MANUAL_NOTIONAL_MULT, MAX_NOTIONAL_BY_ASSET };
