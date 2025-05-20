// ZenScalp - version visuelle enrichie avec intégration complète
const express = require('express');
const axios = require('axios');
const cron = require('node-cron');
const technicalIndicators = require('technicalindicators');
const fs = require('fs');
const path = require('path');
const bodyParser = require('body-parser');

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

const PORT = process.env.PORT || 3000;
const POLYGON_API_KEY = 'aag8xgN6WM0Q83HLaOt9WqidQAyKrGtp';
const SYMBOL = 'C:EURUSD';
const WEBHOOK_URL = 'https://discordapp.com/api/webhooks/1374330601431109694/g7CqC2-M8pGraO7F3g0q3At0D6BsvyAb0PHtXdwn0KK3aj_4t9hDRcKyQSmNmkyNVEg3';

const IG_API_URL = 'https://api.ig.com/gateway/deal';
const IG_USERNAME = 'timagnus';
const IG_PASSWORD = 'Lyautey#1';
const IG_API_KEY = 'abd969f1ef5b6c5abd190d6deab2ae3401dfebc1';

const ANNOUNCEMENT_FILE = path.resolve('announcements.json');
const PERFORMANCE_FILE = path.resolve('performance.json');
global.entryPrice = null;
global.entryDirection = null;
global.entryTime = null;
global.latestSignal = null

let isPaused = false;
let lastPauseMessage = null;

function loadAnnouncementWindows() {
  try {
    return JSON.parse(fs.readFileSync(ANNOUNCEMENT_FILE, 'utf-8'));
  } catch {
    return [];
  }
}

function isDuringPauseWindow() {
  const nowParis = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Paris' }));
  const currentMinutes = nowParis.getHours() * 60 + nowParis.getMinutes();
  return loadAnnouncementWindows().some(({ time }) => {
    const [h, m] = time.split(':').map(Number);
    return Math.abs(currentMinutes - (h * 60 + m)) <= 15;
  });
}

function getBusinessDays(startDate, count) {
  const days = [];
  let current = new Date(startDate);
  while (days.length < count) {
    if (current.getDay() !== 0 && current.getDay() !== 6) {
      days.push(new Date(current));
    }
    current.setDate(current.getDate() + 1);
  }
  return days;
}

function generatePerformanceData(start = new Date('2025-06-01'), days = 250) {
  const businessDays = getBusinessDays(start, days);
  const rows = [];
  let capital = 1000;

  for (let i = 0; i < businessDays.length; i++) {
    const date = businessDays[i];
    const objectifCapital = capital * 1.013;
const objectif = +(objectifCapital - capital).toFixed(2);
rows.push({
  date: date.toISOString().split('T')[0],
  capitalObjectif: +objectifCapital.toFixed(2),
  capital: +capital.toFixed(2),
  objectif,
  resultat: null,
  ecart: null
});
capital = objectifCapital;
  }
  return rows;
}

function updatePerformanceData(data) {
  let capital = 1000;

  for (let i = 0; i < data.length; i++) {
    const prev = data[i - 1];
    if (i === 0) {
      data[i].capital = capital;
    } else {
      capital = prev.capital + (prev.resultat || 0);
      data[i].capital = +capital.toFixed(2);
    }

    const expected = 1000 * Math.pow(1.013, i);
    const retard = capital - expected;
    const objectif = +(capital * 0.013 + (retard < 0 ? -retard : 0)).toFixed(2);

    data[i].objectif = objectif;
    data[i].ecart = data[i].resultat != null ? +(data[i].resultat - objectif).toFixed(2) : null;
  }
  return data;
}

function loadPerformanceData() {
  try {
    if (!fs.existsSync(PERFORMANCE_FILE)) {
      const data = generatePerformanceData();
      fs.writeFileSync(PERFORMANCE_FILE, JSON.stringify(data, null, 2));
      return data;
    }
    const raw = fs.readFileSync(PERFORMANCE_FILE);
    const parsed = JSON.parse(raw);
    return updatePerformanceData(parsed);
  } catch (e) {
    console.error("❌ Erreur chargement performances:", e);
    return [];
  }
}

function savePerformanceData(data) {
  fs.writeFileSync(PERFORMANCE_FILE, JSON.stringify(data, null, 2));
}

