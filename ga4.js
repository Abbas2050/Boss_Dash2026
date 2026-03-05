// Google Analytics 4 API integration for Marketing insights
import { BetaAnalyticsDataClient } from "@google-analytics/data";

const DEBUG_GA4 = process.env.DEBUG_GA4 === "1";

function debug(...args) {
  if (DEBUG_GA4) console.log("[GA4]", ...args);
}

function createClientAndPropertyId() {
  const propertyId = process.env.GA4_PROPERTY_ID || "476328175";
  if (!propertyId) {
    throw new Error("GA4_PROPERTY_ID is not configured");
  }

  const explicitKeyFile = process.env.GA4_KEY_FILE || process.env.GOOGLE_APPLICATION_CREDENTIALS;
  const inlineCredentialsRaw = process.env.GA4_SERVICE_ACCOUNT_JSON || "";
  let inlineCredentials = null;
  if (inlineCredentialsRaw) {
    try {
      inlineCredentials = JSON.parse(inlineCredentialsRaw);
    } catch {
      throw new Error("GA4_SERVICE_ACCOUNT_JSON is not valid JSON");
    }
  }

  if (inlineCredentials) {
    debug("Using inline GA4 service-account JSON from env");
    return {
      propertyId,
      client: new BetaAnalyticsDataClient({ credentials: inlineCredentials }),
    };
  }

  if (explicitKeyFile) {
    debug("Using key file:", explicitKeyFile);
    return {
      propertyId,
      client: new BetaAnalyticsDataClient({ keyFilename: explicitKeyFile }),
    };
  }

  // Fallback to ADC (Application Default Credentials).
  debug("Using application default credentials");
  return {
    propertyId,
    client: new BetaAnalyticsDataClient(),
  };
}

function mapRows(rows, mapper) {
  return Array.isArray(rows) ? rows.map(mapper) : [];
}

function emptyInsights(propertyId, startDate, endDate, warning) {
  return {
    meta: {
      source: "google-analytics-4",
      propertyId,
      startDate,
      endDate,
      generatedAt: new Date().toISOString(),
      warning,
    },
    main: {
      sessions: 0,
      activeUsers: 0,
      newUsers: 0,
      returningUsers: 0,
      conversions: 0,
      bounceRate: 0,
      engagementDuration: 0,
    },
    topCountries: [],
    campaigns: [],
    activeUsersByCountry: [],
    activeUsersBySource: [],
    userTrend: [],
    campaignTrend: [],
  };
}

