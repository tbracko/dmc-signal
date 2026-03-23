#!/usr/bin/env node
// DMS Signal Bot v4.5 — AUTO-TRADE edition
// Mirrors the DMS algorithm from index.html exactly — same levels, same scoring, same signals
// Now also executes trades on Hyperliquid with TP/SL/trailing stops
// Node 18+ required (uses built-in fetch)
'use strict';
const fs    = require('fs');
const path  = require('path');
const ethers = require('ethers');

// ── CONFIG (env vars or .env file) ──────────────────────────────────────────
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
const MIN_RR        = parseFloat(process.env.MIN_RR || '1.5');
const INTERVAL_MS   = parseInt(process.env.INTERVAL_MS || '120000', 10);
const DEDUP_FILE    = path.join(__dirname, '.dedup.json');

// ── AUTO-TRADE CONFIG ────────────────────────────────────────────────────────
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

// ── COINS (BTC, HYPE, SOL + GOLD via Hyperliquid HIP-3) ─────────────────────
const COINS = {
  bitcoin:     { id:'bitcoin',     label:'BTC',  apiSym:'BTCUSDT',  asset:'BTC',      exchange:'binance' },
  hyperliquid: { id:'hyperliquid', label:'HYPE', apiSym:'HYPEUSDT', asset:'HYPE',     exchange:'bybit'   },
  solana:      { id:'solana',      label:'SOL',  apiSym:'SOLUSDT',  asset:'SOL',      exchange:'binance' },
  gold:        { id:'gold',        label:'GOLD', apiSym:'xyz:GOLD', asset:'xyz:GOLD', exchange:'hyperliquid' },
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


// ── STATE ────────────────────────────────────────────────────────────────────
const coinState = {};  // coinId -> { price, htfDir, results: { tf: dmsResult } }
const ACTIVE_TRADES_FILE = path.join(__dirname, '.active_trades.json');
const CLOSED_TRADES_FILE = path.join(__dirname, '.closed_trades.json');

// ── DEDUP ─────────────────────────────────────────────────────────────────────
function loadDedup(){
  try{ return JSON.parse(fs.readFileSync(DEDUP_FILE,'utf8')); }catch{ return {}; }
}
function saveDedup(d){ fs.writeFileSync(DEDUP_FILE, JSON.stringify(d)); }
function isDedupSuppressed(coinId, tf, type, level){
  const d   = loadDedup();
  const key = `${coinId}:${tf}:${type}:${Math.round(level)}`;
  const win = type === 'BLIND_ENTRY' ? 28800000 : 14400000;
  const now = Date.now();
  let changed = false;
  for(const k of Object.keys(d)){ if(now - d[k] > 28800000){ delete d[k]; changed=true; } }
  if(changed) saveDedup(d);
  return !!(d[key] && (now - d[key]) < win);
}
function markDedupFired(coinId, tf, type, level){
  const d   = loadDedup();
  const key = `${coinId}:${tf}:${type}:${Math.round(level)}`;
  d[key] = Date.now();
  saveDedup(d);
}

// ── TELEGRAM ──────────────────────────────────────────────────────────────────
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

// ── EXCHANGE APIs ─────────────────────────────────────────────────────────────
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
  if(!Array.isArray(raw) || raw.length < 4) throw new Error(`HL candles ${coin} ${interval}: empty (${raw.length || 0})`);
  return raw.map(k => ({
    t: k.t, o: +k.o, h: +k.h, l: +k.l, c: +k.c,
    bh: Math.max(+k.o, +k.c), bl: Math.min(+k.o, +k.c)
  }));
}

