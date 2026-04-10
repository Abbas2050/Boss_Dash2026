/**
 * PSP Clients - Node.js port of OtherProject/backofficetool/src/psp_clients.php
 * Direct API integrations for Bitpace, LetKnowPay, OwnBit (TRON), HeroPayment, Google Sheets
 */

import crypto from 'crypto';
import { google } from 'googleapis';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadGoogleSheetsMappingConfig } from './googleSheetsMappingConfig.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─────────────────────────────────────────────────────────
// Bitpace Client
// Auth: POST /api/v1/auth/token (merchant_code + password)
// Balance: GET /api/v1/balance/currency (Bearer token)
// Returns: USDT balance only
// ─────────────────────────────────────────────────────────
export class BitpaceClient {
  constructor() {
    this.merchantCode = process.env.BITPACE_MERCHANT_CODE || '';
    this.password = process.env.BITPACE_API_PASS || '';
    this.baseUrl = (process.env.BITPACE_BASE_URL || 'https://api.bitpace.com').replace(/\/+$/, '');
    this._token = null;
    this._tokenExpiry = 0;
    this._tokenCacheFile = path.join(__dirname, '../storage/bitpace_token.json');
    this._loadCachedToken();
  }

  _loadCachedToken() {
    try {
      if (fs.existsSync(this._tokenCacheFile)) {
        const d = JSON.parse(fs.readFileSync(this._tokenCacheFile, 'utf8'));
        if (d?.token && d?.expiry > Date.now()) {
          this._token = d.token;
          this._tokenExpiry = d.expiry;
        }
      }
    } catch { /* ignore */ }
  }

  _saveCachedToken(token) {
    try {
      const dir = path.dirname(this._tokenCacheFile);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(this._tokenCacheFile, JSON.stringify({ token, expiry: this._tokenExpiry }));
    } catch { /* ignore */ }
  }

  async _getAuthToken() {
    if (this._token && this._tokenExpiry > Date.now()) {
      return this._token;
    }

    const res = await fetch(`${this.baseUrl}/api/v1/auth/token`, {
      method: 'POST',
      headers: { 'accept': 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({ merchant_code: this.merchantCode, password: this.password }),
      signal: AbortSignal.timeout(30000),
    });

    const data = await res.json();
    if (!res.ok) {
      throw new Error(`Bitpace auth failed HTTP ${res.status}: ${data.message || data.error || JSON.stringify(data)}`);
    }

    const token = data?.data?.token ?? data?.token;
    if (!token) throw new Error(`Bitpace auth response missing token: ${JSON.stringify(data)}`);

    this._token = token;
    this._tokenExpiry = Date.now() + 10 * 60 * 60 * 1000; // 10 hours
    this._saveCachedToken(token);
    return this._token;
  }

  async getBalance() {
    const requestBalance = async (token) => {
      const res = await fetch(`${this.baseUrl}/api/v1/balance/currency`, {
        headers: { 'Accept': 'application/json', 'Authorization': `Bearer ${token}` },
        signal: AbortSignal.timeout(15000),
      });
      const rawText = await res.text();
      let data = null;
      try { data = JSON.parse(rawText); } catch { /* keep raw text */ }
      return { res, data, rawText };
    };

    let token = await this._getAuthToken();
    let { res, data, rawText } = await requestBalance(token);

    if (!res.ok && (res.status === 401 || res.status === 403)) {
      // Force a fresh token once in case cached token was stale/revoked.
      this._token = null;
      this._tokenExpiry = 0;
      token = await this._getAuthToken();
      ({ res, data, rawText } = await requestBalance(token));
    }

    if (!res.ok) {
      const reason = data?.message || data?.error || rawText || 'Unknown Bitpace error';
      throw new Error(`Bitpace balance HTTP ${res.status}: ${reason}`);
    }

    let balances = {};

    if (Array.isArray(data?.data)) {
      for (const item of data.data) {
        if (item.currency && item.balance != null) balances[item.currency] = parseFloat(item.balance);
      }
    } else if (data?.balances && typeof data.balances === 'object') {
      for (const [cur, amt] of Object.entries(data.balances)) {
        if (!isNaN(amt)) balances[cur] = parseFloat(amt);
      }
    }

    return { balance: balances['USDT'] ?? 0, currencies: balances['USDT'] != null ? { USDT: balances['USDT'] } : {} };
  }
}

// ─────────────────────────────────────────────────────────
// LetKnow Pay Client
// Auth: HMAC-SHA256 via headers C-Request-Nonce, C-Request-Signature, C-Shop-Id
// Balance: POST https://pay.letknow.com/api/2/get_balances
// Returns: USDTTRC20 balance only
// ─────────────────────────────────────────────────────────
export class LetKnowPayClient {
  constructor() {
    this.apiKey = process.env.LETKNOWPAY_API_KEY || '';
    this.shopId = process.env.LETKNOWPAY_SHOP_ID || '';
    this.baseUrl = 'https://pay.letknow.com';
  }