function generatePerformanceTable(data) {
  const objectifFinal = data.at(-1)?.objectif
    ? data.at(-1).capital + data.at(-1).objectif
    : 24931.70;

  let capitalCumul = 1000;
  let joursRenseignés = 0;

  const rows = data.map((d, i) => {
    const resultat = d.resultat != null ? +d.resultat : null;
    const ecart = resultat != null ? +(resultat - d.objectif).toFixed(2) : null;
    if (resultat != null) {
      capitalCumul += resultat;
      joursRenseignés++;
    }

    const color = ecart == null ? '' : ecart >= 0 ? 'style="background:#d4edda"' : 'style="background:#f8d7da"';

    return `<tr ${color}>
      <td>${d.date}</td>
      <td>${d.capitalObjectif.toFixed(2)}€</td>
      <td>${d.capital.toFixed(2)}€</td>
      <td>${d.objectif.toFixed(2)}€</td>
      <td><input type="number" step="0.01" name="resultat-${i}" value="${d.resultat ?? ''}" /></td>
      <td>${ecart != null ? ecart.toFixed(2) + '€' : ''}</td>
    </tr>`;
  });

  const progress = Math.min((capitalCumul / objectifFinal) * 100, 100);
  const barColor = capitalCumul >= objectifFinal * (joursRenseignés / data.length)
    ? '#28a745' // vert
    : '#dc3545'; // rouge

  return `
  <style>
    .progress-bar-container {
      width: 100%;
      background-color: #e0e0e0;
      border-radius: 20px;
      overflow: hidden;
      height: 21px;
      margin-bottom: 12px;
      position: relative;
    }

    .progress-bar-fill {
      height: 100%;
      transition: width 1s ease-in-out, background-color 0.5s ease;
      text-align: right;
      white-space: nowrap;
      color: #fff;
      font-size: 10px;
      display: flex;
      align-items: center;
      justify-content: flex-end;
      padding-right: 6px;
      opacity: 0;
      animation: fadeIn 1s forwards;
    }

    @keyframes fadeIn {
      to {
        opacity: 1;
      }
    }
  </style>

  <div class="card">
    <h2>📈 Suivi de performance</h2>
    <div class="progress-bar-container">
      <div class="progress-bar-fill" style="width: ${progress.toFixed(2)}%; background-color: ${barColor};">
        ${capitalCumul.toFixed(2)}€ 
      </div>
    </div>
    <form method="POST" action="/save-performance">
      <table border="1" cellpadding="5" style="width: 100%; text-align: center;">
        <tr>
          <th>Date</th>
          <th>Objectif Capital</th>
          <th>Capital</th>
          <th>Objectif Jour</th>
          <th>Résultat</th>
          <th>Avance/Retard</th>
        </tr>
        ${rows.join('')}
      </table>
      <br>
      <button type="submit">💾 Enregistrer les performances</button>
    </form>
  </div>
  `;
}

async function getCurrentPrice() {
  try {
    const url = `https://api.polygon.io/v1/last_quote/currencies/EUR/USD?apiKey=${POLYGON_API_KEY}`;
    const response = await axios.get(url);
    return response.data?.last?.ask ?? null;
  } catch (e) {
    console.error('❌ Erreur prix Polygon:', e.message);
    return null;
  }
}

function calculateConfidence(bull, bear) {
  const total = bull + bear;
  return {
    confidence: total ? (bull / total) * 100 : 0,
    confidenceBear: total ? (bear / total) * 100 : 0
  };
}

function detectMultiCandlePattern(candles) {
  const [c1, c2, c3, c4] = candles.slice(-4);
  if (c3.c < c3.o && c4.c > c4.o && c4.c > c3.o && c4.o < c3.c) return '🟩 Avalement haussier';
  if (c3.c > c3.o && c4.c < c4.o && c4.c < c3.o && c4.o > c3.c) return '🟥 Avalement baissier';
  if ([c2, c3, c4].every(c => c.c > c.o)) return '🟩 Trois soldats blancs';
  if ([c2, c3, c4].every(c => c.c < c.o)) return '🟥 Trois corbeaux noirs';
  return null;
}

