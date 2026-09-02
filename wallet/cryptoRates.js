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
 * priced from a live feed, our LetKnow Pay total will still differ from
 * LetKnow's by a few cents. They also mark the dollar-pegged coins to market --
 * their screen values 53.498525 USDC at $53.44, not $53.50 -- whereas our
 * allowlist treats USD/USDT/USDC/PAX/TUSD as exactly 1:1 by construction. That
 * 1:1 rule is deliberate and is not changing here: it is the part of the figure
 * we can defend without a third-party rate. Exact parity with their screen
 * needs THEIR rates, and their API does not expose them. So the goal of this
 * module is "no whole holding is missing from the total", not "matches to the
 * cent".
 *
 * Sources: an ORDERED LIST of public tickers, tried one after another until
 * one of them answers with a price. It is a list rather than a primary with a
 * hardcoded `else` because we have already been burned once by having exactly
 * one: Binance answers HTTP 451 Unavailable For Legal Reasons to IPs in
 * restricted regions, this app is hosted in the US, and the result was a
 * treasury row silently $6.84 short with nothing anywhere saying why. The day
 * Coinbase is blocked or rate-limited too, the fix has to be one more entry in
 * RATE_SOURCES, not another branch in the control flow.
 */

// Binance quotes crypto against USDT, not against USD -- there is no ETHUSD
// pair. USDT trades within a fraction of a cent of a dollar, which is well
// inside the precision this figure needs (we are recovering ~$6.84 of ETH),
// and it is the same peg the dollar allowlist already relies on.
const BINANCE_TICKER_URL = 'https://api.binance.com/api/v3/ticker/price';

// Coinbase quotes true USD -- ETH-USD, not ETH-USDT -- so a rate from here and
// a rate from Binance are not quite the same number. That difference is the
// USDT peg itself, a fraction of a cent on the dollar, and the paragraph above
// already accepts exactly that much error by construction: we are recovering a
// ~$6.84 holding into a figure that admits to being cents away from LetKnow's
// own screen anyway. So the two sources are interchangeable HERE, in this
// module's tolerance, and nowhere else. Nothing in this file may start
// pretending a rate is exact because it came from the USD-quoted source.
const COINBASE_SPOT_URL = 'https://api.coinbase.com/v2/prices';

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
// report: if a source is slow, the right outcome is the report we would have
// produced anyway, on time, with the holding still listed as unvalued -- not
// a balance page that stalls behind a price feed.
const RATE_TIMEOUT_MS = 4000;

// The ceiling on ONE code's whole trip through the source list, not on one
// request. Each source still gets its own RATE_TIMEOUT_MS, but a source may
// only start if there is budget left, and it is cut short to whatever remains.
// Set at double the single-source timeout because that is the honest cost of
// having a fallback at all: a hung primary has to burn its full timeout before
// the secondary can be asked. What this buys is that adding a third and fourth
// source later cannot turn a slow afternoon into a balance page that hangs for
// twenty seconds -- the budget, not the length of the list, sets the worst case.
const RATE_LOOKUP_BUDGET_MS = 2 * RATE_TIMEOUT_MS;

// The sources, in the order they are asked. Each one owns the three things
// that actually differ between price feeds -- how to address a code, which
// HTTP status means "no such market", and where the number sits in the body --
// and nothing else. Everything downstream treats them identically, which is
// the point: a new entry here is a new source, not a new code path.
//
// `unlistedStatus` is the load-bearing one. A status on this list is an ANSWER
// ("we do not trade this"), and an answer is cacheable. Every other failure --
// 429, 451, 5xx, a timeout, a socket error -- is the source declining to
// answer, and caching that would turn a few seconds of trouble into a minute
// of a holding silently dropping out of a treasury total.
const RATE_SOURCES = [
  {
    name: 'binance',
    // Binance answers HTTP 400 with code -1121 for a symbol it does not list.
    unlistedStatus: [400],
    url: (code) => `${BINANCE_TICKER_URL}?symbol=${encodeURIComponent(`${code}USDT`)}`,
    extractPrice: (data) => data?.price,
  },
  {
    name: 'coinbase',
    // Coinbase answers 404 with an errors array for a product it does not
    // list, which is the same "no such market" statement Binance's 400 is.
    unlistedStatus: [404],
    url: (code) => `${COINBASE_SPOT_URL}/${encodeURIComponent(`${code}-USD`)}/spot`,
    // Coinbase sends the price as a STRING ("2358.31") nested under `data`.
    // parseFloat happens in one place below, for every source, so a string
    // amount cannot reach applyUsdRates() and multiply a holding by NaN.
    extractPrice: (data) => data?.data?.amount,
  },
];

