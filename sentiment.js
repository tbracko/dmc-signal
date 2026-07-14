// DMS — sentiment.js  (v5.47, 2026-07-13)
//
// NEWS/SENTIMENT METER — shared module, required by bot.js.
//
// WHAT IT DOES
//   Polls free news feeds (Google News RSS topic queries + CNBC markets RSS),
//   classifies headlines into event buckets with a keyword engine, and produces:
//     riskOff  0..100   (50 = neutral; >65 = risk-off regime, <35 = risk-on)
//     bias     per-asset −100..+100  (bitcoin / sp500 / xyz100 / crude;
//                                     + = long-friendly, − = short-friendly)
//   plus a gateVerdict(coinId, side) used by bot.js executeTrade.
//
// WHY THESE BUCKETS (event study on our own pairs, 2026 data — see
// sentiment-layer-2026-07-13.md):
//   1. WAR/GEOPOLITICS is the #1 driver: Iran war (Feb 28) closed the Strait of
//      Hormuz — crude ±13–18%/day (Mar 6/8/9); the Apr 7 ceasefire → crude −15%,
//      SP500 +2.6%, XYZ100 +3.2%; Jun 11 "close to a deal" → crude sinks, S&P +1.8%;
//      Jul 8 Trump declares ceasefire over → oil jumps, stocks slide.
//      Escalation = crude LONG bias + index/BTC SHORT bias. De-escalation = reverse.
//   2. FED/INFLATION: Jun 5 strong-jobs → rate-HIKE odds → Nasdaq −4% (worst day of
//      year), semis −10%. CPI running 4.2% — hawkish surprises are index-negative.
//   3. CRYPTO-SPECIFIC: Feb 5 BTC −14% (ETF outflows + Bessent no-bailout testimony
//      + $16B liquidation cascade). BTC-only bias, mild risk-off spillover.
//   4. TECH/AI SECTOR: Broadcom's cautious AI forecast nuked semis Jun 5 — hits
//      XYZ100 (Nasdaq-100) hardest, SP500 half-weight.
//   5. TARIFFS/TRADE + generic market panic → broad risk-off.
//
// SHADOW MODE (default): the meter NEVER blocks a trade unless env
// SENTIMENT_GATE=on. In shadow mode bot.js logs the would-block verdict to
// .entry_signals.jsonl (sentimentShadowBlock:true on the entry record) so we can
// validate after 2–4 weeks: how many blocked entries would have lost?
// Promotion rule (same bar as regain/paper): flip SENTIMENT_GATE=on only if
// shadow-blocked trades show PF < 0.7 over >= 10 blocked entries.
//
// ZERO DEPENDENCIES — regex RSS parsing, built-in fetch (Node 18+).

const GN = (q) => `https://news.google.com/rss/search?q=${encodeURIComponent(q + ' when:1d')}&hl=en-US&gl=US&ceid=US:en`;
const FEEDS = [
  { id: 'geo',    url: GN('(iran OR israel OR war OR ceasefire OR "strait of hormuz" OR geopolitical)') },
  { id: 'fed',    url: GN('(fed OR inflation OR CPI OR "rate hike" OR "rate cut" OR "treasury yields" OR payrolls)') },
  { id: 'crypto', url: GN('(bitcoin OR crypto OR ethereum)') },
  { id: 'oil',    url: GN('(oil OR OPEC OR crude OR brent)') },
  { id: 'tech',   url: GN('(nasdaq OR "tech stocks" OR semiconductor OR nvidia OR "S&P 500")') },
  { id: 'trump',  url: GN('trump (market OR tariff OR war OR iran OR fed OR china)') }, // tweet-driven headlines land here in ~minutes
  { id: 'cnbc',   url: 'https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=100003114' },
  // PRIMARY SOURCE: @realDonaldTrump Truth Social posts via Roll Call's archive RSS
  // (truthsocial.com's own API is Cloudflare-walled; this mirror is free and current).
  // kind:'truth' → classify on FULL post text (title is truncated), weight 2× (a
  // market-relevant Trump post moves prices more than one news headline), display
  // prefixed "TRUMP:". Non-market posts (endorsements etc.) match no bucket → ignored.
  { id: 'truth',  url: 'https://trumpstruth.org/feed', kind: 'truth' },
];

