// DMS Signal Bot v5.0 -- AUTO-TRADE edition
// Mirrors the DMS algorithm from index.html exactly -- same levels, same scoring, same signals
// Now also executes trades on Hyperliquid with TP/SL/trailing stops
// Node 18+ required (uses built-in fetch)
//
// v5.0 changelog:
//   - Partial TP (50% at TP1, remainder trails)
//   - GTC limit orders for HIP-3 assets (fee optimization)
//   - maxNotional caps for SP500/GOLD ($500) with double-check safety net
//   - Post-loss cooldown per coin (configurable, default 10min)
//   - Daily loss circuit breaker (halves position size)
//   - Fee-adjusted R:R with per-coin feeEst (GOLD 12bps for builder fees)
//   - Ranging market detector (whipsaw protection)
//   - SP500 US-session-only filter (13:00-21:00 UTC)
//   - Fresh price fetch in executeTrade (stale price fix)
//   - Per-coin minStopPct floors (BTC 0.7%, others 0.5%)

const fs    = require('fs');
const path  = require('path');
const ethers = require('ethers');

// -- CONFIG (env vars or .env file) ------------------------------------------
(function loadDotEnv(){
  const f = path.join(__dirname, '.env');
  if(!fs.existsSync(f)) return;
  fs.readFileSync(f,'utf8').split('\n').forEach(line=>{
    const m = line.match(/^\s*([^#=\s][^=]*?)\s*=\s*(.*)\s*$/);
    if(m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g,'');
  });
})();

const TG_TOKEN  = process.env.TG_TOKEN;
const TG_CHATID = process.env.TG_CHATID;
const WANT_LONG     = process.env.ALERT_LONG    !== 'false';
const WANT_SHORT    = process.env.ALERT_SHORT   !== 'false';
const WANT_ATLEVEL  = process.env.ALERT_ATLEVEL === 'true';
const MIN_RR        = parseFloat(process.env.MIN_RR || '1.0');
const INTERVAL_MS   = parseInt(process.env.INTERVAL_MS || '120000', 10);
const DEDUP_FILE    = path.join(__dirname, '.dedup.json');

// -- AUTO-TRADE CONFIG --------------------------------------------------------
const HL_PRIVATE_KEY  = process.env.HL_PRIVATE_KEY;   // Agent wallet private key
const HL_MASTER_ADDR  = process.env.HL_MASTER_ADDR || '';  // Master account address (if agent wallet)
const AUTO_TRADE      = process.env.AUTO_TRADE === 'true';
const RISK_PCT        = parseFloat(process.env.RISK_PCT || '1');      // % of account to risk per trade
const MIN_CONFIDENCE  = parseInt(process.env.MIN_CONFIDENCE || '50'); // base min confidence %
const MAX_TRADES_DAY  = parseInt(process.env.MAX_TRADES_DAY || '10');
const TRAIL_INTERVAL  = parseInt(process.env.TRAIL_INTERVAL || '30000'); // check trailing every 30s

if(!TG_TOKEN || !TG_CHATID){
  console.error('ERROR: TG_TOKEN and TG_CHATID must be set.');
  process.exit(1);
}

// -- COINS (BTC, HYPE, SPX + GOLD via Hyperliquid HIP-3) ---------------------
const COINS = {
  bitcoin:     { id:'bitcoin',     label:'BTC',    apiSym:'BTCUSDT',      asset:'BTC',        exchange:'binance',     minRR: 1.0, feeEst: 0.05, minStopPct: 0.007, maxNotional: 0 },
  hyperliquid: { id:'hyperliquid', label:'HYPE',   apiSym:'HYPEUSDT',     asset:'HYPE',       exchange:'bybit',       minRR: 1.0, feeEst: 0.05, minStopPct: 0.005, maxNotional: 0 },
  sp500:       { id:'sp500',       label:'S&P500', apiSym:'xyz:SP500',   asset:'xyz:SP500', exchange:'hyperliquid', minRR: 1.5, feeEst: 0.10, minStopPct: 0.005, maxNotional: 500, isHIP3: true },
  gold:        { id:'gold',        label:'GOLD',   apiSym:'xyz:GOLD',    asset:'xyz:GOLD',   exchange:'hyperliquid', minRR: 1.5, feeEst: 0.12, minStopPct: 0.005, maxNotional: 500, isHIP3: true },  // v5.0: feeEst 0.10->0.12 (builder fees ~10bps; 0.15 was too aggressive)
};

const TFS = [
  { l:'1W', w:5 },
  { l:'1D', w:4 },
  { l:'4H', w:3 },
  { l:'1H', w:2 },
  { l:'15m',w:1 },
];

const INTERVAL_MAP = {
  binance: { '1W':'1w', '1D':'1d', '4H':'4h', '1H':'1h', '15m':'15m' },
  bybit:   { '1W':'W',  '1D':'D',  '4H':'240', '1H':'60', '15m':'15' }
};
const HL_INTERVALS = { '1W':'1w', '1D':'1d', '4H':'4h', '1H':'1h', '15m':'15m' };

const LIMITS = { '1W':104, '1D':180, '4H':500, '1H':500, '15m':192 };

const BINANCE = 'https://api.binance.com/api/v3';
const BYBIT   = 'https://api.bybit.com/v5/market';
const HL_API  = 'https://api.hyperliquid.xyz';


// -- STATE --------------------------------------------------------------------
const coinState = {};  // coinId -> { price, htfDir, results: { tf: dmsResult } }
const ACTIVE_TRADES_FILE = path.join(__dirname, '.active_trades.json');
const CLOSED_TRADES_FILE = path.join(__dirname, '.closed_trades.json');

// -- DEDUP ---------------------------------------------------------------------
function loadDedup(){
  try{ return JSON.parse(fs.readFileSync(DEDUP_FILE,'utf8')); }catch{ return {}; }
}
function saveDedup(d){ fs.writeFileSync(DEDUP_FILE, JSON.stringify(d)); }
function isDedupSuppressed(coinId, tf, type, level){
  const d   = loadDedup();
  const key = `${coinId}:${tf}:${type}:${Math.round(level)}`;
  const win = type === 'BLIND_ENTRY' ? 28800000 : 14400000;
  const now = Date.now();
  // v5.0 FIX #3: Prune based on each entry's actual window, not a fixed 8h
  // Old code used 28800000 for all prune checks, meaning 4h entries lingered in the file for 8h
  let changed = false;
  for(const k of Object.keys(d)){
    const entryWindow = k.includes(':BLIND_ENTRY:') ? 28800000 : 14400000;
    if(now - d[k] > entryWindow){ delete d[k]; changed=true; }
  }
  if(changed) saveDedup(d);
  return !!(d[key] && (now - d[key]) < win);
}
function markDedupFired(coinId, tf, type, level){
  const d   = loadDedup();
  const key = `${coinId}:${tf}:${type}:${Math.round(level)}`;
  d[key] = Date.now();
  saveDedup(d);
}

// -- TELEGRAM ------------------------------------------------------------------
async function sendTelegram(msg){
  try{
    const r = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`,{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ chat_id: TG_CHATID, text: msg, parse_mode:'HTML' })
    });
    if(!r.ok) console.warn('Telegram error:', r.status, await r.text());
    return r.ok;
  }catch(e){ console.warn('Telegram fetch error:', e.message); return false; }
}

// -- EXCHANGE APIs -------------------------------------------------------------
async function bnKlines(sym, interval, limit){
  const url = `${BINANCE}/klines?symbol=${sym}&interval=${interval}&limit=${limit}`;
  const r   = await fetch(url);
  if(!r.ok) throw new Error(`Binance ${interval}: ${r.status}`);
  const raw = await r.json();
  if(!Array.isArray(raw) || raw.length < 4) throw new Error(`Binance ${interval}: empty`);
  return raw.map(k=>({
    t:k[0], o:+k[1], h:+k[2], l:+k[3], c:+k[4],
    bh:Math.max(+k[1],+k[4]), bl:Math.min(+k[1],+k[4])
  }));
}

async function bybitKlines(sym, interval, limit){
  const url = `${BYBIT}/kline?category=spot&symbol=${sym}&interval=${interval}&limit=${limit}`;
  const r   = await fetch(url);
  if(!r.ok) throw new Error(`Bybit ${interval}: ${r.status}`);
  const json = await r.json();
  if(json.retCode !== 0) throw new Error(`Bybit ${interval}: ${json.retMsg}`);
  const raw = json.result?.list;
  if(!Array.isArray(raw) || raw.length < 4) throw new Error(`Bybit ${interval}: empty`);
  return raw.reverse().map(k=>({
    t:+k[0], o:+k[1], h:+k[2], l:+k[3], c:+k[4],
    bh:Math.max(+k[1],+k[4]), bl:Math.min(+k[1],+k[4])
  }));
}

// Hyperliquid candles via candleSnapshot POST (HIP-3 assets like xyz:GOLD)
async function hlKlines(coin, interval, limit){
  const now = Date.now();
  const msMap = { '1w':604800000, '1d':86400000, '4h':14400000, '1h':3600000, '15m':900000 };
  const ms = msMap[interval] || 86400000;
  const startTime = now - (ms * limit * 1.1);
  const r = await fetch(HL_API + '/info', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'candleSnapshot', req: { coin, interval, startTime: Math.floor(startTime), endTime: Math.floor(now) } })
  });
  if(!r.ok) throw new Error(`HL candles ${coin} ${interval}: ${r.status}`);
  const raw = await r.json();
  // v4.9: lowered from 4 to 2 -- HIP-3 assets (xyz:SP500, xyz:GOLD) may have limited history
  if(!Array.isArray(raw) || raw.length < 2) throw new Error(`HL candles ${coin} ${interval}: empty (${raw.length || 0})`);
  return raw.map(k => ({
    t: k.t, o: +k.o, h: +k.h, l: +k.l, c: +k.c,
    bh: Math.max(+k.o, +k.c), bl: Math.min(+k.o, +k.c)
  }));
}

// v4.9: reduced limits for HIP-3 assets -- they have shorter history than BTC/HYPE
const HL_LIMITS = { '1W':26, '1D':90, '4H':200, '1H':500, '15m':192 };

async function getCandles(tfLabel, coinId){
  const coin = COINS[coinId];
  if(coin.exchange === 'hyperliquid'){
    return hlKlines(coin.apiSym, HL_INTERVALS[tfLabel], HL_LIMITS[tfLabel]);
  }
  const iv   = INTERVAL_MAP[coin.exchange][tfLabel];
  const limit = coin.exchange === 'bybit' ? Math.min(LIMITS[tfLabel], 200) : LIMITS[tfLabel];
  if(coin.exchange === 'bybit') return bybitKlines(coin.apiSym, iv, limit);
  return bnKlines(coin.apiSym, iv, limit);
}

async function getPrice(coinId){
  const coin = COINS[coinId];
  if(coin.exchange === 'hyperliquid'){
    // Use latest 1h candle for price, daily for 24h change
    const now = Date.now();
    const r = await fetch(HL_API + '/info', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'candleSnapshot', req: { coin: coin.apiSym, interval: '1h', startTime: now - 7200000, endTime: now } })
    });
    if(!r.ok) throw new Error('HL price: ' + r.status);
    const candles = await r.json();
    if(!Array.isArray(candles) || candles.length === 0) throw new Error('HL price: no candles');
    const price = +candles[candles.length - 1].c;
    // 24h change from daily candles
    const r2 = await fetch(HL_API + '/info', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'candleSnapshot', req: { coin: coin.apiSym, interval: '1d', startTime: now - 172800000, endTime: now } })
    });
    let change = 0;
    if(r2.ok){
      const daily = await r2.json();
      if(Array.isArray(daily) && daily.length >= 2){
        const prevClose = +daily[daily.length - 2].c;
        if(prevClose > 0) change = ((price - prevClose) / prevClose * 100);
      }
    }
    return { price, change };
  }
  if(coin.exchange === 'bybit'){
    const r = await fetch(`${BYBIT}/tickers?category=spot&symbol=${coin.apiSym}`);
    if(!r.ok) throw new Error('Bybit price: '+r.status);
    const json = await r.json();
    const t = json.result?.list?.[0];
    if(!t) throw new Error('Bybit price: no data');
    const price = +t.lastPrice;
    const prevPrice = +t.prevPrice24h || price;
    const change = prevPrice > 0 ? ((price - prevPrice) / prevPrice * 100) : 0;
    return { price, change };
  }
  const r = await fetch(`${BINANCE}/ticker/24hr?symbol=${coin.apiSym}`);
  if(!r.ok) throw new Error('Price: '+r.status);
  const d = await r.json();
  return { price: +d.lastPrice, change: +d.priceChangePercent };
}

// -- UTILITIES -----------------------------------------------------------------
function fmt(n){ return n>=1000 ? n.toLocaleString('en-US',{maximumFractionDigits:0}) : n.toFixed(2); }
function atr(c, p=14){
  const tr = c.slice(1).map((x,i)=>Math.max(x.h-x.l, Math.abs(x.h-c[i].c), Math.abs(x.l-c[i].c)));
  return tr.slice(-p).reduce((s,v)=>s+v, 0) / p;
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

// -- DMS SIGNAL ENGINE (v4.9 -- confirmed follow-through + momentum + HTF + LTF align) -
// v5.0: Added coinMinStopPct + feeEst for per-coin SL floor and fee-adjusted R:R
function dms(c, a, dCandles, tf, htfBias, lowerCandles, coinMinRR, coinMinStopPct, feeEst){
  coinMinRR = coinMinRR || 1.0;
  coinMinStopPct = coinMinStopPct || 0.005;
  feeEst = feeEst || 0.05;
  const n = c.length;
  const minCandles = (tf==='1W'||tf==='1D') ? 10 : 20;
  if(n < minCandles) return { sig:'NEUTRAL', type:'NONE', reason:'Insufficient data' };
  // v4.9: Extract htfDir as primitive string (fixes String object === comparison bug)
  const htfDir = (htfBias && htfBias.dir) ? htfBias.dir : (typeof htfBias === 'string' ? htfBias : 'UNCLEAR');
  const usePDHL  = (tf !== '1W');
  const asiaLvls = (tf === '15m') ? (htfBias.__asiaLevels || []) : [];
  const levels   = findDMCLevels(c, usePDHL ? dCandles : null, tf, asiaLvls);
  const cur      = c[n-1];
  const tol      = a * 0.10;
  const nearby = levels
    .filter(l=>Math.abs(l.price-cur.c) < a*30)
    .sort((a,b)=>Math.abs(a.price-cur.c)-Math.abs(b.price-cur.c));

  if(tf !== '15m'){
    const isHTF = (tf==='1W' || tf==='1D');
    const blindCandidate = isHTF ? nearby.find(l=>{
      if(l.tested) return false;
      if(l.strength !== 'strong') return false;
      if(Math.abs(l.price - cur.c) > a * 0.8) return false;
      const eft = l.flippedType;
      const effType = eft==='flipped_support' ? 'support' : eft==='flipped_resistance' ? 'resistance' : l.type;
      if(effType==='resistance' && cur.c >= l.price) return false;
      if(effType==='support'    && cur.c <= l.price) return false;
      return true;
    }) : null;

    if(blindCandidate){
      const ft = blindCandidate.flippedType;
      const effectiveType = ft==='flipped_support' ? 'support' : ft==='flipped_resistance' ? 'resistance' : blindCandidate.type;
      const isRes  = effectiveType === 'resistance';
      const blindSig = isRes ? 'SHORT' : 'LONG';
      const isFlipped = ft==='flipped_support' || ft==='flipped_resistance';
      // v4.5: HTF ALWAYS takes precedence -- no strong-level bypass
      const htfBlocks = (isRes && htfDir==='UP') || (!isRes && htfDir==='DOWN');
      if(!htfBlocks){
        const tgt  = findNextLevel(levels, cur.c, isRes?'short':'long');
        const stop = findStopLevel(levels, blindCandidate.price, isRes?'short':'long', a, coinMinStopPct);
        const rr   = calcRR(cur.c, tgt.price, blindCandidate.price, stop, feeEst);
        if(rr && parseFloat(rr) >= coinMinRR){
          const dist = ((blindCandidate.price - cur.c)/cur.c*100).toFixed(2);
          const htfNote = htfDir!=='UNCLEAR' ? ` . HTF ${htfDir} aligns` : '';
          const typeLabel = isFlipped ? `PASS-THROUGH` : `UNTESTED ${tf}`;
          // v4.9: Require rejection + follow-through + momentum check
          const rejection = hasRejection(c, blindCandidate.price, blindSig, a);
          if(rejection.confirmed){
            // v4.9: LTF alignment -- 1W/1D signals must not conflict with lower-TF momentum
            // Only applies to HTF signals (1W/1D) -- 4H/1H left untouched to avoid over-filtering
            if((tf === '1W' || tf === '1D') && lowerCandles){
              const ltfCheck = hasLTFAlignment(blindSig, lowerCandles);
              if(!ltfCheck.aligned){
                const waitReason = ltfCheck.reason;
                const dir = isRes ? 'RESISTANCE -- lower TF opposing' : 'SUPPORT -- lower TF opposing';
                return { sig:'NEUTRAL', type:'AT_LEVEL', level:blindCandidate.price, target:tgt.price, strength:blindCandidate.strength, score:blindCandidate.score, reason:`WAIT: ${blindCandidate.source} $${fmt(blindCandidate.price)} . rejection confirmed BUT ${waitReason} . ${dir}` };
              }
            }
            return {
              sig:blindSig, type:'BLIND_ENTRY',
              level:blindCandidate.price, target:tgt.price, rr, stopPrice:stop,
              strength:blindCandidate.strength, score:blindCandidate.score,
              reason:`CONFIRMED: ${blindCandidate.source} $${fmt(blindCandidate.price)} . ${dist>0?'+':''}${dist}% . ${typeLabel} . rejection ${rejection.barsAgo} bars ago . follow-through confirmed${htfNote} . R:R ${rr} -> $${fmt(tgt.price)}`
            };
          }
          // No confirmed rejection -> downgrade to AT_LEVEL alert (no auto-trade)
          const waitReason = rejection.reason || 'no confirmed rejection + follow-through';
          const dir = isRes ? 'RESISTANCE -- waiting for confirmation' : 'SUPPORT -- waiting for confirmation';
          return { sig:'NEUTRAL', type:'AT_LEVEL', level:blindCandidate.price, target:tgt.price, strength:blindCandidate.strength, score:blindCandidate.score, reason:`PENDING: ${blindCandidate.source} $${fmt(blindCandidate.price)} . ${dist>0?'+':''}${dist}% . ${typeLabel} . ${waitReason} . ${dir}` };
        }
      }
    }
    // 4H/1H: Check if price is at a level WITH confirmed rejection -> produce entry
    const atLevelWindow = isHTF ? a * 0.4 : a * 1.0;
    const atLevel = nearby.find(l=>Math.abs(l.price-cur.c) < atLevelWindow && l.score >= 20);
    if(atLevel){
      const isRes = atLevel.type === 'resistance';
      const confSig = isRes ? 'SHORT' : 'LONG';
      const htfBlocks = (isRes && htfDir==='UP') || (!isRes && htfDir==='DOWN');
      // On 4H/1H: check for confirmed rejection to upgrade AT_LEVEL -> trade
      if((tf === '4H' || tf === '1H') && !htfBlocks){
        const rejection = hasRejection(c, atLevel.price, confSig, a);
        if(rejection.confirmed){
          const tgt  = findNextLevel(levels, cur.c, isRes?'short':'long');
          const stop = findStopLevel(levels, atLevel.price, isRes?'short':'long', a, coinMinStopPct);
          const rr   = calcRR(cur.c, tgt.price, atLevel.price, stop, feeEst);
          if(rr && parseFloat(rr) >= coinMinRR){
            const dist = ((atLevel.price - cur.c)/cur.c*100).toFixed(2);
            return {
              sig:confSig, type:'BLIND_ENTRY',
              level:atLevel.price, target:tgt.price, rr, stopPrice:stop,
              strength:atLevel.strength, score:atLevel.score,
              reason:`CONFIRMED ${tf}: ${atLevel.source} $${fmt(atLevel.price)} . ${dist>0?'+':''}${dist}% . rejection ${rejection.barsAgo} bars ago . follow-through confirmed . R:R ${rr} -> $${fmt(tgt.price)}`
            };
          }
        }

        // v4.9: STRONG BODY BOUNCE -- catches V-bounces without strict wick pattern
        // Fires when price touched level recently and bounced with a strong body candle
        if(!rejection.confirmed){
          const bounce = hasStrongBodyBounce(c, atLevel.price, confSig, a);
          if(bounce.confirmed){
            const tgt  = findNextLevel(levels, cur.c, isRes?'short':'long');
            const stop = findStopLevel(levels, atLevel.price, isRes?'short':'long', a, coinMinStopPct);
            const rr   = calcRR(cur.c, tgt.price, atLevel.price, stop, feeEst);
            if(rr && parseFloat(rr) >= coinMinRR){
              const dist = ((atLevel.price - cur.c)/cur.c*100).toFixed(2);
              return {
                sig:confSig, type:'BLIND_ENTRY',
                level:atLevel.price, target:tgt.price, rr, stopPrice:stop,
                strength:atLevel.strength, score:atLevel.score,
                reason:`CONFIRMED ${tf}: ${atLevel.source} $${fmt(atLevel.price)} . ${dist>0?'+':''}${dist}% . strong bounce ${bounce.barsAgo} bars ago . body ${bounce.bodyATR} ATR . R:R ${rr} -> $${fmt(tgt.price)}`
              };
            }
          }
        }
      }
      const dir  = atLevel.type==='resistance' ? 'RESISTANCE -- watch for rejection + follow-through' : 'SUPPORT -- watch for rejection + follow-through';
      const dist = ((atLevel.price - cur.c)/cur.c*100).toFixed(2);
      return { sig:'NEUTRAL', type:'AT_LEVEL', level:atLevel.price, target:null, strength:atLevel.strength, score:atLevel.score, reason:`${atLevel.source} $${fmt(atLevel.price)} . ${dist>0?'+':''}${dist}% . ${dir}` };
    }

    // -- BREAKDOWN / BREAKOUT DETECTION (v4.9) --------------------------
    if(isHTF){
      const breakLookback = Math.min(5, n - 1);
      for(const lv of nearby.filter(l => l.score >= 25)){
        const distFromLevel = (cur.c - lv.price) / lv.price;
        const isSup = lv.type === 'support' || lv.flippedType === 'flipped_support';
        const isRes = lv.type === 'resistance' || lv.flippedType === 'flipped_resistance';

        // BREAKDOWN SHORT: price broke below support
        if(isSup && distFromLevel < -0.0015 && cur.c < cur.o){
          const curBody = cur.o - cur.c;
          if(curBody < a * 0.08) continue;
          let aboveCount = 0;
          for(let bi = 1; bi <= breakLookback; bi++){
            const bk = c[n - 1 - bi];
            if(bk && bk.c >= lv.price - a * 0.1) aboveCount++;
          }
          if(aboveCount < 2) continue;
          // v5.0 FIX #7: Also block breakdowns when HTF is UNCLEAR (data gap / startup)
          if(htfDir === 'UP' || htfDir === 'UNCLEAR') continue;

          const tgt  = findNextLevel(levels, cur.c, 'short');
          const stop = lv.price + a * 0.3;
          const rr   = calcRR(cur.c, tgt.price, lv.price, stop, feeEst);
          if(!rr || parseFloat(rr) < coinMinRR) continue;

          const breakDist = (distFromLevel * 100).toFixed(2);
          const htfNote = htfDir === 'DOWN' ? ' . HTF DOWN aligns' : '';
          return {
            sig:'SHORT', type:'BLIND_ENTRY',
            level:lv.price, target:tgt.price, rr, stopPrice:stop,
            strength:lv.strength, score:lv.score,
            reason:`BREAKDOWN ${tf}: ${lv.source} $${fmt(lv.price)} broken . ${breakDist}% below . ${aboveCount}/${breakLookback} above${htfNote} . R:R ${rr}`,
            detail:`Support broken -- SL: $${fmt(stop)}`, untested:false
          };
        }

        // BREAKOUT LONG: price broke above resistance
        if(isRes && distFromLevel > 0.0015 && cur.c > cur.o){
          const curBody = cur.c - cur.o;
          if(curBody < a * 0.08) continue;
          let belowCount = 0;
          for(let bi = 1; bi <= breakLookback; bi++){
            const bk = c[n - 1 - bi];
            if(bk && bk.c <= lv.price + a * 0.1) belowCount++;
          }
          if(belowCount < 2) continue;
          // v5.0 FIX #7: Also block breakouts when HTF is UNCLEAR (data gap / startup)
          if(htfDir === 'DOWN' || htfDir === 'UNCLEAR') continue;

          const tgt  = findNextLevel(levels, cur.c, 'long');
          const stop = lv.price - a * 0.3;
          const rr   = calcRR(cur.c, tgt.price, lv.price, stop, feeEst);
          if(!rr || parseFloat(rr) < coinMinRR) continue;

          const breakDist = (distFromLevel * 100).toFixed(2);
          const htfNote = htfDir === 'UP' ? ' . HTF UP aligns' : '';
          return {
            sig:'LONG', type:'BLIND_ENTRY',
            level:lv.price, target:tgt.price, rr, stopPrice:stop,
            strength:lv.strength, score:lv.score,
            reason:`BREAKOUT ${tf}: ${lv.source} $${fmt(lv.price)} broken . +${breakDist}% above . ${belowCount}/${breakLookback} below${htfNote} . R:R ${rr}`,
            detail:`Resistance broken -- SL: $${fmt(stop)}`, untested:false
          };
        }
      }
    }

    return { sig:'NEUTRAL', type:'NONE', level:null, target:null, reason:'Between levels' };
  }

  // 15m trap detection
  const maxLB = 3;
  const htfBlockShort = htfDir === 'UP';
  const htfBlockLong  = htfDir === 'DOWN';

  for(const lv of nearby.filter(l=>l.type==='resistance')){
    for(let lb=1; lb<=maxLB; lb++){
      if(n-1-lb < 0) break;
      const trap    = c[n-1-lb];
      const confirm = c[n-1];
      const wickedThrough = trap.h  > lv.price + (tol*0.5);
      const bodyBelow     = trap.bh < lv.price - (lv.price*0.004);
      const wickSize      = trap.h - trap.bh;
      const bodyRange     = trap.bh - trap.bl;
      const strongReject  = wickSize > bodyRange * 0.5;
      if(!wickedThrough || !bodyBelow || !strongReject) continue;
      const priceRallied   = confirm.bh > trap.bh + a * 0.7;
      const levelReclaimed = c.slice(n-lb, n).some(k => k.bh > lv.price);
      const currentAbove   = confirm.bh > lv.price;
      const trapMid        = (trap.bh + trap.bl) / 2;
      const confirmFollows = confirm.c <= trapMid;
      if(priceRallied || levelReclaimed || currentAbove || !confirmFollows) continue;
      if(htfBlockShort) continue;
      const tgt  = findNextLevel(levels, confirm.c, 'short');
      const stop = findStopLevel(levels, lv.price, 'short', a, coinMinStopPct);
      const rr   = calcRR(confirm.c, tgt.price, lv.price, stop, feeEst);
      if(rr && parseFloat(rr) < MIN_RR) continue;
      const dist = ((lv.price - confirm.c)/confirm.c*100).toFixed(2);
      return { sig:'SHORT', type:'FAIL_GAIN', level:lv.price, target:tgt.price, rr, stopPrice:stop, strength:lv.strength, score:lv.score, reason:`${lv.source} $${fmt(lv.price)} . ${dist}% above . ${lb===1?'just now':lb+' bars ago'}${rr?` . R:R ${rr}`:''} -> $${fmt(tgt.price)}` };
    }
  }
  for(const lv of nearby.filter(l=>l.type==='support')){
    for(let lb=1; lb<=maxLB; lb++){
      if(n-1-lb < 0) break;
      const trap    = c[n-1-lb];
      const confirm = c[n-1];
      const wickedThrough = trap.l  < lv.price - (tol*0.5);
      const bodyAbove     = trap.bl > lv.price + (lv.price*0.004);
      const wickSize      = trap.bl - trap.l;
      const bodyRange     = trap.bh - trap.bl;
      const strongReject  = wickSize > bodyRange * 0.5;
      if(!wickedThrough || !bodyAbove || !strongReject) continue;
      const priceDropped   = confirm.bl < trap.bl - a * 0.7;
      const levelReclaimed = c.slice(n-lb, n).some(k => k.bl < lv.price);
      const currentBelow   = confirm.bl < lv.price;
      const trapMid        = (trap.bh + trap.bl) / 2;
      const confirmFollows = confirm.c >= trapMid;
      if(priceDropped || levelReclaimed || currentBelow || !confirmFollows) continue;
      if(htfBlockLong) continue;
      const tgt  = findNextLevel(levels, confirm.c, 'long');
      const stop = findStopLevel(levels, lv.price, 'long', a, coinMinStopPct);
      const rr   = calcRR(confirm.c, tgt.price, lv.price, stop, feeEst);
      if(rr && parseFloat(rr) < MIN_RR) continue;
      const dist = ((confirm.c - lv.price)/confirm.c*100).toFixed(2);
      return { sig:'LONG', type:'FAIL_LOSE', level:lv.price, target:tgt.price, rr, stopPrice:stop, strength:lv.strength, score:lv.score, reason:`${lv.source} $${fmt(lv.price)} . ${dist}% below . ${lb===1?'just now':lb+' bars ago'}${rr?` . R:R ${rr}`:''} -> $${fmt(tgt.price)}` };
    }
  }
  const atLevel = nearby.find(l=>Math.abs(l.price-cur.c) < a*1.5 && l.score>=20);
  if(atLevel){
    const dist = ((atLevel.price - cur.c)/cur.c*100).toFixed(2);
    const dir  = atLevel.type==='resistance' ? 'RESISTANCE -- watch for wick + body close back below' : 'SUPPORT -- watch for wick + body close back above';
    return { sig:'NEUTRAL', type:'AT_LEVEL', level:atLevel.price, target:null, strength:atLevel.strength, score:atLevel.score, reason:`${atLevel.source} $${fmt(atLevel.price)} . ${dist>0?'+':''}${dist}% . ${dir}` };
  }
  return { sig:'NEUTRAL', type:'NONE', level:null, target:null, reason:'Between levels' };
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
  const threshold = 2;
  if(bullScore>=threshold && bullScore>bearScore) return { dir:'UP' };
  if(bearScore>=threshold && bearScore>bullScore) return { dir:'DOWN' };
  if(h4FailedHigh && h1Bearish) return { dir:'DOWN' };
  if(h4FailedLow  && h1Bullish) return { dir:'UP' };
  if(h4n.bh>h4p.bh && h4n.bl>h4p.bl) return { dir:'UP' };
  if(h4n.bh<h4p.bh && h4n.bl<h4p.bl) return { dir:'DOWN' };
  return { dir:'UNCLEAR' };
}

// ==============================================================================
// ##  HYPERLIQUID TRADING MODULE                                            ##
// ==============================================================================

const HL = {
  wallet: null,
  address: '',
  masterAddress: '',
  assetMap: {},
  szDecimals: {},
  enabled: false,
  activeTrades: {},
  cachedEquity: 0,
  _lastEquitySync: 0,
  tradesToday: 0,
  lastTradeDay: '',

  // v5.0: Post-loss cooldown -- tracks last SL time per coin (ms timestamp)
  lastSlTime: {},   // coinId -> timestamp of last SL hit
  COOLDOWN_MS: parseInt(process.env.COOLDOWN_MS || '600000'), // 10 min default (2x 15m candle)

  // v5.0: Daily P&L limit tracking
  dailyPnl: 0,
  dailyPnlDate: '',
  DAILY_LOSS_LIMIT: parseFloat(process.env.DAILY_LOSS_LIMIT || '-10'),  // pause after -$10
  DAILY_LOSS_REDUCE: 0.5, // reduce size to 50% after hitting limit

  // v5.1: Counter-trend blocking -- remembers last profitable trade direction per coin
  lastWinDir: {},    // coinId -> 'LONG' or 'SHORT'
  lastWinTime: {},   // coinId -> ms timestamp of the profitable close
  COUNTER_TREND_WINDOW: 86400000,  // 24h window to boost counter-trend confidence
  COUNTER_TREND_CONF_BOOST: 25,    // +25% confidence needed for counter-trend after recent win

  // v5.1: Per-asset rolling loss circuit breaker
  consecutiveLosses: {},  // coinId -> count of consecutive losses
  MAX_CONSEC_LOSSES: parseInt(process.env.MAX_CONSEC_LOSSES || '3'), // pause after N consecutive losses

  // v5.1: Trailing-stop failure tracking (prevents 1000-alert spam)
  trailFailCount: {},     // coinId -> consecutive failure count
  lastTrailFailAlert: {}, // coinId -> ms timestamp of last alert sent
  TRAIL_ALERT_THROTTLE_MS: 1800000, // 30 min between failure alerts
  MAX_TRAIL_FAILURES: 3,  // after N failures, disable trailing for this trade

  // -- MSGPACK encoder (matches app exactly) --
  msgpack(obj) {
    const buf = [];
    const writeStr = (s) => {
      const b = new TextEncoder().encode(s);
      if (b.length < 32) buf.push(0xa0 | b.length);
      else if (b.length < 256) { buf.push(0xd9); buf.push(b.length); }
      else { buf.push(0xda); buf.push(b.length >> 8); buf.push(b.length & 0xff); }
      for (const c of b) buf.push(c);
    };
    const writeInt = (n) => {
      if (n >= 0 && n < 128) { buf.push(n); }
      else if (n >= 0 && n < 256) { buf.push(0xcc); buf.push(n); }
      else if (n >= 0 && n < 65536) { buf.push(0xcd); buf.push(n >> 8); buf.push(n & 0xff); }
      else if (n >= 0) { buf.push(0xce); buf.push((n >>> 24) & 0xff); buf.push((n >>> 16) & 0xff); buf.push((n >>> 8) & 0xff); buf.push(n & 0xff); }
      else if (n >= -32) { buf.push(n & 0xff); }
      else if (n >= -128) { buf.push(0xd0); buf.push(n & 0xff); }
    };
    const enc = (v) => {
      if (v === null || v === undefined) { buf.push(0xc0); }
      else if (typeof v === 'boolean') { buf.push(v ? 0xc3 : 0xc2); }
      else if (typeof v === 'number' && Number.isInteger(v)) { writeInt(v); }
      else if (typeof v === 'string') { writeStr(v); }
      else if (Array.isArray(v)) {
        if (v.length < 16) buf.push(0x90 | v.length); else { buf.push(0xdc); buf.push(v.length >> 8); buf.push(v.length & 0xff); }
        for (const item of v) enc(item);
      } else if (typeof v === 'object') {
        const keys = Object.keys(v);
        if (keys.length < 16) buf.push(0x80 | keys.length); else { buf.push(0xde); buf.push(keys.length >> 8); buf.push(keys.length & 0xff); }
        for (const k of keys) { enc(k); enc(v[k]); }
      }
    };
    enc(obj);
    return new Uint8Array(buf);
  },

  // -- Compute action hash for phantom agent signing --
  computeActionHash(action, nonce, vaultAddress) {
    const packed = this.msgpack(action);
    const nonceBuf = new Uint8Array(8);
    let n = BigInt(nonce);
    for (let i = 7; i >= 0; i--) { nonceBuf[i] = Number(n & 0xFFn); n >>= 8n; }
    let vaultBuf;
    if (vaultAddress) {
      const addrBytes = ethers.utils.arrayify(vaultAddress);
      vaultBuf = new Uint8Array(1 + addrBytes.length);
      vaultBuf[0] = 1;
      vaultBuf.set(addrBytes, 1);
    } else {
      vaultBuf = new Uint8Array([0]);
    }
    const combined = new Uint8Array(packed.length + nonceBuf.length + vaultBuf.length);
    combined.set(packed);
    combined.set(nonceBuf, packed.length);
    combined.set(vaultBuf, packed.length + nonceBuf.length);
    return ethers.utils.keccak256(combined);
  },

  // -- Sign L1 action (phantom agent EIP-712) --
  async signL1Action(action, nonce, vaultAddress) {
    const hash = this.computeActionHash(action, nonce, vaultAddress || null);
    const domain = {
      name: 'Exchange', version: '1',
      chainId: 1337,
      verifyingContract: '0x0000000000000000000000000000000000000000'
    };
    const types = {
      Agent: [
        { name: 'source', type: 'string' },
        { name: 'connectionId', type: 'bytes32' }
      ]
    };
    const value = { source: 'a', connectionId: hash };
    const sig = await this.wallet._signTypedData(domain, types, value);
    return ethers.utils.splitSignature(sig);
  },

  // -- Float to wire: match Python SDK --
  floatToWire(x) {
    const s = parseFloat(parseFloat(x).toPrecision(5)).toString();
    if (s.includes('.')) return s.replace(/\.?0+$/, '') || '0';
    return s;
  },

  // -- Build order type wire --
  orderTypeToWire(orderType) {
    if (orderType.limit) {
      return { limit: { tif: orderType.limit.tif } };
    } else if (orderType.trigger) {
      return { trigger: {
        isMarket: orderType.trigger.isMarket,
        triggerPx: this.floatToWire(orderType.trigger.triggerPx),
        tpsl: orderType.trigger.tpsl
      }};
    }
    return orderType;
  },

  // -- Initialize HL module --
  async init() {
    if (!HL_PRIVATE_KEY) {
      console.log('HL: No private key configured, auto-trade disabled.');
      return false;
    }
    try {
      this.wallet = new ethers.Wallet(HL_PRIVATE_KEY);
      this.address = this.wallet.address;
      this.masterAddress = HL_MASTER_ADDR;
      await this.fetchMeta();
      this.enabled = AUTO_TRADE;
      this.tradesToday = 0;
      this.lastTradeDay = new Date().toDateString();
      this.loadActiveTrades();
      console.log('HL loaded persisted trades:', Object.keys(this.activeTrades).length, '->', JSON.stringify(this.activeTrades));
      await this.syncPositions();
      await this.syncEquity();
      console.log('HL ready:', this.address, '| Master:', this.masterAddress || 'not set', '| Auto:', this.enabled, '| Equity: $' + this.cachedEquity.toFixed(2), '| Assets:', Object.keys(this.assetMap).join(', '));
      return true;
    } catch (e) {
      console.error('HL init failed:', e);
      return false;
    }
  },

  async fetchMeta() {
    // Fetch all perp metas (main + HIP-3 dexes like xyz:GOLD)
    const res = await fetch(HL_API + '/info', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'allPerpMetas' })
    });
    const allMetas = await res.json();
    // Dex 0 = main validator perps (assetId = index)
    // Dex N (N>=1) = HIP-3: assetId = 100000 + N * 10000 + index_in_meta
    allMetas.forEach((dex, dexIdx) => {
      dex.universe.forEach((a, i) => {
        const assetId = dexIdx === 0 ? i : (100000 + dexIdx * 10000 + i);
        this.assetMap[a.name] = assetId;
        this.szDecimals[a.name] = a.szDecimals;
      });
    });
    console.log('HL meta: ' + Object.keys(this.assetMap).length + ' assets loaded (' + allMetas.length + ' dexes)');
    if (this.assetMap['xyz:GOLD'] !== undefined) console.log('  xyz:GOLD -> assetId', this.assetMap['xyz:GOLD'], 'szDec', this.szDecimals['xyz:GOLD']);
  },

  // -- Get balance (perps + spot) --
  async getBalance() {
    if (!this.wallet) return 0;
    const queryAddr = (this.masterAddress || this.address).toLowerCase();
    const [perpsRes, spotRes] = await Promise.all([
      fetch(HL_API + '/info', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'clearinghouseState', user: queryAddr })
      }),
      fetch(HL_API + '/info', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'spotClearinghouseState', user: queryAddr })
      })
    ]);
    const perpsData = await perpsRes.json();
    const spotData = await spotRes.json();
    const ms = perpsData.marginSummary || {};
    const perpsVal = parseFloat(ms.accountValue || '0');
    const cms = perpsData.crossMarginSummary || {};
    const crossVal = parseFloat(cms.accountValue || '0');
    let spotVal = 0;
    if (spotData.balances) {
      for (const b of spotData.balances) {
        if (b.coin === 'USDC' || b.coin === 'USDT') spotVal += parseFloat(b.total || '0');
      }
    }
    return Math.max(perpsVal, crossVal, spotVal);
  },

  async syncEquity() {
    try {
      const bal = await this.getBalance();
      if (bal > 0) {
        this.cachedEquity = bal;
        this._lastEquitySync = Date.now();
        console.log('HL equity synced: $' + bal.toFixed(2));
      }
    } catch (e) { console.warn('HL syncEquity failed:', e.message); }
  },

  // -- Persist active trades to file (replaces localStorage) --
  saveActiveTrades() {
    try { fs.writeFileSync(ACTIVE_TRADES_FILE, JSON.stringify(this.activeTrades)); } catch(e){}
  },
  loadActiveTrades() {
    try {
      if (fs.existsSync(ACTIVE_TRADES_FILE)) {
        this.activeTrades = JSON.parse(fs.readFileSync(ACTIVE_TRADES_FILE, 'utf8'));
      }
    } catch(e){ this.activeTrades = {}; }
  },

  // -- HIP-3 dexes we trade on (for querying positions, orders, fills) --
  HIP3_DEXES: ['xyz'],

  // -- Fetch trigger orders (SL/TP) -- queries main + HIP-3 dexes --
  async fetchTriggerOrders() {
    try {
      const queryAddr = (this.masterAddress || this.address).toLowerCase();
      const requests = [
        fetch(HL_API + '/info', { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type: 'frontendOpenOrders', user: queryAddr }) }),
        ...this.HIP3_DEXES.map(dex =>
          fetch(HL_API + '/info', { method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ type: 'frontendOpenOrders', user: queryAddr, dex }) }))
      ];
      const responses = await Promise.all(requests);
      const allOrders = [];
      for (const r of responses) {
        const data = await r.json();
        if (Array.isArray(data)) allOrders.push(...data);
      }
      return allOrders;
    } catch(e) { console.warn('fetchTriggerOrders error:', e.message); return []; }
  },

  // -- Sync positions with real HL state (main + HIP-3 dexes) --
  async syncPositions() {
    try {
      const queryAddr = (this.masterAddress || this.address).toLowerCase();
      const [posRes, ...hip3PosRes] = await Promise.all([
        fetch(HL_API + '/info', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type: 'clearinghouseState', user: queryAddr })
        }),
        ...this.HIP3_DEXES.map(dex =>
          fetch(HL_API + '/info', { method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ type: 'clearinghouseState', user: queryAddr, dex }) }))
      ]);
      const trigOrders = await this.fetchTriggerOrders();
      const data = await posRes.json();
      const positions = [...(data.assetPositions || [])];
      // Merge HIP-3 positions
      for (const r of hip3PosRes) {
        const d = await r.json();
        if (d.assetPositions) positions.push(...d.assetPositions);
      }
      const symToId = { BTC: 'bitcoin', HYPE: 'hyperliquid', 'S&P500': 'sp500', 'xyz:SP500': 'sp500', GOLD: 'gold', 'xyz:GOLD': 'gold' };

      // Build SL/TP map from trigger orders
      const trigMap = {};
      if (Array.isArray(trigOrders)) {
        for (const o of trigOrders) {
          const coin = o.coin;
          if (!coin) continue;
          if (!trigMap[coin]) trigMap[coin] = {};
          const trigPx = parseFloat(o.triggerPx || '0');
          if (trigPx <= 0) continue;
          const ot = (o.orderType || '').toLowerCase();
          if (ot.includes('stop') || o.tpsl === 'sl') trigMap[coin].sl = trigPx;
          else if (ot.includes('take profit') || o.tpsl === 'tp') trigMap[coin].tp = trigPx;
        }
      }

      const oldTrades = { ...this.activeTrades };
      const nowOpen = new Set();
      this.activeTrades = {};
      for (const p of positions) {
        const pos = p.position;
        if (!pos || parseFloat(pos.szi) === 0) continue;
        const coinId = symToId[pos.coin];
        if (!coinId) continue;
        nowOpen.add(coinId);
        const szi = parseFloat(pos.szi);
        const entry = parseFloat(pos.entryPx || '0');
        const trig = trigMap[pos.coin] || {};
        const prev = oldTrades[coinId];
        if (prev && prev.side === (szi > 0 ? 'LONG' : 'SHORT') && prev.trailState) {
          this.activeTrades[coinId] = {
            ...prev,
            size: Math.abs(szi),
            entry: entry,
            sl: trig.sl || prev.sl || null,
            tp: trig.tp || prev.tp || null
          };
        } else {
          this.activeTrades[coinId] = {
            asset: pos.coin,
            side: szi > 0 ? 'LONG' : 'SHORT',
            size: Math.abs(szi),
            entry: entry,
            sl: trig.sl || null,
            tp: trig.tp || null,
            initialSl: trig.sl || 0,
            bestPrice: entry,
            trailState: 'initial'
          };
        }
      }

      // Detect closed positions
      for (const [coinId, old] of Object.entries(oldTrades)) {
        if (nowOpen.has(coinId)) continue;
        if (!old.entry || !old.asset) continue;
        const s = coinState[coinId];
        // Use current price if available and valid, otherwise fall back to entry (never $0)
        const exitPx = (s && s.price > 0) ? s.price : old.entry;
        const isLong = old.side === 'LONG';
        const pnl = isLong ? (exitPx - old.entry) * old.size : (old.entry - exitPx) * old.size;
        // Detect TP/SL by proximity (within 2% of the level) rather than directional check
        let reason = 'auto_closed';
        const tpDist = old.tp ? Math.abs(exitPx - old.tp) / old.tp : Infinity;
        const slDist = old.sl ? Math.abs(exitPx - old.sl) / old.sl : Infinity;
        if (tpDist < 0.02 && tpDist <= slDist) reason = 'tp_hit';
        else if (slDist < 0.02 && slDist < tpDist) reason = 'sl_hit';
        else if (old.sl && ((isLong && exitPx <= old.sl) || (!isLong && exitPx >= old.sl))) reason = 'sl_hit';

        const closed = loadClosedTrades();
        closed.unshift({
          coin: old.asset, side: old.side, size: old.size,
          entry: old.entry, exit: exitPx, pnl, ts: new Date().toISOString(), reason
        });
        saveClosedTrades(closed);

        const emoji = reason === 'tp_hit' ? '✅' : reason === 'sl_hit' ? '🛑' : '📊';
        const label = reason === 'tp_hit' ? 'TP HIT' : reason === 'sl_hit' ? 'SL HIT' : 'CLOSED';
        console.log(`HL POSITION CLOSED: ${label} ${old.side} ${old.asset} | P&L: $${pnl.toFixed(2)}`);

        // v5.0: Record SL cooldown timestamp for this coin
        if (reason === 'sl_hit') {
          this.lastSlTime[coinId] = Date.now();
          console.log(`HL COOLDOWN: ${coinId} on cooldown for ${this.COOLDOWN_MS/1000}s after SL hit`);
        }

        // v5.1: Reset trail-failure tracking on position close (new trade starts clean)
        this.trailFailCount[coinId] = 0;
        delete this.lastTrailFailAlert[coinId];

        // v5.1: Track consecutive losses and last winning direction per coin
        if (pnl > 0) {
          this.consecutiveLosses[coinId] = 0;
          this.lastWinDir[coinId] = old.side;   // 'LONG' or 'SHORT'
          this.lastWinTime[coinId] = Date.now();
          console.log(`HL WIN TRACKER: ${coinId} last win direction=${old.side}, consecutive losses reset to 0`);
        } else if (pnl < 0) {
          this.consecutiveLosses[coinId] = (this.consecutiveLosses[coinId] || 0) + 1;
          console.log(`HL LOSS TRACKER: ${coinId} consecutive losses=${this.consecutiveLosses[coinId]}/${this.MAX_CONSEC_LOSSES}`);
          if (this.consecutiveLosses[coinId] >= this.MAX_CONSEC_LOSSES) {
            console.warn(`HL CIRCUIT BREAKER: ${coinId} paused -- ${this.consecutiveLosses[coinId]} consecutive losses`);
            const cbCoin = COINS[coinId];
            await sendTelegram(`⏸ <b>${cbCoin?.label || coinId} CIRCUIT BREAKER</b>\n${this.consecutiveLosses[coinId]} consecutive losses -- auto-trading paused for this asset.`);
          }
        }

        // v5.0: Track daily P&L
        const pnlDay = new Date().toDateString();
        if (pnlDay !== this.dailyPnlDate) { this.dailyPnl = 0; this.dailyPnlDate = pnlDay; }
        this.dailyPnl += pnl;
        const dailyStr = this.dailyPnl >= 0 ? `+$${this.dailyPnl.toFixed(2)}` : `-$${Math.abs(this.dailyPnl).toFixed(2)}`;

        await sendTelegram(`${emoji} <b>${label}: ${old.side} ${old.asset}</b>\nEntry: $${fmt(old.entry)}\nExit: $${fmt(exitPx)}\nP&L: <b>$${pnl.toFixed(2)}</b>\nDaily P&L: ${dailyStr}`);
      }

      this.saveActiveTrades();
      console.log('HL positions synced:', Object.keys(this.activeTrades).length, 'open');
    } catch(e) { console.warn('HL syncPositions error:', e.message); }
  },

  // -- Place an order --
  async placeOrder(asset, isBuy, size, price, orderType, reduceOnly = false) {
    const assetIdx = this.assetMap[asset];
    if (assetIdx === undefined) throw new Error('Unknown asset: ' + asset + ' (loaded: ' + Object.keys(this.assetMap).join(',') + ')');
    const szDec = this.szDecimals[asset] || 3;
    const sizeStr = this.floatToWire(parseFloat(size.toFixed(szDec)));
    const priceStr = this.floatToWire(price);
    const orderWire = { a: assetIdx, b: isBuy, p: priceStr, s: sizeStr, r: reduceOnly, t: this.orderTypeToWire(orderType) };
    const action = { type: 'order', orders: [orderWire], grouping: 'na' };
    const nonce = Date.now();
    const signature = await this.signL1Action(action, nonce, null);
    if (!signature || !signature.r) throw new Error('Signing failed -- null signature');
    const payload = { action, nonce, signature: { r: signature.r, s: signature.s, v: signature.v } };
    console.log('HL order:', asset, isBuy ? 'BUY' : 'SELL', sizeStr, '@', priceStr, reduceOnly ? '(reduce)' : '', 'assetIdx:', assetIdx);

    let res;
    try {
      res = await fetch(HL_API + '/exchange', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
    } catch (fetchErr) {
      throw new Error('HL API fetch failed: ' + fetchErr.message);
    }

    if (!res.ok) {
      const body = await res.text().catch(() => '(empty)');
      throw new Error('HL API HTTP ' + res.status + ': ' + body.slice(0, 200));
    }

    let result;
    try {
      result = await res.json();
    } catch (parseErr) {
      throw new Error('HL API response not valid JSON (HTTP ' + res.status + ')');
    }
    if (!result) throw new Error('HL API returned null (HTTP ' + res.status + ')');

    // Log raw response for debugging
    console.log('HL response:', JSON.stringify(result).slice(0, 300));

    if (result.status === 'ok' && result.response?.data?.statuses) {
      const s = result.response.data.statuses[0];
      if (s?.error) {
        console.error('HL order error:', s.error);
        return { status: 'err', response: s.error };
      }
      if (s?.filled) {
        console.log('HL FILLED:', s.filled.totalSz, '@', s.filled.avgPx);
        return { status: 'ok', filled: true, totalSz: s.filled.totalSz, avgPx: s.filled.avgPx, oid: s.filled.oid, raw: result };
      }
      if (s?.resting) {
        console.log('HL RESTING:', s.resting.oid);
        return { status: 'ok', filled: false, resting: true, oid: s.resting.oid, raw: result };
      }
    }
    // Unexpected response shape -- return as-is but log a warning
    if (result.status === 'err') {
      console.error('HL API error:', result.response || result);
      return { status: 'err', response: result.response || JSON.stringify(result).slice(0, 200) };
    }
    console.warn('HL unexpected response shape:', JSON.stringify(result).slice(0, 300));
    return result;
  },

  // -- Fetch open orders (main + HIP-3 dexes) --
  async fetchOpenOrders() {
    // v5.1 FIX: Use frontendOpenOrders instead of openOrders.
    // The standard openOrders endpoint does NOT return the orderType field, so
    // trigger orders (Stop Market / TP) are indistinguishable from limit orders.
    // frontendOpenOrders returns orderType + isTrigger + triggerPx fields,
    // which cancelTriggerOrders needs to filter correctly.
    const queryAddr = (this.masterAddress || this.address).toLowerCase();
    const requests = [
      fetch(HL_API + '/info', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'frontendOpenOrders', user: queryAddr }) }),
      ...this.HIP3_DEXES.map(dex =>
        fetch(HL_API + '/info', { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type: 'frontendOpenOrders', user: queryAddr, dex }) }))
    ];
    const responses = await Promise.all(requests);
    const allOrders = [];
    for (const r of responses) {
      const data = await r.json();
      if (Array.isArray(data)) allOrders.push(...data);
    }
    return allOrders;
  },

  // -- Cancel an order --
  async cancelOrder(asset, oid) {
    const assetIdx = this.assetMap[asset];
    if (assetIdx === undefined) return;
    const action = { type: 'cancel', cancels: [{ a: assetIdx, o: oid }] };
    const nonce = Date.now();
    const signature = await this.signL1Action(action, nonce, null);
    const payload = { action, nonce, signature: { r: signature.r, s: signature.s, v: signature.v } };
    const res = await fetch(HL_API + '/exchange', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    return await res.json();
  },

  // -- Cancel all trigger orders for an asset --
  // v5.1 FIX: Use isTrigger flag from frontendOpenOrders (standard openOrders lacks orderType)
  async cancelTriggerOrders(asset) {
    try {
      const orders = await this.fetchOpenOrders();
      // A trigger order has isTrigger === true OR orderType containing "Stop"/"Take"
      // (some HL responses only set one of these, so check both for safety)
      const triggers = orders.filter(o => {
        if (o.coin !== asset) return false;
        if (o.isTrigger === true) return true;
        if (o.orderType && /Stop|Take|Trigger/i.test(o.orderType)) return true;
        return false;
      });
      if (triggers.length > 0) {
        console.log(`HL cancelTriggerOrders: ${asset} found ${triggers.length} trigger order(s) to cancel`);
      }
      for (const o of triggers) {
        try {
          await this.cancelOrder(asset, o.oid);
        } catch (e) {
          console.warn(`cancelTriggerOrders: failed to cancel oid ${o.oid}:`, e.message);
        }
      }
      return triggers.length;
    } catch (e) { console.warn('cancelTriggerOrders error:', e.message); return 0; }
  },

  // -- Execute full trade: market entry + SL + TP --
  async executeTrade(coinId, signal, confidence) {
    const coin = COINS[coinId];
    const asset = coin?.asset;
    if (!asset || !this.enabled || !this.wallet) return null;

    // Daily trade limit
    const today = new Date().toDateString();
    if (today !== this.lastTradeDay) { this.tradesToday = 0; this.lastTradeDay = today; }
    if (this.tradesToday >= MAX_TRADES_DAY) {
      console.warn('HL: daily trade limit reached (' + MAX_TRADES_DAY + ')');
      return null;
    }

    // v5.0: Post-loss cooldown check (#3)
    const lastSl = this.lastSlTime[coinId];
    if (lastSl && (Date.now() - lastSl) < this.COOLDOWN_MS) {
      const remaining = Math.round((this.COOLDOWN_MS - (Date.now() - lastSl)) / 1000);
      console.warn(`HL: ${coinId} on post-loss cooldown (${remaining}s remaining), skipping`);
      return null;
    }

    // v5.1: Per-asset rolling loss circuit breaker
    const consecLosses = this.consecutiveLosses[coinId] || 0;
    if (consecLosses >= this.MAX_CONSEC_LOSSES) {
      console.warn(`HL CIRCUIT BREAKER: ${coinId} blocked -- ${consecLosses} consecutive losses (max ${this.MAX_CONSEC_LOSSES}). Manual review needed.`);
      await sendTelegram(`⏸ <b>${coin.label} PAUSED</b>\n${consecLosses} consecutive losses -- trading paused until a manual reset or profitable close.`);
      return null;
    }

    // v5.1: Counter-trend blocking after recent profitable trade
    // If the last profitable trade on this coin was in the opposite direction within 24h,
    // require higher confidence to enter (prevents flipping against a validated trend)
    const recentWinDir = this.lastWinDir[coinId];
    const recentWinTime = this.lastWinTime[coinId];
    if (recentWinDir && recentWinTime && (Date.now() - recentWinTime) < this.COUNTER_TREND_WINDOW) {
      if (signal.sig !== recentWinDir) {
        const requiredConf = MIN_CONFIDENCE + this.COUNTER_TREND_CONF_BOOST;
        if (confidence < requiredConf) {
          console.warn(`HL COUNTER-TREND BLOCK: ${coinId} -- last win was ${recentWinDir} ${((Date.now()-recentWinTime)/3600000).toFixed(1)}h ago, ${signal.sig} needs conf ${requiredConf}% (has ${confidence}%)`);
          return null;
        }
        console.log(`HL: ${coinId} counter-trend ${signal.sig} allowed -- conf ${confidence}% >= ${requiredConf}% (last win ${recentWinDir})`);
      }
    }

    // v5.0: Daily P&L limit check (#8)
    const pnlDay = new Date().toDateString();
    if (pnlDay !== this.dailyPnlDate) { this.dailyPnl = 0; this.dailyPnlDate = pnlDay; }

    const { sig, level, stopPrice, rr, type } = signal;
    let { target } = signal;
    if (!stopPrice) { console.warn('HL: no stop price, skipping'); return null; }

    const isBuy = sig === 'LONG';
    // v5.0 FIX #5: Fetch fresh price instead of using potentially stale coinState
    // coinState price could be 30-60s old from last scan cycle
    let currentPrice;
    try {
      const freshData = await getPrice(coinId);
      currentPrice = freshData?.price || coinState[coinId]?.price;
    } catch (e) {
      currentPrice = coinState[coinId]?.price;
      console.warn('HL: fresh price fetch failed, using cached:', e.message);
    }
    if (!currentPrice) { console.warn('HL: no price for', coinId); return null; }

    // Dynamic R:R cap
    const htfDir = coinState[coinId]?.htfDir || 'UNCLEAR';
    const withTrend = (sig === 'LONG' && htfDir === 'UP') || (sig === 'SHORT' && htfDir === 'DOWN');
    const maxRR = withTrend ? 4.0 : 2.5;
    const risk = Math.abs(currentPrice - stopPrice);
    const maxReward = risk * maxRR;
    if (target) {
      const actualReward = Math.abs(target - currentPrice);
      if (actualReward > maxReward) {
        target = isBuy ? currentPrice + maxReward : currentPrice - maxReward;
        console.log(`HL: capped TP to R:R ${maxRR} (${withTrend?'with':'counter'}-trend) ->`, target.toFixed(1));
      }
    }

    // Position sizing
    const accountSize = this.cachedEquity > 0 ? this.cachedEquity : 100;
    let riskPct = RISK_PCT;

    // v5.0: Reduce position size by 50% if daily loss limit breached (#8)
    if (this.dailyPnl <= this.DAILY_LOSS_LIMIT) {
      riskPct = RISK_PCT * this.DAILY_LOSS_REDUCE;
      console.warn(`HL: daily P&L $${this.dailyPnl.toFixed(2)} <= limit $${this.DAILY_LOSS_LIMIT} -- reducing risk to ${riskPct}%`);
    }

    const riskAmount = accountSize * riskPct / 100;
    const slDistance = Math.abs(currentPrice - stopPrice);
    // v5.0: Use per-coin minStopPct instead of hard 0.3%
    const minStopDist = currentPrice * (coin.minStopPct || 0.005);
    if (slDistance < minStopDist) { console.warn('HL: SL too tight (' + (slDistance/currentPrice*100).toFixed(3) + '% < ' + ((coin.minStopPct||0.005)*100).toFixed(1) + '%)'); return null; }

    let size = riskAmount / slDistance;
    const szDec = this.szDecimals[asset] || 3;

    // v5.0: Cap max notional for HIP-3 assets (#4)
    // v5.0.1: Added verbose logging + hard enforcement to catch bypass bugs
    const maxNotional = coin.maxNotional || 0;
    console.log(`HL: ${asset} sizing: raw size=${size.toFixed(szDec)} notional=$${(size*currentPrice).toFixed(0)} maxNotional=${maxNotional} coinId=${coinId}`);
    if (maxNotional > 0) {
      const notional = size * currentPrice;
      if (notional > maxNotional) {
        const oldSize = size;
        size = maxNotional / currentPrice;
        console.log(`HL: CAPPED ${asset} notional $${notional.toFixed(0)} -> $${maxNotional} (size ${oldSize.toFixed(szDec)} -> ${size.toFixed(szDec)})`);
      }
    }

    // v5.0.1: Safety-net double-check — hard block if notional still exceeds 1.1x cap after rounding
    // This catches any edge case where the cap above was bypassed
    if (maxNotional > 0) {
      const finalNotional = parseFloat(size.toFixed(szDec)) * currentPrice;
      if (finalNotional > maxNotional * 1.1) {
        console.error(`HL: HARD BLOCK ${asset} — notional $${finalNotional.toFixed(0)} exceeds ${maxNotional}*1.1 after rounding! This should not happen.`);
        await sendTelegram(`🚨 <b>HARD BLOCK: ${asset}</b>\nNotional $${finalNotional.toFixed(0)} exceeds cap $${maxNotional} after rounding.\nTrade rejected. Check maxNotional logic.`);
        return null;
      }
    }

    const minSize = Math.pow(10, -szDec);
    if (size < minSize) { console.warn('HL: size too small:', size); return null; }

    // v5.0: HIP-3 assets use GTC limit at best bid/ask instead of IOC taker (#1)
    const isHIP3 = coin.isHIP3 || false;
    let entryPx, entryOrderType;
    if (isHIP3) {
      // Place limit at 0.05% through the spread for quick fill without taker fee
      const limitSlip = currentPrice * 0.0005;
      entryPx = isBuy ? currentPrice + limitSlip : currentPrice - limitSlip;
      entryOrderType = { limit: { tif: 'Gtc' } };
      console.log(`HL: ${asset} using GTC limit order @ ${entryPx.toFixed(1)} (HIP-3 fee optimization)`);
    } else {
      // Standard: IOC limit with 1% slippage (taker)
      const slip = currentPrice * 0.01;
      entryPx = isBuy ? currentPrice + slip : currentPrice - slip;
      entryOrderType = { limit: { tif: 'Ioc' } };
    }

    try {
      // 1. Entry order (IOC for standard, GTC limit for HIP-3)
      const entryRes = await this.placeOrder(asset, isBuy, size, entryPx, entryOrderType);
      if (!entryRes) { console.error('HL entry returned null'); return null; }
      if (entryRes.status === 'err') { console.error('HL entry failed:', entryRes.response); return null; }
      // v5.0 FIX #8: For IOC, explicitly reject resting orders (shouldn't happen, but handle edge cases)
      if (!isHIP3 && entryRes.resting) {
        console.error('HL entry resting instead of filling (IOC) — cancelling');
        try { await this.cancelOrder(asset, entryRes.oid); } catch(e){}
        return null;
      }
      // For GTC orders, resting is OK (will fill shortly); for IOC, must be filled immediately
      if (!isHIP3 && (entryRes.filled === false || (!entryRes.filled && !entryRes.totalSz))) { console.error('HL entry not filled'); return null; }
      // For HIP-3 GTC: if resting, wait 5s then check if filled
      if (isHIP3 && entryRes.resting && !entryRes.filled) {
        console.log('HL: HIP-3 GTC order resting, waiting 5s for fill...');
        await new Promise(r => setTimeout(r, 5000));
        // Check position to see if filled
        await this.syncPositions();
        if (!this.activeTrades[coinId]) {
          console.warn('HL: HIP-3 GTC order not filled after 5s, cancelling');
          try { await this.cancelOrder(asset, entryRes.oid); } catch(e){}
          return null;
        }
      }

      // 2. Stop Loss (full position)
      const slPx = isBuy ? stopPrice * 0.98 : stopPrice * 1.02;
      const slRes = await this.placeOrder(asset, !isBuy, size, slPx,
        { trigger: { isMarket: true, triggerPx: stopPrice, tpsl: 'sl' } }, true);
      if (!slRes || slRes.status === 'err') {
        console.error('HL SL placement failed:', slRes ? slRes.response : 'null');
        await sendTelegram(`⚠️ <b>SL FAILED for ${sig} ${asset}</b>\nTrade open WITHOUT stop loss -- place manually!`);
      }

      // 3. v5.0: PARTIAL TP -- close 50% at TP1, let remainder ride with trailing stop (#6)
      // This was the only profitable pattern observed (HYPE trade on Apr 6)
      if (target) {
        const tpSize = parseFloat((size * 0.5).toFixed(szDec)); // 50% of position
        if (tpSize >= Math.pow(10, -szDec)) {
          const tpPx = isBuy ? target * 1.02 : target * 0.98;
          const tpRes = await this.placeOrder(asset, !isBuy, tpSize, tpPx,
            { trigger: { isMarket: true, triggerPx: target, tpsl: 'tp' } }, true);
          if (!tpRes || tpRes.status === 'err') {
            console.error('HL TP placement failed:', tpRes ? tpRes.response : 'null');
            await sendTelegram(`⚠️ <b>TP FAILED for ${sig} ${asset}</b>\nTrade open without take profit`);
          } else {
            console.log(`HL: Partial TP placed: ${tpSize} of ${size.toFixed(szDec)} @ $${fmt(target)} (50%)`);
          }
        } else {
          // Size too small to split -- place full TP
          const tpPx = isBuy ? target * 1.02 : target * 0.98;
          await this.placeOrder(asset, !isBuy, size, tpPx,
            { trigger: { isMarket: true, triggerPx: target, tpsl: 'tp' } }, true);
        }
      }

      // Track active trade
      const actualEntry = entryRes.avgPx ? +entryRes.avgPx : currentPrice;
      this.activeTrades[coinId] = {
        asset, side: sig, size, entry: actualEntry,
        sl: stopPrice, tp: target,
        initialSl: stopPrice,
        bestPrice: actualEntry,
        trailState: 'initial',
        partialTp: true,   // v5.0: partial TP is now default
        originalSize: size  // v5.0: track original size for trailing logic
      };
      this.saveActiveTrades();
      this.tradesToday++;

      const tradeMsg = `${isBuy ? '🟢' : '🔴'} <b>AUTO-TRADE: ${sig} ${asset}</b>\nEntry: <b>$${fmt(actualEntry)}</b>\nSize: ${size.toFixed(szDec)}\nSL: <b>$${fmt(stopPrice)}</b>${target ? '\nTP: <b>$' + fmt(target) + '</b>' : ''}\nR:R ${rr || '?'}\n\n<a href="https://tbracko.github.io/dmc-signal">Open DMS</a>`;
      console.log(`HL TRADE: ${sig} ${asset} | Size: ${size.toFixed(szDec)} | Entry: $${fmt(actualEntry)} | SL: $${fmt(stopPrice)}${target ? ' | TP: $' + fmt(target) : ''}`);
      await sendTelegram(tradeMsg);

      return entryRes;
    } catch (e) {
      console.error('HL trade error:', e);
      await sendTelegram(`❌ <b>TRADE FAILED: ${sig} ${asset}</b>\n${e.message}`);
      return null;
    }
  },

  // -- Trailing stop logic --
  async trailStops() {
    if (!this.wallet || !this.enabled) return;
    // v5.0 FIX #2: Fetch live positions once to verify trades still open
    let livePositions;
    try {
      const queryAddr = (this.masterAddress || this.address).toLowerCase();
      const [mainRes, ...hip3Res] = await Promise.all([
        fetch(HL_API + '/info', { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type: 'clearinghouseState', user: queryAddr }) }),
        ...this.HIP3_DEXES.map(dex =>
          fetch(HL_API + '/info', { method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ type: 'clearinghouseState', user: queryAddr, dex }) }))
      ]);
      const mainData = await mainRes.json();
      livePositions = [...(mainData.assetPositions || [])];
      for (const r of hip3Res) { const d = await r.json(); livePositions.push(...(d.assetPositions || [])); }
    } catch (e) { console.warn('trailStops: position fetch failed, skipping cycle:', e.message); return; }

    for (const [coinId, trade] of Object.entries(this.activeTrades)) {
      if (!trade || !trade.entry || !trade.sl) continue;

      // v5.0 FIX #2: Verify position still exists on-exchange
      const stillOpen = livePositions.find(p =>
        (p.position?.coin || p.coin) === trade.asset &&
        parseFloat(p.position?.szi || p.szi || '0') !== 0
      );
      if (!stillOpen) {
        console.log(`HL TRAIL: ${trade.asset} position closed on-exchange, removing from activeTrades`);
        delete this.activeTrades[coinId];
        this.saveActiveTrades();
        continue;
      }

      const px = coinState[coinId]?.price;
      if (!px || px <= 0) continue;
      const isLong = trade.side === 'LONG';
      const risk = Math.abs(trade.entry - (trade.initialSl || trade.sl));
      if (risk <= 0) continue;

      // Track best price
      if (isLong && px > trade.bestPrice) trade.bestPrice = px;
      if (!isLong && (trade.bestPrice === 0 || px < trade.bestPrice)) trade.bestPrice = px;

      const pnlFromEntry = isLong ? (px - trade.entry) : (trade.entry - px);
      const rMultiple = pnlFromEntry / risk;

      let newSl = null;

      if (trade.trailState === 'initial' && rMultiple >= 1.0) {
        newSl = trade.entry;
        trade.trailState = 'breakeven';
        console.log(`HL TRAIL ${trade.asset}: SL -> BREAKEVEN $${fmt(newSl)} (1:1 R hit)`);
        await sendTelegram(`🔄 <b>SL -> BREAKEVEN: ${trade.asset}</b>\nEntry: $${fmt(trade.entry)}\n1:1 R reached`);
      } else if (trade.trailState === 'breakeven' && rMultiple >= 1.5) {
        trade.trailState = 'trailing';
        newSl = isLong ? trade.bestPrice - risk * 1.5 : trade.bestPrice + risk * 1.5;
        console.log(`HL TRAIL ${trade.asset}: trailing SL to $${fmt(newSl)} (1.5R trail started)`);
      } else if (trade.trailState === 'trailing') {
        const trailSl = isLong ? trade.bestPrice - risk * 1.5 : trade.bestPrice + risk * 1.5;
        if ((isLong && trailSl > trade.sl) || (!isLong && trailSl < trade.sl)) {
          newSl = trailSl;
          console.log(`HL TRAIL ${trade.asset}: updated trailing SL to $${fmt(newSl)}`);
        }
      }

      if (newSl !== null && newSl !== trade.sl) {
        // v5.1: Skip if trailing is disabled for this trade due to prior failures
        if (trade.trailDisabled) continue;

        try {
          const cancelled = await this.cancelTriggerOrders(trade.asset);
          const slPx = isLong ? newSl * 0.98 : newSl * 1.02;
          const trailSlRes = await this.placeOrder(trade.asset, !isLong, trade.size, slPx,
            { trigger: { isMarket: true, triggerPx: newSl, tpsl: 'sl' } }, true);
          if (!trailSlRes || trailSlRes.status === 'err') {
            const errDetail = trailSlRes ? JSON.stringify(trailSlRes.response).slice(0, 200) : 'null';
            console.error(`HL trail SL placement failed for ${trade.asset} (cancelled ${cancelled} triggers):`, errDetail);

            // v5.1: Track consecutive trail failures per coin
            this.trailFailCount[coinId] = (this.trailFailCount[coinId] || 0) + 1;
            const failCount = this.trailFailCount[coinId];

            // v5.1: Throttle Telegram alerts to max 1 per 30 min per coin
            const lastAlert = this.lastTrailFailAlert[coinId] || 0;
            if (Date.now() - lastAlert >= this.TRAIL_ALERT_THROTTLE_MS) {
              this.lastTrailFailAlert[coinId] = Date.now();
              await sendTelegram(`⚠️ <b>TRAIL SL FAILED: ${trade.asset}</b>\nFail #${failCount}. Error: ${errDetail.slice(0, 100)}\nCancelled ${cancelled} existing triggers.`);
            }

            // v5.1: After MAX_TRAIL_FAILURES, disable trailing for this trade entirely
            if (failCount >= this.MAX_TRAIL_FAILURES) {
              trade.trailDisabled = true;
              this.saveActiveTrades();
              console.warn(`HL trail SL: disabling trailing for ${trade.asset} after ${failCount} failures`);
              await sendTelegram(`⏸ <b>TRAILING DISABLED: ${trade.asset}</b>\n${failCount} consecutive failures. Current SL kept. Manual review needed.`);
            }
            continue;
          }
          // v5.1: Success -- reset failure counter
          this.trailFailCount[coinId] = 0;
          // Re-place TP
          if (trade.tp) {
            const tpPx = isLong ? trade.tp * 1.02 : trade.tp * 0.98;
            const trailTpRes = await this.placeOrder(trade.asset, !isLong, trade.size, tpPx,
              { trigger: { isMarket: true, triggerPx: trade.tp, tpsl: 'tp' } }, true);
            if (!trailTpRes || trailTpRes.status === 'err') {
              console.error('HL trail TP re-place failed:', trailTpRes ? trailTpRes.response : 'null');
            }
          }
          trade.sl = newSl;
          this.saveActiveTrades();
        } catch (e) { console.error('HL trailStops error:', e.message); }
      }
    }
  },

  // -- Close a position (used for reverse trades) --
  async closePosition(coinId) {
    const trade = this.activeTrades[coinId];
    if (!trade) return null;
    const px = coinState[coinId]?.price;
    if (!px) return null;
    const isLong = trade.side === 'LONG';
    const slip = px * 0.01;
    const closePx = isLong ? px - slip : px + slip;

    try {
      const result = await this.placeOrder(trade.asset, !isLong, trade.size, closePx, { limit: { tif: 'Ioc' } }, true);
      if (result.status !== 'err' && (result.filled || result.totalSz)) {
        const exitPrice = result.avgPx ? +result.avgPx : px;
        const pnl = isLong ? (exitPrice - trade.entry) * trade.size : (trade.entry - exitPrice) * trade.size;
        const closed = loadClosedTrades();
        closed.unshift({
          coin: trade.asset, side: trade.side, size: trade.size,
          entry: trade.entry, exit: exitPrice, pnl,
          ts: new Date().toISOString(), reason: 'opposite_signal'
        });
        saveClosedTrades(closed);
        delete this.activeTrades[coinId];
        this.saveActiveTrades();

        // v5.0: Track daily P&L on close
        const cpDay = new Date().toDateString();
        if (cpDay !== this.dailyPnlDate) { this.dailyPnl = 0; this.dailyPnlDate = cpDay; }
        this.dailyPnl += pnl;

        // v5.1: Track consecutive losses and last winning direction
        if (pnl > 0) {
          this.consecutiveLosses[coinId] = 0;
          this.lastWinDir[coinId] = trade.side;
          this.lastWinTime[coinId] = Date.now();
        } else if (pnl < 0) {
          this.consecutiveLosses[coinId] = (this.consecutiveLosses[coinId] || 0) + 1;
        }

        console.log(`HL CLOSED ${trade.side} ${trade.asset}: P&L $${pnl.toFixed(2)} | Daily: $${this.dailyPnl.toFixed(2)} | ConsecLosses: ${this.consecutiveLosses[coinId]||0}`);
        await sendTelegram(`🔄 <b>REVERSED: ${trade.side} ${trade.asset}</b>\nExit: $${fmt(exitPrice)}\nP&L: <b>$${pnl.toFixed(2)}</b>`);
        return { exitPrice, pnl };
      }
      return null;
    } catch (e) {
      console.error('HL close error:', e.message);
      return null;
    }
  }
};