function analyzeM15(data) {
  const close = data.map(c => c.c);
  const ema50 = technicalIndicators.EMA.calculate({ period: 50, values: close });
  const ema100 = technicalIndicators.EMA.calculate({ period: 100, values: close });
  const price = close.at(-1);
  return (price > ema50.at(-1) && ema50.at(-1) > ema100.at(-1)) ? 'HAUSSIÈRE'
       : (price < ema50.at(-1) && ema50.at(-1) < ema100.at(-1)) ? 'BAISSIÈRE'
       : 'INDÉTERMINÉE';
}

function analyzeTrendM5M15(data5m, data15m) {
  const close5 = data5m.map(c => c.c);
  const close15 = data15m.map(c => c.c);

  const ema50_5m = technicalIndicators.EMA.calculate({ period: 50, values: close5 });
  const ema100_5m = technicalIndicators.EMA.calculate({ period: 100, values: close5 });
  const ema50_15m = technicalIndicators.EMA.calculate({ period: 50, values: close15 });
  const ema100_15m = technicalIndicators.EMA.calculate({ period: 100, values: close15 });

  const price5 = close5.at(-1);
  const price15 = close15.at(-1);

  const margin = 0.00005;

  const e50_5 = ema50_5m.at(-1);
  const e100_5 = ema100_5m.at(-1);
  const e50_15 = ema50_15m.at(-1);
  const e100_15 = ema100_15m.at(-1);

  // Debug
  console.log('[DEBUG TREND] M5:', { price5, e50_5, e100_5 });
  console.log('[DEBUG TREND] M15:', { price15, e50_15, e100_15 });

  let trend5 = (price5 !== undefined && e50_5 !== undefined && e100_5 !== undefined)
    ? (price5 < e50_5 - margin && e50_5 < e100_5 - margin)
      ? 'BAISSIÈRE'
      : (price5 > e50_5 + margin && e50_5 > e100_5 + margin)
        ? 'HAUSSIÈRE'
        : 'INDÉTERMINÉE'
    : 'INDÉTERMINÉE';

  let trend15 = (price15 !== undefined && e50_15 !== undefined && e100_15 !== undefined)
    ? (price15 < e50_15 - margin && e50_15 < e100_15 - margin)
      ? 'BAISSIÈRE'
      : (price15 > e50_15 + margin && e50_15 > e100_15 + margin)
        ? 'HAUSSIÈRE'
        : 'INDÉTERMINÉE'
    : 'INDÉTERMINÉE';

  return { trend5, trend15 };
}






// ZenScalp - version visuelle enrichie avec scoring pondéré réaliste + Ichimoku & prox res/sup