async function getCandles(tfLabel, coinId){
  const coin = COINS[coinId];
  if(coin.exchange === 'hyperliquid'){
    return hlKlines(coin.apiSym, HL_INTERVALS[tfLabel], LIMITS[tfLabel]);
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

// ── UTILITIES ─────────────────────────────────────────────────────────────────
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

// ── SESSION LEVELS ────────────────────────────────────────────────────────────
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

// ── LEVEL HELPERS ─────────────────────────────────────────────────────────────
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
  return merged;
}
function findNextLevel(levels, currentPrice, direction){
  const qualityLevels = levels.filter(l => l.score >= 12);
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
function findStopLevel(levels, trapPrice, direction){
  const qualityLevels = levels.filter(l => l.score >= 12);
  const pool   = qualityLevels.length >= 2 ? qualityLevels : levels;
  const sorted = [...pool].sort((a,b)=>a.price-b.price);
  if(direction === 'short'){
    const candidates = sorted.filter(l=>l.price > trapPrice * 1.003);
    return candidates.length ? candidates[0].price : trapPrice * 1.015;
  } else {
    const candidates = sorted.filter(l=>l.price < trapPrice * 0.997);
    return candidates.length ? candidates[candidates.length-1].price : trapPrice * 0.985;
  }
}
function calcRR(entry, target, trapLevel, stopLevel){
  const stopRef = stopLevel || trapLevel;
  const risk    = Math.abs(entry - stopRef) * 1.05;
  const reward  = Math.abs(entry - target);
  if(risk < 1) return null;
  return (reward / risk).toFixed(1);
}

// ── REJECTION CANDLE DETECTION (v4.8 — follow-through confirmation) ──────────
// Phase 1: Rejection candle must NOT be the current candle — we need at least
//          one follow-through candle that confirms the bounce direction.
//          This prevents firing signals the instant a wick appears, before
//          knowing whether price actually bounced or sliced through.
// Phase 2: Momentum filter — if last 3-5 candles show strong directional
//          momentum AGAINST the signal, suppress it (price is trending through
//          the level, not bouncing).
// Returns { confirmed: true/false, barsAgo, wickRatio, followThrough }

function hasRejection(candles, levelPrice, direction, atrVal) {
  const n = candles.length;
  if (n < 3) return { confirmed: false };

  // Phase 2: Momentum filter — check if recent candles show strong opposing momentum
  const momentumBlocked = hasMomentumAgainst(candles, direction, atrVal);
  if (momentumBlocked.blocked) return { confirmed: false, reason: momentumBlocked.reason };

  // Check candles 1-3 bars ago (NOT the current candle at index 0)
  // The current candle (i=0) is the follow-through candle
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
        // Follow-through check: current candle must confirm the bounce
        // - Close higher than rejection candle's body low (moving away from level)
        // - Close above the level (not still stuck below)
        const followOk = cur.c > k.bl && cur.c >= levelPrice - atrVal * 0.1;
        if (followOk) {
          return { confirmed: true, barsAgo: i, wickRatio, followThrough: true };
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
        // Follow-through check: current candle confirms rejection downward
        // - Close lower than rejection candle's body high
        // - Close below the level
        const followOk = cur.c < k.bh && cur.c <= levelPrice + atrVal * 0.1;
        if (followOk) {
          return { confirmed: true, barsAgo: i, wickRatio, followThrough: true };
        }
      }
    }
  }
  return { confirmed: false };
}

// ── MOMENTUM FILTER (v4.8) ──────────────────────────────────────────────────
// Checks if last 3-5 candles show strong directional momentum AGAINST the
// proposed trade direction. If price is clearly trending through a level
// (e.g., 4 consecutive bearish candles breaking support), a wick at that level
// is just a pause, not a reversal — don't fire a LONG.
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

