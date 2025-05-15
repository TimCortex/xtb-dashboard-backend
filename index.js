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
let entryPrice = null;
let entryDirection = null;
let isPaused = false;
let lastPauseMessage = null;
let entryTime = null;

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

// ZenScalp - version visuelle enrichie avec scoring pondéré réaliste + Ichimoku & prox res/sup

function generateVisualAnalysis(data, m15Trend = 'INDÉTERMINÉE') {
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

  // M15 Trend
  if (m15Trend === 'HAUSSIÈRE') {
    bull += 0.6;
    details.push('✅ M15 HAUSSIÈRE (+0.6)');
  } else if (m15Trend === 'BAISSIÈRE') {
    bear += 0.6;
    details.push('❌ M15 BAISSIÈRE (+0.6 bear)');
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

  // Ichimoku breakout (prix > nuage + Tenkan > Kijun)
  const lastIchi = ichimoku.at(-1);
  if (lastIchi && price > lastIchi.spanA && price > lastIchi.spanB && lastIchi.conversion > lastIchi.base) {
    bull += 0.7;
    details.push('✅ Ichimoku breakout (+0.7)');
  } else if (lastIchi && price < lastIchi.spanA && price < lastIchi.spanB && lastIchi.conversion < lastIchi.base) {
    bear += 0.7;
    details.push('❌ Ichimoku breakdown (+0.7 bear)');
  }

  // Proximité résistance/support (10 pips)
  const lastHigh = high.slice(-20).reduce((a, b) => Math.max(a, b), 0);
  const lastLow = low.slice(-20).reduce((a, b) => Math.min(a, b), Infinity);
  const pipDistance = 0.0010; // 10 pips EUR/USD

  if (price > lastHigh - pipDistance) {
    bull -= 0.5;
    details.push('⚠️ Proximité résistance (-0.5)');
  }
  if (price < lastLow + pipDistance) {
    bear -= 0.5;
    details.push('⚠️ Proximité support (-0.5)');
  }

  let confidence = (bull / (bull + bear)) * 100;
  let confidenceBear = (bear / (bull + bear)) * 100;
  const signal = confidence >= 70 ? 'BUY' : confidenceBear >= 70 ? 'SELL' : 'WAIT';
  const candles = data.slice(-4);
  const pattern = detectMultiCandlePattern(candles);

  // Ajouter impact des patterns
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

  // Vérification de contradiction
  let commentaire = null;
  if ((signal === 'BUY' && pattern && pattern.includes('🟥')) || (signal === 'SELL' && pattern && pattern.includes('🟩'))) {
    commentaire = `⚠️ Contradiction entre signal ${signal} et pattern ${pattern}`;
    details.push(commentaire);
  }

  // Analyse du sentiment global du marché
  function evaluateMarketSentiment(data) {
    const closes = data.map(c => c.c);
    const opens = data.map(c => c.o);
    const candles = data.slice(-24); // Dernières 2h sur M5
    let altCount = 0;
    let dojiCount = 0;
    let prevDirection = null;

    for (let c of candles) {
      const body = Math.abs(c.c - c.o);
      const candleDirection = c.c > c.o ? 'bull' : c.c < c.o ? 'bear' : 'doji';
      if (body < (c.h - c.l) * 0.2) dojiCount++;
      if (prevDirection && candleDirection !== prevDirection) altCount++;
      if (candleDirection !== 'doji') prevDirection = candleDirection;
    }

    const altRatio = altCount / candles.length;
    const dojiRatio = dojiCount / candles.length;
    let sentiment = 0;

    if (altRatio > 0.5) sentiment -= 0.4;
    if (dojiRatio > 0.3) sentiment -= 0.3;
    if (Math.abs(ema50.at(-1) - ema100.at(-1)) < 0.0003) sentiment -= 0.3;
    if (m15Trend === 'INDÉTERMINÉE') sentiment -= 0.4;

    return Math.max(-1, Math.min(1, sentiment));
  }

  // Calcul du sentiment
  const sentiment = evaluateMarketSentiment(data);
  if (sentiment < 0) {
    confidence *= 1 + sentiment;
    confidenceBear *= 1 + sentiment;
    details.push(`⚠️ Sentiment marché défavorable : ${sentiment.toFixed(2)} → ajustement du score`);
  }

  // Plafonnement dur
  confidence = Math.min(confidence, 95);
  confidenceBear = Math.min(confidenceBear, 95);

  if (commentaire) details.push(commentaire);

  // Ajouter logique de sortie intelligente
if (typeof global.entryPrice !== 'undefined' && typeof global.entryDirection !== 'undefined' && global.entryTime) {
  const currentTime = Date.now();
  const elapsed = (currentTime - global.entryTime) / 1000; // en secondes
  const pips = Math.round((price - global.entryPrice) * 10000);
  const tolerance = 3;

  const losing = (global.entryDirection === 'BUY' && pips < -tolerance) ||
                 (global.entryDirection === 'SELL' && pips > tolerance);

  const signalAligned = global.entryDirection === signal;
  const trendOk = (global.entryDirection === 'BUY' && m15Trend === 'HAUSSIÈRE') ||
                  (global.entryDirection === 'SELL' && m15Trend === 'BAISSIÈRE');

  if (elapsed < 120) {
    details.push('🟡 Attente - position trop récente (<2min)');
  } else if (losing && (!signalAligned || !trendOk || confidence < 65)) {
    details.push('🔴 Sortie recommandée - perte confirmée et contexte affaibli.');
  } else {
    details.push('🟢 Attente conseillée - contexte toujours valide.');
  }
}

return { price, signal, confidence, confidenceBear, pattern, m15Trend, details, commentaire };
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
    const m15Trend = analyzeM15(data15m);
    const analysis = generateVisualAnalysis(data5m, m15Trend);

    let msg = `📈 **Signal visuel : ${analysis.signal}**
`;
    msg += `💰 **Prix :** ${price.toFixed(5)}
`;
    msg += `📊 **Confiance :** 📈 ${analysis.confidence.toFixed(1)}% / 📉 ${analysis.confidenceBear.toFixed(1)}%
`;
    msg += `🕒 **Tendance M15 :** ${analysis.m15Trend}
`;
    if (analysis.pattern) msg += `🕯️ **Pattern :** ${analysis.pattern}
`;

    if (entryPrice && entryDirection) {
      const pips = Math.round((price - entryPrice) * 10000);
      const inLoss = (entryDirection === 'BUY' && pips < 0) || (entryDirection === 'SELL' && pips > 0);
      if (inLoss) {
        msg += `
⛳ **Entry :** ${entryPrice.toFixed(5)} (${entryDirection})
`;
        msg += `📉 **Perte actuelle :** ${Math.abs(pips)} pips
`;
        msg += analysis.confidence > 60 ? '🟢 Attente conseillée' : '🔴 Sortie recommandée';
      }
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
  entryPrice = parseFloat(price);
  entryDirection = direction;
  entryTime = Date.now();
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
  entryPrice = parseFloat(price);
  entryDirection = direction;
  entryTime = Date.now();
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
