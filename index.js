const express = require('express');
const axios = require('axios');
const technicalIndicators = require('technicalindicators');

const app = express();
const PORT = process.env.PORT || 3000;

// Polygon.io API
const POLYGON_API_KEY = 'PxC6peU74MGVfAXPhqj704n6p64Jck8p';
const SYMBOL = 'C:EURUSD'; // Forex pair in Polygon format

// Fonction pour récupérer les dernières bougies OHLC (5 min interval)
async function fetchOHLCData() {
  const url = `https://api.polygon.io/v2/aggs/ticker/${SYMBOL}/range/5/minute/2024-01-01/2024-12-31?limit=100&apiKey=${POLYGON_API_KEY}`;
  try {
    const response = await axios.get(url);
    return response.data.results || [];
  } catch (error) {
    console.error('Erreur Polygon API:', error.response?.data || error.message);
    return [];
  }
}

// Fonction pour analyser les données avec les indicateurs techniques
function analyzeData(candles) {
  const closes = candles.map(c => c.c); // closing prices
  const highs = candles.map(c => c.h);
  const lows = candles.map(c => c.l);

  const sma20 = technicalIndicators.SMA.calculate({ period: 20, values: closes });
  const ema9 = technicalIndicators.EMA.calculate({ period: 9, values: closes });
  const ema21 = technicalIndicators.EMA.calculate({ period: 21, values: closes });
  const rsi14 = technicalIndicators.RSI.calculate({ period: 14, values: closes });
  const macd = technicalIndicators.MACD.calculate({
    values: closes,
    fastPeriod: 12,
    slowPeriod: 26,
    signalPeriod: 9,
    SimpleMAOscillator: false,
    SimpleMASignal: false
  });
  const bb = technicalIndicators.BollingerBands.calculate({
    period: 20,
    values: closes,
    stdDev: 2
  });
  const stochastic = technicalIndicators.Stochastic.calculate({
    high: highs,
    low: lows,
    close: closes,
    period: 14,
    signalPeriod: 3
  });

  const lastClose = closes[closes.length - 1];
  const lastRSI = rsi14[rsi14.length - 1];
  const lastMACD = macd[macd.length - 1];
  const lastBB = bb[bb.length - 1];
  const lastStoch = stochastic[stochastic.length - 1];

  // Analyse simple basée sur RSI et MACD pour exemple
  let signal = 'Neutral';
  if (lastRSI < 30 && lastMACD.MACD > lastMACD.signal) {
    signal = 'Buy';
  } else if (lastRSI > 70 && lastMACD.MACD < lastMACD.signal) {
    signal = 'Sell';
  }

  return {
    lastClose,
    lastRSI,
    lastMACD,
    lastBB,
    lastStoch,
    signal
  };
}

// Endpoint principal
app.get('/analyze', async (req, res) => {
  const candles = await fetchOHLCData();
  if (candles.length === 0) {
    return res.status(500).send('Erreur récupération des données OHLC');
  }
  const analysis = analyzeData(candles);
  res.json(analysis);
});

// Démarrage du serveur
app.listen(PORT, () => {
  console.log(`Serveur en ligne sur le port ${PORT}`);
});