// ---- Event buckets ---------------------------------------------------------
// Order matters: first matching direction wins inside a bucket (e.g. "ceasefire
// over" must classify as ESCALATION even though it contains "ceasefire").
const RE = {
  warEsc:   /\b(cease-?fire.{0,40}(over|end(s|ed)?|collaps\w*|broken|distant|doubt|unravel\w*|fading|stall\w*|jeopard\w*)|truce (is )?(over|ends?|broken)|strikes?\b|missile|drone attack|attack(s|ed)?\b|escalat\w+|invasion|bombs?\b|bombing|nuclear (threat|program|strike)|retaliat\w+|hormuz (closed|shut|blocked)|war (with|against|breaks|erupts|widens)|goes to war|mobiliz\w+|declares? war)/i,
  warDeesc: /\b(cease-?fire|truce|peace (deal|talks|agreement|plan)|de-?escalat\w+|tensions? (ease|cool)|close to a deal|deal with iran|diplomatic (breakthrough|solution)|end (of|to) the war|hormuz (reopen|open)\w*)/i,
  fedHawk:  /\b(rate hike|hawkish|hot(ter)? (cpi|inflation)|hotter[- ]than[- ]expected|(inflation|cpi|prices).{0,40}hotter|inflation (accelerat\w+|surges?|jumps?|sticky|stays high)|yields? (surge|spike|jump|climb)|strong (jobs|payrolls|hiring)|fed (holds?|pauses?).{0,20}(higher|longer)|hike odds)/i,
  fedDove:  /\b(rate cut|dovish|inflation (cools?|slows?|eases?|falls?|below)|soft landing|yields? (fall|drop|sink|slide|tumble)|weak (jobs|payrolls)|fed cut)/i,
  cryptoCtx:/\b(bitcoin|crypto|btc|ethereum|coinbase)\b/i,
  techCtx:  /\b(chip|semiconductor|nvidia|broadcom|amd|intel|nasdaq|tech (stocks?|shares|names)|ai (stocks?|rally|bubble|spending|favorites?|names|trade|darlings)|artificial intelligence|data ?centers?|megacaps?|big tech)\b/i,
  oilCtx:   /\b(oil|crude|opec|brent|wti|barrel|gasoline)\b/i,
  neg:      /\b(crash\w*|plunge\w*|tumble\w*|sell-?off|rout|sink\w*|slide\w*|slump\w*|worst (day|week|month)|outflows?|liquidat\w+|hack(ed|s)?|exploit|sues?|crackdown|ban(s|ned)?|charges|collapse\w*|fear|panic|drops?|falls?|bear market|correction|wipes? out|(sharply|broadly) lower|\blower\b|\bdown\b|declines?|dips?|retreats?|skids?|drags?\b|below (a |its )?(key|support|critical))/i,
  pos:      /\b(rall(y|ies)\w*|surge\w*|soar\w*|jump\w*|record high|all-time high|inflows?|approv\w+|adopt\w+|climbs?|gains?|rebound\w*|best (day|week)|breakout|bullish)/i,
  oilBull:  /\b(supply (cut|disruption|shock|risk)|output cut|inventor(y|ies) draw|production (halt|cut|outage)|outage|embargo|sanctions on (iran|russia)|demand (rises?|surge))/i,
  oilBear:  /\b(output (increase|hike|boost)|production (increase|rise|boost)|inventor(y|ies) build|supply glut|oversuppl\w+|demand (falls?|weakens?|cut))/i,
  tariff:   /\b(tariffs?|trade war|import dut\w+|export (controls|ban|curbs)|trade (deal|truce) (collaps\w+|off|over))/i,
  panicCtx: /\b(stocks?|market|wall street|s&p|nasdaq|dow|equit\w+)\b/i,
};

