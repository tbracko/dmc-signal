// DMS — signals.js  (canonical signal-engine module)
//
// Single source of truth for the pure signal-detection functions:
//   dms(), detectRetest(), atr(), calcADX(), trendExhaustion48h(), nextMove()
// Plus level helpers (V-peaks, PDHL, fib, DMC), session boundaries, conviction
// helpers (rejection / strong-body-bounce / momentum / LTF alignment).
//
// Consumed by:
//   - bot.js (production trading bot) — v5.21+
//   - backtester/signals.js (re-exports this file)
//   - dms-v53.html (still copy-paste; planned in #6)
//
// Also exports the per-coin filter configs (CHOP_FILTER, MAX_HOLD_HOURS,
// FUNDING_EXIT_THRESHOLD, BREAKOUT_QUALITY, EXHAUSTION_THRESHOLDS) since they
// were defined alongside the signal functions historically. They could move to
// a dedicated trading-config.js later, but co-locating with the functions that
// reference them keeps tuning context together.
//
// Cross-references in comments (e.g. "v5.7", "v5.12") refer to the bot.js
// changelog and are preserved for traceability.
//
// v5.22.1 (2026-05-08): Wrapped in an IIFE. When this file loads in a browser via
// <script src="signals.js">, top-level `function fmt`, `function atr` etc. would
// otherwise become window globals — colliding with the dashboard's destructure
// `const { fmt } = window.DMSSignals` (same scope = redeclaration error).
// The IIFE keeps the function declarations private; only the UMD export escapes.

