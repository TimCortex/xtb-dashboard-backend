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
const WEBHOOK_URL = 'https://discord.com/api/webhooks/1366467465630187603/dyRbP05w82szDugjqa6IRF5rkvFGER4RTFqonh2gxGhrE-mHRe_gY4kH0HYHDNjAbPLi';

const IG_API_URL = 'https://api.ig.com/gateway/deal';
const IG_USERNAME = 'timagnus';
const IG_PASSWORD = 'Lyautey#1';
const IG_API_KEY = '2a3e078a4eec24c7479614f8ba54ebf781ed7298';

const ANNOUNCEMENT_FILE = path.resolve('announcements.json');
global.entryPrice = null;
global.entryDirection = null;
global.entryTime = null;

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

async function getCurrentPrice() {
  try {
    const loginRes = await axios.post(`${IG_API_URL}/session`, {
      identifier: IG_USERNAME,
      password: IG_PASSWORD
    }, {
      headers: {
        'X-IG-API-KEY': IG_API_KEY,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      }
    });

    const cst = loginRes.headers['cst'];
    const xSecurityToken = loginRes.headers['x-security-token'];

    const res = await axios.get(`${IG_API_URL}/markets/CS.D.EURUSD.MINI.IP`, {
      headers: {
        'X-IG-API-KEY': IG_API_KEY,
        'CST': cst,
        'X-SECURITY-TOKEN': xSecurityToken,
        'Accept': 'application/json'
      }
    });

    return res.data.snapshot.offer ?? null;
  } catch {
    const url = `https://api.polygon.io/v1/last_quote/currencies/EUR/USD?apiKey=${POLYGON_API_KEY}`;
    const response = await axios.get(url);
    return response.data?.last?.ask ?? null;
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

  // Hybride : priorité au modèle strict, sinon base moyenne
  let trend5 = price5 > ema50_5m.at(-1) && ema50_5m.at(-1) > ema100_5m.at(-1) ? 'HAUSSIÈRE'
             : price5 < ema50_5m.at(-1) && ema50_5m.at(-1) < ema100_5m.at(-1) ? 'BAISSIÈRE'
             : ema50_5m.at(-1) > ema100_5m.at(-1) ? 'HAUSSIÈRE'
             : ema50_5m.at(-1) < ema100_5m.at(-1) ? 'BAISSIÈRE'
             : 'INDÉTERMINÉE';

  let trend15 = price15 > ema50_15m.at(-1) && ema50_15m.at(-1) > ema100_15m.at(-1) ? 'HAUSSIÈRE'
              : price15 < ema50_15m.at(-1) && ema50_15m.at(-1) < ema100_15m.at(-1) ? 'BAISSIÈRE'
              : ema50_15m.at(-1) > ema100_15m.at(-1) ? 'HAUSSIÈRE'
              : ema50_15m.at(-1) < ema100_15m.at(-1) ? 'BAISSIÈRE'
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
  const pipDistance = 0.0010;

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

 let totalScore = bull + bear;
let confidence = totalScore > 0 ? (bull / totalScore) * 100 : 0;
let confidenceBear = totalScore > 0 ? (bear / totalScore) * 100 : 0;

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
  } else if (price > lastHigh - pipDistance) {
    generalWarning = '⚠️ Le prix est proche d’une résistance.';
    safeDistanceBonus = false;
  } else if (price < lastLow + pipDistance) {
    generalWarning = '⚠️ Le prix est proche d’un support.';
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




async function fetchData(period = 5) {
  const today = new Date().toISOString().split('T')[0];
  const url = `https://api.polygon.io/v2/aggs/ticker/${SYMBOL}/range/${period}/minute/2024-04-01/${today}?adjusted=true&sort=desc&limit=100&apiKey=${POLYGON_API_KEY}`;
  const { data } = await axios.get(url);
  return data.results.reverse();
}

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

app.get('/set-entry', (req, res) => {
  const { price, direction } = req.query;
  if (!price || !['BUY', 'SELL'].includes(direction)) {
    return res.status(400).send('Paramètres invalides (GET)');
  }
 global.entryPrice = parseFloat(price);
global.entryDirection = direction;
global.entryTime = Date.now();

  res.send(`✅ Entry défini via GET : ${price} (${direction})`);
});

app.get('/dashboard', (req, res) => {
  const entryHTML = entryPrice ? `
    <div class="card">
      <h2>🎯 Entry Price</h2>
      <p><strong>Prix :</strong> ${entryPrice.toFixed(5)}</p>
      <p><strong>Direction :</strong> ${entryDirection}</p>
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

  res.send(`
    <html>
    <head>
      <title>ZenScalp Dashboard</title>
      <style>
        body { font-family: sans-serif; margin: 40px; background: #f4f4f4; }
        .card { background: #fff; padding: 20px; border-radius: 10px; box-shadow: 0 0 10px rgba(0,0,0,0.1); margin-bottom: 20px; }
        .warning { background-color: #fff3cd; }
        .danger { background-color: #e74c3c; color: white; padding: 8px 12px; border: none; border-radius: 5px; cursor: pointer; }
        input, select { margin-right: 10px; padding: 6px; }
        table { border-collapse: collapse; margin-top: 20px; }
        td { padding: 5px; }
        button { padding: 6px 10px; cursor: pointer; border-radius: 5px; }
      </style>
    </head>
    <body>
      <h1>📊 ZenScalp Dashboard</h1>
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
      <script>
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


app.listen(PORT, () => console.log(`🟢 Serveur ZenScalp actif sur port ${PORT}`));