// ── DMS SIGNAL ENGINE (v4.8 — confirmed follow-through + momentum + HTF block) ─
function dms(c, a, dCandles, tf, htfBias){
  const n = c.length;
  const minCandles = (tf==='1W'||tf==='1D') ? 10 : 20;
  if(n < minCandles) return { sig:'NEUTRAL', type:'NONE', reason:'Insufficient data' };
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
      // v4.5: HTF ALWAYS takes precedence — no strong-level bypass
      const htfBlocks = (isRes && htfBias==='UP') || (!isRes && htfBias==='DOWN');
      if(!htfBlocks){
        const tgt  = findNextLevel(levels, cur.c, isRes?'short':'long');
        const stop = findStopLevel(levels, blindCandidate.price, isRes?'short':'long');
        const rr   = calcRR(cur.c, tgt.price, blindCandidate.price, stop);
        if(rr && parseFloat(rr) >= 1.0){
          const dist = ((blindCandidate.price - cur.c)/cur.c*100).toFixed(2);
          const htfNote = htfBias!=='UNCLEAR' ? ` · HTF ${htfBias} aligns` : '';
          const typeLabel = isFlipped ? `PASS-THROUGH` : `UNTESTED ${tf}`;
          // v4.8: Require rejection + follow-through + momentum check
          const rejection = hasRejection(c, blindCandidate.price, blindSig, a);
          if(rejection.confirmed){
            return {
              sig:blindSig, type:'BLIND_ENTRY',
              level:blindCandidate.price, target:tgt.price, rr, stopPrice:stop,
              strength:blindCandidate.strength, score:blindCandidate.score,
              reason:`CONFIRMED: ${blindCandidate.source} $${fmt(blindCandidate.price)} · ${dist>0?'+':''}${dist}% · ${typeLabel} · rejection ${rejection.barsAgo} bars ago · follow-through confirmed${htfNote} · R:R ${rr} → $${fmt(tgt.price)}`
            };
          }
          // No confirmed rejection → downgrade to AT_LEVEL alert (no auto-trade)
          const waitReason = rejection.reason || 'no confirmed rejection + follow-through';
          const dir = isRes ? 'RESISTANCE — waiting for confirmation' : 'SUPPORT — waiting for confirmation';
          return { sig:'NEUTRAL', type:'AT_LEVEL', level:blindCandidate.price, target:tgt.price, strength:blindCandidate.strength, score:blindCandidate.score, reason:`PENDING: ${blindCandidate.source} $${fmt(blindCandidate.price)} · ${dist>0?'+':''}${dist}% · ${typeLabel} · ${waitReason} · ${dir}` };
        }
      }
    }
    // 4H/1H: Check if price is at a level WITH confirmed rejection → produce entry
    const atLevelWindow = isHTF ? a * 0.4 : a * 1.0;
    const atLevel = nearby.find(l=>Math.abs(l.price-cur.c) < atLevelWindow && l.score >= 20);
    if(atLevel){
      const isRes = atLevel.type === 'resistance';
      const confSig = isRes ? 'SHORT' : 'LONG';
      const htfBlocks = (isRes && htfBias==='UP') || (!isRes && htfBias==='DOWN');
      // On 4H/1H: check for confirmed rejection to upgrade AT_LEVEL → trade
      if((tf === '4H' || tf === '1H') && !htfBlocks){
        const rejection = hasRejection(c, atLevel.price, confSig, a);
        if(rejection.confirmed){
          const tgt  = findNextLevel(levels, cur.c, isRes?'short':'long');
          const stop = findStopLevel(levels, atLevel.price, isRes?'short':'long');
          const rr   = calcRR(cur.c, tgt.price, atLevel.price, stop);
          if(rr && parseFloat(rr) >= 1.0){
            const dist = ((atLevel.price - cur.c)/cur.c*100).toFixed(2);
            return {
              sig:confSig, type:'BLIND_ENTRY',
              level:atLevel.price, target:tgt.price, rr, stopPrice:stop,
              strength:atLevel.strength, score:atLevel.score,
              reason:`CONFIRMED ${tf}: ${atLevel.source} $${fmt(atLevel.price)} · ${dist>0?'+':''}${dist}% · rejection ${rejection.barsAgo} bars ago · follow-through confirmed · R:R ${rr} → $${fmt(tgt.price)}`
            };
          }
        }
      }
      const dir  = atLevel.type==='resistance' ? 'RESISTANCE — watch for rejection + follow-through' : 'SUPPORT — watch for rejection + follow-through';
      const dist = ((atLevel.price - cur.c)/cur.c*100).toFixed(2);
      return { sig:'NEUTRAL', type:'AT_LEVEL', level:atLevel.price, target:null, strength:atLevel.strength, score:atLevel.score, reason:`${atLevel.source} $${fmt(atLevel.price)} · ${dist>0?'+':''}${dist}% · ${dir}` };
    }
    return { sig:'NEUTRAL', type:'NONE', level:null, target:null, reason:'Between levels' };
  }

  // 15m trap detection
  const maxLB = 3;
  const htfBlockShort = htfBias === 'UP';
  const htfBlockLong  = htfBias === 'DOWN';

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
      const stop = findStopLevel(levels, lv.price, 'short');
      const rr   = calcRR(confirm.c, tgt.price, lv.price, stop);
      if(rr && parseFloat(rr) < MIN_RR) continue;
      const dist = ((lv.price - confirm.c)/confirm.c*100).toFixed(2);
      return { sig:'SHORT', type:'FAIL_GAIN', level:lv.price, target:tgt.price, rr, stopPrice:stop, strength:lv.strength, score:lv.score, reason:`${lv.source} $${fmt(lv.price)} · ${dist}% above · ${lb===1?'just now':lb+' bars ago'}${rr?` · R:R ${rr}`:''} → $${fmt(tgt.price)}` };
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
      const stop = findStopLevel(levels, lv.price, 'long');
      const rr   = calcRR(confirm.c, tgt.price, lv.price, stop);
      if(rr && parseFloat(rr) < MIN_RR) continue;
      const dist = ((confirm.c - lv.price)/confirm.c*100).toFixed(2);
      return { sig:'LONG', type:'FAIL_LOSE', level:lv.price, target:tgt.price, rr, stopPrice:stop, strength:lv.strength, score:lv.score, reason:`${lv.source} $${fmt(lv.price)} · ${dist}% below · ${lb===1?'just now':lb+' bars ago'}${rr?` · R:R ${rr}`:''} → $${fmt(tgt.price)}` };
    }
  }
  const atLevel = nearby.find(l=>Math.abs(l.price-cur.c) < a*1.5 && l.score>=20);
  if(atLevel){
    const dist = ((atLevel.price - cur.c)/cur.c*100).toFixed(2);
    const dir  = atLevel.type==='resistance' ? 'RESISTANCE — watch for wick + body close back below' : 'SUPPORT — watch for wick + body close back above';
    return { sig:'NEUTRAL', type:'AT_LEVEL', level:atLevel.price, target:null, strength:atLevel.strength, score:atLevel.score, reason:`${atLevel.source} $${fmt(atLevel.price)} · ${dist>0?'+':''}${dist}% · ${dir}` };
  }
  return { sig:'NEUTRAL', type:'NONE', level:null, target:null, reason:'Between levels' };
}