function generateVisualAnalysis(data, trend5 = 'INDÉTERMINÉE', trend15 = 'INDÉTERMINÉE') {
  const close = data.map(c => c.c);
  const high = data.map(c => c.h);
  const low = data.map(c => c.l);
  const price = close.at(-1);

  const ema50 = technicalIndicators.EMA.calculate({ period: 50, values: close });
  const ema100 = technicalIndicators.EMA.calculate({ period: 100, values: close });
  const rsi = technicalIndicators.RSI.calculate({ period: 14, values: close });
  const macd = technicalIndicators.MACD.calculate({ values: close, fastPeriod: 12, slowPeriod: 26, signalPeriod: 9 });
  const stoch = technicalIndicators.Stochastic.calculate({ high, low, close, period: 5, signalPeriod: 3 });
  const ichimoku = technicalIndicators.IchimokuCloud.calculate({ high, low, conversionPeriod: 9, basePeriod: 26, spanPeriod: 52, displacement: 26 });

  let bull = 0, bear = 0, details = [];

  // Ajouter les données d'entrée globales
  if (typeof global.entryTime === 'undefined') global.entryTime = null;

  // EMA
  if (price > ema50.at(-1) && ema50.at(-1) > ema100.at(-1)) {
    bull += 0.8;
    details.push('✅ EMA50 > EMA100 (+0.8)');
  } else if (price < ema50.at(-1) && ema50.at(-1) < ema100.at(-1)) {
    bear += 0.8;
    details.push('❌ EMA50 < EMA100 (+0.8 bear)');
  }

  // RSI
  if (rsi.at(-1) > 50) {
    bull += 0.6;
    details.push('✅ RSI > 50 (+0.6)');
  } else {
    bear += 0.6;
    details.push('❌ RSI < 50 (+0.6 bear)');
  }

  // Tendance combinée M5 / M15
  if (trend5 === 'HAUSSIÈRE') {
    bull += 0.6;
    details.push('✅ Tendance M5 haussière (+0.6)');
  } else if (trend5 === 'BAISSIÈRE') {
    bear += 0.6;
    details.push('❌ Tendance M5 baissière (+0.6 bear)');
  }

  if (trend15 === 'HAUSSIÈRE') {
    bull += 0.4;
    details.push('✅ Tendance M15 haussière (+0.4)');
  } else if (trend15 === 'BAISSIÈRE') {
    bear += 0.4;
    details.push('❌ Tendance M15 baissière (+0.4 bear)');
  }

  if ((trend5 === 'HAUSSIÈRE' && trend15 === 'BAISSIÈRE') ||
      (trend5 === 'BAISSIÈRE' && trend15 === 'HAUSSIÈRE')) {
    details.push('⚠️ Contradiction entre tendance M5 et M15');
  }

  // MACD
  const lastMACD = macd.at(-1);
  if (lastMACD && lastMACD.MACD > lastMACD.signal) {
    bull += 0.6;
    details.push('✅ MACD haussier (+0.6)');
  } else if (lastMACD) {
    bear += 0.6;
    details.push('❌ MACD baissier (+0.6 bear)');
  }

  // Stochastique
  const lastStoch = stoch.at(-1);
  if (lastStoch && lastStoch.k > lastStoch.d && lastStoch.k < 80) {
    bull += 0.4;
    details.push('✅ Stochastique haussier (+0.4)');
  } else if (lastStoch && lastStoch.k < lastStoch.d && lastStoch.k > 20) {
    bear += 0.4;
    details.push('❌ Stochastique baissier (+0.4 bear)');
  }

  // Ichimoku breakout
  const lastIchi = ichimoku.at(-1);
  if (lastIchi && price > lastIchi.spanA && price > lastIchi.spanB && lastIchi.conversion > lastIchi.base) {
    bull += 0.7;
    details.push('✅ Ichimoku breakout (+0.7)');
  } else if (lastIchi && price < lastIchi.spanA && price < lastIchi.spanB && lastIchi.conversion < lastIchi.base) {
    bear += 0.7;
    details.push('❌ Ichimoku breakdown (+0.7 bear)');
  }

  // Proximité res/sup
  const lastHigh = high.slice(-20).reduce((a, b) => Math.max(a, b), 0);
  const lastLow = low.slice(-20).reduce((a, b) => Math.min(a, b), Infinity);
  const pipDistance = 0.0006;

  if (price > lastHigh - pipDistance) {
  bull -= 0.4;
  bear += 0.2; // contexte favorable à une vente
  details.push('⚠️ Proximité résistance (-0.4 bull, +0.2 bear)');
}

  if (price < lastLow + pipDistance) {
  bear -= 0.4;
  bull += 0.2; // contexte favorable à un achat
  details.push('⚠️ Proximité support (-0.4 bear, +0.2 bull)');
}

  // Détection d'un range étroit sur les 6 dernières bougies
const recentCloses = close.slice(-6);
const recentHighs = high.slice(-6);
const recentLows = low.slice(-6);
const rangeMax = Math.max(...recentHighs);
const rangeMin = Math.min(...recentLows);
const rangeAmplitude = rangeMax - rangeMin;


 let totalScore = bull + bear;
let confidence = totalScore > 0 ? (bull / totalScore) * 100 : 0;
let confidenceBear = totalScore > 0 ? (bear / totalScore) * 100 : 0;

  // Si range très étroit (< 0.0006 = 6 pips), on neutralise fortement
if (rangeAmplitude < 0.0008) {
  details.push(`⚠️ Marché en range étroit (${(rangeAmplitude * 10000).toFixed(1)} pips sur 6 bougies) → neutralisation du signal`);
  confidence *= 0.5;
  confidenceBear *= 0.5;
}

  const signal = confidence >= 70 ? 'BUY' : confidenceBear >= 70 ? 'SELL' : 'WAIT';
  const candles = data.slice(-4);
  const pattern = detectMultiCandlePattern(candles);

  // Patterns
  if (pattern === '🟩 Avalement haussier') {
    bull += 0.7;
    details.push('✅ Pattern : Avalement haussier (+0.7)');
  } else if (pattern === '🟥 Avalement baissier') {
    bear += 0.7;
    details.push('❌ Pattern : Avalement baissier (+0.7 bear)');
  } else if (pattern === '🟩 Trois soldats blancs') {
    bull += 0.6;
    details.push('✅ Pattern : Trois soldats blancs (+0.6)');
  } else if (pattern === '🟥 Trois corbeaux noirs') {
    bear += 0.6;
    details.push('❌ Pattern : Trois corbeaux noirs (+0.6 bear)');
  }

  let commentaire = null;
  if ((signal === 'BUY' && pattern && pattern.includes('🟥')) || (signal === 'SELL' && pattern && pattern.includes('🟩'))) {
    commentaire = `⚠️ Contradiction entre signal ${signal} et pattern ${pattern}`;
    details.push(commentaire);
  }

  // Sentiment marché
  const sentiment = (() => {
  const candles = data.slice(-24);
  let altCount = 0, dojiCount = 0, prev = null;

  for (let c of candles) {
    const body = Math.abs(c.c - c.o);
    const dir = c.c > c.o ? 'bull' : c.c < c.o ? 'bear' : 'doji';
    if (body < (c.h - c.l) * 0.2) dojiCount++;
    if (prev && dir !== prev) altCount++;
    if (dir !== 'doji') prev = dir;
  }

  let score = 0;

  // ➤ Seuillage plus permissif
  const altRatio = altCount / candles.length;
  const dojiRatio = dojiCount / candles.length;

  if (altRatio > 0.6) score -= 0.3;           // moins sévère qu'avant
  if (dojiRatio > 0.4) score -= 0.2;          // dojis tolérés jusqu’à 40%
  if (Math.abs(ema50.at(-1) - ema100.at(-1)) < 0.00025) score -= 0.2;
  if (trend15 === 'INDÉTERMINÉE') score -= 0.2; // avant c’était -0.4

  return Math.max(-1, Math.min(1, score));
})();


  // Proximité technique
  let generalWarning = '';
  let safeDistanceBonus = true;
  if (lastIchi && price > lastIchi.spanA && price < lastIchi.spanB) {
    generalWarning = '⚠️ Le prix est dans ou proche du nuage Ichimoku.';
    safeDistanceBonus = false;
  } if (price > lastHigh - pipDistance) {
  generalWarning = `⚠️ Le prix est proche d’une résistance (${lastHigh.toFixed(5)}).`;
  safeDistanceBonus = false;
} else if (price < lastLow + pipDistance) {
  generalWarning = `⚠️ Le prix est proche d’un support (${lastLow.toFixed(5)}).`;
  safeDistanceBonus = false;
}

  if (generalWarning) details.push(generalWarning);
  if (!safeDistanceBonus) {
    confidence -= 0.3;
    confidenceBear -= 0.3;
  } else {
    confidence += 0.3;
    confidenceBear += 0.3;
    details.push('✅ Aucun obstacle technique proche → léger bonus de confiance.');
  }

  confidence = Math.min(confidence, 95);
  confidenceBear = Math.min(confidenceBear, 95);

  if (commentaire) details.push(commentaire);

 // Logique de sortie intelligente complète
if (global.entryPrice !== null && global.entryDirection && global.entryTime) {
  const elapsed = (Date.now() - global.entryTime) / 1000; // secondes
  const pips = Math.round((price - global.entryPrice) * 10000 * (global.entryDirection === 'BUY' ? 1 : -1));
  const tolerance = 3;

  const signalAligned = signal === global.entryDirection;
  const trendOk = (global.entryDirection === 'BUY' && trend5 === 'HAUSSIÈRE') ||
                  (global.entryDirection === 'SELL' && trend5 === 'BAISSIÈRE');

  let recommandation = '';
  let raisons = [];

  if (elapsed < 360) {
    recommandation = '🟡 Attente - position trop récente (<3min)';
    raisons.push('⏳ Moins de 3 minutes écoulées');
  } else if (pips < -tolerance) {
    if (!signalAligned) raisons.push(`❌ Signal actuel : ${signal} ≠ position ${global.entryDirection}`);
    if (!trendOk) raisons.push(`❌ Tendance M15 : ${trend15}, non favorable`);
    if (confidence < 65) raisons.push(`❌ Confiance trop faible : ${confidence.toFixed(1)}%`);

    if (raisons.length > 0) {
      recommandation = `🔴 Sortie recommandée - perte de ${Math.abs(pips)} pips`;
    } else {
      recommandation = `🟢 Attente - contexte global encore favorable malgré ${Math.abs(pips)} pips de perte`;
    }
  } else {
    recommandation = `🟢 Position encore valide - gain ou perte contenue (${pips} pips)`;
  }

  details.push('✅ Recommandation :\n' + recommandation);
  if (raisons.length) details.push('🧠 Raisons :\n' + raisons.join('\n'));
}



  return {
    price,
    signal,
    confidence,
    confidenceBear,
    pattern,
    trend5,
    trend15,
    details,
    commentaire
  };
}

function getISODateNDaysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().split('T')[0];
}

async function fetchData(period = 5) {
  const from = getISODateNDaysAgo(10); // ← recule de 10 jours pour avoir 300 bougies disponibles
  const to = new Date().toISOString().split('T')[0];
  const url = `https://api.polygon.io/v2/aggs/ticker/${SYMBOL}/range/${period}/minute/${from}/${to}?adjusted=true&sort=desc&limit=300&apiKey=${POLYGON_API_KEY}`;
  const { data } = await axios.get(url);
  console.log(`[DEBUG] Bougies ${period}m reçues : ${data.results.length}`);
  return data.results.reverse();
}
/*
async function fetchDataFromIG(period = 5) {
  try {
    // 1. Login session
    const sessionRes = await axios.post(`${IG_API_URL}/session`, {
      identifier: IG_USERNAME,
      password: IG_PASSWORD
    }, {
      headers: {
        'X-IG-API-KEY': IG_API_KEY,
        'Content-Type': 'application/json',
        'Accept': 'application/json;version=3'
      }
    });

    const cst = sessionRes.headers['cst'];
    const xSecurityToken = sessionRes.headers['x-security-token'];

    // 2. Fetch candles
    const resolution = period === 5 ? 'MINUTE_5' : 'MINUTE_15';
    const res = await axios.get(`${IG_API_URL}/prices/CS.D.EURUSD.MINI.IP/${resolution}/100`, {
      headers: {
        'X-IG-API-KEY': IG_API_KEY,
        'CST': cst,
        'X-SECURITY-TOKEN': xSecurityToken,
        'Accept': 'application/json;version=3'
      }
    });

    // 3. Convert to format compatible with TA libs
    return res.data.prices.map(p => ({
      t: new Date(p.snapshotTime).getTime(),
      o: parseFloat(p.openPrice.ask),
      h: parseFloat(p.highPrice.ask),
      l: parseFloat(p.lowPrice.ask),
      c: parseFloat(p.closePrice.ask),
      v: p.lastTradedVolume
    }));
  } catch (err) {
    console.error('❌ Erreur IG fetch:', err.message);
    return [];
  }
}*/





