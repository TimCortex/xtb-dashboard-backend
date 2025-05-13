// ZenScalp - Logique pondérée
const express = require('express');
const axios = require('axios');
const cron = require('node-cron');
const technicalIndicators = require('technicalindicators');
const fs = require('fs');
const path = require('path');
const bodyParser = require('body-parser');
let isPaused = false;
let lastPauseMessage = null;

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

const PORT = process.env.PORT || 3000;
const MODE_PERSISTANT = process.env.MODE_PERSISTANT === 'true';
console.log(`🔁 Mode persistant activé : ${MODE_PERSISTANT}`);

const POLYGON_API_KEY = 'aag8xgN6WM0Q83HLaOt9WqidQAyKrGtp';
const SYMBOL = 'C:EURUSD';
const WEBHOOK_URL = 'https://discord.com/api/webhooks/1366467465630187603/dyRbP05w82szDugjqa6IRF5rkvFGER4RTFqonh2gxGhrE-mHRe_gY4kH0HYHDNjAbPLi';

const ANNOUNCEMENT_FILE = path.resolve('announcements.json');
function loadAnnouncementWindows() {
  try {
    return JSON.parse(fs.readFileSync(ANNOUNCEMENT_FILE, 'utf-8'));
  } catch (err) {
    console.error('Erreur lecture annonces :', err.message);
    return [];
  }
}
function saveAnnouncementWindows(data) {
  fs.writeFileSync(ANNOUNCEMENT_FILE, JSON.stringify(data, null, 2));
}
function isDuringPauseWindow() {
  const nowUTC = new Date();

  // Convertir UTC → heure de Paris (CET/CEST automatiquement)
  const nowParis = new Date(nowUTC.toLocaleString('en-US', { timeZone: 'Europe/Paris' }));
  const currentParisMinutes = nowParis.getHours() * 60 + nowParis.getMinutes();

  const windows = loadAnnouncementWindows();
  return windows.some(({ time }) => {
    const [h, m] = time.split(':').map(Number);
    const scheduledMinutes = h * 60 + m;

    return Math.abs(currentParisMinutes - scheduledMinutes) <= 15;
  });
}

function detectCandlePattern(candle) {
  const body = Math.abs(candle.c - candle.o);
  const range = candle.h - candle.l;
  const upperWick = candle.h - Math.max(candle.c, candle.o);
  const lowerWick = Math.min(candle.c, candle.o) - candle.l;
  const bodyPct = body / range;
  if (bodyPct > 0.85 && upperWick < range * 0.05 && lowerWick < range * 0.05) {
    return candle.c < candle.o ? '🟥 Marubozu baissière — forte pression vendeuse' : '🟩 Marubozu haussière — forte pression acheteuse';
  }
  if (bodyPct < 0.15 && upperWick > range * 0.2 && lowerWick > range * 0.2) {
    return '🟨 Doji — indécision sur le marché';
  }
  if (upperWick > body * 2 && lowerWick < body) {
    return '💥 Shooting star — possible retournement baissier';
  }
  if (lowerWick > body * 2 && upperWick < body) {
    return '🔨 Marteau — possible retournement haussier';
  }
  return null;
}

function detectMultiCandlePattern(candles) {
  if (!candles || candles.length < 4) return null;

  const [c1, c2, c3, c4] = candles.slice(-4);

  // Avalement haussier
  if (c3.c < c3.o && c4.c > c4.o && c4.c > c3.o && c4.o < c3.c) {
    return '🟩 Avalement haussier — possible retournement à la hausse';
  }

  // Avalement baissier
  if (c3.c > c3.o && c4.c < c4.o && c4.c < c3.o && c4.o > c3.c) {
    return '🟥 Avalement baissier — possible retournement à la baisse';
  }

  // Trois soldats blancs
  if ([c2, c3, c4].every(c => c.c > c.o)) {
    return '🟩 Trois soldats blancs — continuation haussière forte';
  }

  // Trois corbeaux noirs
  if ([c2, c3, c4].every(c => c.c < c.o)) {
    return '🟥 Trois corbeaux noirs — continuation baissière forte';
  }

  // Harami haussier
  if (c3.c < c3.o && c4.c > c4.o && c4.o > c3.c && c4.c < c3.o) {
    return '🔄 Harami haussier — possible retournement';
  }

  // Harami baissier
  if (c3.c > c3.o && c4.c < c4.o && c4.o < c3.c && c4.c > c3.o) {
    return '🔄 Harami baissier — possible retournement';
  }

  return null;
}