(function () {
'use strict';

function fmt(n){ return n>=1000 ? n.toLocaleString('en-US',{maximumFractionDigits:0}) : n.toFixed(2); }
function atr(c, p=14){
  // v5.7: guard against malformed candles (NaN h/l/c) or short arrays — previously a
  // single bad candle poisoned the ATR → SL placement fed NaN/undefined prices.
  if (!Array.isArray(c) || c.length < 2) return 0;
  const tr = c.slice(1).map((x,i)=>{
    const h=x.h, l=x.l, pc=c[i].c;
    if(!Number.isFinite(h) || !Number.isFinite(l) || !Number.isFinite(pc)) return null;
    return Math.max(h-l, Math.abs(h-pc), Math.abs(l-pc));
  }).filter(v => v != null && Number.isFinite(v));
  if (tr.length === 0) return 0;
  const slice = tr.slice(-p);
  const result = slice.reduce((s,v)=>s+v, 0) / slice.length;
  return Number.isFinite(result) ? result : 0;
}

// v5.12: ADX (Average Directional Index) — measures trend strength regardless of direction.
// ADX < 20 = weak/ranging market, 20-40 = trending, > 40 = strong trend.
// Used by the chop filter to skip entries on assets stuck in a range.
function calcADX(c, p = 14) {
  if (!Array.isArray(c) || c.length < p + 2) return 0;
  // +DM / -DM and True Range for each bar
  const dmPlus = [], dmMinus = [], trArr = [];
  for (let i = 1; i < c.length; i++) {
    const h = c[i].h, l = c[i].l, pc = c[i - 1].c, ph = c[i - 1].h, pl = c[i - 1].l;
    if (!Number.isFinite(h) || !Number.isFinite(l) || !Number.isFinite(pc) ||
        !Number.isFinite(ph) || !Number.isFinite(pl)) continue;
    const upMove = h - ph, downMove = pl - l;
    dmPlus.push(upMove > downMove && upMove > 0 ? upMove : 0);
    dmMinus.push(downMove > upMove && downMove > 0 ? downMove : 0);
    trArr.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  if (dmPlus.length < p) return 0;
  // Wilder smoothing (EMA-like with 1/p factor)
  let smTR = trArr.slice(0, p).reduce((a, b) => a + b, 0);
  let smDMp = dmPlus.slice(0, p).reduce((a, b) => a + b, 0);
  let smDMm = dmMinus.slice(0, p).reduce((a, b) => a + b, 0);
  const dxArr = [];
  for (let i = p; i < trArr.length; i++) {
    smTR = smTR - smTR / p + trArr[i];
    smDMp = smDMp - smDMp / p + dmPlus[i];
    smDMm = smDMm - smDMm / p + dmMinus[i];
    if (smTR === 0) continue;
    const diP = smDMp / smTR * 100;
    const diM = smDMm / smTR * 100;
    const diSum = diP + diM;
    if (diSum === 0) continue;
    dxArr.push(Math.abs(diP - diM) / diSum * 100);
  }
  if (dxArr.length < p) return dxArr.length > 0 ? dxArr[dxArr.length - 1] : 0;
  // Smooth DX into ADX (first ADX = average of first p DX values, then Wilder smooth)
  let adx = dxArr.slice(0, p).reduce((a, b) => a + b, 0) / p;
  for (let i = p; i < dxArr.length; i++) {
    adx = (adx * (p - 1) + dxArr[i]) / p;
  }
  return Number.isFinite(adx) ? adx : 0;
}

// v5.12: Chop filter configuration per coin.
// adxThreshold: below this ADX value, market is considered ranging → skip entry.
// lookbackBars: how many candles to feed into ADX calc (on the ENTRY timeframe).
// minTFWeight: only apply the chop filter on lower TFs (weight <= this). HTF entries
//   (1W/1D) are exempt because they rarely whipsaw on the same time horizon.
// enabled: master switch per coin. Currently only HYPE — expand to others as needed.
const CHOP_FILTER = {
  hyperliquid: { enabled: true,  adxThreshold: 20, lookbackBars: 30, minTFWeight: 3 }, // HYPE: 15m/1H/4H
  bitcoin:     { enabled: false, adxThreshold: 18, lookbackBars: 30, minTFWeight: 3 },
  sp500:       { enabled: false, adxThreshold: 18, lookbackBars: 30, minTFWeight: 3 },
  gold:        { enabled: true,  adxThreshold: 18, lookbackBars: 30, minTFWeight: 3 },
};

// v5.16: Time-based exit for stalled positions — close at market if no TP1 reached
// within maxHoldHours AND position is in drawdown. Prevents death-by-funding on
// range-bound entries (May 4 report: GOLD LONG held 48h, bled $5.61 at SL).
const MAX_HOLD_HOURS = {
  bitcoin:     24,  // BTC is volatile; if no TP1 in 24h while underwater, exit
  hyperliquid: 24,  // HYPE same
  sp500:       36,  // HIP-3 assets trend slower
  gold:        36,  // HIP-3 assets trend slower
};

// v5.16: Funding rate exit signal — if cumulative funding paid on a position exceeds
// this fraction of the entry notional AND position is in drawdown, close at market.
// Catches crowded trades bleeding via carry before they reach SL.
const FUNDING_EXIT_THRESHOLD = 0.0005; // 0.05% of notional

// v5.16: Range breakout quality filter — require the break distance to exceed
// the 48h range ATR ratio. If the "breakout" is just noise within a range, skip.
// breakMinRangeATR: break distance must be >= this × range ATR to qualify as genuine.
const BREAKOUT_QUALITY = {
  enabled: true,
  breakMinRangeATR: 0.7, // break must exceed 0.7× the range's size-to-ATR ratio
};

// v5.7: Trend-exhaustion detector — measures cumulative price move over trailing 48 hours
// using 4H candles (12 candles = 48h). Returns the signed percentage move from the close
// 48h ago to the current close. Positive = price went up, negative = price went down.
// Used by maybeAutoTrade to detect late-cycle entries and tighten stops or reduce size.
function trendExhaustion48h(h4Candles) {
  if (!Array.isArray(h4Candles) || h4Candles.length < 13) return { movePct: 0, highPct: 0, lowPct: 0 };
  const recent = h4Candles.slice(-13); // 12 intervals × 4h = 48h, +1 for the starting close
  const startClose = recent[0].c;
  const endClose = recent[recent.length - 1].c;
  if (!Number.isFinite(startClose) || !Number.isFinite(endClose) || startClose <= 0) return { movePct: 0, highPct: 0, lowPct: 0 };
  const movePct = (endClose - startClose) / startClose * 100;
  // Also track max excursion (peak-to-trough within the window) for a more nuanced view
  let highest = -Infinity, lowest = Infinity;
  for (let i = 1; i < recent.length; i++) {
    if (Number.isFinite(recent[i].h) && recent[i].h > highest) highest = recent[i].h;
    if (Number.isFinite(recent[i].l) && recent[i].l < lowest) lowest = recent[i].l;
  }
  const highPct = startClose > 0 ? (highest - startClose) / startClose * 100 : 0;
  const lowPct  = startClose > 0 ? (startClose - lowest) / startClose * 100 : 0;
  return { movePct, highPct, lowPct };
}

// v5.7: Per-coin exhaustion thresholds — configurable via COINS or environment
// tightenPct: tighten SL to 1.5% and halve size when directional move exceeds this
// skipPct:    skip entry entirely when directional move exceeds this
const EXHAUSTION_THRESHOLDS = {
  bitcoin:     { tightenPct: 3.0, skipPct: 5.0 },
  hyperliquid: { tightenPct: 5.0, skipPct: 8.0 },
  sp500:       { tightenPct: 2.0, skipPct: 3.5 },
  gold:        { tightenPct: 2.0, skipPct: 3.5 },
};

// v5.13: Fetch current predicted funding rate from Hyperliquid for HIP-3 (and standard) assets.
// Returns the per-8h funding rate as a decimal (e.g., 0.0003 = 0.03% per 8h).
// Positive rate = longs pay shorts; negative rate = shorts pay longs.
async function hlFundingRate(apiSym) {
  try {
    const isHIP3 = apiSym.startsWith('xyz:');
    const body = { type: 'metaAndAssetCtxs' };
    if (isHIP3) body.dex = 'xyz';
    const r = await fetch(HL_API + '/info', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (!r.ok) return null;
    const data = await r.json();
    // Response is [meta, assetCtxs[]] — meta.universe[i].name matches assetCtxs[i]
    const [meta, ctxs] = data;
    if (!meta || !meta.universe || !Array.isArray(ctxs)) return null;
    // HIP-3 universe names keep the 'xyz:' prefix (e.g., 'xyz:GOLD', 'xyz:SP500')
    const assetName = isHIP3 ? apiSym : apiSym.replace('USDT', '');
    const idx = meta.universe.findIndex(u => u.name === assetName);
    if (idx < 0 || !ctxs[idx]) return null;
    return parseFloat(ctxs[idx].funding);
  } catch (e) {
    console.warn(`hlFundingRate(${apiSym}):`, e.message);
    return null;
  }
}

function isSwingHigh(c, i, N=3){
  const bh = c[i].bh;
  for(let j=i-N; j<=i+N; j++){
    if(j===i || j<0 || j>=c.length) continue;
    if(c[j].bh >= bh) return false;
  }
  return true;
}
function isSwingLow(c, i, N=3){
  const bl = c[i].bl;
  for(let j=i-N; j<=i+N; j++){
    if(j===i || j<0 || j>=c.length) continue;
    if(c[j].bl <= bl) return false;
  }
  return true;
}
function detectFlippedLevel(c, formationIdx, originalType, levelPrice){
  const subsequent = c.slice(formationIdx + 1);
  const tol = levelPrice * 0.003;
  if(originalType === 'resistance'){
    const broke = subsequent.some(k => k.bl > levelPrice - tol && k.bh > levelPrice + tol);
    if(broke) return 'flipped_support';
  } else {
    const broke = subsequent.some(k => k.bh < levelPrice + tol && k.bl < levelPrice - tol);
    if(broke) return 'flipped_resistance';
  }
  return originalType;
}
function scoreLevel(c, i, type){
  let score = 0;
  const x = c[i];
  const range = x.h - x.l;
  const nextCandles = c.slice(i+1, i+4);
  if(type === 'resistance'){
    const closedLower = nextCandles.filter(k => k.c < x.bh).length;
    score += closedLower * 10;
    if(nextCandles.some(k => k.c < x.bh * 0.995)) score += 10;
  } else {
    const closedHigher = nextCandles.filter(k => k.c > x.bl).length;
    score += closedHigher * 10;
    if(nextCandles.some(k => k.c > x.bl * 1.005)) score += 10;
  }
  const wickUp = x.h - x.bh, wickDown = x.bl - x.l;
  const rejection = type === 'resistance' ? wickUp : wickDown;
  score += Math.min(rejection / range, 1) * 20;
  const prevCandles = c.slice(Math.max(0, i-20), i);
  const zone = range * 0.15;
  const touches = prevCandles.filter(k =>
    type === 'resistance'
      ? (k.h >= x.bh - zone && k.h <= x.bh + zone)
      : (k.l <= x.bl + zone && k.l >= x.bl - zone)
  ).length;
  score += Math.min(touches, 3) * 15;
  const approach = c.slice(Math.max(0, i-3), i);
  const directional = type === 'resistance'
    ? approach.every((k,j) => j === 0 || k.bh > approach[j-1].bh)
    : approach.every((k,j) => j === 0 || k.bl < approach[j-1].bl);
  if(directional) score += 10;
  return Math.round(score);
}
function classifyStrength(score){
  if(score >= 40) return 'strong';
  if(score >= 12) return 'med';
  return 'weak';
}
function countLevelTests(c, startIdx, bh, bl, type){
  const levelPrice = type === 'resistance' ? bh : bl;
  const zone = levelPrice * 0.010;
  const raw = c.slice(startIdx).filter(k =>
    type === 'resistance'
      ? k.bh >= levelPrice - zone
      : k.bl <= levelPrice + zone
  ).length;
  return Math.min(raw, 10);
}
function findVPeaks(c, tf){
  const n = c.length, L = [];
  const lookback = 2;
  const wickRatio = 0.25;
  for(let i = lookback; i < n - lookback; i++){
    const x = c[i];
    const range = x.h - x.l;
    if(range < x.c * 0.0001) continue;
    const wickUp   = x.h  - x.bh;
    const wickDown = x.bl - x.l;
    if(isSwingHigh(c, i, lookback)){
      let score = scoreLevel(c, i, 'resistance');
      const testCount = countLevelTests(c, i+1, x.bh, x.bl, 'resistance');
      const tested = testCount > 0;
      if(testCount >= 2) score = Math.round(score * 0.5);
      else if(testCount === 1) score = Math.round(score * 0.75);
      const strength = classifyStrength(score);
      const flippedTypeR = detectFlippedLevel(c, i, 'resistance', x.bh);
      L.push({
        price:x.bh, bh:x.bh, bl:x.bh*0.999,
        type:'resistance', flippedType:flippedTypeR,
        wickSize:wickUp, score, strength, tested, testCount,
        idx:i, tf, source:`V-High${wickUp>range*wickRatio?' (wick reject)':''}`
      });
    }
    if(isSwingLow(c, i, lookback)){
      let score = scoreLevel(c, i, 'support');
      const testCount = countLevelTests(c, i+1, x.bh, x.bl, 'support');
      const tested = testCount > 0;
      if(testCount >= 2) score = Math.round(score * 0.5);
      else if(testCount === 1) score = Math.round(score * 0.75);
      const strength = classifyStrength(score);
      const flippedTypeS = detectFlippedLevel(c, i, 'support', x.bl);
      L.push({
        price:x.bl, bh:x.bl*1.001, bl:x.bl,
        type:'support', flippedType:flippedTypeS,
        wickSize:wickDown, score, strength, tested, testCount,
        idx:i, tf, source:`V-Low${wickDown>range*wickRatio?' (wick reject)':''}`
      });
    }
  }
  return L;
}
function findPDHL(dCandles){
  if(!dCandles || dCandles.length < 3) return [];
  const prev = dCandles[dCandles.length-2];
  const prev2 = dCandles[dCandles.length-3];
  const levels = [];
  levels.push({ price:prev.bh, bh:prev.bh, bl:prev.bh*0.999, type:'resistance', strength:'strong', tested:false, source:'PDH', score:70, tf:'PDH/PDL' });
  levels.push({ price:prev.bl, bh:prev.bl*1.001, bl:prev.bl, type:'support', strength:'strong', tested:false, source:'PDL', score:70, tf:'PDH/PDL' });
  if(Math.abs(prev2.bh - prev.bh)/prev.bh > 0.005)
    levels.push({ price:prev2.bh, bh:prev2.h, bl:prev2.bh, type:'resistance', strength:'med', tested:false, source:'PDH-2', score:50, tf:'PDH/PDL' });
  if(Math.abs(prev2.bl - prev.bl)/prev.bl > 0.005)
    levels.push({ price:prev2.bl, bh:prev2.bl, bl:prev2.l, type:'support', strength:'med', tested:false, source:'PDL-2', score:50, tf:'PDH/PDL' });
  return levels;
}

// -- SESSION LEVELS ------------------------------------------------------------
function getSessionBoundaries(){
  const now = new Date();
  const londonOffset = (() => {
    const s = now.toLocaleString('en-GB',{timeZone:'Europe/London',hour:'numeric',hour12:false,timeZoneName:'short'});
    return (s.includes('BST') || new Date().toLocaleString('en',{timeZone:'Europe/London',timeZoneName:'short'}).includes('BST')) ? 1 : 0;
  })();
  const nyOffset = (() => {
    const s = new Date().toLocaleString('en',{timeZone:'America/New_York',timeZoneName:'short'});
    return s.includes('EDT') ? -4 : -5;
  })();
  return {
    asiaOpen:0, asiaClose:8,
    londonOpen:8-londonOffset, londonClose:16-londonOffset,
    nyOpen:9-nyOffset-5, nyClose:16-nyOffset-5,
    londonOffset, nyOffset
  };
}
function getCurrentSession(){
  const now = new Date();
  const h = now.getUTCHours() + now.getUTCMinutes()/60;
  const b = getSessionBoundaries();
  if(h>=b.asiaOpen && h<b.asiaClose) return 'ASIA';
  if(h>=b.londonOpen && h<b.londonClose) return 'LONDON';
  if(h>=b.nyOpen && h<b.nyClose) return 'NY';
  return 'AFTER_HOURS';
}
function getAsiaRange(candles15m){
  if(!candles15m || candles15m.length < 4) return null;
  const now = new Date();
  const todayMidnightUTC = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const asiaCloseUTC = todayMidnightUTC + 8 * 3600000;
  let asiaCandles = candles15m.filter(k => k.t >= todayMidnightUTC && k.t < asiaCloseUTC);
  if(asiaCandles.length < 2){
    const yestMidnight = todayMidnightUTC - 86400000;
    asiaCandles = candles15m.filter(k => k.t >= yestMidnight && k.t < yestMidnight+8*3600000);
    if(asiaCandles.length < 2) return null;
    return { high:Math.max(...asiaCandles.map(k=>k.bh)), low:Math.min(...asiaCandles.map(k=>k.bl)), complete:true, source:'yesterday' };
  }
  return { high:Math.max(...asiaCandles.map(k=>k.bh)), low:Math.min(...asiaCandles.map(k=>k.bl)), complete:getCurrentSession()!=='ASIA', source:'today' };
}
function getAsiaLevels(candles15m){
  const asia = getAsiaRange(candles15m);
  if(!asia || !asia.complete) return [];
  return [
    { price:asia.high, bh:asia.high, bl:asia.high*0.999, type:'resistance', strength:'strong', tested:false, score:75, tf:'SESSION', source:'Asia High' },
    { price:asia.low,  bh:asia.low*1.001, bl:asia.low,  type:'support',    strength:'strong', tested:false, score:75, tf:'SESSION', source:'Asia Low'  },
  ];
}
function getNYRange(candles15m){
  if(!candles15m || candles15m.length < 4) return null;
  const b = getSessionBoundaries();
  const now = new Date();
  const todayMidnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const nyOpen  = todayMidnight + b.nyOpen  * 3600000;
  const nyClose = todayMidnight + b.nyClose * 3600000;
  let ny = candles15m.filter(k => k.t >= nyOpen && k.t < nyClose);
  if(ny.length < 2){
    const yest = todayMidnight - 86400000;
    ny = candles15m.filter(k => k.t >= yest+b.nyOpen*3600000 && k.t < yest+b.nyClose*3600000);
    if(ny.length < 2) return null;
    return { high:Math.max(...ny.map(k=>k.bh)), low:Math.min(...ny.map(k=>k.bl)), complete:true, source:'yesterday' };
  }
  const cur = getCurrentSession();
  return { high:Math.max(...ny.map(k=>k.bh)), low:Math.min(...ny.map(k=>k.bl)), complete:cur==='AFTER_HOURS'||cur==='ASIA', source:'today' };
}
function getNYLevels(candles15m){
  const ny = getNYRange(candles15m);
  if(!ny || !ny.complete) return [];
  return [
    { price:ny.high, bh:ny.high, bl:ny.high*0.999, type:'resistance', strength:'strong', tested:false, score:60, tf:'SESSION', source:'NY High' },
    { price:ny.low,  bh:ny.low*1.001, bl:ny.low,  type:'support',    strength:'strong', tested:false, score:60, tf:'SESSION', source:'NY Low'  },
  ];
}
function getLondonRange(candles15m){
  if(!candles15m || candles15m.length < 4) return null;
  const b = getSessionBoundaries();
  const now = new Date();
  const todayMidnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const lOpen  = todayMidnight + b.londonOpen  * 3600000;
  const lClose = todayMidnight + b.londonClose * 3600000;
  let lon = candles15m.filter(k => k.t >= lOpen && k.t < lClose);
  if(lon.length < 2){
    const yest = todayMidnight - 86400000;
    lon = candles15m.filter(k => k.t >= yest+b.londonOpen*3600000 && k.t < yest+b.londonClose*3600000);
    if(lon.length < 2) return null;
    return { high:Math.max(...lon.map(k=>k.bh)), low:Math.min(...lon.map(k=>k.bl)), complete:true, source:'yesterday' };
  }
  const cur = getCurrentSession();
  return { high:Math.max(...lon.map(k=>k.bh)), low:Math.min(...lon.map(k=>k.bl)), complete:cur==='NY'||cur==='AFTER_HOURS', source:'today' };
}
function getLondonLevels(candles15m){
  const l = getLondonRange(candles15m);
  if(!l || !l.complete) return [];
  return [
    { price:l.high, bh:l.high, bl:l.high*0.999, type:'resistance', strength:'strong', tested:false, score:72, tf:'SESSION', source:'London High' },
    { price:l.low,  bh:l.low*1.001, bl:l.low,  type:'support',    strength:'strong', tested:false, score:72, tf:'SESSION', source:'London Low'  },
  ];
}

// -- FIBONACCI RETRACEMENT LEVELS (v4.9) ------------------------------------
// When there's a big gap between nearest support and resistance (>8% of price),
// generate fib retracements from the recent major swing to fill the void.
function findFibLevels(candles, existingLevels, currentPrice){
  if(!candles || candles.length < 20) return [];
  const n = candles.length;
  const lookback = Math.min(120, n);
  let swingHigh = -Infinity, swingLow = Infinity;
  let hiIdx = -1, loIdx = -1;
  for(let i = n - lookback; i < n; i++){
    if(candles[i].h > swingHigh){ swingHigh = candles[i].h; hiIdx = i; }
    if(candles[i].l < swingLow){ swingLow = candles[i].l; loIdx = i; }
  }
  const range = swingHigh - swingLow;
  if(range / currentPrice < 0.08) return [];
  const aboveLevels = existingLevels.filter(l => l.price > currentPrice);
  const belowLevels = existingLevels.filter(l => l.price < currentPrice);
  const nearestAbove = aboveLevels.length ? Math.min(...aboveLevels.map(l => l.price)) : swingHigh;
  const nearestBelow = belowLevels.length ? Math.max(...belowLevels.map(l => l.price)) : swingLow;
  const gapAbove = (nearestAbove - currentPrice) / currentPrice;
  const gapBelow = (currentPrice - nearestBelow) / currentPrice;
  if(gapAbove < 0.08 && gapBelow < 0.08) return [];
  const isDowntrend = loIdx > hiIdx;
  const fibRatios = [0.236, 0.382, 0.5, 0.618, 0.786];
  const fibs = [];
  for(const ratio of fibRatios){
    let price;
    if(isDowntrend) price = swingLow + range * ratio;
    else price = swingHigh - range * ratio;
    const dist = Math.abs(price - currentPrice) / currentPrice;
    if(dist > 0.20 || dist < 0.01) continue;
    const dupExists = existingLevels.some(l => Math.abs(l.price - price) / price < 0.005);
    if(dupExists) continue;
    const pctLabel = (ratio * 100).toFixed(1);
    const isAbove = price > currentPrice;
    fibs.push({
      price: Math.round(price * 100) / 100,
      bh: price * 1.001, bl: price * 0.999,
      type: isAbove ? 'resistance' : 'support',
      strength: ratio === 0.5 || ratio === 0.618 ? 'strong' : 'med',
      score: ratio === 0.618 ? 55 : ratio === 0.5 ? 50 : 40,
      tested: false, testCount: 0,
      source: `Fib ${pctLabel}%`,
      tf: 'FIB', isFib: true
    });
  }
  return fibs;
}

// -- LEVEL HELPERS -------------------------------------------------------------
function findDMCLevels(c, dCandles, tf, asiaLevels){
  const vp   = findVPeaks(c, tf);
  const pdhl = dCandles ? findPDHL(dCandles) : [];
  const asia = (tf === '15m' && asiaLevels) ? asiaLevels : [];
  const all  = [...vp, ...pdhl, ...asia];
  const merged = [];
  for(const l of all.sort((a,b)=>b.score-a.score)){
    const dup = merged.find(m=>Math.abs(m.price-l.price)/l.price < 0.003);
    if(!dup) merged.push(l);
    else if(l.score > dup.score) Object.assign(dup, l);
  }
  // v4.9: Add fib levels when there's a large gap in structure
  if(tf !== '15m'){
    const curPrice = c[c.length-1].c;
    const fibs = findFibLevels(c, merged, curPrice);
    merged.push(...fibs);
  }
  return merged;
}
function findNextLevel(levels, currentPrice, direction){
  // Use all levels with score >= 10 -- lower threshold catches more 4H/1H levels
  const qualityLevels = levels.filter(l => l.score >= 10);
  const pool   = qualityLevels.length >= 2 ? qualityLevels : levels;
  const sorted = [...pool].sort((a,b)=>a.price-b.price);
  if(direction === 'long'){
    const candidates = sorted.filter(l=>l.price > currentPrice * 1.003);
    if(candidates.length) return { price:candidates[0].price, source:candidates[0].source };
  } else {
    const candidates = sorted.filter(l=>l.price < currentPrice * 0.995);
    if(candidates.length) return { price:candidates[candidates.length-1].price, source:candidates[candidates.length-1].source };
  }
  return { price: direction === 'long' ? currentPrice*1.025 : currentPrice*0.975, source:'ATR est.' };
}
// v4.9: ATR-aware -- enforces minimum 1.0 ATR distance to avoid noise wicks
// v5.0: Per-coin minStopPct override (BTC 0.7%, others 0.5%)
function findStopLevel(levels, trapPrice, direction, atrVal, coinMinStopPct){
  const qualityLevels = levels.filter(l => l.score >= 10);
  const pool   = qualityLevels.length >= 2 ? qualityLevels : levels;
  const sorted = [...pool].sort((a,b)=>a.price-b.price);
  // ATR-based minimum distance: at least 1.0 ATR from trap, floor = per-coin minStopPct (default 0.5%)
  const stopFloor = coinMinStopPct || 0.005;
  const minDist = atrVal ? Math.max(atrVal * 1.0, trapPrice * stopFloor) : trapPrice * stopFloor;
  // Max stop distance: 4% from trap -- prevents absurdly wide stops
  const maxStopDist = trapPrice * 0.04;
  if(direction === 'short'){
    const candidates = sorted.filter(l=>l.price > trapPrice + minDist && l.price < trapPrice + maxStopDist);
    const levelStop = candidates.length ? candidates[0].price : null;
    const fallback = trapPrice * 1.02;
    if(levelStop) return Math.max(levelStop, trapPrice + minDist);
    return Math.max(fallback, trapPrice + minDist);
  } else {
    const candidates = sorted.filter(l=>l.price < trapPrice - minDist && l.price > trapPrice - maxStopDist);
    const levelStop = candidates.length ? candidates[candidates.length-1].price : null;
    const fallback = trapPrice * 0.98;
    if(levelStop) return Math.min(levelStop, trapPrice - minDist);
    return Math.min(fallback, trapPrice - minDist);
  }
}
// v5.0: Fee-adjusted R:R -- subtracts round-trip fees from reward and adds to risk
function calcRR(entry, target, trapLevel, stopLevel, feeEst){
  const stopRef = stopLevel || trapLevel;
  const feePct = feeEst || 0.05; // basis points as % (0.05 = 5bps)
  // v5.0 FIX #4: Use actual exit price for exit fee (not entry for both legs)
  const entryFee = entry * (feePct / 100);
  const exitFee  = target * (feePct / 100);
  const roundTripFee = entryFee + exitFee;
  const risk    = Math.abs(entry - stopRef) * 1.05 + roundTripFee;
  const reward  = Math.abs(entry - target) - roundTripFee;
  if(risk < 1 || reward <= 0) return null;
  const rr = reward / risk;
  // Cap R:R at 2.5 -- beyond this, targets are unrealistically far
  return Math.min(rr, 2.5).toFixed(1);
}

// -- REJECTION CANDLE DETECTION (v4.9 -- follow-through confirmation) ----------
// Phase 1: Rejection candle must NOT be the current candle -- we need at least
//          one follow-through candle that confirms the bounce direction.
//          This prevents firing signals the instant a wick appears, before
//          knowing whether price actually bounced or sliced through.
// Phase 2: Momentum filter -- if last 3-5 candles show strong directional
//          momentum AGAINST the signal, suppress it (price is trending through
//          the level, not bouncing).
// Returns { confirmed: true/false, barsAgo, wickRatio, followThrough }

function hasRejection(candles, levelPrice, direction, atrVal) {
  const n = candles.length;
  if (n < 3) return { confirmed: false };

  const cur = candles[n - 1]; // current candle = follow-through

  for (let i = 1; i < Math.min(4, n); i++) {
    const k = candles[n - 1 - i];  // rejection candidate (must be PREVIOUS candle)
    const body = k.bh - k.bl;
    const totalRange = k.h - k.l;
    if (totalRange < atrVal * 0.05) continue;  // skip doji/tiny candles

    if (direction === 'LONG') {
      const lowerWick = k.bl - k.l;
      const wickRatio = totalRange > 0 ? lowerWick / totalRange : 0;
      if (k.l <= levelPrice + atrVal * 0.3
        && lowerWick >= body * 0.5
        && wickRatio >= 0.25
        && k.c >= levelPrice - atrVal * 0.15)
      {
        // Follow-through: current candle must close above rejection candle's body low
        const followOk = cur.c > k.bl && cur.c >= levelPrice - atrVal * 0.1;
        if (followOk) {
          // Check follow-through strength -- a strong candle overrides momentum
          const curBody = cur.c - cur.o; // positive = bullish
          const strongFollow = curBody > atrVal * 0.15; // decent bullish body
          // Momentum filter -- only blocks if follow-through is weak
          if (!strongFollow) {
            const mom = hasMomentumAgainst(candles, direction, atrVal);
            if (mom.blocked) return { confirmed: false, reason: mom.reason };
          }
          return { confirmed: true, barsAgo: i, wickRatio, followThrough: true, strongFollow };
        }
      }
    } else {
      const upperWick = k.h - k.bh;
      const wickRatio = totalRange > 0 ? upperWick / totalRange : 0;
      if (k.h >= levelPrice - atrVal * 0.3
        && upperWick >= body * 0.5
        && wickRatio >= 0.25
        && k.c <= levelPrice + atrVal * 0.15)
      {
        const followOk = cur.c < k.bh && cur.c <= levelPrice + atrVal * 0.1;
        if (followOk) {
          const curBody = cur.o - cur.c; // positive = bearish
          const strongFollow = curBody > atrVal * 0.15;
          if (!strongFollow) {
            const mom = hasMomentumAgainst(candles, direction, atrVal);
            if (mom.blocked) return { confirmed: false, reason: mom.reason };
          }
          return { confirmed: true, barsAgo: i, wickRatio, followThrough: true, strongFollow };
        }
      }
    }
  }
  return { confirmed: false };
}

// -- STRONG BODY BOUNCE (v4.9) ---------------------------------------------
// Catches V-bounces where price hits a level and reverses with a strong body
// candle, even if there's no classic wick rejection pattern. This is an
// alternative to hasRejection for 4H/1H when:
//   - A recent candle touched/pierced the level (low within 0.5 ATR for LONG)
//   - Current or recent candle has a strong directional body (>= 0.20 ATR)
//   - Close is decisively away from the level in the trade direction
//   - At least 2 of last 3 candles support the direction (multi-candle bounce)
function hasStrongBodyBounce(candles, levelPrice, direction, atrVal) {
  const n = candles.length;
  if (n < 4) return { confirmed: false };

  // Look back up to 3 candles for a touch of the level
  let touchBar = -1;
  for (let i = 1; i < Math.min(4, n); i++) {
    const k = candles[n - 1 - i];
    if (direction === 'LONG' && k.l <= levelPrice + atrVal * 0.5) { touchBar = i; break; }
    if (direction === 'SHORT' && k.h >= levelPrice - atrVal * 0.5) { touchBar = i; break; }
  }
  // Also check current candle
  const cur = candles[n - 1];
  if (touchBar === -1) {
    if (direction === 'LONG' && cur.l <= levelPrice + atrVal * 0.5) touchBar = 0;
    if (direction === 'SHORT' && cur.h >= levelPrice - atrVal * 0.5) touchBar = 0;
  }
  if (touchBar === -1) return { confirmed: false };

  // Current candle must have a strong body in the direction
  const curBody = direction === 'LONG' ? (cur.c - cur.o) : (cur.o - cur.c);
  if (curBody < atrVal * 0.20) return { confirmed: false };

  // Current close must be away from the level in the right direction
  if (direction === 'LONG' && cur.c < levelPrice + atrVal * 0.1) return { confirmed: false };
  if (direction === 'SHORT' && cur.c > levelPrice - atrVal * 0.1) return { confirmed: false };

  // Multi-candle confirmation: at least 2 of last 3 candles (including current) are with direction
  let withDir = 0;
  for (let i = 0; i < Math.min(3, n); i++) {
    const k = candles[n - 1 - i];
    const bd = k.c - k.o;
    if (direction === 'LONG' && bd > 0) withDir++;
    if (direction === 'SHORT' && bd < 0) withDir++;
  }
  if (withDir < 2) return { confirmed: false };

  const bodyATR = (curBody / atrVal).toFixed(2);
  return { confirmed: true, barsAgo: touchBar, bodyATR };
}

// -- MOMENTUM FILTER (v4.9) --------------------------------------------------
// Checks if last 3-5 candles show strong directional momentum AGAINST the
// proposed trade direction. If price is clearly trending through a level
// (e.g., 4 consecutive bearish candles breaking support), a wick at that level
// is just a pause, not a reversal -- don't fire a LONG.
function hasMomentumAgainst(candles, direction, atrVal) {
  const n = candles.length;
  if (n < 4) return { blocked: false };

  const lookback = Math.min(5, n - 1);
  let againstCount = 0;
  let totalMove = 0;

  for (let i = 1; i <= lookback; i++) {
    const k = candles[n - 1 - i];
    const bodyDir = k.c - k.o; // positive = bullish, negative = bearish
    if (direction === 'LONG' && bodyDir < -atrVal * 0.05) againstCount++;
    if (direction === 'SHORT' && bodyDir > atrVal * 0.05) againstCount++;
    totalMove += bodyDir;
  }

  // Block if 3+ of last 5 candles are against direction AND net move is against
  const netAgainst = (direction === 'LONG' && totalMove < -atrVal * 0.5)
                  || (direction === 'SHORT' && totalMove > atrVal * 0.5);

  if (againstCount >= 3 && netAgainst) {
    return { blocked: true, reason: `${againstCount}/${lookback} candles against ${direction}, net move ${(totalMove/atrVal).toFixed(1)} ATR` };
  }
  return { blocked: false };
}

// -- LOWER-TF ALIGNMENT CHECK (v4.9) ---------------------------------------
// Before ANY signal fires, check if lower-TF candles are moving WITH the signal.
// 1W/1D check 4H+1H, 4H checks 1H+15m, 1H checks 15m.
// Two independent blocking conditions (either one blocks):
//   A) Candle count: 3+ of last 5 candles are against direction
//   B) Net move: last 5 candles net move > 0.3 ATR against direction + 2+ candles
function hasLTFAlignment(direction, lowerCandles) {
  if (!lowerCandles) return { aligned: true };
  const checks = [];

  for (const [label, candles] of Object.entries(lowerCandles)) {
    if (!candles || candles.length < 6) continue;
    const n = candles.length;
    const a = atr(candles);
    const lookback = 5;
    let againstCount = 0, withCount = 0, netMove = 0;
    for (let i = 0; i < lookback; i++) {
      const k = candles[n - 1 - i];
      const bodyDir = k.c - k.o;
      netMove += bodyDir;
      if (direction === 'LONG' && bodyDir < -a * 0.02) againstCount++;
      else if (direction === 'LONG' && bodyDir > a * 0.02) withCount++;
      else if (direction === 'SHORT' && bodyDir > a * 0.02) againstCount++;
      else if (direction === 'SHORT' && bodyDir < -a * 0.02) withCount++;
    }
    // Net move direction: positive = bullish
    const netAgainst = (direction === 'SHORT' && netMove > a * 0.3)
                    || (direction === 'LONG' && netMove < -a * 0.3);
    const netMoveATR = (netMove / a).toFixed(2);
    checks.push({ label, againstCount, withCount, lookback, netAgainst, netMoveATR });
  }

  for (const ch of checks) {
    // Block A: majority of candles moving against signal
    if (ch.againstCount >= 3) {
      return { aligned: false, reason: `${ch.label}: ${ch.againstCount}/${ch.lookback} candles against ${direction} (net ${ch.netMoveATR} ATR)` };
    }
    // Block B: strong net move against even if individual candles are mixed
    if (ch.netAgainst && ch.againstCount >= 2) {
      return { aligned: false, reason: `${ch.label}: net move ${ch.netMoveATR} ATR against ${direction} (${ch.againstCount}/${ch.lookback} candles)` };
    }
  }
  return { aligned: true };
}

// -- RETEST STRATEGY DETECTION (v5.11) -----------------------------------------
// "Retest" pattern (highest conviction per Tomaž, 2026-04-24):
//   1) Price BREAKS a level (up or down) — at least one recent close beyond level.
//   2) Price returns to the level and RETESTS it WITHOUT closing through — wicks
//      across the level are allowed, but no candle since the break closed back
//      on the original side of the level.
//   3) A CONVICTION candle (current bar) closes in the continuation direction
//      with a body >= 0.5 × ATR. This is the entry trigger.
//
// For a LONG retest:  broke UP through level; level now acts as support; retest
//   from above (wick touches level); conviction = strong bullish body closing
//   above level.
// For a SHORT retest: broke DOWN through level; level now acts as resistance;
//   retest from below (wick touches level); conviction = strong bearish body
//   closing below level.
//
// Returns { confirmed, direction, breakBarsAgo, retestBarsAgo, retestExtreme,
//           convictionBodyATR, reason }.
//
// `opts` (optional) — per-asset overrides sourced from coins-config.js:
//   breakDistFloorPct (default 0.0015) — minimum "break" distance as a % of price.
//                     Crypto-calibrated default; lower for assets where ATR is
//                     small vs. price (e.g. SP500 LTFs at $7,400 with $7 ATR).
//   minBreakCloses    (default 2) — number of closes between break bar and
//                     retest bar that must hold beyond the level. Lower to 1
//                     when a valid break-to-retest can happen in a single bar.
function detectRetest(c, levelPrice, atrVal, coinMinStopPct, opts){
  const n = c.length;
  if(n < 10) return { confirmed:false, reason:'insufficient candles' };
  if(!atrVal || atrVal <= 0) return { confirmed:false, reason:'no ATR' };

  opts = opts || {};
  const breakDistFloorPct = (opts.breakDistFloorPct != null) ? opts.breakDistFloorPct : 0.0015;
  const minBreakClosesCfg = (opts.minBreakCloses    != null) ? opts.minBreakCloses    : 2;

  // Tolerances — scale with ATR and enforce a price-% floor
  const stopFloor  = coinMinStopPct || 0.005;
  const breakDist  = Math.max(atrVal * 0.3, levelPrice * breakDistFloorPct);  // how far beyond = a "break"
  const retestTol  = Math.max(atrVal * 0.4, levelPrice * 0.002);   // how close = "touched the level"
  const closeBuf   = atrVal * 0.1;                                 // wick-through tolerance on closes
  const minBodyATR = 0.5;                                           // conviction threshold
  const LOOKBACK   = Math.min(25, n - 1);
  const RETEST_WIN = 5;   // retest must be within last N bars before current

  const cur = c[n - 1];

  // ---- Step 1: conviction direction from the CURRENT candle -------------
  const bullBody = cur.c - cur.o;
  const bearBody = cur.o - cur.c;
  let direction = null, convictionBody = 0;
  if(bullBody >= atrVal * minBodyATR && cur.c > levelPrice + closeBuf){
    direction = 'LONG';  convictionBody = bullBody;
  } else if(bearBody >= atrVal * minBodyATR && cur.c < levelPrice - closeBuf){
    direction = 'SHORT'; convictionBody = bearBody;
  } else {
    return { confirmed:false, reason:'no conviction candle (body < 0.5 ATR or wrong side of level)' };
  }

  // ---- Step 2: find the retest bar within the last RETEST_WIN bars ------
  // Retest bar must touch the level with a wick AND close on the continuation side.
  let retestBarsAgo = -1, retestExtreme = null;
  for(let i = 1; i <= RETEST_WIN; i++){
    if(n - 1 - i < 0) break;
    const k = c[n - 1 - i];
    if(direction === 'LONG'){
      const touched = k.l <= levelPrice + retestTol && k.l >= levelPrice - retestTol;
      const closedAbove = k.c >= levelPrice - closeBuf;
      if(touched && closedAbove){ retestBarsAgo = i; retestExtreme = k.l; break; }
    } else {
      const touched = k.h >= levelPrice - retestTol && k.h <= levelPrice + retestTol;
      const closedBelow = k.c <= levelPrice + closeBuf;
      if(touched && closedBelow){ retestBarsAgo = i; retestExtreme = k.h; break; }
    }
  }
  if(retestBarsAgo === -1){
    return { confirmed:false, reason:'no retest touch in last ' + RETEST_WIN + ' bars' };
  }

  // ---- Step 3: between retest and current, NO closes through the level --
  // Wicks allowed; closes are not.
  for(let i = 0; i < retestBarsAgo; i++){
    const k = c[n - 1 - i];
    if(direction === 'LONG' && k.c < levelPrice - closeBuf){
      return { confirmed:false, reason:`closed through level ${i} bars ago (failed retest)` };
    }
    if(direction === 'SHORT' && k.c > levelPrice + closeBuf){
      return { confirmed:false, reason:`closed through level ${i} bars ago (failed retest)` };
    }
  }

  // ---- Step 4: verify an earlier BREAK of the level --------------------
  // Scan further back for a bar whose close is beyond the level by breakDist,
  // AND at some point before that bar, price was on the opposite side.
  let breakBarsAgo = -1;
  for(let i = retestBarsAgo + 1; i <= LOOKBACK; i++){
    if(n - 1 - i < 0) break;
    const k = c[n - 1 - i];
    const brokeBeyond = direction === 'LONG'
      ? k.c >= levelPrice + breakDist
      : k.c <= levelPrice - breakDist;
    if(!brokeBeyond) continue;
    // Confirm price was on the opposite side earlier — look up to 10 bars further back
    const deepLookEnd = Math.min(i + 10, n - 1);
    let oppositeFound = false;
    for(let j = i + 1; j <= deepLookEnd; j++){
      if(n - 1 - j < 0) break;
      const kk = c[n - 1 - j];
      if(direction === 'LONG' && kk.c < levelPrice - closeBuf){ oppositeFound = true; break; }
      if(direction === 'SHORT' && kk.c > levelPrice + closeBuf){ oppositeFound = true; break; }
    }
    if(oppositeFound){ breakBarsAgo = i; break; }
  }
  if(breakBarsAgo === -1){
    return { confirmed:false, reason:'no prior break of level within lookback' };
  }

  // ---- Step 5 (v5.17): post-break confirmation -- require multiple closes beyond level
  // Filters false breakdowns: e.g. May 5 GOLD short where a single candle spiked through
  // support ($4,513.9) and immediately reversed. Count candles between the break bar and
  // the retest bar that closed beyond the level. Default >= 2; per-asset override via
  // coins-config.js minBreakCloses (SP500 = 1 — break-to-retest can happen in one bar
  // on a strong index move; the extra-close gate was blocking otherwise valid setups).
  const MIN_BREAK_CLOSES = minBreakClosesCfg;
  let breakCloseCount = 0;
  for(let i = retestBarsAgo + 1; i <= breakBarsAgo; i++){
    if(n - 1 - i < 0) break;
    const k = c[n - 1 - i];
    if(direction === 'LONG'  && k.c >= levelPrice + closeBuf) breakCloseCount++;
    if(direction === 'SHORT' && k.c <= levelPrice - closeBuf) breakCloseCount++;
  }
  if(breakCloseCount < MIN_BREAK_CLOSES){
    return { confirmed:false, reason:`only ${breakCloseCount} close(s) beyond level after break (need ${MIN_BREAK_CLOSES}+) — likely false breakdown` };
  }

  return {
    confirmed: true,
    direction,
    breakBarsAgo,
    retestBarsAgo,
    retestExtreme,
    breakCloseCount,
    convictionBodyATR: +(convictionBody / atrVal).toFixed(2),
    reason: `break ${breakBarsAgo}b ago (${breakCloseCount} closes held), retest ${retestBarsAgo}b ago, body ${(convictionBody/atrVal).toFixed(2)} ATR`
  };
}

// -- DMS SIGNAL ENGINE (v5.11 -- RETEST STRATEGY, replaces v4.9 trap/bounce/breakout) --
// Retest = only pattern we trade. Runs on every TF (15m, 1H, 4H, 1D, 1W); signals
// aggregate into multi-TF confidence the same way as before. HTF direction still
// blocks counter-trend retests via maybeAutoTrade's existing gate.
//
// `coinOpts` (optional) — forwarded to detectRetest for per-asset retest tuning
// (breakDistFloorPct, minBreakCloses). Pulled from coins-config.js by callers.
function dms(c, a, dCandles, tf, htfBias, lowerCandles, coinMinRR, coinMinStopPct, feeEst, coinOpts){
  coinMinRR = coinMinRR || 1.0;
  coinMinStopPct = coinMinStopPct || 0.005;
  feeEst = feeEst || 0.05;
  coinOpts = coinOpts || {};
  const n = c.length;
  const minCandles = (tf==='1W'||tf==='1D') ? 12 : 20;
  if(n < minCandles) return { sig:'NEUTRAL', type:'NONE', reason:'Insufficient data' };

  // htfBias can be a carrier object {dir, __asiaLevels} or a raw string.
  const htfDir = (htfBias && htfBias.dir) ? htfBias.dir : (typeof htfBias === 'string' ? htfBias : 'UNCLEAR');
  const usePDHL  = (tf !== '1W');
  const asiaLvls = (tf === '15m') ? (htfBias.__asiaLevels || []) : [];
  const levels   = findDMCLevels(c, usePDHL ? dCandles : null, tf, asiaLvls);
  const cur      = c[n-1];

  // Candidate levels: decent score, within ATR range. Closest first.
  const nearby = levels
    .filter(l => Math.abs(l.price - cur.c) < a * 30 && l.score >= 15)
    .sort((x, y) => Math.abs(x.price - cur.c) - Math.abs(y.price - cur.c));

  if(nearby.length === 0){
    return { sig:'NEUTRAL', type:'NONE', level:null, target:null, reason:'No qualifying levels within range' };
  }

  // -- RETEST DETECTION (v5.11) --------------------------------------------
  // Try up to 5 nearest levels; first confirmed retest wins.
  const maxToTest = Math.min(nearby.length, 5);
  let atLevelFallback = null;   // remembered level for AT_LEVEL fallback output

  for(let li = 0; li < maxToTest; li++){
    const lv = nearby[li];
    const result = detectRetest(c, lv.price, a, coinMinStopPct, coinOpts);

    if(result.confirmed){
      const sig = result.direction;   // 'LONG' | 'SHORT'
      const dirLower = sig === 'LONG' ? 'long' : 'short';

      // Local HTF counter-trend gate: block on lower TFs when HTF clearly opposes.
      // HTF TFs (1W/1D) may fire against htfDir — they are often what turns it.
      // (maybeAutoTrade also hard-blocks counter-trend at the trade level.)
      const isHTF = (tf === '1W' || tf === '1D');
      const counterTrend = (sig === 'LONG' && htfDir === 'DOWN') ||
                           (sig === 'SHORT' && htfDir === 'UP');
      if(counterTrend && !isHTF){
        if(!atLevelFallback) atLevelFallback = { ...lv, _retestReason: 'counter-trend, waiting for HTF flip' };
        continue;
      }

      // LTF alignment: on HTF signals only, respect lower-TF momentum (mirrors old v4.9 rule)
      if(isHTF && lowerCandles){
        const ltfCheck = hasLTFAlignment(sig, lowerCandles);
        if(!ltfCheck.aligned){
          if(!atLevelFallback) atLevelFallback = { ...lv, _retestReason: `LTF opposing: ${ltfCheck.reason}` };
          continue;
        }
      }

      // TP = next level in continuation direction
      const tgt = findNextLevel(levels, cur.c, dirLower);

      // SL = far side of the tested level + ATR buffer; enforce per-coin minStopPct from entry
      const stopBuf = Math.max(a * 0.3, lv.price * 0.002);
      let stop;
      if(sig === 'LONG'){
        stop = lv.price - stopBuf;
        const entryFloor = cur.c * (1 - coinMinStopPct);
        stop = Math.min(stop, entryFloor);
      } else {
        stop = lv.price + stopBuf;
        const entryCeil = cur.c * (1 + coinMinStopPct);
        stop = Math.max(stop, entryCeil);
      }

      const rr = calcRR(cur.c, tgt.price, lv.price, stop, feeEst);
      if(!rr || parseFloat(rr) < coinMinRR){
        if(!atLevelFallback) atLevelFallback = { ...lv, _retestReason: `R:R ${rr || 'n/a'} < ${coinMinRR}` };
        continue;
      }

      const dist    = ((lv.price - cur.c) / cur.c * 100).toFixed(2);
      const htfNote = ((htfDir === 'UP' && sig === 'LONG') || (htfDir === 'DOWN' && sig === 'SHORT'))
        ? ` . HTF ${htfDir} aligns` : '';
      return {
        sig,
        type: 'BLIND_ENTRY',  // reuse existing type so multi-TF confluence + dedup paths work unchanged
        level: lv.price,
        target: tgt.price,
        rr,
        stopPrice: stop,
        strength: lv.strength,
        score: lv.score,
        // v5.23 (2026-05-08): propagate detectRetest fields so scoreSignal() can use them.
        // Additive — pre-existing consumers ignore these fields.
        convictionBodyATR: result.convictionBodyATR,
        breakCloseCount:   result.breakCloseCount,
        breakBarsAgo:      result.breakBarsAgo,
        retestBarsAgo:     result.retestBarsAgo,
        reason: `RETEST ${tf} ${sig}: ${lv.source} $${fmt(lv.price)} . ${dist>0?'+':''}${dist}% . ${result.reason} . conviction ${result.convictionBodyATR} ATR${htfNote} . R:R ${rr} -> $${fmt(tgt.price)}`,
        detail: `Retest entry -- SL: $${fmt(stop)}`,
        untested: false
      };
    } else if(!atLevelFallback){
      atLevelFallback = { ...lv, _retestReason: result.reason };
    }
  }

  // -- NO CONFIRMED RETEST: emit AT_LEVEL if price is hugging a level ------
  if(atLevelFallback && Math.abs(atLevelFallback.price - cur.c) < a * 1.5){
    const lv = atLevelFallback;
    const dist = ((lv.price - cur.c) / cur.c * 100).toFixed(2);
    const dir = lv.type === 'resistance'
      ? 'RESISTANCE -- watching for retest + conviction'
      : 'SUPPORT -- watching for retest + conviction';
    const why = lv._retestReason ? ` . ${lv._retestReason}` : '';
    return {
      sig: 'NEUTRAL',
      type: 'AT_LEVEL',
      level: lv.price,
      target: null,
      strength: lv.strength,
      score: lv.score,
      reason: `${lv.source} $${fmt(lv.price)} . ${dist>0?'+':''}${dist}% . ${dir}${why}`
    };
  }

  return { sig:'NEUTRAL', type:'NONE', level:null, target:null, reason:'No retest pattern' };
}


// -- HTF BIAS ------------------------------------------------------------------
function nextMove(h4C, h1C){
  const n4=h4C.length, n1=h1C.length;
  if(n4<8||n1<8) return { dir:'UNCLEAR' };
  const h4 = h4C.slice(-6);
  let bull4=0, bear4=0;
  for(let i=1;i<h4.length;i++){
    if(h4[i].bh>h4[i-1].bh && h4[i].bl>h4[i-1].bl) bull4++;
    else if(h4[i].bh<h4[i-1].bh && h4[i].bl<h4[i-1].bl) bear4++;
  }
  const h4n=h4C[n4-1], h4p=h4C[n4-2], h4pp=h4C[n4-3];
  const h4FailedHigh = h4n.bh < h4p.bh && h4p.bh > h4pp.bh;
  const h4FailedLow  = h4n.bl > h4p.bl && h4p.bl < h4pp.bl;
  const h1 = h1C.slice(-8);
  let bull1=0, bear1=0;
  for(let i=1;i<h1.length;i++){ if(h1[i].bh>h1[i-1].bh) bull1++; else bear1++; }
  const h1n=h1C[n1-1], h1p=h1C[n1-2];
  const h1Bearish = h1n.bh < h1p.bh && h1n.bl < h1p.bl;
  const h1Bullish = h1n.bh > h1p.bh && h1n.bl > h1p.bl;
  const bearScore = bear4 + (h4FailedHigh?2:0) + (bear1>=5?1:0) + (h1Bearish?1:0);
  const bullScore = bull4 + (h4FailedLow?2:0)  + (bull1>=5?1:0) + (h1Bullish?1:0);
  // v5.1: Raised threshold from 2→3, require gap>1, removed single-candle tiebreaker (synced w/ app)
  const threshold = 3;
  if(bullScore>=threshold && bullScore>bearScore+1) return { dir:'UP' };
  if(bearScore>=threshold && bearScore>bullScore+1) return { dir:'DOWN' };
  if(h4FailedHigh && h1Bearish) return { dir:'DOWN' };
  if(h4FailedLow  && h1Bullish) return { dir:'UP' };
  return { dir:'UNCLEAR' };
}

// =============================================================================
// scoreSignal() — v5.23 (2026-05-08)
// =============================================================================
// Combines multi-TF confidence with conviction quality, level quality, market
// regime alignment, and range/exhaustion penalties into a single 0–100 strength
// score. Hand-tuned weights as a starting point — validation against real fills
// happens in counterfactual.js (which buckets historical trades by score and
// reports per-bucket win rate).
//
// Inputs:
//   coinState     { price, htfDir, range48h, exhaustion48h, fundingRate }
//   dmsResult     return value from dms() — must have sig, level, score, rr,
//                 convictionBodyATR, breakCloseCount (v5.23 propagation)
//   allResults    { '1W': dmsRes, '1D': ..., ... } — for confluence calc
//   entryCandles  candles on the firing TF (for ADX read)
//
// Output: { score: 0–100, label: 'STRONG'|'SOLID'|'MODERATE'|'WEAK'|'NONE',
//           color: hex, breakdown: { factor: contribution } }
function scoreSignal({ coinState, dmsResult, allResults, entryCandles } = {}) {
  if (!dmsResult || dmsResult.sig === 'NEUTRAL') {
    return { score: 0, label: 'NONE', color: '#5d7a99', breakdown: {} };
  }
  const sig = dmsResult.sig;
  const breakdown = {};

  // --- Base: multi-TF confidence (0–100) ---
  const SIG_TFS = [{l:'1W',w:5},{l:'1D',w:4},{l:'4H',w:3},{l:'1H',w:2},{l:'15m',w:1}];
  const totalW = 15;
  let wL = 0, wS = 0;
  if (allResults) {
    for (const tf of SIG_TFS) {
      const r = allResults[tf.l];
      if (!r) continue;
      if (r.sig === 'LONG')  wL += tf.w;
      if (r.sig === 'SHORT') wS += tf.w;
    }
  } else {
    // Fall back to giving credit to the firing TF only — implies single-TF signal.
    wL = sig === 'LONG' ? 1 : 0;
    wS = sig === 'SHORT' ? 1 : 0;
  }
  const conf = Math.round(Math.max(wL, wS) / totalW * 100);
  let score = conf;
  breakdown.base_confidence = conf;

  // --- HTF agreement (with-trend bonus / counter-trend penalty) ---
  if (coinState && coinState.htfDir) {
    const htf = coinState.htfDir;
    if ((sig === 'LONG' && htf === 'UP') || (sig === 'SHORT' && htf === 'DOWN')) {
      score += 15; breakdown.htf_with_trend = 15;
    } else if ((sig === 'LONG' && htf === 'DOWN') || (sig === 'SHORT' && htf === 'UP')) {
      score -= 15; breakdown.htf_counter_trend = -15;
    }
  }

  // --- Conviction body ATR (decisiveness of the entry candle) ---
  if (typeof dmsResult.convictionBodyATR === 'number') {
    const cb = Math.min(dmsResult.convictionBodyATR, 2);
    const bonus = Math.round(cb * 10);   // 0–20
    score += bonus; breakdown.conviction_body = bonus;
  }

  // --- Break close count (v5.17: did the break hold?) ---
  if (typeof dmsResult.breakCloseCount === 'number') {
    const bcc = Math.min(dmsResult.breakCloseCount, 5);
    const bonus = Math.round(bcc * 3);   // 0–15
    score += bonus; breakdown.break_close = bonus;
  }

  // --- Level quality (scoreLevel output) ---
  if (typeof dmsResult.score === 'number') {
    const bonus = Math.round(Math.min(dmsResult.score, 100) * 0.2);  // 0–20
    score += bonus; breakdown.level_quality = bonus;
  }

  // --- ADX on entry TF (range vs trend) ---
  if (entryCandles && entryCandles.length >= 30) {
    const adx = calcADX(entryCandles);
    const bonus = Math.round(Math.min(adx, 50) * 0.3);  // 0–15
    score += bonus; breakdown.adx = bonus;
  }

  // --- R:R asymmetry ---
  const rr = parseFloat(dmsResult.rr);
  if (rr >= 2.0)      { score += 5;  breakdown.rr_high = 5; }
  else if (rr >= 1.5) { score += 2;  breakdown.rr_decent = 2; }

  // --- Funding rate alignment (HL perp tailwind) ---
  if (coinState && typeof coinState.fundingRate === 'number' &&
      Math.abs(coinState.fundingRate) > 0.0001) {
    const favors = coinState.fundingRate > 0 ? 'SHORT' : 'LONG';
    if (sig === favors) { score += 5; breakdown.funding_aligned = 5; }
  }

  // --- Range position penalty (entries at the extreme reverse more often) ---
  if (coinState && coinState.range48h && coinState.price) {
    const r = coinState.range48h;
    const size = r.high - r.low;
    if (size > 0) {
      const pos = (coinState.price - r.low) / size;   // 0=bottom, 1=top
      if (sig === 'LONG' && pos > 0.80)  { score -= 10; breakdown.range_extreme_top = -10; }
      if (sig === 'SHORT' && pos < 0.20) { score -= 10; breakdown.range_extreme_bot = -10; }
    }
  }

  // --- 48h exhaustion penalty (move already played out) ---
  if (coinState && coinState.exhaustion48h) {
    const exh = coinState.exhaustion48h;
    const dirMove = sig === 'LONG' ? (exh.movePct || 0) : -(exh.movePct || 0);
    if (dirMove > 1) {
      const pen = Math.min(Math.round(dirMove * 2), 20);
      score -= pen; breakdown.exhaustion = -pen;
    }
  }

  // Clip + label
  score = Math.max(0, Math.min(100, score));
  let label, color;
  if (score >= 80)      { label = 'STRONG';   color = '#00e676'; }
  else if (score >= 60) { label = 'SOLID';    color = '#7fdb8e'; }
  else if (score >= 40) { label = 'MODERATE'; color = '#ffc107'; }
  else                  { label = 'WEAK';     color = '#ff3d5a'; }

  return { score, label, color, breakdown };
}


// v5.22 (2026-05-08): Dual-mode UMD-style export. Works in both:
//   - Node CommonJS  (bot.js, daily-report.js, backtester) → module.exports
//   - Browser <script>  (dms-v53.html / index.html)        → window.DMSSignals
// This is the entry point that lets the dashboard import the same signal engine
// as bot.js, eliminating the duplicate-bug class (plan item #6).
const __DMS_SIGNALS_EXPORTS = {
  fmt, atr, calcADX, trendExhaustion48h,
  isSwingHigh, isSwingLow, detectFlippedLevel, scoreLevel, classifyStrength,
  countLevelTests, findVPeaks, findPDHL,
  getSessionBoundaries, getCurrentSession,
  getAsiaRange, getAsiaLevels, getNYRange, getNYLevels, getLondonRange, getLondonLevels,
  findFibLevels, findDMCLevels, findNextLevel, findStopLevel, calcRR,
  hasRejection, hasStrongBodyBounce, hasMomentumAgainst, hasLTFAlignment,
  detectRetest, dms, nextMove, scoreSignal,
  CHOP_FILTER, MAX_HOLD_HOURS, FUNDING_EXIT_THRESHOLD, BREAKOUT_QUALITY, EXHAUSTION_THRESHOLDS,
};
if (typeof module !== 'undefined' && module.exports) {
  // Node / CommonJS
  module.exports = __DMS_SIGNALS_EXPORTS;
} else if (typeof globalThis !== 'undefined') {
  // Browser
  globalThis.DMSSignals = __DMS_SIGNALS_EXPORTS;
}

})();  // end IIFE — see v5.22.1 note at the top
