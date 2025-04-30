const express = require('express');
const axios = require('axios');
const cron = require('node-cron');
const technicalIndicators = require('technicalindicators');

const app = express();
const PORT = process.env.PORT || 3000;
const MODE_PERSISTANT = process.env.MODE_PERSISTANT === 'true';
console.log(`🔁 Mode persistant activé : ${MODE_PERSISTANT}`);

const POLYGON_API_KEY = 'aag8xgN6WM0Q83HLaOt9WqidQAyKrGtp';
const SYMBOL = 'C:EURUSD';
const WEBHOOK_URL = 'https://discord.com/api/webhooks/1366467465630187603/dyRbP05w82szDugjqa6IRF5rkvFGER4RTFqonh2gxGhrE-mHRe_gY4kH0HYHDNjAbPLi';

let lastSignal = 'WAIT';

async function fetchForexData() {
  const today = new Date().toISOString().split('T')[0];
  const url = `https://api.polygon.io/v2/aggs/ticker/${SYMBOL}/range/5/minute/2024-04-01/${today}?adjusted=true&sort=desc&limit=100&apiKey=${POLYGON_API_KEY}`;
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
  const convPeriod = 9, basePeriod = 26;

  const conv = (Math.max(...high.slice(-convPeriod)) + Math.min(...low.slice(-convPeriod))) / 2;
  const base = (Math.max(...high.slice(-basePeriod)) + Math.min(...low.slice(-basePeriod))) / 2;

  return { conversion: conv, base };
}

function computeSLTP(price, signal, levels) {
  let sl, tp;
  if (levels.support.length && levels.resistance.length) {
    if (signal.includes('BUY')) {
      sl = levels.support[0];
      tp = levels.resistance[0];
    } else {
      sl = levels.resistance[0];
      tp = levels.support[0];
    }
  } else {
    const percentSL = price * 0.001;
    const percentTP = price * 0.002;
    sl = signal.includes('BUY') ? price - percentSL : price + percentSL;
    tp = signal.includes('BUY') ? price + percentTP : price - percentTP;
  }
  return { sl: sl.toFixed(5), tp: tp.toFixed(5) };
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
    ema9: ema9.at(-1),
    ema21: ema21.at(-1),
    ema50: ema50.at(-1),
    ema100: ema100.at(-1),
    rsi14: rsi14.at(-1),
    macd: macd.length ? macd.at(-1) : { histogram: 0 },
    stoch: stoch.length ? stoch.at(-1) : { k: 0, d: 0 },
    sar: sar.length ? sar.at(-1) : close.at(-1),
    ichimoku
  };

  let bullCount = 0, bearCount = 0;
  if (latest.rsi14 > 50) bullCount++; else if (latest.rsi14 < 50) bearCount++;
  if (latest.macd?.histogram > 0) bullCount++; else if (latest.macd?.histogram < 0) bearCount++;
  if (latest.stoch?.k > latest.stoch?.d) bullCount++; else if (latest.stoch?.k < latest.stoch?.d) bearCount++;
  if (latest.sar < latest.price) bullCount++; else if (latest.sar > latest.price) bearCount++;
  if (latest.ichimoku?.conversion > latest.ichimoku?.base) bullCount++; else if (latest.ichimoku?.conversion < latest.ichimoku?.base) bearCount++;

  let signal = 'WAIT';
  if (bullCount >= 5) signal = 'STRONG BUY';
  else if (bullCount >= 3) signal = 'GOOD BUY';
  else if (bullCount >= 1) signal = 'BUY';
  else if (bearCount >= 5) signal = 'STRONG SELL';
  else if (bearCount >= 3) signal = 'GOOD SELL';
  else if (bearCount >= 1) signal = 'SELL';

  let trend = 'INDÉTERMINÉE';
  if (latest.price > latest.ema50 && latest.ema50 > latest.ema100) trend = 'HAUSSIÈRE';
  else if (latest.price < latest.ema50 && latest.ema50 < latest.ema100) trend = 'BAISSIÈRE';

  message: `${signal.includes('SELL') ? '📉' : signal.includes('BUY') ? '📈' : '⏸️'} ${signal} en tendance ${trend}`
  };
}
}
}
}

async function sendDiscordAlert(analysis, levels) {
  const { sl, tp } = computeSLTP(analysis.price, analysis.signal, levels);
  const msg = `${analysis.signal.includes('SELL') ? '📉' : analysis.signal.includes('BUY') ? '📈' : '⏸️'} **${analysis.signal}**
💰 Prix: ${analysis.price}\n📈 RSI: ${analysis.rsi14?.toFixed(2) ?? 'N/A'}\n📉 MACD: ${analysis.macd?.histogram?.toFixed(5) ?? 'N/A'}\n🎯 Stoch: K ${analysis.stoch?.k?.toFixed(2) ?? 'N/A'}, D ${analysis.stoch?.d?.toFixed(2) ?? 'N/A'}\n☁️ Ichimoku: Tenkan ${analysis.ichimoku?.conversion?.toFixed(5)}, Kijun ${analysis.ichimoku?.base?.toFixed(5)}\n🛑 SL: ${sl} | 🎯 TP: ${tp}\n📎 Supports: ${levels.support.map(p => p.toFixed(5)).join(', ')}\n📎 Résistances: ${levels.resistance.map(p => p.toFixed(5)).join(', ')}`;
  await axios.post(WEBHOOK_URL, { content: msg });
}

cron.schedule('* * * * *', async () => {
  try {
    const candles = await fetchForexData();
    const levels = detectLevels(candles);
    const analysis = analyze(candles);
    lastAnalysis = analysis;
    appendToCSV(analysis);
    console.log(`Analyse ${new Date().toLocaleTimeString()}: ${analysis.signal} (${analysis.trend})`);

    if (
      (!MODE_PERSISTANT && analysis.signal !== 'WAIT') ||
      (MODE_PERSISTANT && analysis.signal !== lastSignal)
    ) {
      await sendDiscordAlert(analysis, levels);
      lastSignal = analysis.signal;
    }
  } catch (err) {
    console.error('Erreur Cron:', err.message);
  }
});

cron.schedule('*/30 * * * *', async () => {
  await axios.post(WEBHOOK_URL, {
    content: `✅ Heartbeat: ZenScalp actif à ${new Date().toLocaleTimeString()}`
  });
});

const fs = require('fs');
const path = require('path');
const csvPath = path.join(__dirname, 'signals.csv');
let lastAnalysis = null;

function appendToCSV(analysis) {
  const header = 'timestamp,price,signal,rsi,macd_hist,stoch_k,stoch_d,sar,ema50,ema100,trend
';
  const line = `${analysis.timestamp || new Date().toISOString()},${analysis.price},${analysis.signal},${analysis.rsi14},${analysis.macd?.histogram},${analysis.stoch?.k},${analysis.stoch?.d},${analysis.sar},${analysis.ema50},${analysis.ema100},${analysis.trend}
`;
  if (!fs.existsSync(csvPath)) fs.writeFileSync(csvPath, header);
  fs.appendFileSync(csvPath, line);
}

app.get('/indicateurs', (req, res) => {
  if (!lastAnalysis) return res.status(404).json({ error: 'Aucune analyse encore disponible.' });
  res.json(lastAnalysis);
});

app.get('/', (req, res) => {
  res.send('ZenScalp backend agressif et intelligent 🚀');
});

app.listen(PORT, () => {
  console.log(`🟢 Serveur ZenScalp lancé sur le port ${PORT}`);
});