// -- CLOSED TRADES persistence (file-based) --
function loadClosedTrades() {
  try { return JSON.parse(fs.readFileSync(CLOSED_TRADES_FILE, 'utf8')); } catch { return []; }
}
function saveClosedTrades(trades) {
  fs.writeFileSync(CLOSED_TRADES_FILE, JSON.stringify(trades.slice(0, 200)));
}

// One-time cleanup: remove trades with invalid exit prices ($0 or near-zero)
(function cleanupBadTrades(){
  const trades = loadClosedTrades();
  const cleaned = trades.filter(t => t.exit > 1);
  if (cleaned.length < trades.length) {
    console.log('Cleaned up', trades.length - cleaned.length, 'trades with invalid exit prices');
    saveClosedTrades(cleaned);
  }
})();

// -- SYNC FILL HISTORY: Backfill closed trades from HL API ---------------------
// This catches trades that were closed (TP/SL) while the bot was down or crashed.
// Queries HL userFillsByTime and records any closedPnl fills not already tracked.
async function syncFillHistory() {
  if (!HL.wallet) return;
  try {
    const queryAddr = (HL.masterAddress || HL.address).toLowerCase();
    const startMs = Date.now() - 48 * 60 * 60 * 1000; // last 48h
    const HIP3_DEXES = HL.HIP3_DEXES || ['xyz'];
    const requests = [
      fetch(HL_API + '/info', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'userFillsByTime', user: queryAddr, startTime: startMs }) }),
      ...HIP3_DEXES.map(dex =>
        fetch(HL_API + '/info', { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type: 'userFillsByTime', user: queryAddr, startTime: startMs, dex }) }))
    ];
    const responses = await Promise.all(requests);
    const allFills = [];
    for (const r of responses) {
      const data = await r.json();
      if (Array.isArray(data)) allFills.push(...data);
    }

    // Filter for closing fills (non-zero closedPnl)
    const closeFills = allFills.filter(f => parseFloat(f.closedPnl || '0') !== 0);
    if (closeFills.length === 0) return;

    // Cluster fills within 5s of each other for the same coin (one close = multiple fills)
    closeFills.sort((a, b) => a.time - b.time);
    const clusters = [];
    for (const f of closeFills) {
      const last = clusters.length ? clusters[clusters.length - 1] : null;
      if (last && last.coin === f.coin && Math.abs(f.time - last.endTs) < 5000) {
        last.fills.push(f); last.endTs = f.time;
      } else {
        clusters.push({ coin: f.coin, fills: [f], startTs: f.time, endTs: f.time });
      }
    }

    // Check which clusters are already recorded
    const closed = loadClosedTrades();
    const existingTs = new Set(closed.map(t => {
      // Match by timestamp rounded to 10s (fills and our records may differ by a few seconds)
      return t.ts ? Math.round(new Date(t.ts).getTime() / 10000) : 0;
    }));

    const symToId = { BTC:'bitcoin', HYPE:'hyperliquid', 'S&P500':'sp500', 'xyz:SP500':'sp500', GOLD:'gold', 'xyz:GOLD':'gold' };
    let added = 0;

    for (const cl of clusters) {
      const tsKey = Math.round(cl.startTs / 10000);
      if (existingTs.has(tsKey)) continue; // already recorded

      const pnl = cl.fills.reduce((s, f) => s + parseFloat(f.closedPnl || '0'), 0);
      const totalSz = cl.fills.reduce((s, f) => s + parseFloat(f.sz || '0'), 0);
      if (totalSz <= 0) continue; // skip empty fills
      const avgPx = cl.fills.reduce((s, f) => s + parseFloat(f.px || '0') * parseFloat(f.sz || '0'), 0) / totalSz;
      const side = cl.fills[0].side; // B = bought to close short, A = sold to close long
      const tradeSide = side === 'B' ? 'SHORT' : 'LONG'; // was short if closed by buying
      const coinId = symToId[cl.coin];

      // Try to find entry price from activeTrades or estimate from PnL
      let entryPx = avgPx; // fallback
      if (coinId && HL.activeTrades[coinId]) {
        entryPx = HL.activeTrades[coinId].entry || avgPx;
      } else if (totalSz > 0) {
        // Estimate entry from PnL: pnl = (exit - entry) * size for LONG, (entry - exit) * size for SHORT
        entryPx = tradeSide === 'LONG' ? avgPx - pnl / totalSz : avgPx + pnl / totalSz;
      }

      closed.unshift({
        coin: cl.coin, side: tradeSide, size: totalSz,
        entry: parseFloat(entryPx.toFixed(2)), exit: parseFloat(avgPx.toFixed(2)),
        pnl: parseFloat(pnl.toFixed(4)),
        ts: new Date(cl.startTs).toISOString(),
        reason: 'synced_from_hl'
      });
      existingTs.add(tsKey);
      added++;
    }

    if (added > 0) {
      // Sort by timestamp descending (newest first)
      closed.sort((a, b) => new Date(b.ts) - new Date(a.ts));
      saveClosedTrades(closed);
      console.log(`Fill history sync: added ${added} missed closed trades (total: ${closed.length})`);
    }
  } catch (e) {
    console.warn('syncFillHistory error:', e.message);
  }
}