// Per-bucket impact vectors (per matched headline, before time decay).
const IMPACT = {
  warEsc:    { riskOff: +8, crude: +8, sp500: -5, xyz100: -5, bitcoin: -4 },
  warDeesc:  { riskOff: -8, crude: -8, sp500: +5, xyz100: +5, bitcoin: +4 },
  fedHawk:   { riskOff: +5, sp500: -4, xyz100: -5, bitcoin: -3 },
  fedDove:   { riskOff: -5, sp500: +4, xyz100: +5, bitcoin: +3 },
  cryptoNeg: { riskOff: +2, bitcoin: -7 },
  cryptoPos: { bitcoin: +7 },
  techNeg:   { riskOff: +2, xyz100: -7, sp500: -3 },
  techPos:   { xyz100: +7, sp500: +3 },
  oilBull:   { crude: +5 },
  oilBear:   { crude: -5 },
  tariff:    { riskOff: +5, sp500: -4, xyz100: -4 },
  panic:     { riskOff: +6, sp500: -4, xyz100: -4, bitcoin: -3 },
};

const HALF_LIFE_H = 6;      // headline weight halves every 6h
const WINDOW_MS   = 24 * 3600000;
const SCAN_MS     = parseInt(process.env.SENTIMENT_SCAN_MS || '600000', 10); // 10 min
const GATE_ON     = process.env.SENTIMENT_GATE === 'on';   // default OFF = shadow
const RISKOFF_HI  = parseFloat(process.env.SENTIMENT_RISKOFF_HI || '65');
const RISKOFF_LO  = parseFloat(process.env.SENTIMENT_RISKOFF_LO || '35');
const BIAS_BLOCK  = parseFloat(process.env.SENTIMENT_BIAS_BLOCK || '40');

// ---- Headline classification ----------------------------------------------
function classify(title) {
  const buckets = [];
  if (RE.warEsc.test(title)) buckets.push('warEsc');
  else if (RE.warDeesc.test(title)) buckets.push('warDeesc');
  if (RE.fedHawk.test(title)) buckets.push('fedHawk');
  else if (RE.fedDove.test(title)) buckets.push('fedDove');
  if (RE.cryptoCtx.test(title)) {
    if (RE.neg.test(title)) buckets.push('cryptoNeg');
    else if (RE.pos.test(title)) buckets.push('cryptoPos');
  }
  if (RE.techCtx.test(title) && !RE.cryptoCtx.test(title)) {
    if (RE.neg.test(title)) buckets.push('techNeg');
    else if (RE.pos.test(title)) buckets.push('techPos');
  }
  if (RE.oilCtx.test(title)) {
    if (RE.oilBull.test(title)) buckets.push('oilBull');
    else if (RE.oilBear.test(title)) buckets.push('oilBear');
    // price-move headlines: oil surging = bullish regime signal, falling = bearish
    else if (RE.pos.test(title)) buckets.push('oilBull');
    else if (RE.neg.test(title)) buckets.push('oilBear');
  }
  if (RE.tariff.test(title)) buckets.push('tariff');
  if (buckets.length === 0 && RE.panicCtx.test(title) && RE.neg.test(title)) buckets.push('panic');
  return buckets.slice(0, 2); // max 2 buckets per headline
}

// ---- RSS fetch/parse (zero-dep) --------------------------------------------
const deent = (s) => s.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&#39;|&apos;|&#8217;/g, "'").replace(/&quot;|&#8220;|&#8221;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();
function parseRss(xml, wantDesc) {
  const out = [];
  const items = xml.match(/<item>[\s\S]*?<\/item>/g) || [];
  for (const it of items) {
    const tm = it.match(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/);
    const dm = it.match(/<pubDate>([\s\S]*?)<\/pubDate>/);
    if (!tm) continue;
    const title = deent(tm[1]);
    const ts = dm ? Date.parse(dm[1]) : Date.now();
    let desc = '';
    if (wantDesc) {
      const de = it.match(/<description>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/description>/);
      if (de) desc = deent(de[1]).slice(0, 400);
    }
    if (title && Number.isFinite(ts)) out.push({ title, ts, desc });
  }
  return out;
}
async function fetchFeed(feed) {
  try {
    const r = await fetch(feed.url, { headers: { 'User-Agent': 'Mozilla/5.0 (DMS-sentiment)' }, redirect: 'follow', signal: AbortSignal.timeout(15000) });
    if (!r.ok) return [];
    const items = parseRss(await r.text(), feed.kind === 'truth');
    return items.map(it => ({ ...it, kind: feed.kind || 'news' }));
  } catch (e) { console.warn(`sentiment: feed ${feed.id} failed: ${e.message}`); return []; }
}

