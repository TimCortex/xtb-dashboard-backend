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

async function fetchForexData() {
  const today = new Date().toISOString().split('T')[0];
  const url = `https://api.polygon.io/v2/aggs/ticker/${SYMBOL}/range/5/minute/2024-04-01/${today}?adjusted=true&sort=desc&limit=100&apiKey=${POLYGON_API_KEY}`;
  const { data } = await axios.get(url);
  return data.results.reverse(); // oldest first
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

  const conversionPeriod = 9;
  const basePeriod = 26;

  const recentHighConv = Math.max(...high.slice(-conversionPeriod));
  const recentLowConv = Math.min(...low.slice(-conversionPeriod));
  const conversion = (recentHighConv + recentLowConv) / 2;

  const recentHighBase = Math.max(...high.slice(-basePeriod));
  const recentLowBase = Math.min(...low.slice(-basePeriod));
  const base = (recentHighBase + recentLowBase) / 2;

  return { conversion, base };
}


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
  const stoch = technicalIndicators.Stochastic.calculate({ high, low, close, period: 14, signalPeriod: 3 });
  const sar = technicalIndicators.PSAR.calculate({ high, low, step: 0.02, max: 0.2 });
  const bb = technicalIndicators.BollingerBands.calculate({ values: close, period: 20, stdDev: 2 });

  const ichimoku = calculateIchimoku(data);

  const latest = {
    price: close.at(-1),
    ema9: ema9.at(-1),
    ema21: ema21.at(-1),
    rsi14: rsi14.at(-1),
    macd: macd.at(-1),
    stoch: stoch.at(-1),
    sar: sar.at(-1),
    bb: bb.at(-1),
    ichimoku
  };

  // STRONG signal logique
  let signal = 'WAIT';
  const bullish =
    latest.ema9 > latest.ema21 &&
    latest.rsi14 > 50 &&
    latest.macd.histogram > 0 &&
    latest.stoch.k > latest.stoch.d &&
    latest.sar < latest.price &&
    latest.ichimoku.conversion > latest.ichimoku.base;

  const bearish =
    latest.ema9 < latest.ema21 &&
    latest.rsi14 < 50 &&
    latest.macd.histogram < 0 &&
    latest.stoch.k < latest.stoch.d &&
    latest.sar > latest.price &&
    latest.ichimoku.conversion < latest.ichimoku.base;

  if (bullish) {
    signal = 'STRONG BUY';
  } else if (latest.ema9 > latest.ema21 && latest.stoch.k > latest.stoch.d) {
    signal = 'BUY';
  } else if (bearish) {
    signal = 'STRONG SELL';
  } else if (latest.ema9 < latest.ema21 && latest.stoch.k < latest.stoch.d) {
    signal = 'SELL';
  }

  return { ...latest, signal };
}

async function sendDiscordAlert(analysis, levels) {
  const msg = `📊 **${analysis.signal}**\n💰 Prix: ${analysis.price}\n📈 RSI: ${analysis.rsi14?.toFixed(2)}\n📉 MACD: ${analysis.macd?.histogram?.toFixed(5)}\n🎯 Stoch K: ${analysis.stoch?.k?.toFixed(2)}, D: ${analysis.stoch?.d?.toFixed(2)}\n💡 Ichimoku: Tenkan ${analysis.ichimoku?.conversion?.toFixed(5)}, Kijun ${analysis.ichimoku?.base?.toFixed(5)}\n🛑 Supports: ${levels.support.map(p => p.toFixed(5)).join(', ')}\n📌 Résistances: ${levels.resistance.map(p => p.toFixed(5)).join(', ')}`;
  await axios.post(WEBHOOK_URL, { content: msg });
}

// Analyse toutes les 1 min
cron.schedule('* * * * *', async () => {
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

// Heartbeat
cron.schedule('*/30 * * * *', async () => {
  await axios.post(WEBHOOK_URL, {
    content: `✅ Heartbeat: ZenScalp tourne toujours (${new Date().toLocaleTimeString()})`
  });
});

app.get('/', (req, res) => {
  res.send('ZenScalp backend agressif prêt 🧠🚀');
});

app.listen(PORT, () => {
  console.log(`🟢 Serveur ZenScalp lancé sur le port ${PORT}`);
});
