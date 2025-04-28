const express = require('express');
const axios = require('axios');
const technicalIndicators = require('technicalindicators');
const app = express();
const PORT = process.env.PORT || 3000;

const POLYGON_API_KEY = 'PxC6peU74MGVfAXPhqj704n6p64Jck8p';
const SYMBOL = 'C:EURUSD';
const INTERVAL = '5'; // minutes
const LIMIT = 100; // nombre de bougies à récupérer

async function fetchForexData() {
  const url = `https://api.polygon.io/v2/aggs/ticker/${SYMBOL}/range/${INTERVAL}/minute/2023-01-01/2023-12-31?adjusted=true&sort=desc&limit=${LIMIT}&apiKey=${POLYGON_API_KEY}`;
  const { data } = await axios.get(url);
  return data.results.reverse(); // du plus ancien au plus récent
}

function analyze(data) {
  const close = data.map(candle => candle.c);

  // Calculs
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
    high: data.map(c => c.h),
    low: data.map(c => c.l),
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

  // Détermination d’un signal simple
  let signal = 'WAIT';
  if (latest.ema9 > latest.ema21 && latest.rsi14 > 50 && latest.macd.histogram > 0 && latest.stoch.k > latest.stoch.d) {
    signal = 'BUY';
  } else if (latest.ema9 < latest.ema21 && latest.rsi14 < 50 && latest.macd.histogram < 0 && latest.stoch.k < latest.stoch.d) {
    signal = 'SELL';
  }

  return { ...latest, signal };
}

// Endpoint principal
app.get('/', (req, res) => {
  res.send('ZenScalp backend actif 🚀');
});

app.get('/eurusd', async (req, res) => {
  try {
    const candles = await fetchForexData();
    const result = analyze(candles);
    res.json(result);
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Erreur durant l’analyse');
  }
});

app.listen(PORT, () => {
  console.log(`🟢 Serveur ZenScalp lancé sur le port ${PORT}`);
});
