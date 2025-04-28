const axios = require('axios');

// Ta clé API TraderMade
const API_KEY = 'awhGMWCdUSSnyLFbnnxV';

// Fonction pour récupérer le prix de l'EUR/USD
async function getEURUSD() {
  try {
    const response = await axios.get('https://marketdata.tradermade.com/api/v1/live', {
      params: {
        currency: 'EURUSD',
        api_key: API_KEY
      }
    });

    const data = response.data;
    console.log('Prix EUR/USD:', data.quotes[0]);

  } catch (error) {
    console.error('Erreur lors de la récupération des données:', error.response?.data || error.message);
  }
}

getEURUSD();