// ==============================================================================
// ##  ALERT & TRADE EXECUTION LOGIC                                         ##
// ==============================================================================

async function maybeAlert(sig, tf, type, level, target, rr, stopPrice, coinId, price, allLevels){
  if(isDedupSuppressed(coinId, tf, type, level)) return;
  // Filter by signal direction (fixed: BLIND_ENTRY can be SHORT too)
  if(sig === 'SHORT' && !WANT_SHORT) return;
  if(sig === 'LONG' && !WANT_LONG) return;
  if(type==='AT_LEVEL'){
    if(!WANT_ATLEVEL) return;
    if(sig !== 'NEUTRAL') return;
  }
  const icon      = sig==='LONG' ? '🟢' : sig==='SHORT' ? '🔴' : '🟡';
  const coinLabel = COINS[coinId].label;
  const dir       = type==='FAIL_GAIN' ? 'FAIL TO GAIN' : type==='FAIL_LOSE' ? 'FAIL TO LOSE' : type==='BLIND_ENTRY' ? 'CONFIRMED ENTRY' : 'AT LEVEL';
  let msg;
  if(type==='AT_LEVEL'){
    msg = `${icon} <b>DMS AT LEVEL</b> . ${coinLabel} [${tf}]\n👁 Approaching $${fmt(level)} -- watch 15m candle\n\n<a href="https://tbracko.github.io/dmc-signal">Open DMS</a>`;
  } else {
    const rrLine  = rr     ? `\nR:R <b>${rr}</b>` : '';
    const tpLine  = target ? `\nTake Profit: <b>$${fmt(target)}</b>` : '';
    const slLevel = stopPrice || findStopLevel(
      allLevels.length ? allLevels : [{ price:level, type:sig==='SHORT'?'resistance':'support' }],
      level, sig==='SHORT'?'short':'long'
    );
    const slLine  = slLevel ? `\nStop Loss: <b>$${fmt(slLevel)}</b>` : '';
    msg = `${icon} <b>DMS ${dir}</b> . ${coinLabel} [${tf}]\n\nEntry now: <b>$${fmt(price)}</b>\nLevel: <b>$${fmt(level)}</b>${tpLine}${slLine}${rrLine}\n\n<a href="https://tbracko.github.io/dmc-signal">Open DMS</a>`;
  }
  markDedupFired(coinId, tf, type, level);
  const ok = await sendTelegram(msg);
  console.log(`[${new Date().toISOString()}] ${ok?'SENT':'FAILED'} alert: ${coinLabel} [${tf}] ${type} ${sig} @ $${fmt(level)}`);
}

