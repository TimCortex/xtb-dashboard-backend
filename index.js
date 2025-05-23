// ZenScalp - version visuelle enrichie avec intégration complète
const express = require('express');
const axios = require('axios');
const cron = require('node-cron');
const technicalIndicators = require('technicalindicators');
const fs = require('fs');
const path = require('path');
const bodyParser = require('body-parser');
const SIGNAL_LOG_PATH = './signal_history.json';
const SIGNAL_RESULT_FILE = path.resolve('signal_results.json');
const activeSignals = new Map(); // Map temporaire en RAM

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'Public')));


const PORT = process.env.PORT || 3000;
const POLYGON_API_KEY = 'aag8xgN6WM0Q83HLaOt9WqidQAyKrGtp';
const SYMBOL = 'C:EURUSD';
const WEBHOOK_URL = 'https://discordapp.com/api/webhooks/1374330601431109694/g7CqC2-M8pGraO7F3g0q3At0D6BsvyAb0PHtXdwn0KK3aj_4t9hDRcKyQSmNmkyNVEg3';

const IG_API_URL = 'https://api.ig.com/gateway/deal';
const IG_USERNAME = 'timagnus';
const IG_PASSWORD = 'Lyautey#1';
const IG_API_KEY = 'abd969f1ef5b6c5abd190d6deab2ae3401dfebc1';
const IG_ACCOUNT_ID = 'EXM4S'; // remplace par ton vrai identifiant


const ANNOUNCEMENT_FILE = path.resolve('announcements.json');
const PERFORMANCE_FILE = path.resolve('performance.json');
global.entryPrice = null;
global.entryDirection = null;
global.entryTime = null;
global.latestSignal = null
global.lastManualPosition = null;
global.isSignalActive = false;



let isPaused = false;
let lastPauseMessage = null;

//

function loadSignalResults() {
  try {
    if (!fs.existsSync(SIGNAL_RESULT_FILE)) fs.writeFileSync(SIGNAL_RESULT_FILE, '[]');
    return JSON.parse(fs.readFileSync(SIGNAL_RESULT_FILE));
  } catch {
    return [];
  }
}

// ZenScalp - version enrichie avec logique adaptative avancée : tags + combinaisons + contexte

function getAdaptiveWeights() {
  const all = loadSignalResults();
  const tagStats = {};
  const comboStats = {};

  for (const sig of all) {
    const tags = sig.context?.tags || [];
    const outcome = sig.outcome;

    for (const tag of tags) {
      if (!tagStats[tag]) tagStats[tag] = { success: 0, fail: 0 };
      if (outcome === 'success') tagStats[tag].success++;
      else if (outcome === 'fail') tagStats[tag].fail++;
    }

    // Combinations
    const sorted = [...tags].sort();
    for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; j < sorted.length; j++) {
        const comboKey = `${sorted[i]}|${sorted[j]}`;
        if (!comboStats[comboKey]) comboStats[comboKey] = { success: 0, fail: 0 };
        if (outcome === 'success') comboStats[comboKey].success++;
        else if (outcome === 'fail') comboStats[comboKey].fail++;
      }
    }
  }

  const scoreMap = {};
  for (const tag in tagStats) {
    const { success, fail } = tagStats[tag];
    const total = success + fail;
    const rate = total ? success / total : 0.5;
    scoreMap[tag] = +(rate * 2 - 1).toFixed(2); // Échelle de -1 à +1
  }

  const comboMap = {};
  for (const combo in comboStats) {
    const { success, fail } = comboStats[combo];
    const total = success + fail;
    const rate = total ? success / total : 0.5;
    comboMap[combo] = +(rate * 1.0 - 0.5).toFixed(2); // Échelle plus douce : -0.5 à +0.5
  }

  return { scoreMap, comboMap };
}

function applyDeepWeights(tags, context = {}) {
  const { scoreMap, comboMap } = getAdaptiveWeights();
  let total = 0;

  // Poids individuel
  for (const tag of tags) {
    total += scoreMap[tag] ?? 0.2;
  }

  // Poids combinés
  const sorted = [...tags].sort();
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      const key = `${sorted[i]}|${sorted[j]}`;
      total += comboMap[key] ?? 0;
    }
  }

  return total;
}


function applyWeights(tags, defaultScore = 0.4) {
  const weights = getAdaptiveWeights();
  return tags.reduce((sum, tag) => sum + (weights[tag] ?? defaultScore), 0);
}


// ZenScalp - version enrichie avec boucle de suivi TP/SL asynchrone

