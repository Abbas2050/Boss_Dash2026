/**
 * USD spot rates for the crypto holdings the PSP APIs will not price.
 *
 * Why this file exists at all: LetKnow Pay's merchant screen shows a converted
 * total (~$191.24) that its API cannot reproduce. get_balances returns bare
 * amounts and no rate, and every read-only conversion method we could think of
 * -- get_rates, get_exchange_rates, get_balance_report, get_balances_report,
 * get_total_balance, get_balances_usd -- answers 404, while get_balances
 * itself ignores a `convert_to` parameter. Their API cannot value the holding,
 * so we price it ourselves rather than keep reporting a treasury figure that
 * is visibly short of the provider's own screen.
 *
 * WHAT THIS CANNOT DO, stated plainly so nobody chases it later: even with ETH
 * priced from Binance, our LetKnow Pay total will still differ from LetKnow's
 * by a few cents. They also mark the dollar-pegged coins to market -- their
 * screen values 53.498525 USDC at $53.44, not $53.50 -- whereas our allowlist
 * treats USD/USDT/USDC/PAX/TUSD as exactly 1:1 by construction. That 1:1 rule
 * is deliberate and is not changing here: it is the part of the figure we can
 * defend without a third-party rate. Exact parity with their screen needs
 * THEIR rates, and their API does not expose them. So the goal of this module
 * is "no whole holding is missing from the total", not "matches to the cent".
 *
 * Source: Binance's public ticker. No key, no auth, generous rate limits, and
 * a flat one-symbol-one-price response with nothing to negotiate.
 */

// Binance quotes crypto against USDT, not against USD -- there is no ETHUSD
// pair. USDT trades within a fraction of a cent of a dollar, which is well
// inside the precision this figure needs (we are recovering ~$6.84 of ETH),
// and it is the same peg the dollar allowlist already relies on.
const BINANCE_TICKER_URL = 'https://api.binance.com/api/v3/ticker/price';

// Held at MODULE level, not on any instance or caller. This is the same
// mistake-and-fix the TRON client documents: walletMonitor builds fresh
// clients on every poll, so a cache owned by an instance is empty every time
// and every poll hits the upstream API live. That is how Tronscan started
// answering HTTP 429 and both OwnBit rows read $0.00. A public price feed
// polled once per widget refresh would earn the same treatment, so the cache
// belongs where repeated polls can actually find it.
const RATE_CACHE = new Map();
const RATE_CACHE_TTL = 60 * 1000;

// Short on purpose. This lookup is an enrichment hanging off the balance
// report: if Binance is slow, the right outcome is the report we would have
// produced anyway, on time, with the holding still listed as unvalued -- not
// a balance page that stalls behind a price feed.
const RATE_TIMEOUT_MS = 4000;

/**
 * Test seam. The cache is module-level and deliberately survives callers, so a
 * test that wants a real fetch has to be able to empty it.
 */
export function resetUsdRateCache() {
  RATE_CACHE.clear();
}

// Binance answers HTTP 400 with code -1121 for a symbol it does not list. That
// is an ANSWER -- "no such market" -- and it stays true for the life of the
// cache window, so it is worth remembering: otherwise every poll re-asks about
// the same unlisted ticker forever. A 429, a 5xx, a timeout or a socket error
// is NOT an answer, and caching those as "unlisted" would turn a few seconds
// of upstream trouble into a minute of a holding being silently dropped.
async function fetchOneRate(code) {
  const url = `${BINANCE_TICKER_URL}?symbol=${encodeURIComponent(`${code}USDT`)}`;
  const res = await fetch(url, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(RATE_TIMEOUT_MS),
  });

  if (res.status === 400) return { code, rate: null, cacheable: true };
  if (!res.ok) return { code, rate: null, cacheable: false };

  const data = await res.json();
  const rate = typeof data?.price === 'number' ? data.price : parseFloat(data?.price);

  // A price that will not parse, or a zero/negative one, is not a rate. Say
  // "no rate" rather than let a 0 multiply a real holding down to nothing.
  if (!Number.isFinite(rate) || rate <= 0) return { code, rate: null, cacheable: false };

  return { code, rate, cacheable: true };
}

/**
 * USD rates for the given currency codes.
 *
 *   getUsdRates(['ETH', 'BTC']) -> { ETH: 2367.12, BTC: 64210.5 }
 *
 * A code Binance does not list is simply ABSENT from the returned object. Not
 * an error, not a zero -- absence is what the caller checks, and it is the
 * same shape a per-code failure produces, so the caller only has to handle one
 * case: "no rate for this holding, leave it unvalued".
 *
 * Every code is fetched independently and every failure is contained. One
 * ticker timing out must not cost the others their price, and must not throw:
 * the caller is building a treasury figure and a partial answer beats an
 * exception that loses the whole thing.
 */
export async function getUsdRates(codes) {
  const wanted = [
    ...new Set(
      (codes ?? [])
        .filter((code) => typeof code === 'string' && code.trim() !== '')
        .map((code) => code.trim().toUpperCase()),
    ),
  ];
  if (wanted.length === 0) return {};

  const rates = {};
  const now = Date.now();
  const toFetch = [];

  for (const code of wanted) {
    const cached = RATE_CACHE.get(code);
    if (cached && now < cached.expiry) {
      // A cached null means "Binance does not list this", which is as much of
      // an answer as a price is -- it just leaves the code out of the result.
      if (cached.rate !== null) rates[code] = cached.rate;
    } else {
      toFetch.push(code);
    }
  }

  if (toFetch.length === 0) return rates;

  const fetched = await Promise.all(
    toFetch.map(async (code) => {
      try {
        return await fetchOneRate(code);
      } catch {
        // Timeout, DNS, socket, unparseable body. Not an answer, so nothing
        // gets cached and this code just has no rate this cycle.
        return { code, rate: null, cacheable: false };
      }
    }),
  );

  for (const { code, rate, cacheable } of fetched) {
    if (cacheable) RATE_CACHE.set(code, { rate, expiry: Date.now() + RATE_CACHE_TTL });
    if (rate !== null) rates[code] = rate;
  }

  return rates;
}