/**
 * Test seam. The cache is module-level and deliberately survives callers, so a
 * test that wants a real fetch has to be able to empty it.
 */
export function resetUsdRateCache() {
  RATE_CACHE.clear();
}

// One request to one source. Returns what happened rather than throwing for a
// bad status, because "what happened" is the thing both the caller and the
// diagnostic need: `definitive` says whether the source actually answered the
// question, which is what decides whether the answer may be cached and whether
// the next source is worth asking.
async function fetchFromSource(source, code, timeoutMs) {
  const res = await fetch(source.url(code), {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (source.unlistedStatus.includes(res.status)) {
    return { rate: null, definitive: true, status: res.status, error: null };
  }

  // 451, 429, 5xx, an HTML captcha page. The source is not saying this coin
  // has no market; it is saying it will not talk to us right now.
  if (!res.ok) return { rate: null, definitive: false, status: res.status, error: null };

  const data = await res.json();
  const raw = source.extractPrice(data);
  const rate = typeof raw === 'number' ? raw : parseFloat(raw);

  // A price that will not parse, or a zero/negative one, is not a rate. Say
  // "no rate" rather than let a 0 multiply a real holding down to nothing.
  if (!Number.isFinite(rate) || rate <= 0) {
    return { rate: null, definitive: false, status: res.status, error: 'unusable price in response body' };
  }

  return { rate, definitive: true, status: res.status, error: null };
}

// Walks the source list for one code and reports the whole trip: the rate if
// any source produced one, which source that was, and an attempt record for
// every source asked. The attempts are not debug garnish -- until they existed,
// a code that went unpriced looked exactly the same whether Binance had never
// heard of it or had refused our IP with a 451, and that ambiguity is what let
// this bug sit in a treasury figure.
async function lookupRate(code) {
  const startedAt = Date.now();
  const attempts = [];

  // Only a source that actually ANSWERED lets us remember the outcome. If any
  // source in the chain merely declined, "no rate" is this minute's accident
  // rather than a fact about the coin, and must be re-asked next cycle.
  let everySourceAnswered = true;

  for (const source of RATE_SOURCES) {
    const remaining = RATE_LOOKUP_BUDGET_MS - (Date.now() - startedAt);
    if (remaining <= 0) {
      attempts.push({ source: source.name, status: null, error: 'not attempted: lookup budget exhausted' });
      everySourceAnswered = false;
      break;
    }

    const timeoutMs = Math.min(RATE_TIMEOUT_MS, remaining);
    try {
      const outcome = await fetchFromSource(source, code, timeoutMs);
      attempts.push({ source: source.name, status: outcome.status, error: outcome.error });
      if (outcome.rate !== null) {
        return { code, rate: outcome.rate, cacheable: true, source: source.name, attempts };
      }
      if (!outcome.definitive) everySourceAnswered = false;
    } catch (error) {
      // Timeout, DNS, socket, unparseable body. Not an answer, so the next
      // source is still worth asking and nothing here gets cached.
      const message =
        error?.name === 'TimeoutError'
          ? `request aborted after ${timeoutMs}ms`
          : error?.message || String(error);
      attempts.push({ source: source.name, status: null, error: message });
      everySourceAnswered = false;
    }
  }

  return { code, rate: null, cacheable: everySourceAnswered, source: null, attempts };
}

// Renders one code's attempts as a single log line: "binance HTTP 451,
// coinbase timeout after 4000ms". Short enough to sit in the iisnode stdout
// log next to everything else, which is the only place anyone will look when
// the row reads short again.
function summariseAttempts(attempts) {
  return attempts
    .map(({ source, status, error }) => {
      if (status !== null && !error) return `${source} HTTP ${status}`;
      if (status !== null) return `${source} HTTP ${status} (${error})`;
      return `${source} ${error}`;
    })
    .join(', ');
}

/**
 * USD rates for the given currency codes.
 *
 *   getUsdRates(['ETH', 'BTC']) -> { ETH: 2367.12, BTC: 64210.5 }
 *
 * A code no source will price is simply ABSENT from the returned object. Not
 * an error, not a zero -- absence is what the caller checks, and it is the
 * same shape a per-code failure produces, so the caller only has to handle one
 * case: "no rate for this holding, leave it unvalued".
 *
 * Every code is looked up independently and every failure is contained. One
 * ticker timing out must not cost the others their price, and must not throw:
 * the caller is building a treasury figure and a partial answer beats an
 * exception that loses the whole thing.
 */
export async function getUsdRates(codes) {
  const wanted = normaliseCodes(codes);
  if (wanted.length === 0) return {};

  const rates = {};
  const now = Date.now();
  const toFetch = [];

  for (const code of wanted) {
    const cached = RATE_CACHE.get(code);
    if (cached && now < cached.expiry) {
      // A cached null means "every source says it does not trade this", which
      // is as much of an answer as a price is -- it just leaves the code out
      // of the result.
      if (cached.rate !== null) rates[code] = cached.rate;
    } else {
      toFetch.push(code);
    }
  }

  if (toFetch.length === 0) return rates;

  const fetched = await Promise.all(
    toFetch.map(async (code) => {
      try {
        return await lookupRate(code);
      } catch (error) {
        // lookupRate already contains per-source failures; this is the guard
        // for anything it did not predict, and it degrades the same way.
        return {
          code,
          rate: null,
          cacheable: false,
          source: null,
          attempts: [{ source: null, status: null, error: error?.message || String(error) }],
        };
      }
    }),
  );

  for (const { code, rate, cacheable, attempts } of fetched) {
    if (cacheable) RATE_CACHE.set(code, { rate, expiry: Date.now() + RATE_CACHE_TTL });
    if (rate !== null) {
      rates[code] = rate;
    } else {
      // The line that was missing. A holding drops out of the treasury total
      // here and nowhere else, so this is the one place that can say why.
      console.warn(`[cryptoRates] no USD rate for ${code}: ${summariseAttempts(attempts)}`);
    }
  }

  return rates;
}

function normaliseCodes(codes) {
  return [
    ...new Set(
      (codes ?? [])
        .filter((code) => typeof code === 'string' && code.trim() !== '')
        .map((code) => code.trim().toUpperCase()),
    ),
  ];
}

/**
 * The same lookup, reported instead of applied: per code, every source that
 * was asked, the HTTP status or error text it gave back, and which source (if
 * any) ultimately supplied the rate. Feeds the rateSources section of
 * /api/wallet/psp-debug.
 *
 * Deliberately reads and writes NOTHING in the cache. The question this
 * answers is "what does this server's network position get from these feeds
 * right now" -- a cached answer from a minute ago is exactly the wrong reply,
 * and a diagnostic that seeded the cache could change the very production
 * behaviour it was called to observe.
 *
 * Contains its own failures for the same reason getUsdRates() does: this runs
 * inside an admin route that also reports two live PSP balances, and a price
 * feed blowing up must not cost that route its other sections.
 */
export async function probeUsdRateSources(codes) {
  const wanted = normaliseCodes(codes);

  const results = await Promise.all(
    wanted.map(async (code) => {
      try {
        const { rate, source, attempts } = await lookupRate(code);
        return { code, rate, pricedBy: source, attempts };
      } catch (error) {
        return {
          code,
          rate: null,
          pricedBy: null,
          attempts: [{ source: null, status: null, error: error?.message || String(error) }],
        };
      }
    }),
  );

  return {
    checkedAt: new Date().toISOString(),
    sourceOrder: RATE_SOURCES.map((source) => source.name),
    perSourceTimeoutMs: RATE_TIMEOUT_MS,
    lookupBudgetMs: RATE_LOOKUP_BUDGET_MS,
    codes: results,
  };
}