function scheduleSignalEvaluation(signalObj) {
  const id = Date.now();
  const timestamp = new Date().toISOString();

  const signal = {
    ...signalObj,
    timestamp
  };

  activeSignals.set(id, signal);
  global.activeSignal = signal;
  global.isSignalActive = true;

  const { direction, context } = signal;
  const takeProfit = 1.5; // en pips
  const stopLoss = 5;     // en pips
  const checkInterval = 5000;
  const maxWaitTime = 10 * 60 * 1000;
  const startTime = Date.now();

  // Enregistre le prix d’entrée fiable (mid)
  getCurrentPrice().then(initial => {
    if (!initial || typeof initial.mid !== 'number') {
      console.warn('❌ Prix d’entrée indisponible.');
      global.activeSignal = null;
      global.isSignalActive = false;
      return;
    }

    const entryPrice = initial.mid;
    signal.price = entryPrice; // pour dashboard
    signal.entryPrice = entryPrice;

    const interval = setInterval(async () => {
      const currentTime = Date.now();

      const latest = await getCurrentPrice();
      if (!latest) return;
      const latestPrice = latest.mid;

      const pips = (latestPrice - entryPrice) * 10000 * (direction === 'BUY' ? 1 : -1);
      const roundedPips = +pips.toFixed(1);

      let outcome = null;
      if (roundedPips >= takeProfit) outcome = 'success';
      else if (roundedPips <= -stopLoss) outcome = 'fail';

      const timeExpired = currentTime - startTime > maxWaitTime;

      if (outcome) {
        clearInterval(interval);
        activeSignals.delete(id);

        if (global.activeSignal?.timestamp === timestamp) {
          global.activeSignal = null;
          global.isSignalActive = false;
        }

        const result = {
          timestamp,
          direction,
          entryPrice,
          exitPrice: latestPrice,
          pips: roundedPips,
          outcome: outcome || 'fail',
          context
        };

        const existing = loadSignalResults();
        existing.push(result);
        saveSignalResults(existing);
      }
    }, checkInterval);
  });
}





function saveSignalResults(results) {
  fs.writeFileSync(SIGNAL_RESULT_FILE, JSON.stringify(results, null, 2));
}


function loadSignalHistory() {
  try {
    return JSON.parse(fs.readFileSync(SIGNAL_LOG_PATH, 'utf-8'));
  } catch {
    return [];
  }
}

function getSignalHistoryHTML() {
  const results = loadSignalResults();
  const active = global.activeSignal;

  const rows = results.slice().reverse().map(sig => {
    return `<tr>
      <td>${new Date(sig.timestamp).toLocaleString('fr-FR')}</td>
      <td>${sig.direction}</td>
      <td>${typeof sig.entryPrice === 'number' ? sig.entryPrice.toFixed(5) : '-'}</td>
      <td>${typeof sig.exitPrice === 'number' ? sig.exitPrice.toFixed(5) : '-'}</td>
      <td>${typeof sig.pips === 'number' ? `${sig.pips} pips` : '-'}</td>
      <td>${sig.outcome === 'success' ? '✅' : sig.outcome === 'fail' ? '❌' : '-'}</td>
    </tr>`;
  });

  if (active) {
    const since = new Date(active.timestamp);
    rows.unshift(`<tr id="activeRow" class="blinking" data-start="${active.timestamp}">>
>
      <td><span id="activeTimer">⏳</span></td>
      <td>${active.direction}</td>
      <td>${typeof active.price === 'number' ? active.price.toFixed(5) : '-'}</td>
      <td>-</td>
      <td>...</td>
      <td><strong>⏳ En cours</strong></td>
    </tr>`);
  }

  return `
  <div class="card">
    <h2>📜 Historique des signaux</h2>
    <table>
      <tr><th>Heure</th><th>Direction</th><th>Entrée</th><th>Sortie</th><th>Pips</th><th>Résultat</th></tr>
      ${rows.join('')}
    </table>
  </div>
  <style>
    .blinking {
      animation: blink 1.5s infinite;
      background-color: #f0ad4e33;
    }
    @keyframes blink {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.4; }
    }
  </style>
  <script>
    window.globalActiveStart = window.globalActiveStart || Date.now();
    setInterval(() => {
      const span = document.getElementById('activeTimer');
      if (span && window.globalActiveStart) {
        const elapsed = Math.floor((Date.now() - window.globalActiveStart) / 1000);
        const minutes = Math.floor(elapsed / 60);
        const seconds = elapsed % 60;
        span.textContent = minutes + "m" + seconds.toString().padStart(2, '0') + "s";
      }
    }, 1000);
  </script>`;
}