// ---- State ------------------------------------------------------------------
const state = {
  headlines: new Map(),  // key: normalized title -> { title, ts, buckets }
  meter: { riskOff: 50, bias: { bitcoin: 0, sp500: 0, xyz100: 0, crude: 0 }, regime: 'NEUTRAL' },
  topEvents: [], updatedAt: 0, scanCount: 0, lastError: null,
};
// strip trailing " - Source" (Google News appends the outlet) so syndicated copies dedupe
const norm = (t) => t.replace(/\s+-\s+[^-]{2,45}$/, '').toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').slice(0, 90);

const BUCKET_CAP = 6; // max effective (decayed) headlines per bucket — one story
                      // syndicated across 50 outlets must not out-shout everything
function recompute() {
  const now = Date.now();
  const cnt = {};        // bucket -> decayed headline count
  const contributors = [];
  for (const [key, h] of state.headlines) {
    if (now - h.ts > WINDOW_MS) { state.headlines.delete(key); continue; }
    if (!h.buckets.length) continue;
    const w = Math.pow(0.5, (now - h.ts) / 3600000 / HALF_LIFE_H) * (h.w0 || 1);
    let mag = 0;
    for (const b of h.buckets) {
      cnt[b] = (cnt[b] || 0) + w;
      mag += w;
    }
    if (mag > 0) contributors.push({ title: h.title, ts: h.ts, buckets: h.buckets, mag });
  }
  const sums = { riskOff: 0, bitcoin: 0, sp500: 0, xyz100: 0, crude: 0 };
  for (const b of Object.keys(cnt)) {
    const imp = IMPACT[b]; if (!imp) continue;
    const eff = Math.min(cnt[b], BUCKET_CAP);
    for (const k of Object.keys(imp)) sums[k] += imp[k] * eff;
  }
  const squash = (x) => Math.round(100 * Math.tanh(x / 60));
  state.meter = {
    riskOff: Math.max(0, Math.min(100, Math.round(50 + 50 * Math.tanh(sums.riskOff / 60)))),
    bias: { bitcoin: squash(sums.bitcoin), sp500: squash(sums.sp500), xyz100: squash(sums.xyz100), crude: squash(sums.crude) },
    regime: 'NEUTRAL',
  };
  state.meter.regime = state.meter.riskOff >= RISKOFF_HI ? 'RISK-OFF' : state.meter.riskOff <= RISKOFF_LO ? 'RISK-ON' : 'NEUTRAL';
  state.bucketCounts = Object.fromEntries(Object.entries(cnt).map(([b, v]) => [b, +v.toFixed(1)])); // decayed counts — proves a story category was scored even when not a top driver
  state.topEvents = contributors.sort((a, b) => b.mag - a.mag).slice(0, 8)
    .map(c => ({ title: c.title.slice(0, 110), buckets: c.buckets, ageH: +((now - c.ts) / 3600000).toFixed(1) }));
  state.updatedAt = now;
}

async function scan() {
  const results = await Promise.all(FEEDS.map(fetchFeed));
  let added = 0;
  for (const items of results) {
    for (const it of items) {
      const key = norm(it.title);
      if (!key || state.headlines.has(key)) continue;
      const isTruth = it.kind === 'truth';
      // Truth posts: classify on the FULL post text (title is truncated at ~100 chars),
      // 2× weight (primary source), display-prefixed so it's obvious in top drivers.
      const text = isTruth ? (it.title + ' ' + (it.desc || '')) : it.title;
      let buckets = classify(text);
      if (isTruth && buckets.length) {
        // CAMPAIGN-BOILERPLATE FILTER: endorsement/rally posts routinely contain
        // "supports our Tariffs, Energy Dominance, lower gas prices..." — that's stump
        // copy, not market news, and at 2× weight it would poison the meter on every
        // endorsement. For campaign-flavored posts keep ONLY war buckets (a war threat
        // inside a rally post is still a war threat); drop everything else.
        const campaign = /\b(endorse\w*|endorsement|running (to represent|for|against)|vote for|approval rating|election|primary|maga|campaign|poll(s|ing)?\b)/i.test(text);
        if (campaign) buckets = buckets.filter(b => b === 'warEsc' || b === 'warDeesc');
      }
      state.headlines.set(key, {
        title: (isTruth ? 'TRUMP: ' : '') + it.title,
        ts: it.ts, buckets, w0: isTruth ? 2 : 1,
      });
      added++;
    }
  }
  state.scanCount++;
  recompute();
  return added;
}