function detectFVGs(data) {
  const fvgZones = [];

  for (let i = Math.max(2, data.length - 30); i < data.length; i++) {
    const prev2 = data[i - 2];
    const prev1 = data[i - 1];
    const curr = data[i];

    // FVG haussier : le plus bas actuel est au-dessus du plus haut d’il y a 2 bougies
    if (curr.l > prev2.h) {
      fvgZones.push({
        type: 'bullish',
        gapHigh: prev2.h,
        gapLow: curr.l,
        index: i,
        time: new Date(curr.t).toLocaleTimeString()
      });
    }

    // FVG baissier : le plus haut actuel est en dessous du plus bas d’il y a 2 bougies
    if (curr.h < prev2.l) {
      fvgZones.push({
        type: 'bearish',
        gapHigh: curr.h,
        gapLow: prev2.l,
        index: i,
        time: new Date(curr.t).toLocaleTimeString()
      });
    }
  }

  return fvgZones;
}

let lastAnalysis = null;

async function fetchForexData() {
  const today = new Date().toISOString().split('T')[0];
  const url = `https://api.polygon.io/v2/aggs/ticker/${SYMBOL}/range/5/minute/2024-04-01/${today}?adjusted=true&sort=desc&limit=300&apiKey=${POLYGON_API_KEY}`;
  const { data } = await axios.get(url);
  return data.results.reverse();
}

async function getCurrentPrice() {
  try {
    const url = `https://api.polygon.io/v1/last_quote/currencies/EUR/USD?apiKey=${POLYGON_API_KEY}`;
    const response = await axios.get(url);
    return response.data?.last?.ask ?? null;
  } catch (err) {
    console.error("❌ Erreur getCurrentPrice :", err.message);
    return null;
  }
}

function detectLevels(data) {
  const prices = data.map(d => d.c);
  const supports = [], resistances = [];
  for (let i = 2; i < prices.length - 2; i++) {
    if (prices[i] < prices[i - 1] && prices[i] < prices[i + 1]) supports.push(prices[i]);
    if (prices[i] > prices[i - 1] && prices[i] > prices[i + 1]) resistances.push(prices[i]);
  }
  return {
    support: supports.length ? supports.sort((a, b) => b - a).slice(-2) : [],
    resistance: resistances.length ? resistances.sort((a, b) => b - a).slice(0, 2) : []
  };
}

function generateWarning(price, signal, levels, fvgList = []) {
  const proximity = price * 0.0005;

  // Support/Résistance
  if (signal.includes('BUY')) {
    const nearRes = levels.resistance.find(r => Math.abs(r - price) <= proximity);
    if (nearRes) return `⚠️ Risque de retournement : prix proche résistance (${nearRes.toFixed(5)})`;
  } else if (signal.includes('SELL')) {
    const nearSup = levels.support.find(s => Math.abs(s - price) <= proximity);
    if (nearSup) return `⚠️ Risque de retournement : prix proche support (${nearSup.toFixed(5)})`;
  }

  // Proximité d'un FVG
  for (const fvg of fvgList) {
    if (price >= fvg.gapLow - proximity && price <= fvg.gapHigh + proximity) {
      return `⚠️ Proximité d'une zone FVG (${fvg.type === 'bullish' ? '⬆️ haussière' : '⬇️ baissière'})`;
    }
  }

  return '';
}

function calculateIchimoku(data) {
  const high = data.map(c => c.h);
  const low = data.map(c => c.l);
  const conv = (Math.max(...high.slice(-9)) + Math.min(...low.slice(-9))) / 2;
  const base = (Math.max(...high.slice(-26)) + Math.min(...low.slice(-26))) / 2;
  return { conversion: conv, base };
}


