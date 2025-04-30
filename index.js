const express = require('express');
const axios = require('axios');
const cron = require('node-cron');
const technicalIndicators = require('technicalindicators');

const app = express();
const PORT = process.env.PORT || 3000;

const POLYGON_API_KEY = 'aag8xgN6WM0Q83HLaOt9WqidQAyKrGtp';
const SYMBOL = 'C:EURUSD';
const WEBHOOK_URL = 'https://discord.com/api/webhooks/1366467465630187603/dyRbP05w82szDugjqa6IRF5rkvFGER4RTFqonh2gxGhrE-mHRe_gY4kH0HYHDNjAbPLi';

let lastSignal = 'WAIT';

// 📈 Récupération des données 5 minutes
async function fetchForexData() {
  const today = new Date().toISOString().split('T')[0];
  const url = `https://api.polygon.io/v2/aggs/ticker/${SYMBOL}/range/5/minute/2024-04-01/${today}?adjusted=true&sort=desc&limit=100&apiKey=${POLYGON_API_KEY}`;
  const { data } = await axios.get(url);
  return data.results.reverse(); // du plus ancien au plus récent
}

// 📊 Détection de niveaux clés
function detectLevels(data) {
  const prices = data.map(d => d.c);
  const supports = [], resistances = [];

  for (let i = 2; i < prices.length - 2; i++) {
    const prev = prices[i - 1], curr = prices[i], next = prices[i + 1];

    if (curr < prev && curr < next) supports.push(curr);
    if (curr > prev && curr > next) resistances.push(curr);
  }

  return {
    support: supports.length ? supports.sort((a, b) => b - a).slice(-2) : [],
    resistance: resistances.length ? resistances.sort((a, b) => b - a).slice(0, 2) : []
  };
}

// 📉 Analyse technique avec logique agressive
function analyze(data) {
  const close = data.map(c => c.c);
  const high = data.map(c => c.h);
  const low = data.map(c => c.l);

  const ema9 = technicalIndicators.EMA.calculate({ period: 9, values: close });
  const ema21 = technicalIndicators.EMA.calculate({ period: 21, values: close });
  const rsi14 = technicalIndicators.RSI.calculate({ period: 14, values: close });
  const macd = technicalIndicators.MACD.calculate({
    values: close,
    fastPeriod: 12,
    slowPeriod: 26,
    signalPeriod: 9,
    SimpleMAOscillator: false,
    SimpleMASignal: false
  });
  const stoch = technicalIndicators.Stochastic.calculate({
    high, low, close,
    period: 14,
    signalPeriod: 3
  });

  const latest = {
    price: close.at(-1),
    ema9: ema9.at(-1),
    ema21: ema21.at(-1),
    rsi14: rsi14.at(-1),
    macd: macd.at(-1),
    stoch: stoch.at(-1)
  };

  // 🧠 Nouvelle logique de signaux
  if (latest.ema9 > latest.ema21 && latest.rsi14 > 55 && latest.macd.histogram > 0.0001 && latest.stoch.k > latest.stoch.d + 2) {
    return { ...latest, signal: 'STRONG BUY' };
  }
  if (latest.ema9 > latest.ema21 && latest.rsi14 > 50 && latest.macd.histogram > 0 && latest.stoch.k > latest.stoch.d) {
    return { ...latest, signal: 'BUY' };
  }
  if (latest.ema9 < latest.ema21 && latest.rsi14 < 45 && latest.macd.histogram < -0.0001 && latest.stoch.k < latest.stoch.d - 2) {
    return { ...latest, signal: 'STRONG SELL' };
  }
  if (latest.ema9 < latest.ema21 && latest.rsi14 < 50 && latest.macd.histogram < 0 && latest.stoch.k < latest.stoch.d) {
    return { ...latest, signal: 'SELL' };
  }

  return { ...latest, signal: 'WAIT' };
}

// 📤 Envoi Discord
async function sendDiscordAlert(analysis, levels) {
  const message = {
    content: `📊 **Signal détecté: ${analysis.signal}**\n💰 Prix: ${analysis.price}\n📈 RSI: ${analysis.rsi14.toFixed(2)}\n📉 MACD: ${analysis.macd.histogram.toFixed(5)}\n🎯 Stochastique: K ${analysis.stoch.k.toFixed(2)}, D ${analysis.stoch.d.toFixed(2)}\n🛑 Supports: ${levels.support.map(p => p.toFixed(5)).join(', ')}\n📌 Résistances: ${levels.resistance.map(p => p.toFixed(5)).join(', ')}`
  };
  await axios.post(WEBHOOK_URL, message);
}

// 🔁 Cron toutes les minutes
cron.schedule('*/1 * * * *', async () => {
  try {
    const candles = await fetchForexData();
    const levels = detectLevels(candles);
    const analysis = analyze(candles);
    console.log(`Analyse ${new Date().toLocaleTimeString()}: ${analysis.signal}`);

    if (analysis.signal !== 'WAIT' && analysis.signal !== lastSignal) {
      await sendDiscordAlert(analysis, levels);
      lastSignal = analysis.signal;
    }
  } catch (err) {
    console.error('Erreur Cron:', err.message);
  }
});

// 💓 Heartbeat toutes les 30 minutes
cron.schedule('*/30 * * * *', async () => {
  await axios.post(WEBHOOK_URL, {
    content: `✅ Heartbeat: ZenScalp tourne toujours (${new Date().toLocaleTimeString()})`
  });
});

// 🌐 Route principale
app.get('/', (req, res) => {
  res.send('ZenScalp backend actif 🚀');
});

app.listen(PORT, () => {
  console.log(`🟢 Serveur ZenScalp lancé sur le port ${PORT}`);
});