  async getBalance() {
    const nonce = Date.now().toString();
    const signature = crypto
      .createHmac('sha256', this.apiKey)
      .update(`${nonce}|${this.shopId}|${this.apiKey}`)
      .digest('hex');

    const res = await fetch(`${this.baseUrl}/api/2/get_balances`, {
      method: 'POST',
      headers: {
        'C-Request-Nonce': nonce,
        'C-Request-Signature': signature,
        'C-Shop-Id': this.shopId,
        'Content-Type': 'application/json',
      },
      body: '',
      signal: AbortSignal.timeout(15000),
    });

    const data = await res.json();
    if (!res.ok || data.result !== 'success') {
      throw new Error(`LetKnow Pay API error: ${data.error_message ?? data.result ?? res.status}`);
    }

    const allBalances = data.balances ?? {};
    return {
      balance: parseFloat(allBalances['USDTTRC20'] ?? 0),
      currencies: allBalances['USDTTRC20'] != null ? { USDTTRC20: parseFloat(allBalances['USDTTRC20']) } : {},
    };
  }
}

// ─────────────────────────────────────────────────────────
// OwnBit / TRON Client
// No auth needed - public Tronscan API
// Balance: GET https://apilist.tronscan.org/api/account?address=...
// Returns: USDT TRC20 (divide by 1,000,000 for 6 decimals)
// Cache: 5-minute in-memory TTL
// ─────────────────────────────────────────────────────────
export class OwnBitClient {
  constructor() {
    this.walletAddress = process.env.TRON_WALLET_ADDRESS || '';
    this._cache = null;
    this._cacheExpiry = 0;
    this._cacheTTL = 5 * 60 * 1000; // 5 minutes
  }

  async _getTronAccountData() {
    if (this._cache && Date.now() < this._cacheExpiry) {
      return this._cache;
    }

    const url = `https://apilist.tronscan.org/api/account?address=${encodeURIComponent(this.walletAddress)}`;
    const res = await fetch(url, {
      headers: { 'Accept': 'application/json' },
      signal: AbortSignal.timeout(15000),
    });

    if (!res.ok) throw new Error(`TRON Tronscan HTTP ${res.status}`);
    const data = await res.json();

    this._cache = data;
    this._cacheExpiry = Date.now() + this._cacheTTL;
    return data;
  }

  async getBalance() {
    if (!this.walletAddress) throw new Error('TRON_WALLET_ADDRESS not configured');
    const data = await this._getTronAccountData();

    let usdtBalance = 0;
    const tokens = data?.trc20token_balances ?? [];
    for (const token of tokens) {
      const name = (token.tokenName ?? '').toLowerCase();
      if (name.includes('usdt') || name.includes('tether')) {
        usdtBalance = parseFloat(token.balance ?? 0) / 1_000_000;
        break;
      }
    }

    return { balance: usdtBalance, currencies: { 'USDT TRC20': usdtBalance } };
  }
}

// ─────────────────────────────────────────────────────────
// HeroPayment Client
// Auth: HMAC-SHA512 on query string, headers x-api-key + x-api-sign
// V2 Balance: GET /v2/balance
// Custody Balance: GET /custody/balances (sum usdEstimate or available)
// Returns: combined total
// ─────────────────────────────────────────────────────────
export class HeroPaymentClient {
  constructor() {
    this.apiKey = process.env.HEROPAYMENT_API_KEY || '';
    this.apiSecret = process.env.HEROPAYMENT_API_SECRET || '';
    this.custodyApiKey = process.env.HEROPAYMENT_CUSTODY_API_KEY || '';
    this.custodyApiSecret = process.env.HEROPAYMENT_CUSTODY_API_SECRET || '';
    this.baseUrl = (process.env.HEROPAYMENT_BASE_URL || 'https://api.heropayments.io').replace(/\/+$/, '');
  }

  _signGet(params, secret) {
    const queryString = new URLSearchParams(params).toString();
    const sign = crypto.createHmac('sha512', secret).update(queryString).digest('hex');
    return { queryString, sign };
  }

