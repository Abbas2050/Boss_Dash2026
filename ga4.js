// Google Analytics 4 API integration for Marketing insights
import { BetaAnalyticsDataClient } from "@google-analytics/data";

const DEBUG_GA4 = process.env.DEBUG_GA4 === "1";
const INSIGHTS_CACHE = new Map();
const INSIGHTS_CACHE_TTL_MS = 120000;

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

  // Do not fallback to ADC in this app; require explicit env-based credentials.
  throw new Error(
    "GA4 credentials are not configured. Set GA4_SERVICE_ACCOUNT_JSON or GA4_KEY_FILE/GOOGLE_APPLICATION_CREDENTIALS.",
  );
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
    summary: {
      activeUsers: 0,
      activeUsersPrev: 0,
      activeUsersDeltaPct: 0,
      newUsers: 0,
      newUsersPrev: 0,
      newUsersDeltaPct: 0,
      newUserPct: 0,
      newUserPctPrev: 0,
      newUserPctDeltaPct: 0,
      pctEngaged: 0,
      pctEngagedPrev: 0,
      pctEngagedDeltaPct: 0,
      pageviewsPerUser: 0,
      pageviewsPerUserPrev: 0,
      pageviewsPerUserDeltaPct: 0,
      engagementTimeSec: 0,
      engagementTimeSecPrev: 0,
      engagementTimeSecDeltaPct: 0,
    },
    activeUsersTrend: [],
    monthlyUsersSessions: [],
    countryTrend: [],
    deviceCategory: [],
    osBreakdown: [],
    browserBreakdown: [],
    browserTrend: [],
    sessionSourceTable: [],
    sessionSourceTrend: [],
    topPages: [],
    topPagesTrend: [],
    topEvents: [],
    topEventsTrend: [],
  };
}

function toPercentDelta(curr, prev) {
  const c = Number(curr || 0);
  const p = Number(prev || 0);
  if (!Number.isFinite(c) || !Number.isFinite(p)) return 0;
  if (p === 0) return c === 0 ? 0 : 100;
  return ((c - p) / Math.abs(p)) * 100;
}

