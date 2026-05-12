// DMS — coins-config.js (shared source of truth)
//
// Per-coin sizing, fees, exchange routing, and manual-trade detection threshold.
// Imported by bot.js, daily-report.js, and backtester/config.js.
//
// v5.25 (2026-05-12): EQUITY-PROPORTIONAL SIZING
//   Replaced static maxNotional dollar caps with equityPct — a fraction of account
//   equity. The bot computes maxNotional dynamically:  equity × equityPct.
//   No floors, no ceilings — scales automatically as the account grows.
//   Daily loss limit also scales: 3% of equity (was flat -$10).
//
//   equityPct ratios:
//     BTC   0.50  (50% of equity)  — moderate vol, flagship asset
//     HYPE  0.25  (25%)            — highest vol alt, smallest allocation
//     SP500 1.00  (100%)           — low vol TradFi index, largest allocation
//     GOLD  0.40  (40%)            — moderate vol commodity
//
//   At $1K equity:  BTC $500, HYPE $250, SP500 $1,000, GOLD $400
//   At $5K equity:  BTC $2,500, HYPE $1,250, SP500 $5,000, GOLD $2,000
//
// Edit only this file when adjusting:
//   - equityPct per-coin allocation
//   - per-coin minRR / minStopPct / feeEst
//   - exchange or apiSym mappings
//   - isHIP3 flag
//
// Prior version notes:
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
//   v5.19 (2026-05-08): GOLD maxNotional 300 → 200 (now superseded by equityPct 0.40).
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
  bitcoin:     { id:'bitcoin',     label:'BTC',    apiSym:'BTCUSDT',    asset:'BTC',        exchange:'binance',     minRR: 1.0, feeEst: 0.05, minStopPct: 0.007, equityPct: 0.50, isHIP3: false },
  hyperliquid: { id:'hyperliquid', label:'HYPE',   apiSym:'HYPEUSDT',   asset:'HYPE',       exchange:'bybit',       minRR: 1.0, feeEst: 0.05, minStopPct: 0.005, equityPct: 0.25, isHIP3: false },
  sp500:       { id:'sp500',       label:'S&P500', apiSym:'xyz:SP500',  asset:'xyz:SP500',  exchange:'hyperliquid', minRR: 1.2, feeEst: 0.10, minStopPct: 0.005, equityPct: 1.00, isHIP3: true,  breakDistFloorPct: 0.0008, minBreakCloses: 1 },
  gold:        { id:'gold',        label:'GOLD',   apiSym:'xyz:GOLD',   asset:'xyz:GOLD',   exchange:'hyperliquid', minRR: 1.5, feeEst: 0.12, minStopPct: 0.005, equityPct: 0.40, isHIP3: true  },
};

// Daily loss limit as fraction of equity (3%). Bot computes: equity × DAILY_LOSS_PCT.
const DAILY_LOSS_PCT = 0.03;

// Tag a fill as MANUAL when its opening notional > dynamic maxNotional × this multiplier.
// Bot hard-blocks at 1.10×, so anything > 1.05× cannot have been bot-generated.
// bot.js still respects an env override (process.env.MANUAL_NOTIONAL_MULT); this
// is the default both bot.js and daily-report.js fall back to.
const MANUAL_NOTIONAL_MULT = 1.05;

// Helper: compute dynamic maxNotional for an asset given current equity.
// Used by bot.js (live trading) and daily-report.js (trade classification).
function getMaxNotional(coinOrAsset, equity) {
  let coin = coinOrAsset;
  if (typeof coinOrAsset === 'string') {
    coin = Object.values(COINS).find(c => c.asset === coinOrAsset || c.id === coinOrAsset);
  }
  if (!coin || !coin.equityPct) return 0;
  return equity * coin.equityPct;
}

// Convenience: build { 'BTC': maxNotional, ... } for a given equity.
// Replaces the old static MAX_NOTIONAL_BY_ASSET. daily-report.js calls this
// with the account equity at report time.
function getMaxNotionalByAsset(equity) {
  return Object.fromEntries(
    Object.values(COINS).map(c => [c.asset, getMaxNotional(c, equity)])
  );
}

module.exports = { COINS, DAILY_LOSS_PCT, MANUAL_NOTIONAL_MULT, getMaxNotional, getMaxNotionalByAsset };
