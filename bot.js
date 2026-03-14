#!/usr/bin/env node
// DMS Signal Bot — runs every 2 minutes, sends Telegram alerts for new signals
// Node 18+ required (uses built-in fetch)
//
// Setup:
//   cp .env.example .env        # fill in your TG_TOKEN and TG_CHATID
//   node bot.js                 # run once
//   # or keep alive with pm2:
//   pm2 start bot.js --name dms-bot

'use strict';
const fs   = require('fs');
const path = require('path');

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
const WANT_HTF_ONLY = process.env.ALERT_HTF_ONLY === 'true';
const MIN_RR        = parseFloat(process.env.MIN_RR || '1.5');
const INTERVAL_MS   = parseInt(process.env.INTERVAL_MS || '120000', 10);
const DEDUP_FILE    = path.join(__dirname, '.dedup.json');

if(!TG_TOKEN || !TG_CHATID){
  console.error('ERROR: TG_TOKEN and TG_CHATID must be set.');
  process.exit(1);
}

// ── COINS ────────────────────────────────────────────────────────────────────
const COINS = {
  bitcoin:  { label:'BTC', bnSym:'BTCUSDT' },
  ethereum: { label:'ETH', bnSym:'ETHUSDT' },
  solana:   { label:'SOL', bnSym:'SOLUSDT' },
};
const TFS = [
  { l:'1W', iv:'1w', limit:104 },
  { l:'1D', iv:'1d', limit:180 },
  { l:'4H', iv:'4h', limit:200 },
  { l:'1H', iv:'1h', limit:120 },
  { l:'15m',iv:'15m',limit:192 },
];
const BINANCE = 'https://api.binance.com/api/v3';

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

// ── BINANCE API ───────────────────────────────────────────────────────────────
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

async function getPrice(coinId){
  const r = await fetch(`${BINANCE}/ticker/24hr?symbol=${COINS[coinId].bnSym}`);
  if(!r.ok) throw new Error('Price: '+r.status);
  const d = await r.json();
  return { price:+d.lastPrice, change:+d.priceChangePercent };
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
  if(type==='resistance'){
    const closedLower = nextCandles.filter(k => k.c < x.bh).length;
    score += closedLower * 10;
    if(nextCandles.some(k => k.c < x.bh * 0.995)) score += 10;
  } else {
    const closedHigher = nextCandles.filter(k => k.c > x.bl).length;
    score += closedHigher * 10;
    if(nextCandles.some(k => k.c > x.bl * 1.005)) score += 10;
  }
  const wickUp = x.h - x.bh, wickDown = x.bl - x.l;
  const rejection = type==='resistance' ? wickUp : wickDown;
  score += Math.min(rejection/range, 1) * 20;
  const prevCandles = c.slice(Math.max(0,i-20), i);
  const zone = range * 0.15;
  const touches = prevCandles.filter(k=>
    type==='resistance'
      ? (k.h >= x.bh - zone && k.h <= x.bh + zone)
      : (k.l <= x.bl + zone && k.l >= x.bl - zone)
  ).length;
  score += Math.min(touches, 3) * 15;
  const approach = c.slice(Math.max(0,i-3),i);
  const directional = type==='resistance'
    ? approach.every((k,j)=>j===0||k.bh>approach[j-1].bh)
    : approach.every((k,j)=>j===0||k.bl<approach[j-1].bl);
  if(directional) score += 10;
  return Math.round(score);
}

function classifyStrength(score){
  if(score >= 40) return 'strong';
  if(score >= 12) return 'med';
  return 'weak';
}

function countLevelTests(c, startIdx, bh, bl, type){
  const levelPrice = type==='resistance' ? bh : bl;
  const zone = levelPrice * 0.010;
  const raw = c.slice(startIdx).filter(k =>
    type==='resistance'
      ? k.bh >= levelPrice - zone
      : k.bl <= levelPrice + zone
  ).length;
  return Math.min(raw, 10);
}

