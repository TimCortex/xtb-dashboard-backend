// ZenScalp - Gestion dynamique des annonces via formulaire + correction signaux
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
  const now = new Date();
  const currentMinutes = now.getUTCHours() * 60 + now.getUTCMinutes();
  const windows = loadAnnouncementWindows();
  return windows.some(({ time }) => {
    const [h, m] = time.split(':').map(Number);
    const scheduled = h * 60 + m;
    return Math.abs(currentMinutes - scheduled) <= 5;
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

let lastSignal = 'WAIT';
let lastNotificationSignal = null;
let lastAnalysis = null;

async function fetchForexData() {
  const today = new Date().toISOString().split('T')[0];
  const url = `https://api.polygon.io/v2/aggs/ticker/${SYMBOL}/range/5/minute/2024-04-01/${today}?adjusted=true&sort=desc&limit=300&apiKey=${POLYGON_API_KEY}`;
  const { data } = await axios.get(url);
  return data.results.reverse();
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

function calculateIchimoku(data) {
  const high = data.map(c => c.h);
  const low = data.map(c => c.l);
  const conv = (Math.max(...high.slice(-9)) + Math.min(...low.slice(-9))) / 2;
  const base = (Math.max(...high.slice(-26)) + Math.min(...low.slice(-26))) / 2;
  return { conversion: conv, base };
}

function generateWarning(price, signal, levels) {
  const proximity = price * 0.0005;
  if (signal.includes('BUY')) {
    const nearRes = levels.resistance.find(r => Math.abs(r - price) <= proximity);
    if (nearRes) return `⚠️ Risque de retournement : prix proche résistance (${nearRes.toFixed(5)})`;
  } else if (signal.includes('SELL')) {
    const nearSup = levels.support.find(s => Math.abs(s - price) <= proximity);
    if (nearSup) return `⚠️ Risque de retournement : prix proche support (${nearSup.toFixed(5)})`;
  }
  return '';
}

function analyze(data) {
  const close = data.map(c => c.c);
  const high = data.map(c => c.h);
  const low = data.map(c => c.l);

  const ema9 = technicalIndicators.EMA.calculate({ period: 9, values: close });
  const ema21 = technicalIndicators.EMA.calculate({ period: 21, values: close });
  const ema50 = technicalIndicators.EMA.calculate({ period: 50, values: close });
  const ema100 = technicalIndicators.EMA.calculate({ period: 100, values: close });
  const rsi14 = technicalIndicators.RSI.calculate({ period: 14, values: close });
  const macd = technicalIndicators.MACD.calculate({ values: close, fastPeriod: 12, slowPeriod: 26, signalPeriod: 9 });
  const stoch = technicalIndicators.Stochastic.calculate({ high, low, close, period: 14, signalPeriod: 3 });
  const sar = technicalIndicators.PSAR.calculate({ high, low, step: 0.02, max: 0.2 });
  const ichimoku = calculateIchimoku(data);

  const latest = {
    timestamp: new Date().toISOString(),
    price: close.at(-1),
    ema50: ema50.at(-1),
    ema100: ema100.at(-1),
    rsi14: rsi14.at(-1),
    macd: macd.length ? macd.at(-1) : { histogram: null },
    stoch: stoch.length ? stoch.at(-1) : { k: 0, d: 0 },
    sar: sar.length ? sar.at(-1) : close.at(-1),
    ichimoku
  };

  let bull = 0, bear = 0;
  if (latest.rsi14 > 50) bull++; else if (latest.rsi14 < 50) bear++;
  if (latest.macd?.histogram > 0) bull++; else if (latest.macd?.histogram < 0) bear++;
  if (latest.stoch?.k > latest.stoch?.d) bull++; else if (latest.stoch?.k < latest.stoch?.d) bear++;
  if (latest.sar < latest.price) bull++; else if (latest.sar > latest.price) bear++;
  if (latest.ichimoku?.conversion > latest.ichimoku?.base) bull++; else if (latest.ichimoku?.conversion < latest.ichimoku?.base) bear++;

  let signal = 'WAIT';
  if (bull >= 5) signal = 'STRONG BUY';
  else if (bull >= 3 && bear === 0) signal = 'GOOD BUY';
  else if (bull >= 1 && bear === 0) signal = 'WAIT TO BUY';
  else if (bear >= 5) signal = 'STRONG SELL';
  else if (bear >= 3 && bull === 0) signal = 'GOOD SELL';
  else if (bear >= 1 && bull === 0) signal = 'WAIT TO SELL';

  let trend = 'INDÉTERMINÉE';
  const above50 = latest.price > latest.ema50;
  const above100 = latest.price > latest.ema100;
  if (above50 && above100) trend = 'HAUSSIÈRE';
  else if (!above50 && !above100) trend = 'BAISSIÈRE';

  if (trend === 'INDÉTERMINÉE' && (signal === 'GOOD BUY' || signal === 'GOOD SELL')) {
    signal = signal.includes('BUY') ? 'WAIT TO BUY' : 'WAIT TO SELL';
  }

  return { ...latest, signal, trend };
}


async function sendDiscordAlert(analysis, levels, pattern = null) {
  const warning = generateWarning(analysis.price, analysis.signal, levels);
  const msg = `${analysis.signal.includes('SELL') ? '📉' : analysis.signal.includes('BUY') ? '📈' : '⏸️'} **${analysis.signal}**\n`
    + `💰 Prix: ${analysis.price}\n`
    + `📊 Tendance: ${analysis.trend}\n`
    + `${warning ? warning + '\n' : ''}${pattern ? pattern : ''}`;
  await axios.post(WEBHOOK_URL, { content: msg });
}

cron.schedule('* * * * *', async () => {
  try {
    if (isDuringPauseWindow()) {
      console.log('⏸️ Pause ZenScalp autour d’une annonce économique.');
      return;
    }

    const candles = await fetchForexData();
    const lastCandle = candles.at(-1);
    const levels = detectLevels(candles);
    const analysis = analyze(candles);
    lastAnalysis = analysis;
    appendToCSV(analysis);

    const pattern = detectCandlePattern(lastCandle);

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
  res.send(`
    <html><body>
    <h2>🗓️ Gestion des annonces économiques</h2>
    <form action="/update-announcements" method="POST">
      <textarea name="data" rows="15" cols="50">${JSON.stringify(annonces, null, 2)}</textarea><br><br>
      <button type="submit">💾 Enregistrer</button>
    </form>
    </body></html>
  `);
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