function getPreviousDateRange(startDate, endDate) {
  const s = new Date(`${startDate}T00:00:00Z`);
  const e = new Date(`${endDate}T00:00:00Z`);
  const days = Math.max(1, Math.round((e.getTime() - s.getTime()) / 86400000) + 1);
  const prevEnd = new Date(s);
  prevEnd.setUTCDate(prevEnd.getUTCDate() - 1);
  const prevStart = new Date(prevEnd);
  prevStart.setUTCDate(prevStart.getUTCDate() - (days - 1));
  const fmt = (d) => {
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, "0");
    const day = String(d.getUTCDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  };
  return { startDate: fmt(prevStart), endDate: fmt(prevEnd) };
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
  const cacheKey = `${propertyId}|${startDate}|${endDate}`;
  const cached = INSIGHTS_CACHE.get(cacheKey);
  if (cached && Date.now() - cached.ts < INSIGHTS_CACHE_TTL_MS) {
    return cached.data;
  }

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
        { name: "engagementRate" },
        { name: "userEngagementDuration" },
        { name: "screenPageViews" },
      ],
    });
    main = resp || main;
  } catch (err) {
    const warning = err?.message || "Failed to fetch GA4 main report";
    debug("main report error:", warning);
    return emptyInsights(propertyId, startDate, endDate, warning);
  }

  const prevRange = getPreviousDateRange(startDate, endDate);
  let previousMain = { rows: [] };
  try {
    const [resp] = await client.runReport({
      property,
      dateRanges: [{ startDate: prevRange.startDate, endDate: prevRange.endDate }],
      metrics: [
        { name: "sessions" },
        { name: "activeUsers" },
        { name: "newUsers" },
        { name: "conversions" },
        { name: "engagementRate" },
        { name: "userEngagementDuration" },
        { name: "screenPageViews" },
      ],
    });
    previousMain = resp || previousMain;
  } catch (err) {
    debug("previous main report error:", err?.message || err);
  }

  let countries = { rows: [] };
  try {
    const [resp] = await client.runReport({
      property,
      dateRanges: [{ startDate, endDate }],
      dimensions: [{ name: "country" }],
      metrics: [{ name: "activeUsers" }],
      orderBys: [{ metric: { metricName: "activeUsers" }, desc: true }],
      limit: 21,
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

  let activeUsersTrend = { rows: [] };
  try {
    const [resp] = await client.runReport({
      property,
      dateRanges: [{ startDate, endDate }, { startDate: prevRange.startDate, endDate: prevRange.endDate }],
      dimensions: [{ name: "date" }],
      metrics: [{ name: "activeUsers" }],
      orderBys: [{ dimension: { dimensionName: "date" } }],
      limit: 120,
    });
    activeUsersTrend = resp || activeUsersTrend;
  } catch (err) {
    debug("activeUsersTrend report error:", err?.message || err);
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

  let monthlyUsersSessions = { rows: [] };
  try {
    const [resp] = await client.runReport({
      property,
      dateRanges: [{ startDate, endDate }],
      dimensions: [{ name: "month" }],
      metrics: [{ name: "activeUsers" }, { name: "sessions" }],
      orderBys: [{ dimension: { dimensionName: "month" } }],
      limit: 24,
    });
    monthlyUsersSessions = resp || monthlyUsersSessions;
  } catch (err) {
    debug("monthlyUsersSessions report error:", err?.message || err);
  }

  let countryTrend = { rows: [] };
  try {
    const [resp] = await client.runReport({
      property,
      dateRanges: [{ startDate, endDate }],
      dimensions: [{ name: "date" }, { name: "country" }],
      metrics: [{ name: "activeUsers" }],
      orderBys: [{ dimension: { dimensionName: "date" } }],
      limit: 1000,
    });
    countryTrend = resp || countryTrend;
  } catch (err) {
    debug("countryTrend report error:", err?.message || err);
  }

  let deviceCategory = { rows: [] };
  try {
    const [resp] = await client.runReport({
      property,
      dateRanges: [{ startDate, endDate }],
      dimensions: [{ name: "deviceCategory" }],
      metrics: [{ name: "activeUsers" }],
      orderBys: [{ metric: { metricName: "activeUsers" }, desc: true }],
      limit: 10,
    });
    deviceCategory = resp || deviceCategory;
  } catch (err) {
    debug("deviceCategory report error:", err?.message || err);
  }

  let osBreakdown = { rows: [] };
  try {
    const [resp] = await client.runReport({
      property,
      dateRanges: [{ startDate, endDate }],
      dimensions: [{ name: "operatingSystem" }],
      metrics: [{ name: "activeUsers" }],
      orderBys: [{ metric: { metricName: "activeUsers" }, desc: true }],
      limit: 12,
    });
    osBreakdown = resp || osBreakdown;
  } catch (err) {
    debug("osBreakdown report error:", err?.message || err);
  }

  let browserBreakdown = { rows: [] };
  try {
    const [resp] = await client.runReport({
      property,
      dateRanges: [{ startDate, endDate }],
      dimensions: [{ name: "browser" }],
      metrics: [{ name: "activeUsers" }],
      orderBys: [{ metric: { metricName: "activeUsers" }, desc: true }],
      limit: 12,
    });
    browserBreakdown = resp || browserBreakdown;
  } catch (err) {
    debug("browserBreakdown report error:", err?.message || err);
  }

  let browserTrend = { rows: [] };
  try {
    const [resp] = await client.runReport({
      property,
      dateRanges: [{ startDate, endDate }],
      dimensions: [{ name: "date" }, { name: "browser" }],
      metrics: [{ name: "activeUsers" }],
      orderBys: [{ dimension: { dimensionName: "date" } }],
      limit: 1200,
    });
    browserTrend = resp || browserTrend;
  } catch (err) {
    debug("browserTrend report error:", err?.message || err);
  }

  let sessionSourceTable = { rows: [] };
  try {
    const [resp] = await client.runReport({
      property,
      dateRanges: [{ startDate, endDate }],
      dimensions: [{ name: "sessionSource" }, { name: "sessionMedium" }],
      metrics: [{ name: "sessions" }],
      orderBys: [{ metric: { metricName: "sessions" }, desc: true }],
      limit: 25,
    });
    sessionSourceTable = resp || sessionSourceTable;
  } catch (err) {
    debug("sessionSourceTable report error:", err?.message || err);
  }

  let sessionSourceTrend = { rows: [] };
  try {
    const [resp] = await client.runReport({
      property,
      dateRanges: [{ startDate, endDate }],
      dimensions: [{ name: "date" }, { name: "sessionSource" }],
      metrics: [{ name: "sessions" }],
      orderBys: [{ dimension: { dimensionName: "date" } }],
      limit: 1200,
    });
    sessionSourceTrend = resp || sessionSourceTrend;
  } catch (err) {
    debug("sessionSourceTrend report error:", err?.message || err);
  }

  let topPages = { rows: [] };
  try {
    const [resp] = await client.runReport({
      property,
      dateRanges: [{ startDate, endDate }],
      dimensions: [{ name: "pagePath" }],
      metrics: [{ name: "screenPageViews" }, { name: "activeUsers" }],
      orderBys: [{ metric: { metricName: "screenPageViews" }, desc: true }],
      limit: 25,
    });
    topPages = resp || topPages;
  } catch (err) {
    debug("topPages report error:", err?.message || err);
  }

  let topPagesTrend = { rows: [] };
  try {
    const [resp] = await client.runReport({
      property,
      dateRanges: [{ startDate, endDate }],
      dimensions: [{ name: "date" }, { name: "pagePath" }],
      metrics: [{ name: "screenPageViews" }],
      orderBys: [{ dimension: { dimensionName: "date" } }],
      limit: 1600,
    });
    topPagesTrend = resp || topPagesTrend;
  } catch (err) {
    debug("topPagesTrend report error:", err?.message || err);
  }

  let topEvents = { rows: [] };
  try {
    const [resp] = await client.runReport({
      property,
      dateRanges: [{ startDate, endDate }],
      dimensions: [{ name: "eventName" }],
      metrics: [{ name: "eventCount" }, { name: "activeUsers" }],
      orderBys: [{ metric: { metricName: "eventCount" }, desc: true }],
      limit: 25,
    });
    topEvents = resp || topEvents;
  } catch (err) {
    debug("topEvents report error:", err?.message || err);
  }

  let topEventsTrend = { rows: [] };
  try {
    const [resp] = await client.runReport({
      property,
      dateRanges: [{ startDate, endDate }],
      dimensions: [{ name: "date" }, { name: "eventName" }],
      metrics: [{ name: "eventCount" }],
      orderBys: [{ dimension: { dimensionName: "date" } }],
      limit: 1600,
    });
    topEventsTrend = resp || topEventsTrend;
  } catch (err) {
    debug("topEventsTrend report error:", err?.message || err);
  }

  const toLabel = (rawDate) => {
    const val = String(rawDate || "");
    const mm = val.slice(4, 6);
    const dd = val.slice(6, 8);
    return val.length === 8 ? `${dd}/${mm}` : val;
  };

  const toMonthLabel = (monthVal) => {
    const val = String(monthVal || "").padStart(2, "0");
    const map = {
      "01": "Jan",
      "02": "Feb",
      "03": "Mar",
      "04": "Apr",
      "05": "May",
      "06": "Jun",
      "07": "Jul",
      "08": "Aug",
      "09": "Sep",
      "10": "Oct",
      "11": "Nov",
      "12": "Dec",
    };
    return map[val] || val;
  };

  const mainRow = main?.rows?.[0];
  const prevMainRow = previousMain?.rows?.[0];

  const currSessions = Number(mainRow?.metricValues?.[0]?.value || 0);
  const currActiveUsers = Number(mainRow?.metricValues?.[1]?.value || 0);
  const currNewUsers = Number(mainRow?.metricValues?.[2]?.value || 0);
  const currConversions = Number(mainRow?.metricValues?.[3]?.value || 0);
  const currEngagementRateRaw = Number(mainRow?.metricValues?.[4]?.value || 0);
  const currEngagementTimeSec = Number(mainRow?.metricValues?.[5]?.value || 0);
  const currPageViews = Number(mainRow?.metricValues?.[6]?.value || 0);

  const prevActiveUsers = Number(prevMainRow?.metricValues?.[1]?.value || 0);
  const prevNewUsers = Number(prevMainRow?.metricValues?.[2]?.value || 0);
  const prevEngagementRateRaw = Number(prevMainRow?.metricValues?.[4]?.value || 0);
  const prevEngagementTimeSec = Number(prevMainRow?.metricValues?.[5]?.value || 0);
  const prevPageViews = Number(prevMainRow?.metricValues?.[6]?.value || 0);

  const currNewUserPct = currActiveUsers > 0 ? (currNewUsers / currActiveUsers) * 100 : 0;
  const prevNewUserPct = prevActiveUsers > 0 ? (prevNewUsers / prevActiveUsers) * 100 : 0;
  const currPctEngaged = currEngagementRateRaw * 100;
  const prevPctEngaged = prevEngagementRateRaw * 100;
  const currPageviewsPerUser = currActiveUsers > 0 ? currPageViews / currActiveUsers : 0;
  const prevPageviewsPerUser = prevActiveUsers > 0 ? prevPageViews / prevActiveUsers : 0;

  const activeUsersTrendRows = mapRows(activeUsersTrend.rows, (row) => {
    const rawDate = String(row.dimensionValues?.[0]?.value || "");
    return {
      date: rawDate,
      label: toLabel(rawDate),
      activeUsers: Number(row.metricValues?.[0]?.value || 0),
      previousUsers: Number(row.metricValues?.[1]?.value || 0),
    };
  });

  const topCountries = mapRows(countries.rows, (row) => ({
    country: row.dimensionValues?.[0]?.value,
    activeUsers: Number(row.metricValues?.[0]?.value || 0),
  }));
  const topCountryNames = new Set(topCountries.slice(0, 5).map((row) => String(row.country || "")));

  const result = {
    meta: {
      source: "google-analytics-4",
      propertyId,
      startDate,
      endDate,
      generatedAt: new Date().toISOString(),
    },
    main: main?.rows?.[0]
      ? {
          sessions: currSessions,
          activeUsers: currActiveUsers,
          newUsers: currNewUsers,
          returningUsers: Math.max(0, currActiveUsers - currNewUsers),
          conversions: currConversions,
          bounceRate: Math.max(0, 100 - currPctEngaged),
          engagementDuration: currEngagementTimeSec,
        }
      : {},
    topCountries,
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
      const label = toLabel(rawDate);
      const activeUsers = Number(row.metricValues?.[0]?.value || 0);
      const newUsers = Number(row.metricValues?.[1]?.value || 0);
      const returningUsers = Math.max(0, activeUsers - newUsers); // inferred from GA4 metrics
      return { date: rawDate, label, activeUsers, newUsers, returningUsers };
    }),
    campaignTrend: mapRows(campaignTrend.rows, (row) => {
      const rawDate = String(row.dimensionValues?.[0]?.value || "");
      const label = toLabel(rawDate);
      return {
        date: rawDate,
        label,
        sessions: Number(row.metricValues?.[0]?.value || 0),
        conversions: Number(row.metricValues?.[1]?.value || 0),
      };
    }),
    summary: {
      activeUsers: currActiveUsers,
      activeUsersPrev: prevActiveUsers,
      activeUsersDeltaPct: toPercentDelta(currActiveUsers, prevActiveUsers),
      newUsers: currNewUsers,
      newUsersPrev: prevNewUsers,
      newUsersDeltaPct: toPercentDelta(currNewUsers, prevNewUsers),
      newUserPct: currNewUserPct,
      newUserPctPrev: prevNewUserPct,
      newUserPctDeltaPct: toPercentDelta(currNewUserPct, prevNewUserPct),
      pctEngaged: currPctEngaged,
      pctEngagedPrev: prevPctEngaged,
      pctEngagedDeltaPct: toPercentDelta(currPctEngaged, prevPctEngaged),
      pageviewsPerUser: currPageviewsPerUser,
      pageviewsPerUserPrev: prevPageviewsPerUser,
      pageviewsPerUserDeltaPct: toPercentDelta(currPageviewsPerUser, prevPageviewsPerUser),
      engagementTimeSec: currEngagementTimeSec,
      engagementTimeSecPrev: prevEngagementTimeSec,
      engagementTimeSecDeltaPct: toPercentDelta(currEngagementTimeSec, prevEngagementTimeSec),
    },
    activeUsersTrend: activeUsersTrendRows,
    monthlyUsersSessions: mapRows(monthlyUsersSessions.rows, (row) => {
      const monthValue = String(row.dimensionValues?.[0]?.value || "");
      return {
        month: monthValue,
        label: toMonthLabel(monthValue),
        activeUsers: Number(row.metricValues?.[0]?.value || 0),
        sessions: Number(row.metricValues?.[1]?.value || 0),
      };
    }),
    countryTrend: mapRows(countryTrend.rows, (row) => {
      const rawDate = String(row.dimensionValues?.[0]?.value || "");
      const country = String(row.dimensionValues?.[1]?.value || "");
      return {
        date: rawDate,
        label: toLabel(rawDate),
        country,
        activeUsers: Number(row.metricValues?.[0]?.value || 0),
      };
    }).filter((row) => topCountryNames.has(String(row.country || ""))),
    deviceCategory: mapRows(deviceCategory.rows, (row) => ({
      device: row.dimensionValues?.[0]?.value,
      activeUsers: Number(row.metricValues?.[0]?.value || 0),
    })),
    osBreakdown: mapRows(osBreakdown.rows, (row) => ({
      operatingSystem: row.dimensionValues?.[0]?.value,
      activeUsers: Number(row.metricValues?.[0]?.value || 0),
    })),
    browserBreakdown: mapRows(browserBreakdown.rows, (row) => ({
      browser: row.dimensionValues?.[0]?.value,
      activeUsers: Number(row.metricValues?.[0]?.value || 0),
    })),
    browserTrend: mapRows(browserTrend.rows, (row) => ({
      date: String(row.dimensionValues?.[0]?.value || ""),
      label: toLabel(String(row.dimensionValues?.[0]?.value || "")),
      browser: row.dimensionValues?.[1]?.value,
      activeUsers: Number(row.metricValues?.[0]?.value || 0),
    })),
    sessionSourceTable: mapRows(sessionSourceTable.rows, (row) => ({
      source: row.dimensionValues?.[0]?.value,
      medium: row.dimensionValues?.[1]?.value,
      sessions: Number(row.metricValues?.[0]?.value || 0),
    })),
    sessionSourceTrend: mapRows(sessionSourceTrend.rows, (row) => ({
      date: String(row.dimensionValues?.[0]?.value || ""),
      label: toLabel(String(row.dimensionValues?.[0]?.value || "")),
      source: row.dimensionValues?.[1]?.value,
      sessions: Number(row.metricValues?.[0]?.value || 0),
    })),
    topPages: mapRows(topPages.rows, (row) => ({
      pagePath: row.dimensionValues?.[0]?.value,
      views: Number(row.metricValues?.[0]?.value || 0),
      activeUsers: Number(row.metricValues?.[1]?.value || 0),
    })),
    topPagesTrend: mapRows(topPagesTrend.rows, (row) => ({
      date: String(row.dimensionValues?.[0]?.value || ""),
      label: toLabel(String(row.dimensionValues?.[0]?.value || "")),
      pagePath: row.dimensionValues?.[1]?.value,
      views: Number(row.metricValues?.[0]?.value || 0),
    })),
    topEvents: mapRows(topEvents.rows, (row) => ({
      eventName: row.dimensionValues?.[0]?.value,
      eventCount: Number(row.metricValues?.[0]?.value || 0),
      activeUsers: Number(row.metricValues?.[1]?.value || 0),
    })),
    topEventsTrend: mapRows(topEventsTrend.rows, (row) => ({
      date: String(row.dimensionValues?.[0]?.value || ""),
      label: toLabel(String(row.dimensionValues?.[0]?.value || "")),
      eventName: row.dimensionValues?.[1]?.value,
      eventCount: Number(row.metricValues?.[0]?.value || 0),
    })),
  };

  INSIGHTS_CACHE.set(cacheKey, { ts: Date.now(), data: result });
  return result;
}

if (import.meta.url === process.argv[1] || import.meta.url === `file://${process.argv[1]}`) {
  getMarketingInsights("2024-01-01", "2024-12-31")
    .then((d) => console.log(JSON.stringify(d, null, 2)))
    .catch((e) => {
      console.error(e?.message || e);
      process.exit(1);
    });
}