function saveSignalHistory(history) {
  fs.writeFileSync(SIGNAL_LOG_PATH, JSON.stringify(history, null, 2));
}

function logSignal({ signal, price, time }) {
  const history = loadSignalHistory();
  history.push({ signal, price, time, success: null });
  saveSignalHistory(history);
}

async function checkSignalSuccess({ signal, price, time }) {
  const getCurrentPrice = require('./priceHelper'); // ou une fonction directe
  const current = await getCurrentPrice();
  const pips = Math.round((current - price) * 10000 * (signal === 'BUY' ? 1 : -1));
  const success = pips >= 10;

  const history = loadSignalHistory();
  const idx = history.findIndex(s => s.time === time);
  if (idx >= 0) history[idx].success = success;
  saveSignalHistory(history);
}

// Exemple d’appel
function emitSignal(signal, price) {
  const time = Date.now();
  logSignal({ signal, price, time });

  setTimeout(() => checkSignalSuccess({ signal, price, time }), 60000);
}

module.exports = {
  emitSignal,
  loadSignalHistory
};
//

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

function getSignalSummaryHTML() {
  const data = loadSignalResults();
  const tagStats = {};
  let successCount = 0, failCount = 0;

  for (const sig of data) {
    for (const t of sig.context?.tags || []) {
      // on récupère toujours une string pour la clé
      const tagName = typeof t === 'object' && t.name ? t.name : t;
      if (!tagStats[tagName]) tagStats[tagName] = { success: 0, fail: 0 };
      if (sig.outcome === 'success') tagStats[tagName].success++;
      else if (sig.outcome === 'fail') tagStats[tagName].fail++;
    }
    if (sig.outcome === 'success') successCount++;
    else if (sig.outcome === 'fail') failCount++;
  }

  if (Object.keys(tagStats).length === 0) {
    return `<div class="card warning"><h2>📊 Historique des tags</h2><p>Aucun signal évalué pour l’instant.</p></div>`;
  }

  const rows = Object.entries(tagStats).map(([tag, { success, fail }]) => {
    const total = success + fail;
    const rate  = total ? ((success / total) * 100) : 0;
    const pct   = rate.toFixed(1);
    const color = rate >= 65 ? '#28a745' : rate <= 35 ? '#e74c3c' : '#f0ad4e';

    return `
      <tr>
        <td>${tag}</td>
        <td>
          <div class="progress-bar">
            <div class="progress-fill" style="width:${pct}%; background:${color}"></div>
          </div>
          <span class="progress-label">${pct}%</span>
        </td>
      </tr>
    `;
  }).join('');

  return `
    <style>
      .progress-bar { width:100%; background:#444; border-radius:4px; height:8px; overflow:hidden; }
      .progress-fill { height:100%; transition:width .5s; }
      .progress-label { font-size:.8em; color:#ddd; margin-left:6px; }
      .tag-summary-table td { padding:6px; vertical-align:middle; }
    </style>
    <div class="card">
      <h2>📊 Historique des tags & importance</h2>
      <table class="tag-summary-table">
        <tr><th>Tag</th><th>Importance</th></tr>
        ${rows}
      </table>
    </div>
  `;
}





async function getCurrentPrice() {
  try {
    const url = `https://api.polygon.io/v1/last_quote/currencies/EUR/USD?apiKey=${POLYGON_API_KEY}`;
    const response = await axios.get(url);
    const quote = response.data?.last;

    if (!quote || typeof quote.ask !== 'number' || typeof quote.bid !== 'number') {
      console.warn('⚠️ Données Polygon incomplètes ou invalides:', quote);
      return null;
    }

    const bid = quote.bid;
    const ask = quote.ask;
    const mid = +( (bid + ask) / 2 ).toFixed(5);

    return { bid, ask, mid };
  } catch (e) {
    console.error('❌ Erreur getCurrentPrice (Polygon):', e.message);
    return null;
  }
}



function getIGAuthHeaders() {
  return axios.post(`${IG_API_URL}/session`, {
    identifier: IG_USERNAME,
    password: IG_PASSWORD
  }, {
    headers: {
      'X-IG-API-KEY': IG_API_KEY,
      'Content-Type': 'application/json',
      'Accept': 'application/json;version=3'
    }
  }).then(res => ({
    CST: res.headers['cst'],
    X_SECURITY_TOKEN: res.headers['x-security-token']
  })).catch(() => null);
}