  async _requestHmacGet(endpoint, params, apiKey, apiSecret) {
    const { queryString, sign } = this._signGet(params, apiSecret);
    const url = `${this.baseUrl}${endpoint}${queryString ? '?' + queryString : ''}`;

    const res = await fetch(url, {
      headers: {
        'x-api-key': apiKey,
        'x-api-sign': sign,
        'Accept': 'application/json',
      },
      signal: AbortSignal.timeout(15000),
    });

    const data = await res.json();
    if (!res.ok) throw new Error(`HeroPayment API HTTP ${res.status}: ${data.error ?? data.message ?? JSON.stringify(data)}`);
    return data;
  }

  async getBalance() {
    let total = 0;
    const currencies = {};

    // V2 flow balance
    try {
      const v2 = await this._requestHmacGet('/v2/balance', {}, this.apiKey, this.apiSecret);
      if (v2?.balance != null) {
        const amt = parseFloat(v2.balance);
        total += amt;
        const cur = v2.walletCurrency ? `V2_${v2.walletCurrency.toUpperCase()}` : 'V2_USDT';
        currencies[cur] = amt;
      }
    } catch (e) {
      console.error('[HeroPayment] V2 balance error:', e.message);
    }

    // Custody flow balances
    if (this.custodyApiKey && this.custodyApiSecret) {
      try {
        const custody = await this._requestHmacGet('/custody/balances', {}, this.custodyApiKey, this.custodyApiSecret);
        if (Array.isArray(custody)) {
          for (const entry of custody) {
            const usd = parseFloat(entry?.usdEstimate ?? entry?.available ?? 0);
            if (usd > 0) {
              total += usd;
              const cur = `CUSTODY_${(entry.currency ?? 'USDT').toUpperCase()}`;
              currencies[cur] = (currencies[cur] ?? 0) + usd;
            }
          }
        }
      } catch (e) {
        console.error('[HeroPayment] Custody balance error:', e.message);
      }
    }

    return { balance: total, currencies };
  }
}

// ─────────────────────────────────────────────────────────
// Google Sheets Client
// Auth: Service account from GA4_SERVICE_ACCOUNT_JSON env var
// Reads cells from sheet named DD/MM/YYYY (today then yesterday fallback)
// K8=Match2Pay, K9=DeusXpay, K12=GoldSouq, K15=FABAed, K16=FABUsd, K17=MBME
// K8=Match2Pay, K9=DeusXpay, K10=OpenPayed, K12=GoldSouq, K15=FABAed, K16=FABUsd, K17=MBME
// K19=bankReceivable, K20=cryptoReceivable, K21/K22=toBeDepositedIntoLPs,
// J25=netAllCurrent, J27=netAfterExpected, J29=differenceActualExpected
// ─────────────────────────────────────────────────────────
export class GoogleSheetsClient {
  constructor() {
    this.spreadsheetId = process.env.GOOGLE_SHEETS_ID || '';
    this._sheetsService = null;
  }

  _getService() {
    if (this._sheetsService) return this._sheetsService;

    const serviceAccountJson = process.env.GA4_SERVICE_ACCOUNT_JSON;
    if (!serviceAccountJson) throw new Error('GA4_SERVICE_ACCOUNT_JSON not configured');

    const key = JSON.parse(serviceAccountJson);
    const auth = new google.auth.GoogleAuth({
      credentials: key,
      scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
    });

    this._sheetsService = google.sheets({ version: 'v4', auth });
    return this._sheetsService;
  }

  _parseCell(value) {
    if (value == null || value === '') return 0;
    return parseFloat(String(value).replace(/[^0-9.-]/g, '')) || 0;
  }

  _todaySheetName(offsetDays = 0) {
    // Use Dubai date to match business reporting day.
    const nowDubai = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Dubai' }));
    nowDubai.setDate(nowDubai.getDate() - offsetDays);
    const dd = String(nowDubai.getDate()).padStart(2, '0');
    const mm = String(nowDubai.getMonth() + 1).padStart(2, '0');
    const yyyy = nowDubai.getFullYear();
    return `${dd}/${mm}/${yyyy}`;
  }

  _candidateSheetNames(daysBack = 7) {
    const names = [];
    for (let offset = 0; offset <= daysBack; offset += 1) {
      names.push(this._todaySheetName(offset));
    }
    return names;
  }

  async _probeSheetExists(sheets, sheetName) {
    try {
      await sheets.spreadsheets.values.get({
        spreadsheetId: this.spreadsheetId,
        range: `'${sheetName}'!A1`,
      });
      return { exists: true, error: null };
    } catch (error) {
      const message =
        error?.response?.data?.error?.message ||
        error?.message ||
        'Unknown Google Sheets error';
      return { exists: false, error: message };
    }
  }

