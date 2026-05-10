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
//   v5.24 (2026-05-10): SP500 retest tuning — breakDistFloorPct 0.0015 → 0.0008 and
//                       minBreakCloses 2 → 1. The 0.15% floor was crypto-calibrated:
//                       at $7,400 it yields breakDist = $11.06, which is 1.6× the 15m
//                       ATR and 0.9× the 1H ATR, making LTF retests nearly impossible
//                       to trigger (May 9 1H breakout cleared by $11.0 — missed by
//                       $0.06). Two-close confirmation also blocked an otherwise
//                       valid 4H setup (break 12:00, retest 16:00, conviction 20:00 —
//                       only 1 close held between break and retest). GOLD keeps the
//                       2-close gate (its default) — the filter was added for GOLD
//                       false breakdowns and should stay there.
//   v5.19 (2026-05-08): GOLD maxNotional 300 → 200. May 1-7 GOLD lost $10.10 vs $1.75
//                       wins (59% of the week's losses on 1 asset). Match BTC's $200 cap
//                       until GOLD shows a green week. Cuts per-SL damage from ~$5 to ~$3.3.
//   v5.17 (2026-05-06): GOLD maxNotional 500 → 300, feeEst 0.10 → 0.12.
//   v5.5  (2026-04-16): HYPE maxNotional 200 → 100; SP500 minRR 1.5 → 1.2.
//   v5.3  (2026-04-13): BTC re-enabled at $200 (was 0).
//
// Optional retest-tuning fields (consumed by signals.js detectRetest):
//   breakDistFloorPct  — minimum "break" distance as a fraction of level price.
//                        Default 0.0015 (0.15%). Override per-asset when ATR is
//                        small relative to price (e.g. SP500 LTFs).
//   minBreakCloses     — number of closes that must hold beyond the level between
//                        the break bar and the retest bar. Default 2 (filters
//                        single-candle false breakdowns). Lower to 1 for assets
//                        where break-to-retest can happen in a single bar.

const COINS = {
  bitcoin:     { id:'bitcoin',     label:'BTC',    apiSym:'BTCUSDT',    asset:'BTC',        exchange:'binance',     minRR: 1.0, feeEst: 0.05, minStopPct: 0.007, maxNotional: 200, isHIP3: false },
  hyperliquid: { id:'hyperliquid', label:'HYPE',   apiSym:'HYPEUSDT',   asset:'HYPE',       exchange:'bybit',       minRR: 1.0, feeEst: 0.05, minStopPct: 0.005, maxNotional: 100, isHIP3: false },
  sp500:       { id:'sp500',       label:'S&P500', apiSym:'xyz:SP500',  asset:'xyz:SP500',  exchange:'hyperliquid', minRR: 1.2, feeEst: 0.10, minStopPct: 0.005, maxNotional: 500, isHIP3: true,  breakDistFloorPct: 0.0008, minBreakCloses: 1 },
  gold:        { id:'gold',        label:'GOLD',   apiSym:'xyz:GOLD',   asset:'xyz:GOLD',   exchange:'hyperliquid', minRR: 1.5, feeEst: 0.12, minStopPct: 0.005, maxNotional: 200, isHIP3: true  },
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
