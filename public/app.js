/* Shared helpers */
async function api(url, method = 'GET', body) {
  const r = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(data.error || 'Something went wrong.'), { status: r.status });
  return data;
}

function drawChart(canvas, data) {
  const dpr = window.devicePixelRatio || 1, w = canvas.clientWidth, h = canvas.clientHeight;
  canvas.width = w * dpr; canvas.height = h * dpr;
  const c = canvas.getContext('2d'); c.scale(dpr, dpr); c.clearRect(0, 0, w, h);
  const min = Math.min(...data), max = Math.max(...data), pad = (max - min) * 0.15 || 1;
  const y = v => h - ((v - min + pad) / (max - min + pad * 2)) * h;
  const x = i => (i / (data.length - 1)) * w;
  c.strokeStyle = 'rgba(143,165,186,.15)'; c.lineWidth = 1;
  for (let i = 1; i < 5; i++) { c.beginPath(); c.moveTo(0, (h / 5) * i); c.lineTo(w, (h / 5) * i); c.stroke(); }
  const up = data[data.length - 1] >= data[0], col = up ? '#19c37d' : '#f0506e';
  const g = c.createLinearGradient(0, 0, 0, h); g.addColorStop(0, col + '55'); g.addColorStop(1, col + '00');
  c.beginPath(); data.forEach((v, i) => (i ? c.lineTo(x(i), y(v)) : c.moveTo(x(i), y(v))));
  c.strokeStyle = col; c.lineWidth = 2.2; c.stroke();
  c.lineTo(w, h); c.lineTo(0, h); c.closePath(); c.fillStyle = g; c.fill();
  const lx = x(data.length - 1), ly = y(data[data.length - 1]);
  c.beginPath(); c.arc(lx - 3, ly, 4.5, 0, 7); c.fillStyle = col; c.fill();
}

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* Mobile menu */
document.addEventListener('click', e => {
  if (e.target.closest('.burger')) document.querySelector('.links').classList.toggle('open');
});

/* Show Dashboard/Logout instead of Login/Register when signed in */
(async () => {
  const slot = document.getElementById('authLinks');
  if (!slot) return;
  try {
    await api('/api/me');
    slot.innerHTML = '<a href="/dashboard.html">Dashboard</a><a href="#" id="logoutBtn" class="btn">Log out</a>';
    document.getElementById('logoutBtn').onclick = async e => { e.preventDefault(); await api('/api/logout', 'POST'); location.href = '/'; };
  } catch {}
})();

/* Auth forms */
const authForm = document.getElementById('authForm');
if (authForm) authForm.addEventListener('submit', async e => {
  e.preventDefault();
  const msg = document.getElementById('msg'); msg.className = 'msg'; msg.textContent = 'Please wait…';
  const body = Object.fromEntries(new FormData(authForm));
  if (body.confirm !== undefined && body.confirm !== body.password) { msg.className = 'msg err'; msg.textContent = 'Passwords do not match.'; return; }
  try { await api(authForm.dataset.action, 'POST', body); const me = await api('/api/me'); location.href = me.is_admin ? '/admin.html' : '/dashboard.html'; }
  catch (err) { msg.className = 'msg err'; msg.textContent = err.message; }
});

/* Landing page: live hero chart + ticker */
if (document.getElementById('heroChart')) {
  let data = Array.from({ length: 80 }, (_, i) => 1.085 + Math.sin(i / 7) * 0.0006 + Math.random() * 0.0003);
  const px = document.getElementById('heroPx');
  setInterval(async () => {
    try {
      const d = await api('/api/prices');
      data = d.assets['EUR/USD'].history.slice(-80);
      document.getElementById('ticker').innerHTML = Object.entries(d.assets).map(([k, v]) => {
        const up = v.history[v.history.length - 1] >= v.history[0];
        return `<span>${k} <b class="${up ? 'up' : 'down'}">${v.price} ${up ? '▲' : '▼'}</b></span>`;
      }).join('');
    } catch { data.push(data[data.length - 1] + (Math.random() - 0.5) * 0.0003); data.shift(); }
    px.textContent = data[data.length - 1].toFixed(5);
    drawChart(document.getElementById('heroChart'), data);
  }, 1000);
  drawChart(document.getElementById('heroChart'), data);
}