// ---- Public API --------------------------------------------------------------
// gateVerdict: would the sentiment layer block this entry?
// In SHADOW mode (default) bot.js logs the verdict but never acts on it.
function gateVerdict(coinId, side) {
  const m = state.meter;
  const bias = m.bias[coinId] ?? 0;
  const risky = coinId === 'bitcoin' || coinId === 'sp500' || coinId === 'xyz100';
  let block = false, reason = null;
  if (side === 'LONG' && risky && m.riskOff >= RISKOFF_HI) { block = true; reason = `risk-off ${m.riskOff} >= ${RISKOFF_HI}`; }
  else if (side === 'LONG' && bias <= -BIAS_BLOCK) { block = true; reason = `${coinId} bias ${bias} <= -${BIAS_BLOCK}`; }
  else if (side === 'SHORT' && bias >= BIAS_BLOCK) { block = true; reason = `${coinId} bias ${bias} >= +${BIAS_BLOCK}`; }
  else if (side === 'SHORT' && coinId === 'crude' && m.riskOff >= RISKOFF_HI && bias >= BIAS_BLOCK) { block = true; reason = `war regime: crude short vs bias +${bias}`; }
  return { block, reason, gateOn: GATE_ON, riskOff: m.riskOff, bias, regime: m.regime };
}
function brief() { // compact snapshot attached to every entry-signal log record
  return { riskOff: state.meter.riskOff, regime: state.meter.regime, bias: state.meter.bias, at: state.updatedAt };
}
function getState() {
  return { ...state.meter, gateOn: GATE_ON, topEvents: state.topEvents, bucketCounts: state.bucketCounts || {},
           headlines24h: state.headlines.size,
           scans: state.scanCount, updatedAt: state.updatedAt ? new Date(state.updatedAt).toISOString() : null };
}
// start(onShift): begin polling. onShift(msg, meter) fires on regime change —
// bot.js forwards it to Telegram (trading service only; TG_MUTED covers ghosts).
let _timer = null, _lastRegime = 'NEUTRAL', _lastShiftTg = 0;
function start(onShift) {
  const run = async () => {
    try {
      await scan();
      const m = state.meter;
      if (m.regime !== _lastRegime && Date.now() - _lastShiftTg > 2 * 3600000) {
        _lastShiftTg = Date.now();
        const top = state.topEvents[0]?.title || 'n/a';
        if (onShift) onShift(
          `🌡 <b>SENTIMENT SHIFT: ${_lastRegime} → ${m.regime}</b>\nrisk-off ${m.riskOff}/100 · BTC ${m.bias.bitcoin} · SPX ${m.bias.sp500} · NDX ${m.bias.xyz100} · CL ${m.bias.crude}\nTop driver: ${top}\n${GATE_ON ? '⛔ gate ACTIVE' : '👁 shadow mode — informational only'}`, m);
        _lastRegime = m.regime;
      } else if (m.regime !== _lastRegime) { _lastRegime = m.regime; }
      state.lastError = null;
    } catch (e) { state.lastError = e.message; console.warn('sentiment scan error:', e.message); }
  };
  setTimeout(run, 20000);          // first scan 20s after boot
  _timer = setInterval(run, SCAN_MS);
  console.log(`sentiment: started (scan every ${SCAN_MS / 60000}min, gate ${GATE_ON ? 'ON' : 'OFF/shadow'}, ${FEEDS.length} feeds)`);
}
function stop() { if (_timer) clearInterval(_timer); }

module.exports = { start, stop, scan, getState, gateVerdict, brief, classify, GATE_ON };
