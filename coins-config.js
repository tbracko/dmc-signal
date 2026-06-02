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
//   equityPct ratios (v5.33):
//     BTC   1.00  (100% of equity) — flagship asset; raised from 0.50 to hit 1% risk intent
//     HYPE  0.25  (25%)            — highest vol alt, smallest allocation
//     SP500 2.00  (200%)           — low vol TradFi index; raised from 1.00, cap now > equity
//     GOLD  0.00  (DISABLED v5.31) — lost in every window; crude replaces the commodity slot
//     CRUDE 0.30  (30%)            — high-vol energy commodity; raised from 0.20 after live validation (v5.33)
//
//   At $1K equity:  BTC $1,000, HYPE $250, SP500 $2,000, CRUDE $300
//   At $5K equity:  BTC $5,000, HYPE $1,250, SP500 $10,000, CRUDE $1,500
//
// Edit only this file when adjusting:
//   - equityPct per-coin allocation
//   - per-coin minRR / minStopPct / feeEst
//   - exchange or apiSym mappings
//   - isHIP3 flag
//
// Prior version notes:
//   v5.33 (2026-06-02): CRUDE SCALE-UP — equityPct 0.20 → 0.30. Crude went live 2026-05-25
//     and hit the validation trigger: 12 closed round-trips, 58.3% win (7W/5L), PF 1.38,
//     expectancy +$0.16/trade, net +$1.90, avg win $1.02 ≈ avg loss −$1.04, traded both
//     directions profitably, no trade hit the 3% max-loss gate. Live edge slightly beats
//     backtest (58% vs 57%). Deliberate half-step (not straight to GOLD's old 0.40) given
//     the thin ~1-week sample; re-validate with counterfactual.js at 20+ closed trades
//     before any further raise. Synced into dms-v53.html COINS object.
//   v5.32 (2026-05-31): RAISE CAPS — SP500 equityPct 1.00 → 2.00, BTC 0.50 → 1.00.
//     Rationale (risk_caps_snapshot_2026-05-31.md): at current ~$1,016 equity every
//     active cap clamps per-trade risk below the 1% RISK_PCT design intent ($10.16).
//     SP500 and BTC were both at 50% of intent ($5.08/trade). These changes bring
//     both to exactly 1% design risk per trade. SP500's cap now exceeds equity, so
//     at minStop 0.5% risk is governed purely by RISK_PCT, not the notional cap.
//     SP500 is the only asset with meaningful bot fills (30d: 17 rt / 70.6% wr /
//     +$7.34). BTC has zero bot fills in 30d (all BTC activity is manual), so the
//     BTC change is theoretical until BTC bot signals fire. Daily-loss limit left
//     at 3% — not changed in this pass. HYPE/CRUDE caps unchanged.
//   v5.31 (2026-05-22): GOLD DISABLED. Set gold equityPct 0.40 → 0. Rationale:
//     live bot P&L showed gold losing in every window (30d −$23.61 / 14% win,
//     60d −$22.54 / 25%, 90d −$38.95 / 27%) despite five prior tuning passes
//     (v5.17/5.19/5.24/5.27/5.28). Crude (v5.30) now covers the commodity slot
//     and backtested materially better (57% vs 43% raw win). equityPct 0 is now
//     the canonical OFF switch: bot.js executeTrade early-returns when
//     equityPct is not > 0, so the asset is still scanned and shown on the
//     dashboard (watch mode) but never auto-traded. Re-enable by restoring 0.40.
//     NOTE: getMaxNotional returns 0 for gold now, so daily-report.js will tag
//     any residual gold fills as 'unknown' source rather than bot/manual.
//   v5.30 (2026-05-22): NEW ASSET — CRUDE (xyz:CL, WTI crude perp on the xyz HIP-3
//     dex). Added after a diversification + edge study:
//       - Correlation: crude is near-zero/negatively correlated with the whole
//         book (vs BTC -0.30, GOLD -0.20, SP500 -0.72 over the sample) — genuine
//         diversification, unlike SILVER (0.87 to GOLD) or NVDA (0.69 to SP500).
//       - Liquidity: deepest market on the xyz dex (~$900M/24h, ~5× SP500).
//       - Backtest (raw-pattern, 7w, gating removed, identical for all coins):
//         crude resolved the Retest pattern BETTER than GOLD — 57% win vs 43%,
//         PF 0.99 vs 0.57, TP1/TP2 follow-through 57%/33% (≈ GOLD's 56%/34%).
//         Full-filter replay produced 0 trades for ALL assets over the window
//         (15m retention only ~7w) — edge not yet live-validated; re-run
//         counterfactual.js once crude has real fills.
//     Config: HIP-3 commodity tuning mirrored from GOLD (minRR 1.2, feeEst 0.12,
//       minStopPct 0.005, breakDistFloorPct 0.0008, minBreakCloses 1).
//       equityPct 0.20 — half of GOLD: conservative start for a new, higher-vol
//       (~68% ann), not-yet-validated asset. Raise after real fills confirm edge.
//       Protective filters (signals.js): CHOP_FILTER enabled (ADX 18, GOLD-style),
//       MAX_HOLD_HOURS 36, EXHAUSTION_THRESHOLDS {3.0, 5.0} (looser than GOLD's
//       {2.0,3.5} because crude's natural 48h moves are larger). NOTE: no session
//       filter — crude trades 24/7. Watch the weekly EIA inventory print
//       (Wed ~14:30 UTC) which spikes crude inside US hours.
//   v5.29 (2026-05-21): Two improvements from counterfactual testing (30d, 29 trades):
//     1. BTC minBreakBodyPct 0.008 (0.8%) — break impulse filter. detectRetest now
//        rejects setups where the largest directional body between break and retest
//        is below this threshold. Filters range-bottom entries where the "break" was
//        just consolidation noise. Counterfactual: +$7.06 net (4 losses avoided,
//        2 marginal wins lost). BTC-only — SP500/GOLD have smaller natural bodies.
//     2. Level-based SL hard floor in dms() — if the level-based SL (before the
//        minStopPct widening) is within minStopPct of entry, skip the signal entirely.
//        Widening the SL past the level distorts R:R and places the stop at a
//        meaningless price. Counterfactual: +$8.04 net, zero winners blocked.
//   v5.28 (2026-05-17): GOLD retest tuning — breakDistFloorPct 0.0015 → 0.0008,
//                       minBreakCloses 2 → 1 (mirrors SP500 config). 1H ATR is
//                       $4.20 (0.09%) but the 0.15% floor yielded breakDist=$6.81
//                       (1.7× ATR), making entries unreachable. New breakDist=$3.63
//                       (0.86× ATR) — still filters noise but allows realistic entries.
//                       May 16 had a $180 flash crash wick that didn't trigger because
//                       the close recovered; this change helps catch follow-through moves.
//   v5.27 (2026-05-16): Two tuning changes from daily trade-summary analysis:
//     BTC minStopPct 0.7% → 1.0% — counterfactual over 60 days showed 5 SL hits
//       clustered at 0.87–0.97% ($10.72 saved). 0.8% saved nothing. No TP blocked.
//     GOLD minRR 1.5 → 1.2 — high minRR was the primary reason GOLD hadn't
//       triggered since May 5 despite 2–3% daily moves. 1.2 matches SP500.
//       Session filters + minBreakCloses=2 remain as safety nets.
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
//   minBreakBodyPct    — minimum break candle body as fraction of price.
//                        Default null (disabled). When set, detectRetest rejects
//                        setups where the largest directional body between the
//                        break bar and the retest bar is below this threshold.
//                        v5.29 (2026-05-21): added for BTC at 0.008 (0.8%).
//                        Counterfactual over 30 days: +$7.06 net (4 losses
//                        avoided, 2 marginal wins lost). Filters range-bottom
//                        shorts where the "break" is just consolidation noise.
//                        NOT applied to SP500/GOLD — their naturally smaller
//                        candle bodies mean this filter blocks too many winners.