async function sendToDiscord(msg) {
  await axios.post(WEBHOOK_URL, { content: msg });
}

cron.schedule('* * * * *', async () => {
  try {
    if (isDuringPauseWindow()) {
      if (!isPaused) {
        isPaused = true;
        await sendToDiscord('⏸️ Analyse suspendue - annonce économique en cours.');
      }
      return;
    }
    if (isPaused) {
      isPaused = false;
      await sendToDiscord('✅ Reprise des analyses ZenScalp.');
    }

    const data5m = await fetchData(5);
const data15m = await fetchData(15);
    const price = await getCurrentPrice();
    const { trend5, trend15 } = analyzeTrendM5M15(data5m, data15m);
    const analysis = generateVisualAnalysis(data5m, trend5, trend15);

    let msg = `_________________________
`;
    msg += `📈 ${analysis.signal}**
`;
    msg += `🪙 **Prix :** ${price.toFixed(5)}
`;
    msg += `📊 **Confiance :** 📈 ${analysis.confidence.toFixed(1)}% / 📉 ${analysis.confidenceBear.toFixed(1)}%
`;
    msg += `🕒 **Tendance :** ${analysis.trend5}
`;
    if (analysis.pattern) msg += `🕯️ **Pattern :** ${analysis.pattern}
`;
    if (analysis.details && analysis.details.length) {
  msg += '\n🧾 **Détails analyse technique :**\n' + analysis.details.map(d => `• ${d}`).join('\n');
}
    if (entryPrice && entryDirection) {
  msg += `\n⛳ **Entry :** ${entryPrice.toFixed(5)} (${entryDirection})`;
  msg += `\n📉 **Écart actuel :** ${Math.round((price - entryPrice) * 10000)} pips`;
}


    await sendToDiscord(msg);
    global.latestSignal = {
    message: msg,
    date: new Date()
};

  } catch (e) {
    console.error('Erreur visuelle:', e.message);
  }
});