function analyze(data, currentPrice = null) {
  const close = data.map(c => c.c);
  const high = data.map(c => c.h);
  const low = data.map(c => c.l);

  const ema50 = technicalIndicators.EMA.calculate({ period: 50, values: close });
  const ema100 = technicalIndicators.EMA.calculate({ period: 100, values: close });
  const adx = technicalIndicators.ADX.calculate({ close, high, low, period: 14 });
  const rsi = technicalIndicators.RSI.calculate({ period: 14, values: close });
  const macd = technicalIndicators.MACD.calculate({ values: close, fastPeriod: 12, slowPeriod: 26, signalPeriod: 9 });
  const stoch = technicalIndicators.Stochastic.calculate({ high, low, close, period: 14, signalPeriod: 3 });
  const williamsR = technicalIndicators.WilliamsR.calculate({ high, low, close, period: 14 });
  const sar = technicalIndicators.PSAR.calculate({ high, low, step: 0.02, max: 0.2 });
  const ichimoku = calculateIchimoku(data);

  const price = currentPrice ?? close.at(-1);
  const ema50Val = ema50.at(-1);
  const ema100Val = ema100.at(-1);
  const adxVal = adx.at(-1)?.adx;
  const rsiVal = rsi.at(-1);
  const macdHist = macd.at(-1)?.histogram;
  const stochVal = stoch.at(-1);
  const williamsRVal = williamsR.at(-1);
  const sarVal = sar.at(-1);
  const ichimokuConv = ichimoku?.conversion;
  const ichimokuBase = ichimoku?.base;

  let bull = 0, bear = 0;

  // Tendance & dynamique (3 pts)
  if (price > ema50Val && ema50Val > ema100Val) bull++; else if (price < ema50Val && ema50Val < ema100Val) bear++;
  if (adxVal > 20) bull++; else if (adxVal < 20) bear++;
  if (ichimokuConv > ichimokuBase) bull++; else if (ichimokuConv < ichimokuBase) bear++;

  // Momentum & oscillateurs (4 pts)
  if (rsiVal > 50) bull++; else if (rsiVal < 50) bear++;
  if (macdHist > 0) bull++; else if (macdHist < 0) bear++;
  if (stochVal.k > stochVal.d) bull++; else if (stochVal.k < stochVal.d) bear++;
  if (williamsRVal > -50) bull++; else if (williamsRVal < -50) bear++;

  // Price Action (3 pts)
  if (sarVal < price) bull++; else if (sarVal > price) bear++;
  const structureBull = close.slice(-3).every((v, i, arr) => i === 0 || v > arr[i - 1]);
  const structureBear = close.slice(-3).every((v, i, arr) => i === 0 || v < arr[i - 1]);
  if (structureBull) bull++; else if (structureBear) bear++;

  let patternScore = 0;
  const last = data.at(-1);
  const body = Math.abs(last.c - last.o);
  const range = last.h - last.l;
  const upperWick = last.h - Math.max(last.c, last.o);
  const lowerWick = Math.min(last.c, last.o) - last.l;
  const bodyPct = body / range;
  if (bodyPct > 0.85 && upperWick < range * 0.05 && lowerWick < range * 0.05) patternScore = last.c > last.o ? 1 : -1;
  else if (upperWick > body * 2) patternScore = -1;
  else if (lowerWick > body * 2) patternScore = 1;

  if (patternScore === 1) bull++; else if (patternScore === -1) bear++;

  const totalScore = bull + bear;
  let signal = 'WAIT';
  if (bull >= 8) signal = 'STRONG BUY';
  else if (bull >= 6) signal = 'GOOD BUY';
  else if (bull >= 4) signal = 'WAIT TO BUY';
  else if (bear >= 8) signal = 'STRONG SELL';
  else if (bear >= 6) signal = 'GOOD SELL';
  else if (bear >= 4) signal = 'WAIT TO SELL';

  // ⚠️ Vérification de cohérence avec la dynamique actuelle (anti-piège)
  const oldPrice = close.at(-3);
  const priceDrop = oldPrice - price;
  const priceRise = price - oldPrice;

  if (signal.includes('BUY') && priceDrop > 0.0005) {
    signal = 'WAIT TO BUY';
  }
  if (signal.includes('SELL') && priceRise > 0.0005) {
    signal = 'WAIT TO SELL';
  }

  // 📏 Check zone de range
  const recentRange = Math.max(...close.slice(-20)) - Math.min(...close.slice(-20));
  const isRanging = recentRange < 0.0010;
  if (isRanging && (signal.includes('STRONG') || signal.includes('GOOD'))) {
    signal = signal.includes('BUY') ? 'WAIT TO BUY' : 'WAIT TO SELL';
  }

  return {
    timestamp: new Date().toISOString(),
    price,
    signal,
    trend: (price > ema50Val && ema50Val > ema100Val) ? 'HAUSSIÈRE' : (price < ema50Val && ema50Val < ema100Val) ? 'BAISSIÈRE' : 'INDÉTERMINÉE',
    rsi14: rsiVal,
    macd: macd.at(-1),
    stoch: stochVal,
    williamsR: williamsRVal,
    sar: sarVal,
    ema50: ema50Val,
    ema100: ema100Val,
    adx: adxVal,
    ichimoku,
    bullPoints: bull,
    bearPoints: bear,
    totalScore,
    recentRange
  };
}




