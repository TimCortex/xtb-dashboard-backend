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

function generateVisualAnalysis(data, m15Trend = 'INDÉTERMINÉE') {
  const close = data.map(c => c.c);
  const high = data.map(c => c.h);
  const low = data.map(c => c.l);
  const price = close.at(-1);
  const ema50 = technicalIndicators.EMA.calculate({ period: 50, values: close });
  const ema100 = technicalIndicators.EMA.calculate({ period: 100, values: close });
  const rsi = technicalIndicators.RSI.calculate({ period: 14, values: close });

  let bull = 0, bear = 0;
  if (price > ema50.at(-1) && ema50.at(-1) > ema100.at(-1)) bull++; else if (price < ema50.at(-1) && ema50.at(-1) < ema100.at(-1)) bear++;
  if (rsi.at(-1) > 50) bull++; else bear++;
  if (m15Trend === 'HAUSSIÈRE') bull++; else if (m15Trend === 'BAISSIÈRE') bear++;

  const { confidence, confidenceBear } = calculateConfidence(bull, bear);
  const signal = confidence >= 70 ? 'BUY' : confidenceBear >= 70 ? 'SELL' : 'WAIT';
  const candles = data.slice(-4);
  const pattern = detectMultiCandlePattern(candles);

  return { price, signal, confidence, confidenceBear, pattern, m15Trend };
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
  res.send(`✅ Entry défini via GET : ${price} (${direction})`);
});


// Ajout d'un entry manuellement
app.post('/set-entry', (req, res) => {
  const { price, direction } = req.body;
  if (!price || !['BUY', 'SELL'].includes(direction)) {
    return res.status(400).send('Paramètres invalides');
  }
  entryPrice = parseFloat(price);
  entryDirection = direction;
  res.send('✅ Entry enregistré');
});

// Suppression d’un entry manuel
app.post('/clear-entry', (req, res) => {
  entryPrice = null;
  entryDirection = null;
  res.send('❌ Entry supprimé');
});

app.get('/status', (req, res) => {
  res.json({
    entry: entryPrice ? { price: entryPrice, direction: entryDirection } : null,
    paused: isPaused
  });
});


app.listen(PORT, () => console.log(`🟢 Serveur ZenScalp actif sur port ${PORT}`));