function findVPeaks(c, tf){
  const n = c.length, L = [];
  const lookback = 2;
  const wickRatio = 0.25;
  for(let i=lookback; i<n-lookback; i++){
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
      if(strength !== 'weak'){
        const flippedTypeR = detectFlippedLevel(c, i, 'resistance', x.bh);
        L.push({
          price:x.bh, bh:x.bh, bl:x.bh*0.999,
          type:'resistance', flippedType:flippedTypeR,
          wickSize:wickUp, score, strength, tested, testCount,
          idx:i, tf, source:`V-High${wickUp>range*wickRatio?' (wick reject)':''}`
        });
      }
    }
    if(isSwingLow(c, i, lookback)){
      let score = scoreLevel(c, i, 'support');
      const testCount = countLevelTests(c, i+1, x.bh, x.bl, 'support');
      const tested = testCount > 0;
      if(testCount >= 2) score = Math.round(score * 0.5);
      else if(testCount === 1) score = Math.round(score * 0.75);
      const strength = classifyStrength(score);
      if(strength !== 'weak'){
        const flippedTypeS = detectFlippedLevel(c, i, 'support', x.bl);
        L.push({
          price:x.bl, bh:x.bl*1.001, bl:x.bl,
          type:'support', flippedType:flippedTypeS,
          wickSize:wickDown, score, strength, tested, testCount,
          idx:i, tf, source:`V-Low${wickDown>range*wickRatio?' (wick reject)':''}`
        });
      }
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
  if(h>=b.asiaOpen && h<b.asiaClose)  return 'ASIA';
  if(h>=b.londonOpen && h<b.londonClose) return 'LONDON';
  if(h>=b.nyOpen && h<b.nyClose)      return 'NY';
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
  const asia = (tf==='15m' && asiaLevels) ? asiaLevels : [];
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
  if(direction==='long'){
    const candidates = sorted.filter(l=>l.price > currentPrice * 1.003);
    if(candidates.length) return { price:candidates[0].price, source:candidates[0].source };
  } else {
    const candidates = sorted.filter(l=>l.price < currentPrice * 0.995);
    if(candidates.length) return { price:candidates[candidates.length-1].price, source:candidates[candidates.length-1].source };
  }
  return { price: direction==='long' ? currentPrice*1.025 : currentPrice*0.975, source:'ATR est.' };
}

function findStopLevel(levels, trapPrice, direction){
  const qualityLevels = levels.filter(l => l.score >= 12);
  const pool   = qualityLevels.length >= 2 ? qualityLevels : levels;
  const sorted = [...pool].sort((a,b)=>a.price-b.price);
  if(direction==='short'){
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

// ── DMS SIGNAL ENGINE ─────────────────────────────────────────────────────────
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
      const isStrongLevel = blindCandidate.score >= 55;
      const htfBlocks = !isStrongLevel && ((isRes && htfBias==='UP') || (!isRes && htfBias==='DOWN'));
      if(!htfBlocks){
        const tgt  = findNextLevel(levels, cur.c, isRes?'short':'long');
        const stop = findStopLevel(levels, blindCandidate.price, isRes?'short':'long');
        const rr   = calcRR(cur.c, tgt.price, blindCandidate.price, stop);
        if(rr && parseFloat(rr) >= 1.0){
          const dist      = ((blindCandidate.price - cur.c)/cur.c*100).toFixed(2);
          const htfNote   = htfBias!=='UNCLEAR' ? ` · HTF ${htfBias} aligns` : '';
          const typeLabel = isFlipped ? `PASS-THROUGH` : `UNTESTED ${tf}`;
          return {
            sig:blindSig, type:'BLIND_ENTRY',
            level:blindCandidate.price, target:tgt.price, rr, stopPrice:stop,
            strength:blindCandidate.strength, score:blindCandidate.score,
            reason:`BLIND: ${blindCandidate.source} $${fmt(blindCandidate.price)} · ${dist>0?'+':''}${dist}% · ${typeLabel}${htfNote} · R:R ${rr} → $${fmt(tgt.price)}`
          };
        }
      }
    }

    const atLevelWindow = isHTF ? a * 0.4 : a * 1.0;
    const atLevel = nearby.find(l=>Math.abs(l.price-cur.c) < atLevelWindow && l.score >= 20);
    if(atLevel){
      const dir  = atLevel.type==='resistance' ? 'RESISTANCE — watch 15m for wick + body close back below' : 'SUPPORT — watch 15m for wick + body close back above';
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
  if(n4<8||n1<8) return { dir:'UNCLEAR', reason:'Insufficient data' };
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

// ── ALERT FORMATTING & SENDING ────────────────────────────────────────────────
async function maybeAlert(sig, tf, type, level, target, rr, stopPrice, coinId, price, allLevels){
  if(isDedupSuppressed(coinId, tf, type, level)) return;
  if(WANT_HTF_ONLY && tf!=='1D' && tf!=='1H') return;
  if((type==='FAIL_GAIN' || (type==='BREAKOUT' && sig==='SHORT')) && !WANT_SHORT) return;
  if((type==='FAIL_LOSE' || type==='BLIND_ENTRY') && !WANT_LONG) return;
  if(type==='AT_LEVEL'){
    if(!WANT_ATLEVEL) return;
    if(sig !== 'NEUTRAL') return;
  }

  const icon      = sig==='LONG' ? '🟢' : sig==='SHORT' ? '🔴' : '🟡';
  const coinLabel = COINS[coinId].label;
  const dir       = type==='FAIL_GAIN' ? 'FAIL TO GAIN' : type==='FAIL_LOSE' ? 'FAIL TO LOSE' : type==='BLIND_ENTRY' ? 'BLIND ENTRY' : 'AT LEVEL';
  const rrTxt     = rr ? ` · R:R ${rr}` : '';

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
    msg = `${icon} <b>DMS ${dir}</b> · ${coinLabel} [${tf}]${rrTxt}\n\nEntry now: <b>$${fmt(price)}</b>\nLevel: <b>$${fmt(level)}</b>${tpLine}${slLine}${rrLine}\n\n<a href="https://tbracko.github.io/dmc-signal">Open DMS</a>`;
  }

  markDedupFired(coinId, tf, type, level);
  const ok = await sendTelegram(msg);
  console.log(`[${new Date().toISOString()}] ${ok?'SENT':'FAILED'} alert: ${coinLabel} [${tf}] ${type} ${sig} @ $${fmt(level)}`);
}

// ── PER-COIN SCAN ─────────────────────────────────────────────────────────────
async function scanCoin(coinId){
  const sym   = COINS[coinId].bnSym;
  const label = COINS[coinId].label;
  try{
    const [priceData, ...allCandles] = await Promise.all([
      getPrice(coinId),
      ...TFS.map(tf => bnKlines(sym, tf.iv, tf.limit).catch(e=>{ console.warn(label, tf.l, e.message); return null; }))
    ]);
    const price = priceData.price;
    const [wC, dC, h4C, h1C, m15C] = allCandles;
    if(!dC) return;

    let htfDir = 'UNCLEAR';
    if(h4C && h1C) htfDir = nextMove(h4C, h1C).dir;
    else if(h4C)   htfDir = nextMove(h4C, h4C).dir;

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

    for(const { i, c, dC: dc } of tfsToRun){
      const tf = TFS[i];
      const a  = atr(c);
      const htfCarrier = Object.assign(String(htfDir), { __asiaLevels: asiaLevels });
      const d = dms(c, a, dc, tf.l, htfCarrier);
      if(d.type==='NONE') continue;
      if(!isDedupSuppressed(coinId, tf.l, d.type, d.level)){
        await maybeAlert(d.sig, tf.l, d.type, d.level, d.target, d.rr, d.stopPrice, coinId, price, allLevels);
      }
    }
  }catch(e){
    console.error(`[${new Date().toISOString()}] Error scanning ${label}:`, e.message);
  }
}

// ── MAIN LOOP ─────────────────────────────────────────────────────────────────
async function scanAll(){
  const coins = Object.keys(COINS);
  console.log(`[${new Date().toISOString()}] Scanning ${coins.map(c=>COINS[c].label).join(', ')}...`);
  for(let i=0; i<coins.length; i++){
    if(i>0) await new Promise(r=>setTimeout(r,2000));
    await scanCoin(coins[i]);
  }
  console.log(`[${new Date().toISOString()}] Scan complete. Next in ${INTERVAL_MS/1000}s.`);
}

async function main(){
  console.log(`DMS Signal Bot started. Interval: ${INTERVAL_MS/1000}s`);
  console.log(`Coins: BTC, ETH, SOL  |  Token: ...${TG_TOKEN.slice(-6)}  |  Chat: ${TG_CHATID}`);
  await sendTelegram('🤖 <b>DMS Signal Bot started</b>\nScanning BTC · ETH · SOL every 2 minutes.');
  await scanAll();
  setInterval(scanAll, INTERVAL_MS);
}

main().catch(e=>{ console.error('Fatal:', e); process.exit(1); });