async function getCurrentPrice() {
  try {
    const url = `https://api.polygon.io/v1/last_quote/currencies/EUR/USD?apiKey=${POLYGON_API_KEY}`;
    const response = await axios.get(url);
    return response.data?.last?.ask ?? null;
  } catch (err) {
    console.error("❌ Erreur getCurrentPrice :", err.message);
    return null;
  }
}

// Modification de la fonction d'envoi du signal pour inclure le prix actuel
async function sendDiscordAlert(analysis, levels, pattern = null) {
  const warning = generateWarning(analysis.price, analysis.signal, levels);

  let msg = `${analysis.signal.includes('SELL') ? '📉' : analysis.signal.includes('BUY') ? '📈' : '⏸️'} **${analysis.signal}**\n`
          + `💰 **Prix actuel :** ${analysis.price.toFixed(5)}\n`
          + `📊 **Tendance :** ${analysis.trend}\n`
          + `🎯 **Score total :** ${analysis.totalScore}/10 (📈 ${analysis.bullPoints} / 📉 ${analysis.bearPoints})\n`;

  if (warning) msg += `${warning}\n`;
  if (pattern) msg += `${pattern}\n`;

  if (analysis.recentRange && analysis.recentRange < 0.0010) {
    msg += `📏 Zone de range étroit (~${(analysis.recentRange / 0.0001).toFixed(1)} pips) — signal affaibli.\n`;
  }

  await axios.post(WEBHOOK_URL, { content: msg });
}


function getParisTimeString() {
  const now = new Date();
  now.setHours(now.getHours() + 2);
  return `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
}

async function sendPauseAlert(time) {
  const msg = `⏸️ **Pause ZenScalp activée**\nAnnonce économique prévue \nLes analyses sont suspendues temporairement.`;
  console.log(msg);
  await axios.post(WEBHOOK_URL, { content: msg });
  lastPauseMessage = time;
}

async function sendResumeAlert() {
  const msg = `✅ **Reprise des analyses ZenScalp**\nFin de la période d'annonce économique (${getParisTimeString()}).\nLes signaux reprennent normalement.`;
  console.log(msg);
  await axios.post(WEBHOOK_URL, { content: msg });
  lastPauseMessage = null;
}

cron.schedule('* * * * *', async () => {
  try {
    const pausedNow = isDuringPauseWindow();
    const now = new Date();
    const currentTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    if (pausedNow && !isPaused) {
      isPaused = true;
      if (lastPauseMessage !== currentTime) await sendPauseAlert(currentTime);
      return;
    }
    if (!pausedNow && isPaused) {
      isPaused = false;
      await sendResumeAlert();
    }
    if (isPaused) return;

    const candles = await fetchForexData();
    const lastCandle = candles.at(-1);
    const currentPrice = await getCurrentPrice();
    const levels = detectLevels(candles);
    const analysis = await analyze(candles, currentPrice);
if (!analysis) return; // 🔁 Stopper si analyse impossible
    lastAnalysis = analysis;
    appendToCSV(analysis);
    const recentCandles = candles.slice(-4);
const pattern = detectMultiCandlePattern(recentCandles);
    console.log(`Analyse ${new Date().toLocaleTimeString()}: ${analysis.signal} (${analysis.trend})`);
    await sendDiscordAlert(analysis, levels, pattern);
  } catch (err) {
    console.error('Erreur Cron :', err.message);
  }
});