async function fetchLatestIGPosition() {
  try {
    const auth = await getIGAuthHeaders();
    if (!auth) return null;

    const res = await axios.get(`${IG_API_URL}/positions`, {
      headers: {
        'X-IG-API-KEY': IG_API_KEY,
        'CST': auth.CST,
        'X-SECURITY-TOKEN': auth.X_SECURITY_TOKEN,
        'Accept': 'application/json;version=2'
      }
    });

    const pos = res.data.positions.find(p => p.market.epic === 'CS.D.EURUSD.MINI.IP');
    if (!pos) return null;

    const direction = pos.position.direction;
    const entry = parseFloat(pos.position.level);
    const size = pos.position.size;
    const date = pos.position.createdDate;

    return { entry, direction, size, date };
  } catch (e) {
    console.error('❌ Erreur récupération position IG :', e.message);
    return null;
  }
}



function detectSupportResistanceStrength(candles, lookback = 100, tolerance = 0.0003) {
  const highs = candles.map(c => c.h);
  const lows = candles.map(c => c.l);

  const lastHigh = Math.max(...highs.slice(-20));
  const lastLow = Math.min(...lows.slice(-20));

  let supportTouches = 0;
  let resistanceTouches = 0;

  for (let i = 0; i < lookback; i++) {
    const c = candles[i];
    if (Math.abs(c.l - lastLow) <= tolerance) supportTouches++;
    if (Math.abs(c.h - lastHigh) <= tolerance) resistanceTouches++;
  }

  const supportStrength = supportTouches >= 4 ? 3 : supportTouches >= 2 ? 2 : 1;
  const resistanceStrength = resistanceTouches >= 4 ? 3 : resistanceTouches >= 2 ? 2 : 1;

  return {
    lastHigh,
    lastLow,
    supportStrength,
    resistanceStrength
  };
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




// ZenScalp - version enrichie avec scoring adaptatif intelligent, exposition des poids par tag


// ZenScalp - version finale : gestion complète des poids, pauses et conditions avancées

function generateVisualAnalysis(data, trend5 = 'INDÉTERMINÉE', trend15 = 'INDÉTERMINÉE', context = {}) {
  // Récupère les poids adaptatifs
  const { scoreMap, comboMap } = getAdaptiveWeights();

  // Filtre des données valides
  data = data.filter(c => c && typeof c.h === 'number' && typeof c.l === 'number' && typeof c.c === 'number' && typeof c.o === 'number');
  const tags = [];
  const details = [];

  // Si données insuffisantes
  if (data.length < 50) {
    return {
      price: null,
      signal: 'WAIT',
      confidence: 0,
      confidenceBear: 0,
      pattern: null,
      trend5,
      trend15,
      tags: [],
      details: ['❌ Analyse impossible - données insuffisantes'],
      commentaire: 'Erreur de données.',
      context: { ...context, tagWeights: {}, pauseUntil: context.pauseUntil }
    };
  }

  // Timestamp de la dernière bougie (ms depuis epoch)
  const lastTs = data.at(-1).t;

  // Pause si volatilité élevée en attente
  if (context.pauseUntil && lastTs < context.pauseUntil) {
    details.push('⏸ Pause volatilité élevée : attendre 5 minutes');
    return {
      price: data.at(-1).c,
      signal: 'WAIT',
      confidence: 50,
      confidenceBear: 50,
      pattern: null,
      trend5,
      trend15,
      tags: [],
      details,
      commentaire: 'Analyse en pause en raison de forte volatilité.',
      context
    };
  }

  // Prépare les séries de prix
  const close = data.map(c => c.c);
  const high = data.map(c => c.h);
  const low = data.map(c => c.l);
  const price = close.at(-1);

  // Calcul des indicateurs
  const ema50 = technicalIndicators.EMA.calculate({ period: 50, values: close });
  const ema100 = technicalIndicators.EMA.calculate({ period: 100, values: close });
  const rsi = technicalIndicators.RSI.calculate({ period: 14, values: close });
  const macd = technicalIndicators.MACD.calculate({ values: close, fastPeriod: 12, slowPeriod: 26, signalPeriod: 9 });
  const stoch = technicalIndicators.Stochastic.calculate({ high, low, close, period: 5, signalPeriod: 3 });
  const ichimoku = technicalIndicators.IchimokuCloud.calculate({ high, low, conversionPeriod: 9, basePeriod: 26, spanPeriod: 52, displacement: 26 });
  const atr = technicalIndicators.ATR.calculate({ period: 14, high, low, close });

  const lastMACD = macd.at(-1);
  const lastStoch = stoch.at(-1);
  const lastIchi = ichimoku.at(-1);
  const lastATR = atr.at(-1) ?? 0.001;

  // Pause si volatilité extrême détectée
  const extremeVolThreshold = 0.0020;
  if (lastATR > extremeVolThreshold) {
    details.push('⚠️ Volatilité extrême détectée, pause 5 minutes');
    context.pauseUntil = lastTs + 5 * 60 * 1000;
    return {
      price,
      signal: 'WAIT',
      confidence: 50,
      confidenceBear: 50,
      pattern: null,
      trend5,
      trend15,
      tags: [],
      details,
      commentaire: 'Analyse en pause en raison de forte volatilité.',
      context
    };
  }

  // Analyse des conditions de marché
  if (price > ema50.at(-1) && ema50.at(-1) > ema100.at(-1)) { tags.push('EMA haussière'); details.push('✅ EMA50 > EMA100'); }
  else if (price < ema50.at(-1) && ema50.at(-1) < ema100.at(-1)) { tags.push('EMA baissière'); details.push('❌ EMA50 < EMA100'); }
  if (rsi.at(-1) > 50) { tags.push('RSI>50'); details.push('✅ RSI > 50'); }
  else { tags.push('RSI<50'); details.push('❌ RSI < 50'); }
  if (lastMACD && lastMACD.MACD > lastMACD.signal) { tags.push('MACD haussier'); details.push('✅ MACD haussier'); }
  else if (lastMACD) { tags.push('MACD baissier'); details.push('❌ MACD baissier'); }
  if (lastStoch && lastStoch.k > lastStoch.d && lastStoch.k < 80) { tags.push('Stoch haussier'); details.push('✅ Stochastique haussier'); }
  else if (lastStoch) { tags.push('Stoch baissier'); details.push('❌ Stochastique baissier'); }
  if (lastIchi && price > lastIchi.spanA && price > lastIchi.spanB && lastIchi.conversion > lastIchi.base) { tags.push('Ichimoku breakout'); details.push('✅ Ichimoku breakout'); }
  else if (lastIchi) { tags.push('Ichimoku breakdown'); details.push('❌ Ichimoku breakdown'); }

  // Tendances
  if (trend5 === 'HAUSSIÈRE') { tags.push('Trend M5 haussier'); details.push('✅ Tendance M5 haussière'); }
  else if (trend5 === 'BAISSIÈRE') { tags.push('Trend M5 baissier'); details.push('❌ Tendance M5 baissière'); }
  if (trend15 === 'HAUSSIÈRE') { tags.push('Trend M15 haussier'); details.push('✅ Tendance M15 haussière'); }
  else if (trend15 === 'BAISSIÈRE') { tags.push('Trend M15 baissier'); details.push('❌ Tendance M15 baissière'); }

  // Patterns bougies
  const pattern = detectMultiCandlePattern(data.slice(-4));
  if (pattern === '🟩 Avalement haussier') { tags.push('Pattern haussier'); details.push('✅ Avalement haussier'); }
  else if (pattern === '🟥 Avalement baissier') { tags.push('Pattern baissier'); details.push('❌ Avalement baissier'); }

  // Volatilité relative
  const atrPips = lastATR * 10000;
  if (lastATR < 0.0004) { tags.push('Volatilité faible'); details.push(`⚠️ Volatilité faible (ATR ${atrPips.toFixed(1)} pips)`); }
  else if (lastATR > 0.0015) { tags.push('Volatilité élevée'); details.push(`⚠️ Volatilité élevée (ATR ${atrPips.toFixed(1)} pips)`); }
  else { tags.push('Volatilité idéale'); details.push(`✅ Volatilité idéale (ATR ${atrPips.toFixed(1)} pips)`); }

  // Supports & résistances
  const { lastHigh, lastLow, supportStrength, resistanceStrength } = detectSupportResistanceStrength(data);
  const distRes = Math.abs(price - lastHigh);
  const distSup = Math.abs(price - lastLow);
  if (distRes <= lastATR * 0.5) { tags.push('Proche résistance'); details.push(`⚠️ Proche résistance (${Math.round(distRes*10000)} pips)`); if (resistanceStrength>=2) { tags.push('Résistance forte'); details.push(`🔴 Force ${resistanceStrength}`); }}
  if (distSup <= lastATR * 0.5) { tags.push('Proche support'); details.push(`⚠️ Proche support (${Math.round(distSup*10000)} pips)`); if (supportStrength>=2) { tags.push('Support fort'); details.push(`🟢 Force ${supportStrength}`); }}

  // Exposition des poids par tag
  const tagWeights = {};
  for (const tag of tags) {
    tagWeights[tag] = +(scoreMap[tag] ?? 0.2).toFixed(2);
  }
  const detailedTags = tags.map(tag => ({ name: tag, weight: tagWeights[tag] }));

  // Scoring adaptatif initial
  let adaptiveScore = applyDeepWeights(tags, context);
  // Bonus/Malus de proximité
  let proximityBonus = 0;
  if (distSup <= lastATR * 0.5) proximityBonus += supportStrength * (adaptiveScore >= 0 ? 0.5 : -0.5);
  if (distRes <= lastATR * 0.5) proximityBonus += resistanceStrength * (adaptiveScore <= 0 ? 0.5 : -0.5);
  adaptiveScore += proximityBonus;

  // Rejets sur résistance et supports forts
  const reboundRes = distRes <= lastATR * 0.3 && resistanceStrength>=2 && lastStoch.k<lastStoch.d && lastMACD.MACD<lastMACD.signal;
  if (adaptiveScore>0 && reboundRes) { details.push('🛑 Rejet résistance : WAIT'); adaptiveScore = 0; }
  const reboundSup = distSup <= lastATR * 0.3 && supportStrength>=2 && lastStoch.k>lastStoch.d && lastMACD.MACD>lastMACD.signal;
  if (adaptiveScore<0 && reboundSup) { details.push('🛑 Rebond support : WAIT'); adaptiveScore = 0; }

  // Range trop étroit (6 bougies)
  const windowSize = 6;
  const highRange = Math.max(...high.slice(-windowSize));
  const lowRange = Math.min(...low.slice(-windowSize));
  if (highRange - lowRange < lastATR * 1.5) { details.push('🔇 Range étroit : WAIT'); adaptiveScore = 0; }

  // Calcul signal final
  const capped = Math.max(-4, Math.min(4, adaptiveScore));
  const confidence = +(50 + capped * 12.5).toFixed(1);
  const confidenceBear = +(100 - confidence).toFixed(1);
  let signal = confidence >= 65 ? 'BUY' : confidence <= 35 ? 'SELL' : 'WAIT';

  // Annulation si contradictoire avec tendance M5
  if ((signal==='BUY' && trend5==='BAISSIÈRE') || (signal==='SELL' && trend5==='HAUSSIÈRE')) {
    signal = 'WAIT';
    details.push('⏸ Contradiction avec M5');
  }

  // Triggers de momentum
  if (macd.length>=2) {
    const prev = macd.at(-2);
    if (prev && lastMACD && ((prev.MACD<=prev.signal && lastMACD.MACD>lastMACD.signal) || (prev.MACD>=prev.signal && lastMACD.MACD<lastMACD.signal))) {
      details.push('⚡ Croisement MACD');
    }
  }
  if (rsi.length>=2 && Math.abs(rsi.at(-1)-rsi.at(-2))>5) {
    details.push(`⚡ Mouvement RSI (${rsi.at(-2).toFixed(1)}→${rsi.at(-1).toFixed(1)})`);
  }
  if (stoch.length>=2 && Math.abs(lastStoch.k-stoch.at(-2).k)>10) {
    details.push(`⚡ Accélération Stoch (${stoch.at(-2).k.toFixed(1)}→${lastStoch.k.toFixed(1)})`);
  }

  // Contradiction pattern
  let commentaire = null;
  if ((signal==='BUY' && pattern?.includes('🟥')) || (signal==='SELL' && pattern?.includes('🟩'))) {
    commentaire = `⚠️ Contradiction signal ${signal} vs pattern ${pattern}`;
    details.push(commentaire);
  }

  return {
    price,
    signal,
    confidence,
    confidenceBear,
    pattern,
    trend5,
    trend15,
    tags: detailedTags,
    details,
    commentaire,
    context: { ...context, pauseUntil: context.pauseUntil, tagWeights, lastSignal: signal }
  };
}












function getISODateNDaysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().split('T')[0];
}