// ── HTF BIAS ──────────────────────────────────────────────────────────────────
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

// ══════════════════════════════════════════════════════════════════════════════
// ██  HYPERLIQUID TRADING MODULE                                            ██
// ══════════════════════════════════════════════════════════════════════════════

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

  // ── MSGPACK encoder (matches app exactly) ──
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

  // ── Compute action hash for phantom agent signing ──
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

  // ── Sign L1 action (phantom agent EIP-712) ──
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

  // ── Float to wire: match Python SDK ──
  floatToWire(x) {
    const s = parseFloat(parseFloat(x).toPrecision(5)).toString();
    if (s.includes('.')) return s.replace(/\.?0+$/, '') || '0';
    return s;
  },

  // ── Build order type wire ──
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

  // ── Initialize HL module ──
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
      console.log('HL loaded persisted trades:', Object.keys(this.activeTrades).length, '→', JSON.stringify(this.activeTrades));
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
    if (this.assetMap['xyz:GOLD'] !== undefined) console.log('  xyz:GOLD → assetId', this.assetMap['xyz:GOLD'], 'szDec', this.szDecimals['xyz:GOLD']);
  },

  // ── Get balance (perps + spot) ──
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

  // ── Persist active trades to file (replaces localStorage) ──
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

  // ── HIP-3 dexes we trade on (for querying positions, orders, fills) ──
  HIP3_DEXES: ['xyz'],

  // ── Fetch trigger orders (SL/TP) — queries main + HIP-3 dexes ──
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

  // ── Sync positions with real HL state (main + HIP-3 dexes) ──
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
      const symToId = { BTC: 'bitcoin', HYPE: 'hyperliquid', SOL: 'solana', GOLD: 'gold', 'xyz:GOLD': 'gold' };

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
        await sendTelegram(`${emoji} <b>${label}: ${old.side} ${old.asset}</b>\nEntry: $${fmt(old.entry)}\nExit: $${fmt(exitPx)}\nP&L: <b>$${pnl.toFixed(2)}</b>`);
      }

      this.saveActiveTrades();
      console.log('HL positions synced:', Object.keys(this.activeTrades).length, 'open');
    } catch(e) { console.warn('HL syncPositions error:', e.message); }
  },

  // ── Place an order ──
  async placeOrder(asset, isBuy, size, price, orderType, reduceOnly = false) {
    const assetIdx = this.assetMap[asset];
    if (assetIdx === undefined) throw new Error('Unknown asset: ' + asset);
    const szDec = this.szDecimals[asset] || 3;
    const sizeStr = this.floatToWire(parseFloat(size.toFixed(szDec)));
    const priceStr = this.floatToWire(price);
    const orderWire = { a: assetIdx, b: isBuy, p: priceStr, s: sizeStr, r: reduceOnly, t: this.orderTypeToWire(orderType) };
    const action = { type: 'order', orders: [orderWire], grouping: 'na' };
    const nonce = Date.now();
    const signature = await this.signL1Action(action, nonce, null);
    const payload = { action, nonce, signature: { r: signature.r, s: signature.s, v: signature.v } };
    console.log('HL order:', asset, isBuy ? 'BUY' : 'SELL', sizeStr, '@', priceStr, reduceOnly ? '(reduce)' : '');
    const res = await fetch(HL_API + '/exchange', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const result = await res.json();

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
    return result;
  },

  // ── Fetch open orders (main + HIP-3 dexes) ──
  async fetchOpenOrders() {
    const queryAddr = (this.masterAddress || this.address).toLowerCase();
    const requests = [
      fetch(HL_API + '/info', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'openOrders', user: queryAddr }) }),
      ...this.HIP3_DEXES.map(dex =>
        fetch(HL_API + '/info', { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type: 'openOrders', user: queryAddr, dex }) }))
    ];
    const responses = await Promise.all(requests);
    const allOrders = [];
    for (const r of responses) {
      const data = await r.json();
      if (Array.isArray(data)) allOrders.push(...data);
    }
    return allOrders;
  },

  // ── Cancel an order ──
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

  // ── Cancel all trigger orders for an asset ──
  async cancelTriggerOrders(asset) {
    try {
      const orders = await this.fetchOpenOrders();
      const triggers = orders.filter(o => o.coin === asset && o.orderType && o.orderType !== 'Limit');
      for (const o of triggers) await this.cancelOrder(asset, o.oid);
      return triggers.length;
    } catch (e) { console.warn('cancelTriggerOrders error:', e.message); return 0; }
  },

  // ── Execute full trade: market entry + SL + TP ──
  async executeTrade(coinId, signal, confidence) {
    const asset = COINS[coinId]?.asset;
    if (!asset || !this.enabled || !this.wallet) return null;

    // Daily trade limit
    const today = new Date().toDateString();
    if (today !== this.lastTradeDay) { this.tradesToday = 0; this.lastTradeDay = today; }
    if (this.tradesToday >= MAX_TRADES_DAY) {
      console.warn('HL: daily trade limit reached (' + MAX_TRADES_DAY + ')');
      return null;
    }

    const { sig, level, stopPrice, rr, type } = signal;
    let { target } = signal;
    if (!stopPrice) { console.warn('HL: no stop price, skipping'); return null; }

    const isBuy = sig === 'LONG';
    const currentPrice = coinState[coinId]?.price;
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
        console.log(`HL: capped TP to R:R ${maxRR} (${withTrend?'with':'counter'}-trend) →`, target.toFixed(1));
      }
    }

    // Position sizing
    const accountSize = this.cachedEquity > 0 ? this.cachedEquity : 100;
    const riskAmount = accountSize * RISK_PCT / 100;
    const slDistance = Math.abs(currentPrice - stopPrice);
    if (slDistance < currentPrice * 0.001) { console.warn('HL: SL too tight'); return null; }

    const size = riskAmount / slDistance;
    const szDec = this.szDecimals[asset] || 3;
    const minSize = Math.pow(10, -szDec);
    if (size < minSize) { console.warn('HL: size too small:', size); return null; }

    // Entry: IOC limit with 1% slippage
    const slip = currentPrice * 0.01;
    const entryPx = isBuy ? currentPrice + slip : currentPrice - slip;

    try {
      // 1. Market entry
      const entryRes = await this.placeOrder(asset, isBuy, size, entryPx, { limit: { tif: 'Ioc' } });
      if (entryRes.status === 'err') { console.error('HL entry failed:', entryRes.response); return null; }
      if (entryRes.filled === false || (!entryRes.filled && !entryRes.totalSz)) { console.error('HL entry not filled'); return null; }

      // 2. Stop Loss
      const slPx = isBuy ? stopPrice * 0.98 : stopPrice * 1.02;
      await this.placeOrder(asset, !isBuy, size, slPx,
        { trigger: { isMarket: true, triggerPx: stopPrice, tpsl: 'sl' } }, true);

      // 3. Take Profit
      if (target) {
        const tpPx = isBuy ? target * 1.02 : target * 0.98;
        await this.placeOrder(asset, !isBuy, size, tpPx,
          { trigger: { isMarket: true, triggerPx: target, tpsl: 'tp' } }, true);
      }

      // Track active trade
      const actualEntry = entryRes.avgPx ? +entryRes.avgPx : currentPrice;
      this.activeTrades[coinId] = {
        asset, side: sig, size, entry: actualEntry,
        sl: stopPrice, tp: target,
        initialSl: stopPrice,
        bestPrice: actualEntry,
        trailState: 'initial'
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

  // ── Trailing stop logic ──
  async trailStops() {
    if (!this.wallet || !this.enabled) return;
    for (const [coinId, trade] of Object.entries(this.activeTrades)) {
      if (!trade || !trade.entry || !trade.sl) continue;
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
        console.log(`HL TRAIL ${trade.asset}: SL → BREAKEVEN $${fmt(newSl)} (1:1 R hit)`);
        await sendTelegram(`🔄 <b>SL → BREAKEVEN: ${trade.asset}</b>\nEntry: $${fmt(trade.entry)}\n1:1 R reached`);
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
        try {
          await this.cancelTriggerOrders(trade.asset);
          const slPx = isLong ? newSl * 0.98 : newSl * 1.02;
          await this.placeOrder(trade.asset, !isLong, trade.size, slPx,
            { trigger: { isMarket: true, triggerPx: newSl, tpsl: 'sl' } }, true);
          // Re-place TP
          if (trade.tp) {
            const tpPx = isLong ? trade.tp * 1.02 : trade.tp * 0.98;
            await this.placeOrder(trade.asset, !isLong, trade.size, tpPx,
              { trigger: { isMarket: true, triggerPx: trade.tp, tpsl: 'tp' } }, true);
          }
          trade.sl = newSl;
          this.saveActiveTrades();
        } catch (e) { console.error('HL trailStops error:', e.message); }
      }
    }
  },

  // ── Close a position (used for reverse trades) ──
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

        console.log(`HL CLOSED ${trade.side} ${trade.asset}: P&L $${pnl.toFixed(2)}`);
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

// ── CLOSED TRADES persistence (file-based) ──
function loadClosedTrades() {
  try { return JSON.parse(fs.readFileSync(CLOSED_TRADES_FILE, 'utf8')); } catch { return []; }
}
function saveClosedTrades(trades) {
  fs.writeFileSync(CLOSED_TRADES_FILE, JSON.stringify(trades.slice(0, 100)));
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

// ══════════════════════════════════════════════════════════════════════════════
// ██  ALERT & TRADE EXECUTION LOGIC                                         ██
// ══════════════════════════════════════════════════════════════════════════════

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
    msg = `${icon} <b>DMS AT LEVEL</b> · ${coinLabel} [${tf}]\n👁 Approaching $${fmt(level)} — watch 15m candle\n\n<a href="https://tbracko.github.io/dmc-signal">Open DMS</a>`;
  } else {
    const rrLine  = rr     ? `\nR:R <b>${rr}</b>` : '';
    const tpLine  = target ? `\nTake Profit: <b>$${fmt(target)}</b>` : '';
    const slLevel = stopPrice || findStopLevel(
      allLevels.length ? allLevels : [{ price:level, type:sig==='SHORT'?'resistance':'support' }],
      level, sig==='SHORT'?'short':'long'
    );
    const slLine  = slLevel ? `\nStop Loss: <b>$${fmt(slLevel)}</b>` : '';
    msg = `${icon} <b>DMS ${dir}</b> · ${coinLabel} [${tf}]\n\nEntry now: <b>$${fmt(price)}</b>\nLevel: <b>$${fmt(level)}</b>${tpLine}${slLine}${rrLine}\n\n<a href="https://tbracko.github.io/dmc-signal">Open DMS</a>`;
  }
  markDedupFired(coinId, tf, type, level);
  const ok = await sendTelegram(msg);
  console.log(`[${new Date().toISOString()}] ${ok?'SENT':'FAILED'} alert: ${coinLabel} [${tf}] ${type} ${sig} @ $${fmt(level)}`);
}