const csvPath = path.join(__dirname, 'signals.csv');
function appendToCSV(analysis) {
  const header = 'timestamp,price,signal,rsi,macd_hist,stoch_k,stoch_d,sar,ema50,ema100,trend';
  const line = `${analysis.timestamp},${analysis.price},${analysis.signal},${analysis.rsi14},${analysis.macd?.histogram},${analysis.stoch?.k},${analysis.stoch?.d},${analysis.sar},${analysis.ema50},${analysis.ema100},${analysis.trend}\n`;
  if (!fs.existsSync(csvPath)) fs.writeFileSync(csvPath, header + '\n');
  fs.appendFileSync(csvPath, line);
}

app.get('/indicateurs', (req, res) => {
  if (!lastAnalysis) return res.status(404).json({ error: 'Aucune analyse disponible' });
  res.json(lastAnalysis);
});

app.get('/annonces', (req, res) => {
  const annonces = loadAnnouncementWindows();
  const rows = annonces.map(({ time }) => `
    <tr>
      <td><input type="time" name="times" value="${time}" required></td>
      <td><button type="button" onclick="this.parentNode.parentNode.remove()">🗑️ Supprimer</button></td>
    </tr>`).join('');

  res.send(`
    <html>
    <head>
      <title>🗓️ Gestion des annonces économiques</title>
      <style>
        body { font-family: sans-serif; margin: 30px; background: #f4f4f4; }
        table { border-collapse: collapse; margin-bottom: 10px; }
        td { padding: 5px; }
        input[type="time"] { padding: 5px; }
        button { padding: 5px 10px; cursor: pointer; }
      </style>
    </head>
    <body>
      <h2>🗓️ Annonces économiques – heure de Paris</h2>
      <form action="/update-announcements" method="POST" onsubmit="return collectTimes()">
        <table id="timesTable">
          ${rows}
        </table>
        <button type="button" onclick="addRow()">➕ Ajouter une annonce</button><br><br>
        <input type="hidden" name="data" id="jsonData">
        <button type="submit">💾 Enregistrer</button>
      </form>
      <script>
        function addRow() {
          const table = document.getElementById('timesTable');
          const row = table.insertRow();
          row.innerHTML = '<td><input type="time" name="times" required></td>' +
                          '<td><button type="button" onclick="this.parentNode.parentNode.remove()">🗑️ Supprimer</button></td>';
        }
        function collectTimes() {
          const inputs = document.getElementsByName('times');
          const data = [];
          for (const input of inputs) {
            if (input.value) data.push({ time: input.value });
          }
          document.getElementById('jsonData').value = JSON.stringify(data, null, 2);
          return true;
        }
      </script>
    </body>
    </html>
  `);
});

app.get('/debug-annonces', (req, res) => {
  try {
    const data = loadAnnouncementWindows();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: 'Impossible de charger les annonces', details: err.message });
  }
});

app.post('/update-announcements', (req, res) => {
  try {
    const jsonData = JSON.parse(req.body.data);
    saveAnnouncementWindows(jsonData);
    res.send('<p>✅ Données mises à jour. <a href="/annonces">Retour</a></p>');
  } catch (err) {
    res.status(400).send(`<p>❌ Erreur JSON : ${err.message} <a href="/annonces">Retour</a></p>`);
  }
});

app.get('/', (req, res) => {
  res.send('ZenScalp backend - analyse avec détection des figures de chandeliers et gestion web des annonces 🚀');
});

app.listen(PORT, () => console.log(`🟢 Serveur ZenScalp sur le port ${PORT}`));