// -- AUTO-TRADE DECISION LOGIC (mirrors app's handleCandle auto-trade block) --
async function maybeAutoTrade(coinId, tfIdx, dmsResult, allResults) {
  if (!HL.enabled || !HL.wallet) return;
  const d = dmsResult;
  if (d.sig === 'NEUTRAL' || !d.stopPrice) return;
  const s = coinState[coinId];
  if (!s) return;

  // Compute confidence (same formula as app)
  let wL = 0, wS = 0, aW = 0;
  TFS.forEach(t => {
    const r = allResults[t.l];
    if (!r) return;
    if (r.type !== 'NONE') aW += t.w;
    if (r.sig === 'LONG') wL += t.w;
    if (r.sig === 'SHORT') wS += t.w;
  });
  const conf = aW > 0 ? Math.round(Math.max(wL, wS) / aW * 100) : 0;
  const majorSig = wL > wS ? 'LONG' : wS > wL ? 'SHORT' : null;
  const sym = COINS[coinId].label;

  // v4.9 Phase 3: Hard-block counter-trend auto-trades
  // If HTF direction clearly opposes the signal, do NOT auto-trade at all
  // This prevents the exact scenarios from the DMS review: LONG signals firing
  // when everything points down, or SHORT signals in clear uptrends
  const htfDir = s.htfDir || 'UNCLEAR';
  const storyDir = s.storyDir || 'UNCLEAR';
  const withTrend = (d.sig === 'LONG' && htfDir === 'UP') || (d.sig === 'SHORT' && htfDir === 'DOWN');
  const counterTrend = (d.sig === 'LONG' && htfDir === 'DOWN') || (d.sig === 'SHORT' && htfDir === 'UP');
  const storyConflicts = (d.sig === 'LONG' && storyDir === 'DOWN') || (d.sig === 'SHORT' && storyDir === 'UP');

  if (counterTrend) {
    console.log(`HL auto-trade BLOCKED ${sym} ${d.sig}: counter-trend (HTF ${htfDir}) -- hard block v4.9`);
    return;
  }
  if (storyConflicts && htfDir === 'UNCLEAR') {
    console.log(`HL auto-trade BLOCKED ${sym} ${d.sig}: story ${storyDir} conflicts, HTF unclear -- counter-structure`);
    return;
  }

  // v5.0.1: SP500 US-session-only filter
  // SP500 entries outside US market hours (13:00-21:00 UTC / 9am-5pm ET) consistently lose
  // Shorts are allowed overnight since downside moves tend to be sharper
  if (coinId === 'sp500') {
    const utcHour = new Date().getUTCHours();
    const inUSSession = utcHour >= 13 && utcHour < 21;
    if (!inUSSession && d.sig === 'LONG') {
      console.log(`HL auto-trade BLOCKED ${sym} LONG: outside US session (${utcHour}:00 UTC, allowed 13:00-21:00) -- session filter`);
      return;
    }
    if (!inUSSession) {
      console.log(`HL: ${sym} SHORT allowed outside US session (${utcHour}:00 UTC) -- shorts exempt from session filter`);
    }
  }

  // v5.0: Ranging market detector for SP500 (#7)
  // If last 3 closed trades on this coin alternated direction (L-S-L or S-L-S), market is ranging
  if (coinId === 'sp500' || coinId === 'gold') {
    const closed = loadClosedTrades();
    const recentCoinTrades = closed.filter(t => {
      const cId = { 'xyz:SP500':'sp500', 'xyz:GOLD':'gold', BTC:'bitcoin', HYPE:'hyperliquid' }[t.coin] || t.coin;
      return cId === coinId;
    }).slice(0, 3);
    if (recentCoinTrades.length >= 3) {
      const dirs = recentCoinTrades.map(t => t.side);
      const isWhipsaw = (dirs[0] !== dirs[1] && dirs[1] !== dirs[2]);
      if (isWhipsaw) {
        // Check if all 3 happened within last 24 hours
        const oldestTs = new Date(recentCoinTrades[2].ts).getTime();
        if (Date.now() - oldestTs < 86400000) {
          console.log(`HL auto-trade BLOCKED ${sym} ${d.sig}: ranging market detected (${dirs.join('->')} in 24h) -- whipsaw protection`);
          await sendTelegram(`⚠️ <b>RANGING MARKET: ${sym}</b>\nLast 3 trades alternated direction (${dirs.join(' → ')})\nSkipping ${d.sig} signal until clear trend`);
          return;
        }
      }
    }
  }

  const effectiveWithTrend = withTrend && !storyConflicts;
  const minConf = effectiveWithTrend ? Math.max(MIN_CONFIDENCE - 15, 25) : storyConflicts ? Math.min(MIN_CONFIDENCE + 15, 80) : MIN_CONFIDENCE;
  const trendLabel = effectiveWithTrend ? 'WITH-TREND' : storyConflicts ? 'COUNTER-STORY' : 'NEUTRAL-TREND';

  if (conf < minConf) {
    console.log(`HL auto-trade SKIP ${sym} ${d.sig}: conf ${conf}% < ${minConf}% (${trendLabel})`);
    return;
  }
  if (d.sig !== majorSig) {
    console.log(`HL auto-trade SKIP ${sym}: signal ${d.sig} != majority ${majorSig}`);
    return;
  }

  const existing = HL.activeTrades[coinId];
  if (existing) {
    if (existing.side === d.sig) {
      // Same direction -- SKIP (max 1 position per coin to limit exposure)
      console.log(`HL auto-trade SKIP ${sym}: already in ${existing.side} (no stacking)`);
    } else {
      // Opposite direction -- close and reverse
      console.log(`HL REVERSE: close ${existing.side} ${sym}, open ${d.sig} (${TFS[tfIdx].l}, conf ${conf}%)`);
      const closeResult = await HL.closePosition(coinId);
      if (closeResult) {
        await HL.executeTrade(coinId, d, conf);
        await HL.syncPositions();
      }
    }
  } else {
    // No existing position -- check max concurrent positions (default 3)
    const MAX_POSITIONS = parseInt(process.env.MAX_POSITIONS || '4');
    const openCount = Object.keys(HL.activeTrades).length;
    if (openCount >= MAX_POSITIONS) {
      console.log(`HL auto-trade SKIP ${sym}: max ${MAX_POSITIONS} positions reached (${openCount} open)`);
      return;
    }
    console.log(`HL AUTO-TRADE FIRE ${sym} ${d.sig} | conf: ${conf}% (min: ${minConf}%, ${trendLabel}) | SL: ${d.stopPrice} | positions: ${openCount+1}/${MAX_POSITIONS}`);
    await HL.executeTrade(coinId, d, conf);
    await HL.syncPositions();
  }
}

