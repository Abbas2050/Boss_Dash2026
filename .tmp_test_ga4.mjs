import { getMarketingInsights } from './ga4.js';

function isoDate(d){return d.toISOString().slice(0,10)}

(async () => {
  try {
    // Full year
    console.log('--- Full year 2024-01-01 -> 2024-12-31 ---');
    const res1 = await getMarketingInsights('2024-01-01', '2024-12-31');
    console.log('RESULT (year): rows main:', Object.keys(res1.main || {}).length, 'topCountries:', (res1.topCountries||[]).length);

    // Last 30 days
    const end30 = new Date();
    const start30 = new Date(); start30.setDate(end30.getDate()-30);
    console.log('--- Last 30 days', isoDate(start30), '->', isoDate(end30), '---');
    const res30 = await getMarketingInsights(isoDate(start30), isoDate(end30));
    console.log('RESULT (30d): rows main:', Object.keys(res30.main||{}).length, 'topCountries:', (res30.topCountries||[]).length);

    // Last 7 days
    const end = new Date();
    const start = new Date(); start.setDate(end.getDate()-7);
    console.log('--- Last 7 days', isoDate(start), '->', isoDate(end), '---');
    const res2 = await getMarketingInsights(isoDate(start), isoDate(end));
    console.log('RESULT (7d):', JSON.stringify(res2, null, 2));
  } catch (err) {
    console.error('GA4 ERROR:', err && err.message ? err.message : err);
    console.error(err);
  }
})();
