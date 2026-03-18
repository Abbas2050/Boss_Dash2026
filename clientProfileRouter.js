import express from "express";

const router = express.Router();
const CLIENT_PROFILE_BASE_URL = String(process.env.VITE_BACKEND_BASE_URL || process.env.BACKEND_API_BASE_URL || "https://api.skylinkscapital.com").replace(/\/+$/, "");

function toYmd(value) {
  const date = value ? new Date(value) : new Date();
  if (Number.isNaN(date.getTime())) return new Date().toISOString().slice(0, 10);
  return date.toISOString().slice(0, 10);
}

async function fetchUpstreamJson(path) {
  const url = `${CLIENT_PROFILE_BASE_URL}/api/ClientProfile${path}`;
  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`ClientProfile upstream ${response.status}${text ? `: ${text}` : ""}`);
  }

  return response.json();
}

router.get("/top-clients", async (req, res) => {
  const fromDate = toYmd(req.query.from);
  const toDate = toYmd(req.query.to);
  const count = Math.max(1, Number(req.query.count || 10) || 10);

  try {
    const json = await fetchUpstreamJson(`/top-clients?from=${encodeURIComponent(fromDate)}&to=${encodeURIComponent(toDate)}&count=${encodeURIComponent(String(count))}`);
    res.json(json);
  } catch (error) {
    res.json({
      generatedAt: new Date().toISOString(),
      fromDate,
      toDate,
      topByEquity: [],
      topByVolume: [],
      topByDailyVolume: [],
      topByDailyRealized: [],
      warning: error instanceof Error ? error.message : String(error),
    });
  }
});

router.get("/:login/detail", async (req, res) => {
  const login = Number(req.params.login) || 0;
  const days = Math.max(1, Number(req.query.days || 30) || 30);

  try {
    const json = await fetchUpstreamJson(`/${encodeURIComponent(String(login))}/detail?days=${encodeURIComponent(String(days))}`);
    res.json(json);
  } catch (error) {
    res.json({
      name: `Client ${login || "-"}`,
      group: "-",
      account: {
        equity: 0,
        balance: 0,
        credit: 0,
        margin: 0,
        marginFree: 0,
        marginLevel: 0,
        marginLeverage: 0,
        floatingPnl: 0,
        swap: 0,
      },
      openPositions: [],
      topSymbols: [],
      summary: {
        periodClosedDeals: 0,
        periodTradedLots: 0,
        dailyAvgLots: 0,
        periodDays: days,
        totalOpenPositions: 0,
        totalOpenLots: 0,
        totalFloatingPnl: 0,
        totalSwap: 0,
      },
      warning: error instanceof Error ? error.message : String(error),
    });
  }
});

export default router;