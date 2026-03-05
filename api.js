// Express API route to expose Google Analytics 4 marketing insights
import express from 'express';
import { getMarketingInsights } from './ga4.js';

const router = express.Router();

// GET /api/marketing-insights?start=YYYY-MM-DD&end=YYYY-MM-DD
router.get('/marketing-insights', async (req, res) => {
  const { start, end } = req.query;
  const isYmd = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
  if (!isYmd(start) || !isYmd(end)) {
    return res.status(400).json({ error: 'Invalid or missing start/end date (YYYY-MM-DD)' });
  }
  try {
    const data = await getMarketingInsights(String(start), String(end));
    res.json(data);
  } catch (err) {
    res.json({
      meta: {
        source: 'google-analytics-4',
        startDate: String(start),
        endDate: String(end),
        generatedAt: new Date().toISOString(),
        warning: err?.message || 'Marketing insights failed',
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
    });
  }
});

export default router;