// ==============================================================================
// ##  PER-COIN SCAN                                                         ##
// ==============================================================================

async function scanCoin(coinId){
  const label = COINS[coinId].label;
  try{
    const [priceData, ...allCandles] = await Promise.all([
      getPrice(coinId),
      ...TFS.map(tf => getCandles(tf.l, coinId).catch(e=>{ console.warn(label, tf.l, e.message); return null; }))
    ]);
    const price = priceData.price;
    const [wC, dC, h4C, h1C, m15C] = allCandles;
    if(!dC) return;

    // Store price in coinState for trailing stops
    if (!coinState[coinId]) coinState[coinId] = {};
    coinState[coinId].price = price;

    // v5.0 FIX #1: Reset htfDir before computation so stale values don't persist
    // when nextMove() returns falsy (e.g. insufficient candle data)
    coinState[coinId].htfDir = 'UNCLEAR';
    let htfDir = 'UNCLEAR';
    if(h4C && h1C) { const nm = nextMove(h4C, h1C); if(nm) htfDir = nm.dir; }
    else if(h4C)   { const nm = nextMove(h4C, h4C); if(nm) htfDir = nm.dir; }
    coinState[coinId].htfDir = htfDir;

    // v4.9: Compute storyDir for auto-trade filtering (mirrors HTML buildStory)
    let storyDir = 'UNCLEAR';
    if(h4C && h1C && h4C.length >= 6 && h1C.length >= 12){
      const h4R = h4C.slice(-6), h1R = h1C.slice(-12);
      const sLevels = (() => {
        const wLvls = wC ? findVPeaks(wC,'1W') : [];
        const dLvls = findVPeaks(dC,'1D');
        const pdhl = findPDHL(dC);
        const all = [...wLvls,...dLvls,...pdhl].sort((a,b)=>b.score-a.score);
        return all.filter(l => Math.abs(l.price - price)/price < 0.02 && l.score >= 20).slice(0,6);
      })();
      if(sLevels.length >= 2){
        let bp = 0, brp = 0;
        for(const lv of sLevels){
          const tol = lv.price * 0.004;
          const isR = lv.type === 'resistance';
          for(let ci=0;ci<h4R.length;ci++){
            const k=h4R[ci], rec=(ci>=h4R.length-2)?2:1;
            const touched = isR ? (k.h>=lv.price-tol) : (k.l<=lv.price+tol);
            if(!touched) continue;
            const gained = isR ? (k.bh>lv.price+tol) : (k.bl<lv.price-tol);
            const failed = isR ? (k.bh<lv.price-tol*0.5) : (k.bl>lv.price+tol*0.5);
            if(gained){ isR ? bp+=2*rec : brp+=2*rec; }
            else if(failed){ isR ? brp+=2*rec : bp+=2*rec; }
          }
          for(let ci=0;ci<h1R.length;ci++){
            const k=h1R[ci], rec=(ci>=h1R.length-2)?2:1;
            const touched = isR ? (k.h>=lv.price-tol) : (k.l<=lv.price+tol);
            if(!touched) continue;
            const gained = isR ? (k.bh>lv.price+tol) : (k.bl<lv.price-tol);
            const failed = isR ? (k.bh<lv.price-tol*0.5) : (k.bl>lv.price+tol*0.5);
            if(gained){ isR ? bp+=rec : brp+=rec; }
            else if(failed){ isR ? brp+=rec : bp+=rec; }
          }
        }
        // Price position context (same as HTML)
        const last3 = h1C.slice(-3);
        if(last3.length>=3){
          const trend = last3[2].c - last3[0].c;
          if(Math.abs(trend)/price > 0.002){
            const resAbove = sLevels.filter(l=>l.type==='resistance'&&l.price>price*1.005);
            const supBelow = sLevels.filter(l=>l.type==='support'&&l.price<price*0.995);
            if(trend<0 && resAbove.length>0) brp+=3;
            if(trend>0 && supBelow.length>0) bp+=3;
          }
        }
        const net = bp - brp;
        if(net>=3) storyDir='UP';
        else if(net<=-3) storyDir='DOWN';
      }
    }
    coinState[coinId].storyDir = storyDir;

    const asiaLevels = m15C
      ? [...getAsiaLevels(m15C), ...getLondonLevels(m15C), ...getNYLevels(m15C)]
      : [];

    const allLevels = (() => {
      const wLvls = wC ? findVPeaks(wC,'1W') : [];
      const dLvls = findVPeaks(dC,'1D');
      const pdhl  = findPDHL(dC);
      const all   = [...wLvls,...dLvls,...pdhl,...asiaLevels].sort((a,b)=>b.price-a.price);
      const dd = [];
      for(const l of all){ if(!dd.find(d=>Math.abs(d.price-l.price)/l.price<0.004)) dd.push(l); }
      return dd;
    })();

    // v4.9: Build lower-TF candle data for LTF alignment checks on 1W/1D only
    // 4H/1H/15m signals are left untouched -- working well for BTC/SPX/HYPE
    const lowerTFCandles = {};
    if (h4C) lowerTFCandles['4H'] = h4C;
    if (h1C) lowerTFCandles['1H'] = h1C;
    const hasLower = Object.keys(lowerTFCandles).length > 0 ? lowerTFCandles : null;

    const tfsToRun = [
      wC  && dC  ? { i:0, c:wC,   dC, lower:hasLower } : null,
      dC         ? { i:1, c:dC,   dC, lower:hasLower } : null,
      h4C && dC  ? { i:2, c:h4C,  dC, lower:null } : null,
      h1C && dC  ? { i:3, c:h1C,  dC, lower:null } : null,
      m15C && dC ? { i:4, c:m15C, dC, lower:null } : null,
    ].filter(Boolean);

    // Store all results for confidence calculation
    const allResults = {};

    // v4.9: Cross-TF conflict prevention -- track which direction fired first
    // If 4H says LONG and 1D says SHORT, only the first (higher-weight TF) fires
    let firedDirection = null; // 'LONG' or 'SHORT' once a tradeable signal fires

    const signalSummary = [];
    for(const { i, c, dC: dc, lower } of tfsToRun){
      const tf = TFS[i];
      const a  = atr(c);
      // v4.9 fix: pass as plain object (String objects break === comparison)
      const htfCarrier = { dir: htfDir || 'UNCLEAR', __asiaLevels: asiaLevels };
      const coinMinRR = COINS[coinId] ? COINS[coinId].minRR : 1.0;
      const coinMinStopPct = COINS[coinId] ? COINS[coinId].minStopPct : 0.005;
      const coinFeeEst = COINS[coinId] ? COINS[coinId].feeEst : 0.05;
      const d = dms(c, a, dc, tf.l, htfCarrier, lower, coinMinRR, coinMinStopPct, coinFeeEst);
      allResults[tf.l] = d;

      // Log ALL non-NONE signals for diagnostics
      if(d.type !== 'NONE'){
        const deduped = isDedupSuppressed(coinId, tf.l, d.type, d.level);
        // v4.9: Block opposite-direction signals within same scan cycle
        const conflicted = firedDirection && d.sig !== 'NEUTRAL' && d.sig !== firedDirection;
        if(conflicted){
          signalSummary.push(`${tf.l}:${d.sig}(CONFLICT-BLOCKED, already ${firedDirection})`);
          continue;
        }
        signalSummary.push(`${tf.l}:${d.sig}(${d.type}${deduped?' DEDUP':''})`);
        if(!deduped){
          // Track which direction we committed to (only for tradeable signals)
          if(d.sig !== 'NEUTRAL' && d.type === 'BLIND_ENTRY') firedDirection = d.sig;
          await maybeAlert(d.sig, tf.l, d.type, d.level, d.target, d.rr, d.stopPrice, coinId, price, allLevels);
          // Auto-trade execution
          await maybeAutoTrade(coinId, i, d, allResults);
        }
      }
    }
    const sigStr = signalSummary.length > 0 ? signalSummary.join(' | ') : 'no signals';
    // -- v4.9: MULTI-TF CONFLUENCE DETECTION ----------------------------------
    // After all TFs processed, check if 2+ TFs broke the same level in the same
    // direction. This is the highest conviction DMS signal.
    const breakoutTypes = ['BLIND_ENTRY', 'BREAKOUT', 'FAIL_GAIN', 'FAIL_LOSE'];
    const confluenceSignals = [];
    for(const tf of TFS){
      const r = allResults[tf.l];
      if(!r || !r.level || r.sig === 'NEUTRAL') continue;
      if(!breakoutTypes.includes(r.type)) continue;
      confluenceSignals.push({ tf: tf.l, weight: tf.w, sig: r.sig, level: r.level, target: r.target, rr: r.rr, stopPrice: r.stopPrice, type: r.type });
    }
    if(confluenceSignals.length >= 2){
      for(let i = 0; i < confluenceSignals.length; i++){
        const matches = [confluenceSignals[i]];
        for(let j = i+1; j < confluenceSignals.length; j++){
          if(confluenceSignals[j].sig === confluenceSignals[i].sig && Math.abs(confluenceSignals[j].level - confluenceSignals[i].level) / confluenceSignals[i].level < 0.005){
            matches.push(confluenceSignals[j]);
          }
        }
        if(matches.length < 2) continue;
        const sig = matches[0].sig;
        const level = matches[0].level;
        const tfList = matches.map(m => m.tf).join('+');
        const bestRR = matches.map(m => m.rr).filter(Boolean).sort((a,b) => +b - +a)[0] || null;
        const bestStop = matches.map(m => m.stopPrice).filter(Boolean)[0] || null;
        const bestTarget = matches.map(m => m.target).filter(Boolean)[0] || null;
        if(isDedupSuppressed(coinId, 'MULTI', 'BLIND_ENTRY', level)) break;
        markDedupFired(coinId, 'MULTI', 'BLIND_ENTRY', level);
        const coinLabel = COINS[coinId].label;
        const icon = sig === 'LONG' ? '\u{1F7E2}' : '\u{1F534}';
        const tpLine = bestTarget ? `\nTake Profit: <b>$${fmt(bestTarget)}</b>` : '';
        const slLine = bestStop ? `\nStop Loss: <b>$${fmt(bestStop)}</b>` : '';
        const rrLine = bestRR ? `\nR:R <b>${bestRR}</b>` : '';
        const msg = `${icon} <b>MULTI-TF ${sig}</b> \u{26A1} ${coinLabel} [${tfList}]\n${matches.length} timeframes confirm at $${fmt(level)}\n\nEntry now: <b>$${fmt(price)}</b>\nLevel: <b>$${fmt(level)}</b>${tpLine}${slLine}${rrLine}\n\n<a href="https://tbracko.github.io/dmc-signal">Open DMS</a>`;
        await sendTelegram(msg);
        console.log(`MULTI-TF ${sig} ${coinLabel} [${tfList}] at $${fmt(level)} -- ${matches.length} TFs confirm`);
        // Auto-trade with high conviction override (skip if already in position)
        // v5.0.1 FIX: Apply session filter + ranging detector here too (was bypassing maybeAutoTrade)
        if(HL.enabled && HL.wallet && bestStop && !HL.activeTrades[coinId]){
          // Session filter for SP500 — block longs outside US hours
          if (coinId === 'sp500' && sig === 'LONG') {
            const utcHr = new Date().getUTCHours();
            if (utcHr < 13 || utcHr >= 21) {
              console.log(`HL MULTI-TF BLOCKED ${COINS[coinId].label} LONG: outside US session (${utcHr}:00 UTC) -- session filter`);
              break;
            }
          }
          // Ranging market detector for SP500/GOLD
          if (coinId === 'sp500' || coinId === 'gold') {
            const closed = loadClosedTrades();
            const recentCoinTrades = closed.filter(t => {
              const cId = { 'xyz:SP500':'sp500', 'xyz:GOLD':'gold', BTC:'bitcoin', HYPE:'hyperliquid' }[t.coin] || t.coin;
              return cId === coinId;
            }).slice(0, 3);
            if (recentCoinTrades.length >= 3) {
              const dirs = recentCoinTrades.map(t => t.side);
              const isWhipsaw = (dirs[0] !== dirs[1] && dirs[1] !== dirs[2]);
              const oldestTs = new Date(recentCoinTrades[2].ts).getTime();
              if (isWhipsaw && Date.now() - oldestTs < 86400000) {
                console.log(`HL MULTI-TF BLOCKED ${COINS[coinId].label} ${sig}: ranging market (${dirs.join('->')} in 24h)`);
                break;
              }
            }
          }
          const tradeSignal = { sig, level, target: bestTarget, rr: bestRR, stopPrice: bestStop, type: 'BLIND_ENTRY', tf: tfList };
          await HL.executeTrade(coinId, tradeSignal, 80);
          await HL.syncPositions();
        }
        break; // only fire once per scan
      }
    }
    console.log(`  ${label}: $${fmt(price)} | HTF: ${htfDir} | Session: ${getCurrentSession()} | ${sigStr}`);
  }catch(e){
    console.error(`[${new Date().toISOString()}] Error scanning ${label}:`, e.message);
  }
}

