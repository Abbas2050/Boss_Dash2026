// fetch_mt5_emails.cjs
// For each login, call /rest/accounts with { login: <id> }, collect userId, then batch fetch users, output CSV

const axios = require('axios');
const fs = require('fs');
require('dotenv').config();

const MT5_ACCOUNT_IDS = [
  100206,100522,100532,100558,100562,100567,100574,100632,100643,100660,100673,100679,100688,100694,100701,100766,100768,100770,100813,100815,100851,100858,100859,100861,100863,100868,100879,100882,100918,100919,100924,100927,100930,100931,100938,100939,100940,100942,100943,100944,100953,100959,100961,100964,100965,100966,100969,100972,100974,100976,100977,100979,100980,100988,100989,100990,100991,100992,100993,100994,100998,101001,101002,101004,101005,101006,101007,101008,101009,101010,101013,101016,101017,101018,101025,101028,101030,101031,101032,101033,101034,101035,101036,101037,101051,101052,101053,101054,101056,101060,101062,101063,101065,101066,101068,101071,101077,101078,101079,101080,101081,101082,101083,101084,101085,101088,101089,101090,101091,101093,101098,101099,101101,101105,101106,101110,101113,101115,101116,101118,101121,101122,101129,101130,101131,101132,101136,101137,101138,101141,101146,101151,101152,101156,101161,101162,101166,101168,101173,101177,101188,101189,101190,101191,101196,101198,101199,101200,101201,101202,101210,101215,101218,101220,101226,101228,101229,101238,101241,101257,101258,101260,101262,101264,101270,101280,101282,101284,101291,101311,101316,101322,101329,101330,101331,101338,101339,101342,101353,101358,101364,101372,101382,101396,101398,101401,101403,101410,101411,101418,101431,101457,101467,101509,101516,101522,101523,101529,101535,101539,101541,101542,101552,101554,101564,101568,101569
];

const API_BASE = process.env.VITE_API_URL?.replace('/transactions', '') || 'http://localhost:8080/rest';
const API_VERSION = process.env.VITE_API_VERSION || '1.0.0';
const API_TOKEN = process.env.VITE_API_TOKEN || '';

async function fetchAccount(login) {
  const url = `${API_BASE}/accounts?version=${API_VERSION}`;
  const headers = {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'Authorization': `Bearer ${API_TOKEN}`,
  };
  try {
    const res = await axios.post(url, { login }, { headers });
    // API may return array or object, handle both
    if (Array.isArray(res.data)) return res.data[0];
    return res.data;
  } catch (err) {
    // Optionally log: console.error(`Failed for login ${login}:`, err.response?.data || err.message);
    return null;
  }
}

async function fetchUsersByIds(userIds) {
  if (userIds.length === 0) return [];
  const url = `${API_BASE}/users?version=${API_VERSION}`;
  const headers = {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'Authorization': `Bearer ${API_TOKEN}`,
  };
  try {
    const res = await axios.post(url, { ids: userIds }, { headers });
    return res.data;
  } catch (err) {
    // Optionally log: console.error('Failed to fetch users:', err.response?.data || err.message);
    return [];
  }
}

async function main() {
  // 1. For each login, fetch account and collect userId
  const loginToUserId = {};
  for (const login of MT5_ACCOUNT_IDS) {
    const acc = await fetchAccount(login);
    if (acc && acc.login && acc.userId) {
      loginToUserId[acc.login] = acc.userId;
    }
  }
  const userIds = Array.from(new Set(Object.values(loginToUserId)));

  // 2. Fetch user details using userIds
  const users = await fetchUsersByIds(userIds);
  // Map userId to email
  const userIdToEmail = {};
  users.forEach(user => {
    if (user.id && user.email) {
      userIdToEmail[user.id] = user.email;
    }
  });

  // 3. Map login to email and write to CSV
  const lines = ["login,email"];
  for (const login of MT5_ACCOUNT_IDS) {
    const userId = loginToUserId[login];
    const email = userId ? (userIdToEmail[userId] || 'NOT FOUND') : 'NOT FOUND';
    lines.push(`${login},${email}`);
  }
  fs.writeFileSync("mt5_emails.csv", lines.join("\n"), "utf8");
  console.log("CSV file 'mt5_emails.csv' created.");
}

main();