  async _readWalletCells(sheets, sheetName) {
    const mapping = loadGoogleSheetsMappingConfig();
    const fields = mapping.fields;
    const q = (cell) => `'${sheetName}'!${cell}`;

    const response = await sheets.spreadsheets.values.batchGet({
      spreadsheetId: this.spreadsheetId,
      ranges: fields.map((f) => q(f.cell)),
    });

    const vr = response.data.valueRanges ?? [];
    const cellsByKey = {};
    const cellsByCell = {};
    const values = {};

    for (let i = 0; i < fields.length; i += 1) {
      const field = fields[i];
      const raw = vr[i]?.values?.[0]?.[0] ?? null;
      const parsed = this._parseCell(raw);

      const cellInfo = {
        key: field.key,
        label: field.label,
        cell: field.cell,
        required: Boolean(field.required),
        raw,
        parsed,
      };

      cellsByKey[field.key] = cellInfo;
      cellsByCell[field.cell] = cellInfo;
      values[field.key] = parsed;
    }

    values.fabTotal = (values.fabAed ?? 0) + (values.fabUsd ?? 0);

    return {
      mapping,
      cells: cellsByKey,
      cellsByCell,
      values,
    };
  }

  async getDebugSnapshot(daysBack = 7) {
    if (!this.spreadsheetId) throw new Error('GOOGLE_SHEETS_ID not configured');
    const sheets = this._getService();

    const testedSheets = [];
    const candidates = this._candidateSheetNames(daysBack);
    let selected = null;

    for (const candidate of candidates) {
      const probe = await this._probeSheetExists(sheets, candidate);
      testedSheets.push({ sheet: candidate, exists: probe.exists, error: probe.error });
      if (probe.exists) {
        selected = candidate;
        break;
      }
    }

    if (!selected) {
      return {
        ok: false,
        spreadsheetId: this.spreadsheetId,
        testedSheets,
        message: 'No candidate date sheet was found or accessible',
      };
    }

    const wallet = await this._readWalletCells(sheets, selected);
    return {
      ok: true,
      spreadsheetId: this.spreadsheetId,
      sheetUsed: selected,
      testedSheets,
      mapping: wallet.mapping,
      cells: wallet.cells,
      cellsByCell: wallet.cellsByCell,
      mapped: wallet.values,
    };
  }

  async getBalance() {
    if (!this.spreadsheetId) throw new Error('GOOGLE_SHEETS_ID not configured');
    const sheets = this._getService();

    let sheetName = null;
    const tested = [];
    for (const candidate of this._candidateSheetNames(7)) {
      const probe = await this._probeSheetExists(sheets, candidate);
      tested.push(`${candidate}: ${probe.exists ? 'ok' : probe.error}`);
      if (probe.exists) {
        sheetName = candidate;
        break;
      }
    }

    if (!sheetName) {
      throw new Error(`No accessible Google Sheets date tab found. Tried: ${tested.join(' | ')}`);
    }

    const wallet = await this._readWalletCells(sheets, sheetName);
    const knownKeys = new Set([
      'match2pay',
      'deusXpay',
      'openPayed',
      'goldSouq',
      'fabAed',
      'fabUsd',
      'fabTotal',
      'mbme',
      'bankReceivable',
      'cryptoReceivable',
      'toBeDepositedIntoLPsK20',
      'toBeDepositedIntoLPsK21',
      'netAllCurrentBalance',
      'netBalanceAfterExpectedFunds',
      'differenceBetweenActualAndExpected',
    ]);

    const customValues = {};
    for (const [key, value] of Object.entries(wallet.values)) {
      if (!knownKeys.has(key)) customValues[key] = value;
    }

    return {
      sheetUsed: sheetName,
      match2pay: wallet.values.match2pay ?? 0,
      deusXpay: wallet.values.deusXpay ?? 0,
      openPayed: wallet.values.openPayed ?? 0,
      goldSouq: wallet.values.goldSouq ?? 0,
      fabAed: wallet.values.fabAed ?? 0,
      fabUsd: wallet.values.fabUsd ?? 0,
      fabTotal: wallet.values.fabTotal ?? 0,
      mbme: wallet.values.mbme ?? 0,
      bankReceivable: wallet.values.bankReceivable ?? 0,
      cryptoReceivable: wallet.values.cryptoReceivable ?? 0,
      toBeDepositedIntoLPsK20: wallet.values.toBeDepositedIntoLPsK20 ?? 0,
      toBeDepositedIntoLPsK21: wallet.values.toBeDepositedIntoLPsK21 ?? 0,
      netAllCurrentBalance: wallet.values.netAllCurrentBalance ?? 0,
      netBalanceAfterExpectedFunds: wallet.values.netBalanceAfterExpectedFunds ?? 0,
      differenceBetweenActualAndExpected: wallet.values.differenceBetweenActualAndExpected ?? 0,
      customValues,
    };
  }
}
