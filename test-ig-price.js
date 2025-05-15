const axios = require('axios');

const API_KEY = '2a3e078a4eec24c7479614f8ba54ebf781ed7298';
const IG_USERNAME = 'timagnus'; // ton nom d'utilisateur IG démo
const IG_PASSWORD = 'Lyautey#1'; // à insérer manuellement pour test
const IG_API_URL = 'https://api.ig.com/gateway/deal/session';

async function getSession() {
  try {
    const res = await axios.post(`${IG_API_URL}/session`, {
      identifier: IG_USERNAME,
      password: IG_PASSWORD,
    }, {
      headers: {
        'X-IG-API-KEY': API_KEY,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      }
    });

    const cst = res.headers['cst'];
    const xSecurityToken = res.headers['x-security-token'];
    return { cst, xSecurityToken };
  } catch (err) {
    console.error('❌ Erreur de connexion :', err.response?.data || err.message);
    return null;
  }
}

async function getPrice(cst, xSecurityToken) {
  try {
    const res = await axios.get(`${IG_API_URL}/markets/CS.D.EURUSD.MINI.IP`, {
      headers: {
        'X-IG-API-KEY': API_KEY,
        'CST': cst,
        'X-SECURITY-TOKEN': xSecurityToken,
        'Accept': 'application/json',
      }
    });

    const snapshot = res.data.snapshot;
    console.log(`📈 EUR/USD - Bid: ${snapshot.bid}, Offer: ${snapshot.offer}`);
  } catch (err) {
    console.error('❌ Erreur récupération prix :', err.response?.data || err.message);
  }
}

(async () => {
  const session = await getSession();
  if (!session) return;
  await getPrice(session.cst, session.xSecurityToken);
})();