// ==============================================================================
// ##  MAIN LOOP                                                             ##
// ==============================================================================

// -- DAILY SUMMARY ------------------------------------------------------------
const SUMMARY_HOUR = parseInt(process.env.SUMMARY_HOUR || '6', 10); // UTC hour to send daily summary
const SUMMARY_FILE = path.join(__dirname, '.last_summary_date');
let lastSummaryDate = (() => { try { return fs.readFileSync(SUMMARY_FILE, 'utf8').trim(); } catch { return ''; } })();

async function sendDailySummary() {
  const today = new Date().toISOString().slice(0, 10);
  // Re-read from disk EVERY time (prevents duplicate across bot restarts or multi-instance)
  try { lastSummaryDate = fs.readFileSync(SUMMARY_FILE, 'utf8').trim(); } catch {}
  if (lastSummaryDate === today) return; // already sent today (by this or another instance)
  // Write FIRST, then send -- so a crash mid-send doesn't cause double send on restart
  lastSummaryDate = today;
  try { fs.writeFileSync(SUMMARY_FILE, today); } catch {}

  try {
    // Refresh equity and backfill any missed closes before building summary
    if (HL.wallet) await HL.syncEquity();
    await syncFillHistory();

    // Get open positions
    const openPositions = Object.entries(HL.activeTrades);
    let openLines = '';
    if (openPositions.length > 0) {
      for (const [coinId, t] of openPositions) {
        const px = coinState[coinId]?.price || 0;
        const isLong = t.side === 'LONG';
        const upnl = px > 0 ? (isLong ? (px - t.entry) * t.size : (t.entry - px) * t.size) : 0;
        const upnlStr = upnl >= 0 ? `+$${upnl.toFixed(2)}` : `-$${Math.abs(upnl).toFixed(2)}`;
        const trail = t.trailState !== 'initial' ? ` [${t.trailState}]` : '';
        openLines += `\n  ${t.side === 'LONG' ? '🟢' : '🔴'} ${t.asset} ${t.side} @ $${fmt(t.entry)} -> ${upnlStr}${trail}`;
      }
    } else {
      openLines = '\n  No open positions';
    }

    // Get yesterday's closed trades
    const closed = loadClosedTrades();
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    const yesterdayTrades = closed.filter(t => t.ts && t.ts.startsWith(yesterday));
    let closedLines = '';
    let dayPnl = 0;
    let wins = 0, losses = 0;
    if (yesterdayTrades.length > 0) {
      for (const t of yesterdayTrades) {
        const pnlStr = t.pnl >= 0 ? `+$${t.pnl.toFixed(2)}` : `-$${Math.abs(t.pnl).toFixed(2)}`;
        const emoji = t.reason === 'tp_hit' ? '✅' : t.reason === 'sl_hit' ? '🛑' : '🔄';
        closedLines += `\n  ${emoji} ${t.coin} ${t.side} -> ${pnlStr}`;
        dayPnl += t.pnl;
        if (t.pnl >= 0) wins++; else losses++;
      }
    } else {
      closedLines = '\n  No trades closed yesterday';
    }

    // Overall stats
    const allWins = closed.filter(t => t.pnl >= 0).length;
    const allLosses = closed.filter(t => t.pnl < 0).length;
    const allTotal = allWins + allLosses;
    const winRate = allTotal > 0 ? Math.round(allWins / allTotal * 100) : 0;
    const totalPnl = closed.reduce((s, t) => s + (t.pnl || 0), 0);

    const equity = HL.cachedEquity > 0 ? `$${HL.cachedEquity.toFixed(2)}` : 'N/A';
    const dayPnlStr = dayPnl >= 0 ? `+$${dayPnl.toFixed(2)}` : `-$${Math.abs(dayPnl).toFixed(2)}`;
    const totalPnlStr = totalPnl >= 0 ? `+$${totalPnl.toFixed(2)}` : `-$${Math.abs(totalPnl).toFixed(2)}`;

    const msg = `📊 <b>DMS Daily Summary</b> . ${today}\n` +
      `\n💰 <b>Equity:</b> ${equity}` +
      `\n\n📈 <b>Open Positions:</b>${openLines}` +
      `\n\n📋 <b>Yesterday's Trades:</b>${closedLines}` +
      (yesterdayTrades.length > 0 ? `\n  Day P&L: <b>${dayPnlStr}</b> (${wins}W/${losses}L)` : '') +
      `\n\n📊 <b>All-Time:</b> ${winRate}% win rate (${allWins}W/${allLosses}L)` +
      `\nTotal P&L: <b>${totalPnlStr}</b>` +
      `\n\n<a href="https://tbracko.github.io/dmc-signal">Open DMS</a>`;

    await sendTelegram(msg);
    console.log(`[${new Date().toISOString()}] Daily summary sent`);
  } catch (e) {
    console.warn('Daily summary error:', e.message);
  }
}

