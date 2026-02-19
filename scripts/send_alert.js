(async ()=>{
  try {
    const payload = {
      event: 'AccountAlert',
      data: {
        alertType: 'MarginCallEnter',
        account: { login: 123456, equity: 250.12, balance: 1000.00, margin: 50.00 },
        group: 'Retail'
      }
    };
    const res = await fetch('http://localhost:3001/api/mock/alerts/trigger', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const txt = await res.text();
    console.log('STATUS', res.status);
    console.log(txt);
  } catch (e) { console.error(e); process.exit(1); }
})();