/* Dashboard */
if (document.getElementById('tradeBox')) {
  let assets = {}, current = 'EUR/USD';
  const $ = id => document.getElementById(id);
  const fmt = n => Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  async function refreshAccount() {
    try {
      const me = await api('/api/me');
      $('who').textContent = me.name; $('bal').textContent = '$' + fmt(me.balance);
      const t = await api('/api/trades');
      $('trades').innerHTML = t.length ? t.map(x => `<tr><td>${x.asset}</td><td>${x.direction.toUpperCase()}</td><td>$${fmt(x.stake)}</td>
        <td>${x.entry}</td><td>${x.exit_price ?? '—'}</td><td><span class="tag ${x.status}">${x.status}</span></td></tr>`).join('')
        : '<tr><td colspan="6">No trades yet. Place your first one.</td></tr>';
    } catch (e) { if (e.status === 401) location.href = '/login.html'; }
  }
  async function tick() {
    const d = await api('/api/prices'); assets = d.assets;
    $('asset').value = current;
    $('px').textContent = assets[current].price;
    $('payout').textContent = Math.round(d.payout * 100) + '%';
    drawChart($('chart'), assets[current].history);
  }
  $('asset').innerHTML = ['EUR/USD', 'GBP/USD', 'BTC/USD', 'XAU/USD', 'USD/KES'].map(a => `<option>${a}</option>`).join('');
  $('asset').onchange = e => { current = e.target.value; tick(); };
  document.querySelectorAll('[data-dir]').forEach(b => b.onclick = async () => {
    const m = $('tmsg'); m.className = 'msg'; m.textContent = '';
    try {
      await api('/api/trade', 'POST', { asset: current, direction: b.dataset.dir, stake: $('stake').value, seconds: $('secs').value });
      m.textContent = 'Trade placed. It settles automatically at expiry.'; refreshAccount();
    } catch (e) { m.className = 'msg err'; m.textContent = e.message; }
  });
  $('logout').onclick = async e => { e.preventDefault(); await api('/api/logout', 'POST'); location.href = '/'; };
  refreshAccount(); tick(); setInterval(tick, 1000); setInterval(refreshAccount, 5000);
}

/* Wallet (deposit / withdraw) */
if (document.getElementById('wallet')) {
  const $ = id => document.getElementById(id), money = n => '$' + Number(n).toFixed(2);
  async function loadTx() {
    const t = await api('/api/transactions');
    $('txs').innerHTML = t.length ? t.map(x => `<tr><td>${esc(x.type)}</td><td>${money(x.amount)}</td><td>${esc(x.method)}</td>
      <td><span class="tag ${x.status === 'approved' ? 'won' : x.status === 'rejected' ? 'lost' : 'open'}">${esc(x.status)}</span></td>
      <td>${esc(x.created_at)}</td></tr>`).join('') : '<tr><td colspan="5">No deposits or withdrawals yet.</td></tr>';
    const me = await api('/api/me'); $('bal').textContent = money(me.balance);
    if (me.is_admin && !document.getElementById('adminLink')) (document.querySelector('.tlinks') || document.querySelector('.links')).insertAdjacentHTML('afterbegin', '<a id="adminLink" href="/admin.html">Admin</a>');
  }
  [['depForm', '/api/deposit'], ['wdForm', '/api/withdraw']].forEach(([id, url]) => {
    const form = $(id);
    if (!form) return;
    form.addEventListener('submit', async e => {
      e.preventDefault(); const m = $('wmsg'); m.className = 'msg';
      try { const r = await api(url, 'POST', Object.fromEntries(new FormData(e.target))); m.textContent = r.message; e.target.reset(); loadTx(); }
      catch (err) { m.className = 'msg err'; m.textContent = err.message; }
    });
  });
  loadTx().catch(() => {}); setInterval(() => loadTx().catch(() => {}), 10000);
}
