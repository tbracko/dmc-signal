// ==============================================================================
// DMS — playbook.js  (v5.51, 2026-07-23)
// ==============================================================================
// Second entry engine: data-mined candle setups, run ALONGSIDE the retest engine.
// Detection is pure (no I/O) — bot.js owns execution. NOT wired into the dashboard
// app on purpose (single-executor rule after the Jul-09 ghost-instance incident).
//
// Provenance (trade-playbook-2026-07-23.md, playbook-validate.js):
//   TBL trend-breakout long — 1H close > 20-bar high, body ≥0.8×ATR, close in top
//       30% of range, EMA20>EMA50 & close>EMA20. SL 1×ATR, TP 2×ATR.
//       crude: +0.33R/trade ×72 (5/7 months+), CL=F 2024/25/26 all positive.
//       xyz100: +0.26R ×85. Sensitivity flat across body 0.5-1.0 × lookback 15-30.
//   DBL dip-buy long (crude only) — mom4 ≤ −1.5×ATR + lower wick ≥0.3×ATR.
//       SL 1×ATR, TP 4×ATR (only exit tune that held OOS). +0.36R ×133, 7/7 months+
//       on xyz:CL (venue-specific: flat on CL=F 2024 — hence auto-bench below).
//   Shorts (TBS) and BTC: NOT enabled — TBS lumpy (−1R avg Jul, negative 2025 ext),
//   BTC fee-dead at 1H (8.6bp RT). See reports before enabling anything new.
//
// Risk: PLAYBOOK_RISK_PCT (default 2) % of equity per trade, SL = 1×ATR.
// Auto-bench: per setup (coin+tag), if the last BENCH_WINDOW closed playbook
// trades sum ≤ BENCH_MIN_SUMR, the setup disables itself + Telegram alert.
// Kill switch: env PLAYBOOK=off.
// ==============================================================================

const PB_PARAMS = {
  lookback: 20,        // breakout window (bars)
  minBody: 0.8,        // conviction body, ×ATR
  minLoc: 0.7,         // close position in bar range (long: ≥0.7)
  dipMom4: -1.5,       // DBL: 4-bar momentum ≤ this, ×ATR
  dipWick: 0.3,        // DBL: lower wick ≥ this, ×ATR
  slMult: 1.0,         // stop = 1×ATR
  cooldownBars: 4,     // per setup per coin
  maxHoldHours: 48,    // alert-only horizon (matches backtest window)
  riskPct: parseFloat(process.env.PLAYBOOK_RISK_PCT || '2'),
  benchWindow: 20,
  benchMinSumR: -8,
  notionalCapMult: 6,  // hard cap: notional ≤ 6× equity
};

// Per-asset enabled setups. tp = target multiple of ATR.
const PB_COINS = {
  crude:  { TBL: { tp: 2 }, DBL: { tp: 4 } },
  xyz100: { TBL: { tp: 2 } },
};

function wilderATR(c, p = 14) {
  const atr = [c[0].h - c[0].l];
  for (let i = 1; i < c.length; i++) {
    const tr = Math.max(c[i].h - c[i].l, Math.abs(c[i].h - c[i - 1].c), Math.abs(c[i].l - c[i - 1].c));
    atr.push((atr[i - 1] * (p - 1) + tr) / p);
  }
  return atr;
}
function emaArr(vals, p) {
  const k = 2 / (p + 1); let e = vals[0];
  return vals.map(x => (e = x * k + e * (1 - k)));
}

// Evaluate the LAST bar of `c` (caller must pass CLOSED 1H bars only — the
// forming-bar bug class from the retest engine must not be repeated here).
// Returns [{tag, dir, entry, sl, tp, atr, barT}] — usually 0 or 1 signals.
function detectPlaybook(coinId, c) {
  const conf = PB_COINS[coinId];
  if (!conf) return [];
  const n = c.length;
  if (n < 121) return [];
  const P = PB_PARAMS;
  const atr = wilderATR(c);
  const closes = c.map(k => k.c);
  const e20 = emaArr(closes, 20), e50 = emaArr(closes, 50);
  const i = n - 1, k = c[i], A = atr[i];
  if (!(A > 0)) return [];
  let hi = -Infinity;
  for (let j = i - P.lookback; j < i; j++) if (c[j].h > hi) hi = c[j].h;
  const body = (k.c - k.o) / A;
  const rng = k.h - k.l;
  const loc = rng > 0 ? (k.c - k.l) / rng : 0.5;
  const mom4 = (k.c - c[i - 4].c) / A;
  const lw = (Math.min(k.o, k.c) - k.l) / A;
  const out = [];
  if (conf.TBL && k.c > hi && body >= P.minBody && loc >= P.minLoc && e20[i] > e50[i] && k.c > e20[i]) {
    out.push({ tag: 'TBL', dir: 'LONG', entry: k.c, sl: k.c - P.slMult * A, tp: k.c + conf.TBL.tp * A, atr: A, barT: k.t });
  }
  if (conf.DBL && mom4 <= P.dipMom4 && lw >= P.dipWick) {
    out.push({ tag: 'DBL', dir: 'LONG', entry: k.c, sl: k.c - P.slMult * A, tp: k.c + conf.DBL.tp * A, atr: A, barT: k.t });
  }
  return out;
}

module.exports = { PB_PARAMS, PB_COINS, detectPlaybook };
