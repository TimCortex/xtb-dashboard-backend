// ZenScalp - Version avec suspension des alertes lors d’annonces économiques via FMP
const express = require('express');
const axios = require('axios');
const cron = require('node-cron');
const technicalIndicators = require('technicalindicators');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const MODE_PERSISTANT = process.env.MODE_PERSISTANT === 'true';
console.log(`🔁 Mode persistant activé : ${MODE_PERSISTANT}`);

const POLYGON_API_KEY = 'aag8xgN6WM0Q83HLaOt9WqidQAyKrGtp';
const FMP_API_KEY = '6814bfd198f049.40358032';
const SYMBOL = 'C:EURUSD';
const WEBHOOK_URL = 'https://discord.com/api/webhooks/1366467465630187603/dyRbP05w82szDugjqa6IRF5rkvFGER4RTFqonh2gxGhrE-mHRe_gY4kH0HYHDNjAbPLi';

let lastSignal = 'WAIT';
let lastNotificationSignal = null;
let suspendNotificationsUntil = null;

async function fetchForexData() {
  const today = new Date().toISOString().split('T')[0];
  const url = `https://api.polygon.io/v2/aggs/ticker/${SYMBOL}/range/5/minute/2024-04-01/${today}?adjusted=true&sort=desc&limit=150&apiKey=${POLYGON_API_KEY}`;
  const { data } = await axios.get(url);
  return data.results.reverse();
}

async function checkUpcomingEconomicEvents() {
  try {
    const now = new Date();
    const nowISO = now.toISOString().split('T')[0];
    const url = `https://financialmodelingprep.com/api/v4/economic_calendar?from=${nowISO}&to=${nowISO}&apikey=${FMP_API_KEY}`;
    const { data } = await axios.get(url);

    const upcoming = data.filter(event => {
      const eventTime = new Date(`${event.date}T${event.time}`);
      const diffMinutes = (eventTime - now) / 60000;
      return ["USD", "EUR"].includes(event.country) && diffMinutes >= 0 && diffMinutes <= 15;
    });

    if (upcoming.length) {
      suspendNotificationsUntil = new Date(Date.now() + 30 * 60000);
      const message = upcoming.map(e => `📌 ${e.event} (${e.country}) à ${e.time}`).join('\n');
      await axios.post(WEBHOOK_URL, {
        content: `⏸️ **Suspension temporaire des alertes ZenScalp (annonce économique)**\n${message}`
      });
    }
  } catch (err) {
    console.error('Erreur évènements FMP :', err.message);
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

function calculateIchimoku(data) {
  const high = data.map(c => c.h);
  const low = data.map(c => c.l);
  const conv = (Math.max(...high.slice(-9)) + Math.min(...low.slice(-9))) / 2;
  const base = (Math.max(...high.slice(-26)) + Math.min(...low.slice(-26))) / 2;
  return { conversion: conv, base };
}

function computeSLTP(price, signal, levels) {
  let sl, tp;
  if (levels.support.length && levels.resistance.length) {
    if (signal.includes('BUY')) {
      sl = levels.support.find(s => s < price) ?? price - price * 0.001;
      tp = levels.resistance.find(r => r > price) ?? price + price * 0.002;
    } else {
      sl = levels.resistance.find(r => r > price) ?? price + price * 0.001;
      tp = levels.support.find(s => s < price) ?? price - price * 0.002;
    }
  } else {
    const percentSL = price * 0.001;
    const percentTP = price * 0.002;
    sl = signal.includes('BUY') ? price - percentSL : price + percentSL;
    tp = signal.includes('BUY') ? price + percentTP : price - percentTP;
  }
  return { sl: sl.toFixed(5), tp: tp.toFixed(5) };
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
    macd: macd.length ? macd.at(-1) : { histogram: 0 },
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
  else if (bull >= 3) signal = 'GOOD BUY';
  else if (bull >= 1) signal = 'WAIT TO BUY';
  else if (bear >= 5) signal = 'STRONG SELL';
  else if (bear >= 3) signal = 'GOOD SELL';
  else if (bear >= 1) signal = 'WAIT TO SELL';

  let trend = 'INDÉTERMINÉE';
  if (latest.ema50 && latest.ema100) {
    if (latest.price > latest.ema50 && latest.ema50 > latest.ema100) trend = 'HAUSSIÈRE';
    else if (latest.price < latest.ema50 && latest.ema50 < latest.ema100) trend = 'BAISSIÈRE';
  }

  return { ...latest, signal, trend };
}

async function sendDiscordAlert(analysis, levels) {
  const { sl, tp } = computeSLTP(analysis.price, analysis.signal, levels);
  const warning = generateWarning(analysis.price, analysis.signal, levels);
  const msg = `${analysis.signal.includes('SELL') ? '📉' : analysis.signal.includes('BUY') ? '📈' : '⏸️'} **${analysis.signal}**\n`
    + `💰 Prix: ${analysis.price}\n📈 RSI: ${analysis.rsi14?.toFixed(2)}\n📉 MACD: ${analysis.macd?.histogram?.toFixed(5)}\n`
    + `🎯 Stoch: K ${analysis.stoch?.k?.toFixed(2)}, D ${analysis.stoch?.d?.toFixed(2)}\n`
    + `☁️ Ichimoku: Tenkan ${analysis.ichimoku?.conversion?.toFixed(5)}, Kijun ${analysis.ichimoku?.base?.toFixed(5)}\n`
    + `🛑 SL: ${sl} | 🎯 TP: ${tp}\n📎 Supports: ${levels.support.map(p => p.toFixed(5)).join(', ')}\n`
    + `📎 Résistances: ${levels.resistance.map(p => p.toFixed(5)).join(', ')}\n${warning}`;
  await axios.post(WEBHOOK_URL, { content: msg });
}

cron.schedule('* * * * *', async () => {
  try {
    const now = new Date();
    if (!suspendNotificationsUntil || now > suspendNotificationsUntil) suspendNotificationsUntil = null;
    if (!suspendNotificationsUntil) await checkUpcomingEconomicEvents();
    if (suspendNotificationsUntil) return console.log('⏳ Notifications suspendues temporairement.');

    const candles = await fetchForexData();
    const levels = detectLevels(candles);
    const analysis = analyze(candles);
    lastAnalysis = analysis;

    if (!MODE_PERSISTANT) {
      if (!analysis.signal.startsWith('WAIT')) await sendDiscordAlert(analysis, levels);
    } else {
      if (analysis.signal === 'WAIT' && lastNotificationSignal !== 'WAIT') {
        await sendDiscordAlert(analysis, levels);
        lastNotificationSignal = 'WAIT';
      } else if (analysis.signal !== 'WAIT' && analysis.signal !== lastNotificationSignal) {
        await sendDiscordAlert(analysis, levels);
        lastNotificationSignal = analysis.signal;
      }
    }
  } catch (err) {
    console.error('Erreur Cron :', err.message);
  }
});

const csvPath = path.join(__dirname, 'signals.csv');
let lastAnalysis = null;
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

app.get('/', (req, res) => {
  res.send('ZenScalp backend avec suspension automatique lors des événements économiques 🚀');
});

app.listen(PORT, () => console.log(`🟢 Serveur ZenScalp sur le port ${PORT}`));