// Ajout GET /clear-entry pour test navigateur
app.get('/clear-entry', (req, res) => {
  entryPrice = null;
  entryDirection = null;
  res.send('❌ Entry supprimé via GET');
});

app.get('/dashboard', (req, res) => {
  const entryHTML = global.entryPrice ? `
    <div class="card">
      <h2>🎯 Entry Price</h2>
      <p><strong>Prix :</strong> ${global.entryPrice.toFixed(5)}</p>
      <p><strong>Direction :</strong> ${global.entryDirection}</p>
      <form method="POST" action="/clear-entry">
        <button class="danger">❌ Supprimer</button>
      </form>
    </div>
  ` : `
    <div class="card warning">
      <h2>⚠️ Aucun Entry</h2>
      <form method="POST" action="/set-entry">
        <input type="number" name="price" step="0.00001" placeholder="Prix" required />
        <select name="direction">
          <option value="BUY">📈 BUY</option>
          <option value="SELL">📉 SELL</option>
        </select>
        <button type="submit">✅ Ajouter</button>
      </form>
    </div>
  `;

  const annonces = loadAnnouncementWindows();
  const rows = annonces.map(({ time }) => `
    <tr>
      <td><input type="time" name="times" value="${time}" required></td>
      <td><button type="button" onclick="this.parentNode.parentNode.remove()">🗑️</button></td>
    </tr>`).join('');

  const perfData = loadPerformanceData();
  const performanceTable = generatePerformanceTable(perfData);

  res.send(`
    <html>
    <head>
      <title>ZenScalp Dashboard</title>
      <style>
        body {
          font-family: 'Segoe UI', sans-serif;
          margin: 40px;
          background: #1e1f22;
          color: #dcddde;
        }
        h1, h2 {
          color: #ffffff;
        }
        .card {
          background: #2f3136;
          padding: 20px;
          border-radius: 10px;
          box-shadow: 0 0 10px rgba(0,0,0,0.3);
          margin-bottom: 20px;
        }
        .warning {
          background-color: #f0ad4e33;
        }
        .danger {
          background-color: #e74c3c;
          color: white;
          padding: 8px 12px;
          border: none;
          border-radius: 5px;
          cursor: pointer;
        }
        input, select {
          margin-right: 10px;
          padding: 6px;
          background: #23272a;
          color: #fff;
          border: 1px solid #444;
          border-radius: 4px;
        }
        table {
          border-collapse: collapse;
          margin-top: 20px;
          width: 100%;
        }
        th, td {
          padding: 6px 10px;
          text-align: center;
          border: 1px solid #444;
        }
        button {
          padding: 6px 10px;
          cursor: pointer;
          border-radius: 5px;
          border: none;
          background-color: #5865f2;
          color: white;
        }
        .signal-box {
          background: #2f3136;
          color: #dcddde;
          border-radius: 8px;
          padding: 15px;
          font-family: inherit;
          white-space: pre-wrap;
          line-height: 1.5;
          font-size: 14px;
          box-shadow: 0 0 5px rgba(0,0,0,0.3);
          opacity: 0;
          animation: fadeIn 1s forwards;
        }
        @keyframes fadeIn {
          to { opacity: 1; }
        }
      </style>
    </head>
    <body>
      <h1>
        <img src="ZenScalp_LogoA01.jpg" alt="ZenScalp" style="height: 32px; vertical-align: middle; margin-right: 10px;">
        ZenScalp Dashboard
      </h1>

      <div style="display: flex; gap: 20px; align-items: flex-start;">
        <div style="flex: 1;">
          ${entryHTML}

          <div class="card">
            <h2>🗓️ Annonces économiques</h2>
            <form method="POST" action="/dashboard" onsubmit="return updateAnnouncements()">
              <table id="timesTable">${rows}</table>
              <button type="button" onclick="addRow()">➕ Ajouter une annonce</button><br><br>
              <input type="hidden" name="annonces" id="jsonData">
              <button type="submit">💾 Enregistrer</button>
            </form>
          </div>

          ${performanceTable}
        </div>

        <div style="flex: 1;">
          <div class="card" id="notifCard">
            <h2>🔔 Dernier Signal <span style="font-size: 0.8em; color: #43b581;">🟢 LIVE</span></h2>
            <div id="notifContent" class="signal-box">Chargement...</div>
            <div id="notifTime" style="font-size: 12px; margin-top: 4px; color: #999;"></div>
            <audio id="notifSound" src="https://actions.google.com/sounds/v1/cartoon/clang_and_wobble.ogg" preload="auto"></audio>
          </div>
        </div>
      </div>

      <script>
        let lastSignalText = '';

        function addRow() {
          const table = document.getElementById('timesTable');
          const row = table.insertRow();
          row.innerHTML = '<td><input type="time" name="times" required></td>' +
                          '<td><button type="button" onclick="this.parentNode.parentNode.remove()">🗑️</button></td>';
        }

        function updateAnnouncements() {
          const inputs = document.getElementsByName('times');
          const data = [];
          for (const input of inputs) {
            if (input.value) data.push({ time: input.value });
          }
          document.getElementById('jsonData').value = JSON.stringify(data);
          return true;
        }

        async function refreshSignal() {
          try {
            const res = await fetch('/latest-signal');
            const data = await res.json();
            const el = document.getElementById('notifContent');
            const timeEl = document.getElementById('notifTime');

            if (data.message && data.message !== lastSignalText) {
              el.innerText = data.message;
              const date = new Date(data.date);
              const timeStr = date.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
              timeEl.innerText = "🕒 Signal généré à " + timeStr;
              lastSignalText = data.message;

              const sound = document.getElementById('notifSound');
              if (sound) sound.play();
            }
          } catch (e) {
            document.getElementById('notifContent').innerText = "⚠️ Erreur lors du chargement.";
            document.getElementById('notifTime').innerText = '';
          }
        }

        refreshSignal();
        setInterval(refreshSignal, 60000);
      </script>
    </body>
    </html>
  `);
});