// ── AUTO-TRADE DECISION LOGIC (mirrors app's handleCandle auto-trade block) ──
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

  // v4.8 Phase 3: Hard-block counter-trend auto-trades
  // If HTF direction clearly opposes the signal, do NOT auto-trade at all
  // This prevents the exact scenarios from the DMS review: LONG signals firing
  // when everything points down, or SHORT signals in clear uptrends
  const htfDir = s.htfDir || 'UNCLEAR';
  const withTrend = (d.sig === 'LONG' && htfDir === 'UP') || (d.sig === 'SHORT' && htfDir === 'DOWN');
  const counterTrend = (d.sig === 'LONG' && htfDir === 'DOWN') || (d.sig === 'SHORT' && htfDir === 'UP');

  if (counterTrend) {
    console.log(`HL auto-trade BLOCKED ${sym} ${d.sig}: counter-trend (HTF ${htfDir}) — hard block v4.8`);
    return;
  }

  const minConf = withTrend ? Math.max(MIN_CONFIDENCE - 15, 25) : MIN_CONFIDENCE;
  const trendLabel = withTrend ? 'WITH-TREND' : 'NEUTRAL-TREND';

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
      // Same direction — SKIP (max 1 position per coin to limit exposure)
      console.log(`HL auto-trade SKIP ${sym}: already in ${existing.side} (no stacking)`);
    } else {
      // Opposite direction — close and reverse
      console.log(`HL REVERSE: close ${existing.side} ${sym}, open ${d.sig} (${TFS[tfIdx].l}, conf ${conf}%)`);
      const closeResult = await HL.closePosition(coinId);
      if (closeResult) {
        await HL.executeTrade(coinId, d, conf);
        await HL.syncPositions();
      }
    }
  } else {
    // No existing position — check max concurrent positions (default 3)
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

// ══════════════════════════════════════════════════════════════════════════════
// ██  PER-COIN SCAN                                                         ██
// ══════════════════════════════════════════════════════════════════════════════

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

    let htfDir = 'UNCLEAR';
    if(h4C && h1C) htfDir = nextMove(h4C, h1C).dir;
    else if(h4C)   htfDir = nextMove(h4C, h4C).dir;
    coinState[coinId].htfDir = htfDir;

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

    const tfsToRun = [
      wC  && dC  ? { i:0, c:wC,   dC } : null,
      dC         ? { i:1, c:dC,   dC } : null,
      h4C && dC  ? { i:2, c:h4C,  dC } : null,
      h1C && dC  ? { i:3, c:h1C,  dC } : null,
      m15C && dC ? { i:4, c:m15C, dC } : null,
    ].filter(Boolean);

    // Store all results for confidence calculation
    const allResults = {};

    const signalSummary = [];
    for(const { i, c, dC: dc } of tfsToRun){
      const tf = TFS[i];
      const a  = atr(c);
      const htfCarrier = Object.assign(String(htfDir), { __asiaLevels: asiaLevels });
      const d = dms(c, a, dc, tf.l, htfCarrier);
      allResults[tf.l] = d;

      // Log ALL non-NONE signals for diagnostics
      if(d.type !== 'NONE'){
        const deduped = isDedupSuppressed(coinId, tf.l, d.type, d.level);
        signalSummary.push(`${tf.l}:${d.sig}(${d.type}${deduped?' DEDUP':''})`);
        if(!deduped){
          await maybeAlert(d.sig, tf.l, d.type, d.level, d.target, d.rr, d.stopPrice, coinId, price, allLevels);
          // Auto-trade execution
          await maybeAutoTrade(coinId, i, d, allResults);
        }
      }
    }
    const sigStr = signalSummary.length > 0 ? signalSummary.join(' | ') : 'no signals';
    console.log(`  ${label}: $${fmt(price)} | HTF: ${htfDir} | Session: ${getCurrentSession()} | ${sigStr}`);
  }catch(e){
    console.error(`[${new Date().toISOString()}] Error scanning ${label}:`, e.message);
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// ██  MAIN LOOP                                                             ██
// ══════════════════════════════════════════════════════════════════════════════

// ── DAILY SUMMARY ────────────────────────────────────────────────────────────
const SUMMARY_HOUR = parseInt(process.env.SUMMARY_HOUR || '6', 10); // UTC hour to send daily summary
let lastSummaryDate = '';

async function sendDailySummary() {
  const today = new Date().toISOString().slice(0, 10);
  if (lastSummaryDate === today) return; // already sent today
  lastSummaryDate = today;

  try {
    // Refresh equity
    if (HL.wallet) await HL.syncEquity();

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
        openLines += `\n  ${t.side === 'LONG' ? '🟢' : '🔴'} ${t.asset} ${t.side} @ $${fmt(t.entry)} → ${upnlStr}${trail}`;
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
        closedLines += `\n  ${emoji} ${t.coin} ${t.side} → ${pnlStr}`;
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

    const msg = `📊 <b>DMS Daily Summary</b> · ${today}\n` +
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
  console.log(`DMS Signal Bot v4.6 started. Interval: ${INTERVAL_MS/1000}s`);
  console.log(`Coins: BTC, HYPE, SOL, GOLD  |  Token: ...${TG_TOKEN.slice(-6)}  |  Chat: ${TG_CHATID}`);

  // Initialize Hyperliquid trading module
  if (HL_PRIVATE_KEY && AUTO_TRADE) {
    const hlOk = await HL.init();
    if (hlOk) {
      console.log('Auto-trading ENABLED | Risk:', RISK_PCT + '%', '| Min conf:', MIN_CONFIDENCE + '%', '| Max trades/day:', MAX_TRADES_DAY);
      await sendTelegram('🤖 <b>DMS Signal Bot v4.6 started</b>\n✅ Auto-trading ENABLED\nScanning BTC · HYPE · SOL · GOLD every 2 min\nRisk: ' + RISK_PCT + '% | Min conf: ' + MIN_CONFIDENCE + '%');
    } else {
      console.warn('Auto-trading init FAILED — running in alert-only mode');
      await sendTelegram('🤖 <b>DMS Signal Bot v4.5 started</b>\n⚠️ Auto-trading FAILED to init\nRunning in alert-only mode');
    }
  } else {
    console.log('Auto-trading DISABLED (set AUTO_TRADE=true and HL_PRIVATE_KEY to enable)');
    await sendTelegram('🤖 <b>DMS Signal Bot v4.6 started</b>\nScanning BTC · HYPE · SOL · GOLD every 2 minutes.\n🔔 Alert-only mode');
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

    // Sync positions & equity every 5 min
    setInterval(async () => {
      try {
        await HL.syncPositions();
        await HL.syncEquity();
      } catch (e) { console.warn('Periodic sync error:', e.message); }
    }, 300000);
  }

  // Daily summary check every 5 min (sends once per day at SUMMARY_HOUR UTC)
  setInterval(checkDailySummary, 300000);
}

main().catch(e=>{ console.error('Fatal:', e); process.exit(1); });