export async function getMarketingInsights(startDate, endDate, _entity) {
  const fallbackPropertyId = process.env.GA4_PROPERTY_ID || "476328175";
  let propertyId = fallbackPropertyId;
  let client;
  try {
    const created = createClientAndPropertyId();
    propertyId = created.propertyId;
    client = created.client;
  } catch (err) {
    const warning = err?.message || "Failed to initialize GA4 client";
    debug("client init error:", warning);
    return emptyInsights(propertyId, startDate, endDate, warning);
  }

  const property = `properties/${propertyId}`;

  let main = { rows: [] };
  try {
    const [resp] = await client.runReport({
      property,
      dateRanges: [{ startDate, endDate }],
      metrics: [
        { name: "sessions" },
        { name: "activeUsers" },
        { name: "newUsers" },
        { name: "conversions" },
        { name: "bounceRate" },
        { name: "userEngagementDuration" },
      ],
    });
    main = resp || main;
  } catch (err) {
    const warning = err?.message || "Failed to fetch GA4 main report";
    debug("main report error:", warning);
    return emptyInsights(propertyId, startDate, endDate, warning);
  }

  let countries = { rows: [] };
  try {
    const [resp] = await client.runReport({
      property,
      dateRanges: [{ startDate, endDate }],
      dimensions: [{ name: "country" }],
      metrics: [{ name: "sessions" }],
      orderBys: [{ metric: { metricName: "sessions" }, desc: true }],
      limit: 5,
    });
    countries = resp || countries;
  } catch (err) {
    debug("countries report error:", err?.message || err);
  }

  let campaigns = { rows: [] };
  try {
    const [resp] = await client.runReport({
      property,
      dateRanges: [{ startDate, endDate }],
      dimensions: [
        { name: "sessionSource" },
        { name: "sessionMedium" },
        { name: "campaignName" },
      ],
      metrics: [{ name: "sessions" }, { name: "conversions" }],
      limit: 50,
    });
    campaigns = resp || campaigns;
  } catch (err) {
    debug("campaigns report error:", err?.message || err);
  }

  let activeUsersByCountry = { rows: [] };
  try {
    const [resp] = await client.runReport({
      property,
      dateRanges: [{ startDate, endDate }],
      dimensions: [{ name: "country" }],
      metrics: [{ name: "activeUsers" }],
      orderBys: [{ metric: { metricName: "activeUsers" }, desc: true }],
      limit: 10,
    });
    activeUsersByCountry = resp || activeUsersByCountry;
  } catch (err) {
    debug("activeUsersByCountry report error:", err?.message || err);
  }

  let activeUsersBySource = { rows: [] };
  try {
    const [resp] = await client.runReport({
      property,
      dateRanges: [{ startDate, endDate }],
      dimensions: [{ name: "firstUserSource" }, { name: "firstUserMedium" }],
      metrics: [{ name: "activeUsers" }],
      orderBys: [{ metric: { metricName: "activeUsers" }, desc: true }],
      limit: 20,
    });
    activeUsersBySource = resp || activeUsersBySource;
  } catch (err) {
    debug("activeUsersBySource report error:", err?.message || err);
  }

  let userTrend = { rows: [] };
  try {
    const [resp] = await client.runReport({
      property,
      dateRanges: [{ startDate, endDate }],
      dimensions: [{ name: "date" }],
      metrics: [{ name: "activeUsers" }, { name: "newUsers" }],
      orderBys: [{ dimension: { dimensionName: "date" } }],
      limit: 90,
    });
    userTrend = resp || userTrend;
  } catch (err) {
    debug("userTrend report error:", err?.message || err);
  }

  let campaignTrend = { rows: [] };
  try {
    const [resp] = await client.runReport({
      property,
      dateRanges: [{ startDate, endDate }],
      dimensions: [{ name: "date" }],
      metrics: [{ name: "sessions" }, { name: "conversions" }],
      orderBys: [{ dimension: { dimensionName: "date" } }],
      limit: 90,
    });
    campaignTrend = resp || campaignTrend;
  } catch (err) {
    debug("campaignTrend report error:", err?.message || err);
  }

  return {
    meta: {
      source: "google-analytics-4",
      propertyId,
      startDate,
      endDate,
      generatedAt: new Date().toISOString(),
    },
    main: main?.rows?.[0]
      ? {
          sessions: Number(main.rows[0].metricValues?.[0]?.value || 0),
          activeUsers: Number(main.rows[0].metricValues?.[1]?.value || 0),
          newUsers: Number(main.rows[0].metricValues?.[2]?.value || 0),
          conversions: Number(main.rows[0].metricValues?.[3]?.value || 0),
          bounceRate: Number(main.rows[0].metricValues?.[4]?.value || 0),
          engagementDuration: Number(main.rows[0].metricValues?.[5]?.value || 0),
        }
      : {},
    topCountries: mapRows(countries.rows, (row) => ({
      country: row.dimensionValues?.[0]?.value,
      sessions: Number(row.metricValues?.[0]?.value || 0),
    })),
    campaigns: mapRows(campaigns.rows, (row) => ({
      source: row.dimensionValues?.[0]?.value,
      medium: row.dimensionValues?.[1]?.value,
      campaign: row.dimensionValues?.[2]?.value,
      sessions: Number(row.metricValues?.[0]?.value || 0),
      conversions: Number(row.metricValues?.[1]?.value || 0),
    })),
    activeUsersByCountry: mapRows(activeUsersByCountry.rows, (row) => ({
      country: row.dimensionValues?.[0]?.value,
      activeUsers: Number(row.metricValues?.[0]?.value || 0),
    })),
    activeUsersBySource: mapRows(activeUsersBySource.rows, (row) => ({
      source: row.dimensionValues?.[0]?.value,
      medium: row.dimensionValues?.[1]?.value,
      activeUsers: Number(row.metricValues?.[0]?.value || 0),
    })),
    userTrend: mapRows(userTrend.rows, (row) => {
      const rawDate = String(row.dimensionValues?.[0]?.value || "");
      // GA4 date format: YYYYMMDD
      const mm = rawDate.slice(4, 6);
      const dd = rawDate.slice(6, 8);
      const label = rawDate.length === 8 ? `${dd}/${mm}` : rawDate;
      const activeUsers = Number(row.metricValues?.[0]?.value || 0);
      const newUsers = Number(row.metricValues?.[1]?.value || 0);
      const returningUsers = Math.max(0, activeUsers - newUsers); // inferred from GA4 metrics
      return { date: rawDate, label, activeUsers, newUsers, returningUsers };
    }),
    campaignTrend: mapRows(campaignTrend.rows, (row) => {
      const rawDate = String(row.dimensionValues?.[0]?.value || "");
      const mm = rawDate.slice(4, 6);
      const dd = rawDate.slice(6, 8);
      const label = rawDate.length === 8 ? `${dd}/${mm}` : rawDate;
      return {
        date: rawDate,
        label,
        sessions: Number(row.metricValues?.[0]?.value || 0),
        conversions: Number(row.metricValues?.[1]?.value || 0),
      };
    }),
  };
}

if (import.meta.url === process.argv[1] || import.meta.url === `file://${process.argv[1]}`) {
  getMarketingInsights("2024-01-01", "2024-12-31")
    .then((d) => console.log(JSON.stringify(d, null, 2)))
    .catch((e) => {
      console.error(e?.message || e);
      process.exit(1);
    });
}