async function fetchData(period = 5) {
  try {
    const now = new Date();
    const fromDate = new Date(now);
    if (period === 15) {
      fromDate.setDate(fromDate.getDate() - 3); // 3 jours pour M15
    } else if (period === 5) {
      fromDate.setDate(fromDate.getDate() - 2); // 2 jours pour M5
    } else {
      fromDate.setDate(fromDate.getDate() - 5); // fallback
    }

    const from = fromDate.toISOString().split('T')[0];
    const to = now.toISOString().split('T')[0];
    const limit = period === 15 ? 3000 : period === 5 ? 1000 : 500;

    const url = `https://api.polygon.io/v2/aggs/ticker/${SYMBOL}/range/${period}/minute/${from}/${to}?adjusted=true&sort=desc&limit=${limit}&apiKey=${POLYGON_API_KEY}`;
    const { data } = await axios.get(url);

    if (!data?.results?.length) {
      console.error(`❌ Aucune donnée reçue pour ${period}min`);
      return [];
    }

    const cleaned = data.results
      .filter(r => r && typeof r.o === 'number' && typeof r.h === 'number' && typeof r.l === 'number' && typeof r.c === 'number')
      .map(r => ({
        t: r.t,
        o: r.o,
        h: r.h,
        l: r.l,
        c: r.c,
        v: r.v ?? 0
      }));

    console.log(`[DEBUG] Bougies valides ${period}m : ${cleaned.length}`);
    return cleaned.reverse();
  } catch (err) {
    console.error(`❌ Erreur fetchData(${period}):`, err.message);
    return [];
  }
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

cron.schedule('*/30 * * * * *', async () => {
  try {
    if (isDuringPauseWindow()) {
      if (!isPaused) {
        isPaused = true;
        const msg = '⏸️ Analyse suspendue - annonce économique en cours.';
        await sendToDiscord(msg);
        global.latestSignal = {
          message: msg,
          date: new Date()
        };
      }
      return;
    }
    if (isPaused) {
      isPaused = false;
      const msg = '✅ Reprise des analyses ZenScalp.';
      await sendToDiscord(msg);
      global.latestSignal = {
        message: msg,
        date: new Date()
      };
    }

    // 🛑 Ne rien faire si un signal est encore en cours d’évaluation
    if (global.isSignalActive) {
  console.log('⏸ Signal ignoré — un trade est encore en cours d’évaluation.');

  global.latestSignal = {
    message: `⏳ Signal en cours (${global.activeSignal?.direction || '-'}) - en attente de TP/SL...`,
    date: new Date(),
    context: global.activeSignal?.context || {},
    price: global.activeSignal?.price || null
  };

  return;
}

    const data5m = await fetchData(5);
    const data15m = await fetchData(15);
    const price = await getCurrentPrice();
    const { trend5, trend15 } = analyzeTrendM5M15(data5m, data15m);

    const analysis = generateVisualAnalysis(data5m, trend5, trend15, {
      lastSignal: global.latestSignal?.context?.lastSignal || null
    });

    if (analysis.signal !== 'WAIT') {
      scheduleSignalEvaluation({
        direction: analysis.signal,
        context: {
          tags: analysis.tags,
          confidence: analysis.confidence,
          confidenceBear: analysis.confidenceBear,
          pattern: analysis.pattern,
          trend5: analysis.trend5,
          trend15: analysis.trend15
        }
      });
    }

    let msg = `_________________________\n`;
    msg += `📈 **Signal : ${analysis.signal}**\n`;
    msg += `🪙 **Prix :** ${price.mid.toFixed(5)}\n`;
    msg += `📊 **Confiance :** 📈 ${analysis.confidence.toFixed(1)}% / 📉 ${analysis.confidenceBear.toFixed(1)}%\n`;
    msg += `🕒 **Tendance :** ${analysis.trend5}\n`;
    if (analysis.pattern) msg += `🕯️ **Pattern :** ${analysis.pattern}\n`;
    if (analysis.details?.length) {
      msg += '\n🧾 **Détails analyse technique :**\n' + analysis.details.map(d => `• ${d}`).join('\n');
    }

    if (entryPrice && entryDirection) {
      msg += `\n⛳ **Entry :** ${entryPrice.toFixed(5)} (${entryDirection})`;
      msg += `\n📉 **Écart actuel :** ${Math.round((price - entryPrice) * 10000)} pips`;
    }

    await sendToDiscord(msg);

    global.latestSignal = {
      message: msg,
      date: new Date(),
      context: analysis.context,
      price
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

app.get('/dashboard', async (req, res) => {
  const igPos = await fetchLatestIGPosition();
  global.latestIGPosition = igPos;

  const entryHTML = igPos ? `
    <div class="card">
      <h2>🎯 Position manuelle IG détectée</h2>
      <p><strong>Prix d'entrée :</strong> ${igPos.entry.toFixed(5)}</p>
      <p><strong>Direction :</strong> ${igPos.direction}</p>
      <p><strong>Taille :</strong> ${igPos.size}</p>
      <p><strong>Date :</strong> ${new Date(igPos.date).toLocaleString('fr-FR')}</p>
    </div>
  ` : `
    <div class="card warning">
      <h2>⚠️ Aucune position manuelle détectée</h2>
    </div>
  `;

  const signalSummaryHTML = getSignalSummaryHTML();
  const signalHistoryHTML = getSignalHistoryHTML();

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
      <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
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
        <img src="/ZenScalp_LogoA01.jpg" alt="ZenScalp" style="height: 32px; vertical-align: middle; margin-right: 10px;">
        ZenScalp Dashboard
      </h1>

      <div style="display: flex; gap: 20px; align-items: flex-start;">
        <div style="flex: 1;">
          ${entryHTML}
          <div id="tagSummary">${signalSummaryHTML}</div>
          <div id="signalHistory">${signalHistoryHTML}</div>


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
            <audio id="notifSound" src="https://actions.google.com/sounds/v1/cartoon/wood_plank_flicks.ogg" preload="auto"></audio>
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

  function renderPieChart(success, fail) {
    const ctx = document.getElementById('pieChart')?.getContext('2d');
    if (!ctx) return;
    if (window.myChart) window.myChart.destroy();

    window.myChart = new Chart(ctx, {
      type: 'pie',
      data: {
        labels: ['Succès', 'Échecs'],
        datasets: [{
          data: [success, fail],
          backgroundColor: ['#28a745', '#e74c3c'],
        }]
      },
      options: {
        responsive: true,
        plugins: { legend: { position: 'bottom' } }
      }
    });
  }

  async function refreshHistory() {
    try {
      const res = await fetch('/latest-signal-history');
      const html = await res.text();
      document.getElementById('signalHistory').innerHTML = html;
    } catch (e) {
      document.getElementById('signalHistory').innerHTML = "<p>⚠️ Erreur chargement historique</p>";
    }
  }

  async function refreshTags() {
    try {
      const res = await fetch('/latest-tags-summary');
      const html = await res.text();
      document.getElementById('tagSummary').innerHTML = html;

      const canvas = document.getElementById('pieChart');
      if (canvas) {
        const success = parseInt(canvas.getAttribute('data-success')) || 0;
        const fail = parseInt(canvas.getAttribute('data-fail')) || 0;
        renderPieChart(success, fail);
      }
    } catch (e) {
      document.getElementById('tagSummary').innerHTML = "<p>⚠️ Erreur chargement tags</p>";
    }
  }

  let lastSignalStart = null;

async function refreshSignalHistory() {
  try {
    const res = await fetch('/latest-signal-history');
    const html = await res.text();

    // Extraire le timestamp du signal actif depuis le HTML
    const tempDiv = document.createElement('div');
    tempDiv.innerHTML = html;
    const activeRow = tempDiv.querySelector('#activeRow');

    // Si un signal actif est détecté
    if (activeRow) {
      const newStart = activeRow.getAttribute('data-start');
      if (newStart !== lastSignalStart) {
        lastSignalStart = newStart;
        window.globalActiveStart = new Date(newStart).getTime();
      }
    }

    // Injecter le HTML une fois la vérification faite
    document.getElementById('signalHistory').innerHTML = html;

  } catch (e) {
    document.getElementById('signalHistory').innerHTML = "<p>⚠️ Erreur chargement historique signaux</p>";
  }
}


  refreshSignal();
  refreshTags();
  refreshSignalHistory();
  setInterval(refreshSignal, 15000);
  setInterval(refreshTags, 15000);
  setInterval(refreshSignalHistory, 15000);
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

app.get('/latest-tags-summary', (req, res) => {
  const html = getSignalSummaryHTML();
  res.send(html);
});

app.get('/latest-signal-history', (req, res) => {
  res.send(getSignalHistoryHTML());
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

app.get('/api/performance-tags', (req, res) => {
  const results = loadSignalResults();
  const counts = {};

  for (const sig of results) {
    for (const tag of sig.context?.tags || []) {
      if (!counts[tag]) counts[tag] = { success: 0, fail: 0 };
      sig.success ? counts[tag].success++ : counts[tag].fail++;
    }
  }

  const data = Object.entries(counts).map(([tag, { success, fail }]) => {
    const total = success + fail;
    const rate = total ? (success / total) * 100 : 0;
    const weight = +(rate * 1.2 - 30).toFixed(2);
    return {
      tag,
      success,
      fail,
      rate: rate.toFixed(1),
      weight: weight.toFixed(2)
    };
  });

  res.json(data);
});

app.listen(PORT, () => console.log(`🟢 Serveur ZenScalp actif sur port ${PORT}`));
