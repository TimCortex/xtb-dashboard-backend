const express = require('express');
const axios = require('axios');
const technicalIndicators = require('technicalindicators');
const cron = require('node-cron');

const app = express();
const PORT = process.env.PORT || 3000;

// CONFIG
const POLYGON_API_KEY = 'aag8xgN6WM0Q83HLaOt9WqidQAyKrGtp';
const SYMBOL = 'C:EURUSD';
const WEBHOOK_URL = 'https://discord.com/api/webhooks/1366467465630187603/dyRbP05w82szDugjqa6IRF5rkvFGER4RTFqonh2gxGhrE-mHRe_gY4kH0HYHDNjAbPLi';

let lastSignal = 'WAIT';

// Récupération des bougies Forex 5 minutes
async function fetchForexData() {
  const today = new Date().toISOString().split('T')[0];
  const url = `https://api.polygon.io/v2/aggs/ticker/${SYMBOL}/range/5/minute/${today}/${today}?adjusted=true&sort=desc&limit=100&apiKey=${POLYGON_API_KEY}`;
  const { data } = await axios.get(url);
  return data.results.reverse();
}

// Analyse des indicateurs
function analyze(data) {
  const close = data.map(c => c.c);
  const high = data.map(c => c.h);
  const low = data.map(c => c.l);

  const sma20 = technicalIndicators.SMA.calculate({ period: 20, values: close });
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
  const bb = technicalIndicators.BollingerBands.calculate({
    period: 20,
    stdDev: 2,
    values: close
  });
  const stoch = technicalIndicators.Stochastic.calculate({
    high,
    low,
    close,
    period: 14,
    signalPeriod: 3
  });

  const latest = {
    price: close.at(-1),
    sma20: sma20.at(-1),
    ema9: ema9.at(-1),
    ema21: ema21.at(-1),
    rsi14: rsi14.at(-1),
    macd: macd.at(-1),
    bb: bb.at(-1),
    stoch: stoch.at(-1)
  };

  let signal = 'WAIT';
  if (latest.ema9 > latest.ema21 && latest.rsi14 > 50 && latest.macd.histogram > 0 && latest.stoch.k > latest.stoch.d) {
    signal = 'BUY';
  } else if (latest.ema9 < latest.ema21 && latest.rsi14 < 50 && latest.macd.histogram < 0 && latest.stoch.k < latest.stoch.d) {
    signal = 'SELL';
  }

  return { ...latest, signal };
}

// Fonction pour envoyer une alerte Discord
async function sendDiscordAlert(analysis) {
  const stopLossPips = 0.0010;
  const takeProfitPips = 0.0020;
  
  let stopLoss, takeProfit;

  if (analysis.signal === 'BUY') {
    stopLoss = analysis.price - stopLossPips;
    takeProfit = analysis.price + takeProfitPips;
  } else if (analysis.signal === 'SELL') {
    stopLoss = analysis.price + stopLossPips;
    takeProfit = analysis.price - takeProfitPips;
  }

  const message = {
    content: `📊 **Signal détecté: ${analysis.signal}**\n` +
             `💰 **Prix**: ${analysis.price}\n` +
             `📈 **RSI**: ${analysis.rsi14.toFixed(2)}\n` +
             `📉 **MACD**: ${analysis.macd.histogram.toFixed(5)}\n` +
             `🎯 **Stochastique**: K ${analysis.stoch.k.toFixed(2)}, D ${analysis.stoch.d.toFixed(2)}\n` +
             `🛡️ **StopLoss**: ${stopLoss.toFixed(5)}\n` +
             `🎯 **TakeProfit**: ${takeProfit.toFixed(5)}`
  };

  await axios.post(WEBHOOK_URL, message);
}

// Fonction pour envoyer un heartbeat
async function sendHeartbeat() {
  const message = {
    content: '🫀 **ZenScalp est actif** — Système OK ✅'
  };
  await axios.post(WEBHOOK_URL, message);
}

// Cron analyse toutes les 5 minutes
cron.schedule('*/2 * * * *', async () => {
  try {
    const candles = await fetchForexData();
    const analysis = analyze(candles);
    console.log(`Analyse ${new Date().toLocaleTimeString()}: ${analysis.signal}`);

    if (analysis.signal !== 'WAIT' && analysis.signal !== lastSignal) {
      await sendDiscordAlert(analysis);
      lastSignal = analysis.signal;
    }
  } catch (err) {
    console.error('Erreur Cron:', err.message);
  }
});

// Cron Heartbeat toutes les 30 minutes
cron.schedule('*/30 * * * *', async () => {
  try {
    await sendHeartbeat();
    console.log('🫀 Heartbeat envoyé');
  } catch (err) {
    console.error('Erreur Heartbeat:', err.message);
  }
});

// Route principale
app.get('/', (req, res) => {
  res.send('ZenScalp backend actif 🚀');
});

app.listen(PORT, () => {
  console.log(`🟢 Serveur ZenScalp lancé sur le port ${PORT}`);
});