app.post('/dashboard', (req, res) => {
  try {
    const annonces = JSON.parse(req.body.annonces);
    fs.writeFileSync(ANNOUNCEMENT_FILE, JSON.stringify(annonces, null, 2));
    res.redirect('/dashboard');
  } catch (err) {
    res.status(400).send('Erreur dans les données JSON.');
  }
});

app.post('/save-performance', (req, res) => {
  const perfData = loadPerformanceData();
  const updated = perfData.map((d, i) => {
    const val = req.body[`resultat-${i}`];
    const resultat = val ? parseFloat(val) : null;
    const ecart = resultat != null ? +(resultat - d.objectif).toFixed(2) : null;
    return { ...d, resultat, ecart };
  });
  savePerformanceData(updated);
  res.redirect('/dashboard');
});


app.post('/set-entry', (req, res) => {
  const { price, direction } = req.body;
  if (!price || !['BUY', 'SELL'].includes(direction)) return res.status(400).send('Paramètres invalides');
  global.entryPrice = parseFloat(price);
global.entryDirection = direction;
global.entryTime = Date.now();

  res.redirect('/dashboard');
});

app.post('/clear-entry', (req, res) => {
  entryPrice = null;
  entryDirection = null;
  res.redirect('/dashboard');
});

app.get('/status', (req, res) => {
  res.json({
    entry: entryPrice ? { price: entryPrice, direction: entryDirection } : null,
    paused: isPaused
  });
});

app.get('/latest-signal', (req, res) => {
  res.json(global.latestSignal || { message: 'Aucun signal récent.', date: null });
});

app.listen(PORT, () => console.log(`🟢 Serveur ZenScalp actif sur port ${PORT}`));