const COINS = {
  bitcoin:     { id:'bitcoin',     label:'BTC',    apiSym:'BTCUSDT',    asset:'BTC',        exchange:'binance',     minRR: 1.0, feeEst: 0.05, minStopPct: 0.010, equityPct: 1.00, isHIP3: false, minBreakBodyPct: 0.008 },
  hyperliquid: { id:'hyperliquid', label:'HYPE',   apiSym:'HYPEUSDT',   asset:'HYPE',       exchange:'bybit',       minRR: 1.0, feeEst: 0.05, minStopPct: 0.005, equityPct: 0.25, isHIP3: false },
  sp500:       { id:'sp500',       label:'S&P500', apiSym:'xyz:SP500',  asset:'xyz:SP500',  exchange:'hyperliquid', minRR: 1.2, feeEst: 0.10, minStopPct: 0.005, equityPct: 2.00, isHIP3: true,  breakDistFloorPct: 0.0008, minBreakCloses: 1 },
  gold:        { id:'gold',        label:'GOLD',   apiSym:'xyz:GOLD',   asset:'xyz:GOLD',   exchange:'hyperliquid', minRR: 1.2, feeEst: 0.12, minStopPct: 0.005, equityPct: 0.00, isHIP3: true,  breakDistFloorPct: 0.0008, minBreakCloses: 1 }, // v5.31: DISABLED (equityPct 0 = no auto-trade). Lost in every window; crude took the commodity slot. Still scanned/displayed (watch mode). Set equityPct back to 0.40 to re-enable.
  crude:       { id:'crude',       label:'CRUDE',  apiSym:'xyz:CL',     asset:'xyz:CL',     exchange:'hyperliquid', minRR: 1.2, feeEst: 0.12, minStopPct: 0.005, equityPct: 0.30, isHIP3: true,  breakDistFloorPct: 0.0008, minBreakCloses: 1 }, // v5.33 (2026-06-02): 0.20→0.30 after live validation — 12 closed trades, 58% win, PF 1.38, +$1.90 net. Half-step; re-validate at 20+ trades before going to 0.40.
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