async function checkDailySummary() {
  const now = new Date();
  if (now.getUTCHours() === SUMMARY_HOUR) {
    await sendDailySummary();
  }
}

async function scanAll(){
  const coins = Object.keys(COINS);
  console.log(`[${new Date().toISOString()}] Scanning ${coins.map(c=>COINS[c].label).join(', ')}...`);
  for(let i=0; i<coins.length; i++){
    if(i > 0) await new Promise(r=>setTimeout(r, 2000));
    await scanCoin(coins[i]);
  }
  console.log(`[${new Date().toISOString()}] Scan complete. Next in ${INTERVAL_MS/1000}s.`);
}

async function main(){
  console.log(`DMS Signal Bot v4.9 started. Interval: ${INTERVAL_MS/1000}s`);
  console.log(`Coins: BTC, HYPE, SPX, GOLD  |  Token: ...${TG_TOKEN.slice(-6)}  |  Chat: ${TG_CHATID}`);

  // Initialize Hyperliquid trading module
  if (HL_PRIVATE_KEY && AUTO_TRADE) {
    const hlOk = await HL.init();
    if (hlOk) {
      console.log('Auto-trading ENABLED | Risk:', RISK_PCT + '%', '| Min conf:', MIN_CONFIDENCE + '%', '| Max trades/day:', MAX_TRADES_DAY);
      // Backfill any closed trades missed during downtime
      await syncFillHistory();
      await sendTelegram('🤖 <b>DMS Signal Bot v4.9 started</b>\n✅ Auto-trading ENABLED\nScanning BTC . HYPE . SPX . GOLD every 2 min\nRisk: ' + RISK_PCT + '% | Min conf: ' + MIN_CONFIDENCE + '%');
    } else {
      console.warn('Auto-trading init FAILED -- running in alert-only mode');
      await sendTelegram('🤖 <b>DMS Signal Bot v4.9 started</b>\n⚠️ Auto-trading FAILED to init\nRunning in alert-only mode');
    }
  } else {
    console.log('Auto-trading DISABLED (set AUTO_TRADE=true and HL_PRIVATE_KEY to enable)');
    await sendTelegram('🤖 <b>DMS Signal Bot v4.9 started</b>\nScanning BTC . HYPE . SPX . GOLD every 2 minutes.\n🔔 Alert-only mode');
  }

  await scanAll();
  setInterval(scanAll, INTERVAL_MS);

  // Trailing stop check loop (every 30s)
  if (HL.enabled) {
    setInterval(async () => {
      try {
        // Refresh prices for trailing stop checks
        for (const coinId of Object.keys(HL.activeTrades)) {
          try {
            const { price } = await getPrice(coinId);
            if (!coinState[coinId]) coinState[coinId] = {};
            coinState[coinId].price = price;
          } catch (e) { /* price fetch failed, skip */ }
        }
        await HL.trailStops();
      } catch (e) { console.warn('Trail check error:', e.message); }
    }, TRAIL_INTERVAL);

    // Sync positions, equity & fill history every 5 min
    setInterval(async () => {
      try {
        await HL.syncPositions();
        await HL.syncEquity();
        await syncFillHistory();
      } catch (e) { console.warn('Periodic sync error:', e.message); }
    }, 300000);
  }

  // Daily summary check every 5 min (sends once per day at SUMMARY_HOUR UTC)
  setInterval(checkDailySummary, 300000);
}

main().catch(e=>{ console.error('Fatal:', e); process.exit(1); });
