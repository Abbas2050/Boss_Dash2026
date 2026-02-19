(async ()=>{
  try {
    const payload = {
      event: 'AccountAlert',
      data: {
        alertType: 'MarginCallEnter',
        account: { login: 654321, equity: 555.55, balance: 2000.00, margin: 100.00 },
        group: 'Retail'
      }
    };
    const res = await fetch('http://localhost:8080/api/mock/alerts/trigger', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const txt = await res.text();
    console.log('STATUS', res.status);
    console.log(txt);
  } catch (e) { console.error(e); process.exit(1); }
})();
