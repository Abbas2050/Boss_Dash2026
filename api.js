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
    res.status(500).json({ error: err?.message || 'Marketing insights failed' });
  }
});

export default router;
