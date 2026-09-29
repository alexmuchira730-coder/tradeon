const $ = id => document.getElementById(id);
const money = n => '$' + Number(n).toFixed(2);
const signed = n => (n >= 0 ? '+' : '-') + '$' + Math.abs(n).toFixed(2);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const TICKS = 1; // contract length in ticks (1 tick = 1 second on 1s indices)
let assets = {}, digitRate = 0.9522, current = 'Volatility 10 (1s) Index';
let mode = 'auto', stakeMode = 'stake', tab = 'open', trades = [], txs = [], bot = null;

/* ---------- header ---------- */
$('tburger').onclick = () => $('tlinks').classList.toggle('open');
$('uBtn').onclick = e => { e.stopPropagation(); $('uMenu').hidden = !$('uMenu').hidden; };
document.addEventListener('click', () => ($('uMenu').hidden = true));
$('lo').onclick = async e => { e.preventDefault(); await api('/api/logout', 'POST'); location.href = '/'; };

/* ---------- chart ---------- */
function drawTerm(cv, P, T, dec) {
  const dpr = devicePixelRatio || 1, w = cv.clientWidth, h = cv.clientHeight;
  cv.width = w * dpr; cv.height = h * dpr;
  const c = cv.getContext('2d'); c.scale(dpr, dpr); c.clearRect(0, 0, w, h);
  const L = 10, R = 70, Tp = 84, B = 28, cw = w - L - R, ch = h - Tp - B, n = P.length;
  const lo = Math.min(...P), hi = Math.max(...P), pad = (hi - lo) * 0.08 || 1, mn = lo - pad, mx = hi + pad;
  const x = i => L + (i / (n - 1)) * cw, y = v => Tp + ch - ((v - mn) / (mx - mn)) * ch;
  c.font = '11px Manrope, sans-serif'; c.strokeStyle = 'rgba(125,142,163,.13)'; c.lineWidth = 1;
  for (let k = 0; k < 5; k++) {
    const v = mn + ((mx - mn) * k) / 4, yy = y(v);
    c.beginPath(); c.moveTo(L, yy); c.lineTo(w - R, yy); c.stroke();
    c.fillStyle = '#7d8ea3'; c.textAlign = 'left'; c.fillText(v.toFixed(dec), w - R + 8, yy + 4);
    const i = Math.round((k * (n - 1)) / 4), xx = x(i);
    c.beginPath(); c.moveTo(xx, Tp); c.lineTo(xx, h - B); c.stroke();
    c.textAlign = 'center'; c.fillText(new Date(T[i]).toLocaleTimeString('en-GB'), Math.min(Math.max(xx, 34), w - R - 20), h - 8);
  }
  const g = c.createLinearGradient(0, Tp, 0, h - B); g.addColorStop(0, 'rgba(255,255,255,.10)'); g.addColorStop(1, 'rgba(255,255,255,0)');
  c.beginPath(); P.forEach((v, i) => (i ? c.lineTo(x(i), y(v)) : c.moveTo(x(i), y(v))));
  c.strokeStyle = '#fff'; c.lineWidth = 1.6; c.lineJoin = 'round'; c.stroke();
  c.lineTo(x(n - 1), h - B); c.lineTo(x(0), h - B); c.closePath(); c.fillStyle = g; c.fill();
  const ly = y(P[n - 1]);
  c.beginPath(); c.arc(x(n - 1), ly, 4, 0, 7); c.fillStyle = '#fff'; c.fill();
  c.fillStyle = '#0c1118'; c.strokeStyle = '#cfd8e3'; c.lineWidth = 1;
  c.beginPath(); c.roundRect(w - R + 2, ly - 11, R - 8, 22, 4); c.fill(); c.stroke();
  c.fillStyle = '#fff'; c.textAlign = 'center'; c.font = '700 11px Manrope, sans-serif'; c.fillText(P[n - 1].toFixed(dec), w - R + 2 + (R - 8) / 2, ly + 4);
}

/* ---------- digit circles ---------- */
$('digits').innerHTML = [...Array(10).keys()].map(d => `<div class="dg" id="dg${d}"><svg viewBox="0 0 52 52"><circle class="tr" cx="26" cy="26" r="22"/><circle class="ar" cx="26" cy="26" r="22" transform="rotate(-90 26 26)"/></svg><div class="tx"><b>${d}</b><small>–</small></div><i class="mk">▲</i></div>`).join('');
function renderDigits(a) {
  const max = Math.max(...a.digits), min = Math.min(...a.digits), C = 2 * Math.PI * 22;
  a.digits.forEach((p, d) => {
    const el = $('dg' + d), ar = el.querySelector('.ar'), sm = el.querySelector('small');
    ar.style.strokeDasharray = `${Math.min(p / 20, 1) * C} ${C}`;
    ar.style.stroke = p === max ? 'var(--teal)' : p === min ? 'var(--red)' : '#3a4759';
    sm.textContent = p.toFixed(1) + '%'; sm.style.color = p === max ? 'var(--teal)' : p === min ? 'var(--red)' : '';
    el.classList.toggle('cur', d === a.lastDigit);
  });
}

/* ---------- market header + list ---------- */
$('mBtn').onclick = e => { e.stopPropagation(); $('mList').hidden = !$('mList').hidden; };
document.addEventListener('click', () => ($('mList').hidden = true));
function renderMarket() {
  const a = assets[current]; if (!a) return;
  const P = a.history, chg = P[P.length - 1] - P[0], pct = (chg / P[0]) * 100;
  $('mName').textContent = current; $('mPx').textContent = a.price.toFixed(a.dec);
  $('mChg').innerHTML = `<span class="${chg >= 0 ? 'up' : 'down'}">${chg.toFixed(a.dec)} (${pct.toFixed(2)}%)</span>`;
  $('mList').innerHTML = Object.keys(assets).map(k => `<button class="${k === current ? 'on' : ''}" data-m="${esc(k)}"><span>${esc(k)}</span><span>${assets[k].price.toFixed(assets[k].dec)}</span></button>`).join('');
  drawTerm($('chart'), P, a.times, a.dec); renderDigits(a);
}
$('mList').onclick = e => { const b = e.target.closest('[data-m]'); if (b) { current = b.dataset.m; renderMarket(); } };
window.addEventListener('resize', renderMarket);

/* ---------- stake / payout ---------- */
const stakeVal = () => { const v = parseFloat($('amt').value) || 0; return stakeMode === 'stake' ? v : v / (1 + digitRate); };
function updPayout() {
  $('payoutVal').textContent = (stakeVal() * (1 + digitRate)).toFixed(2) + ' USD';
  const p = (digitRate * 100).toFixed(2) + '%';
  ['ev', 'od'].forEach(k => { $(k + 'Pc').textContent = p; $(k + 'Bar').style.width = digitRate * 100 + '%'; });
}
$('amt').oninput = updPayout;
$('minus').onclick = () => { $('amt').value = Math.max(1, (parseFloat($('amt').value) || 1) - 1); updPayout(); };
$('plus').onclick = () => { $('amt').value = (parseFloat($('amt').value) || 0) + 1; updPayout(); };
$('stakeSeg').onclick = e => {
  const b = e.target.closest('[data-sm]'); if (!b || b.dataset.sm === stakeMode) return;
  const v = parseFloat($('amt').value) || 0;
  $('amt').value = (b.dataset.sm === 'payout' ? v * (1 + digitRate) : v / (1 + digitRate)).toFixed(2);
  stakeMode = b.dataset.sm;
  document.querySelectorAll('#stakeSeg button').forEach(x => x.classList.toggle('on', x === b)); updPayout();
};
$('modeSeg').onclick = e => {
  const b = e.target.closest('[data-mode]'); if (!b) return; mode = b.dataset.mode;
  document.querySelectorAll('#modeSeg button').forEach(x => x.classList.toggle('on', x === b));
  $('autoBox').hidden = mode !== 'auto'; setMsg('');
};

/* ---------- trading ---------- */
const setMsg = (t, k = '') => { const m = $('dmsg'); m.className = 'msg ' + k; m.textContent = t; };
const place = (side, stake) => api('/api/trade', 'POST', { asset: current, direction: side, stake: +stake.toFixed(2), seconds: TICKS });
function ui() {
  const run = !!bot; $('stopBtn').hidden = !run; $('evenBtn').disabled = $('oddBtn').disabled = run;
}
async function manual(side) {
  try { await place(side, stakeVal()); setMsg(`${side.toUpperCase()} trade placed. Result in about ${TICKS}s.`, 'ok'); acct(); }
  catch (e) { setMsg(e.message, 'err'); }
}
async function waitTrade(id) {
  for (let i = 0; i < 25; i++) {
    await sleep(600);
    try { const l = await api('/api/trades'); const t = l.find(x => x.id === id); if (t && t.status !== 'open') { trades = l; renderLeft(); acct(); return t; } } catch {}
  }
  return null;
}
function stopBot(msg, err) { bot = null; ui(); setMsg(msg, err ? 'err' : 'ok'); }
async function startBot(side) {
  const base = +stakeVal().toFixed(2);
  if (!(base >= 1)) return setMsg('Minimum stake is $1.', 'err');
  bot = { side, base, stake: base, profit: 0, tp: +$('tp').value || Infinity, tl: +$('tl').value || Infinity, lm: Math.max(1, +$('lm').value || 1) };
  ui();
  while (bot) {
    let id;
    try { id = (await place(bot.side, bot.stake)).id; } catch (e) { return stopBot(e.message, true); }
    const t = await waitTrade(id);
    if (!bot) return;
    if (!t) return stopBot('Could not confirm the last trade. Auto trading stopped.', true);
    if (t.status === 'won') { bot.profit += t.payout - t.stake; bot.stake = bot.base; }
    else if (t.status === 'lost') { bot.profit -= t.stake; bot.stake = +Math.min(1000, t.stake * bot.lm).toFixed(2); }
    if (bot.profit >= bot.tp) return stopBot('Target profit reached: ' + signed(bot.profit));
    if (-bot.profit >= bot.tl) return stopBot('Target loss reached: ' + signed(bot.profit));
    setMsg(`Auto: session ${signed(bot.profit)} · next stake ${money(bot.stake)}`, 'ok');
  }
}
['even', 'odd'].forEach(s => ($(s + 'Btn').onclick = () => (mode === 'auto' ? startBot(s) : manual(s))));
$('stopBtn').onclick = () => stopBot('Auto trading stopped.');

/* ---------- left panel ---------- */
document.querySelector('.tabs').onclick = e => {
  const b = e.target.closest('[data-tab]'); if (!b) return; tab = b.dataset.tab;
  document.querySelectorAll('.tabs button').forEach(x => x.classList.toggle('on', x === b)); renderLeft();
};
const empty = (t, s) => `<div class="empty"><div class="ring"></div><b>${t}</b><span>${s}</span></div>`;
function card(t) {
  const pl = t.status === 'won' ? t.payout - t.stake : t.status === 'lost' ? -t.stake : 0;
  return `<div class="pos"><div class="r1"><span>${esc(t.asset)}</span><span class="sd ${esc(t.direction)}">${esc(t.direction.toUpperCase())}</span></div>
   <div class="r2"><span>Stake ${money(t.stake)}</span>${t.status === 'open' ? `<span>Entry ${esc(t.entry)}</span>` : `<b class="${pl >= 0 ? 'up' : 'down'}">${signed(pl)}</b>`}</div></div>`;
}
function renderLeft() {
  const open = trades.filter(t => t.status === 'open'), closed = trades.filter(t => t.status !== 'open');
  $('cOpen').textContent = open.length; $('cClosed').textContent = closed.length;
  $('foot').textContent = `${open.length} open position${open.length === 1 ? '' : 's'}`;
  $('list').innerHTML = tab === 'open' ? (open.length ? open.map(card).join('') : empty('No open positions', 'Your active trades will appear here'))
    : tab === 'closed' ? (closed.length ? closed.map(card).join('') : empty('No closed trades', 'Finished trades will appear here'))
    : txs.length ? txs.map(x => `<div class="pos"><div class="r1"><span>${esc(x.type)}</span><b>${money(x.amount)}</b></div><div class="r2"><span>${esc(x.method)}</span><span>${esc(x.status)}</span></div></div>`).join('')
    : empty('No transactions', 'Deposits and withdrawals will appear here');
}

/* ---------- data loops ---------- */
async function acct() {
  try {
    const [me, t, x] = await Promise.all([api('/api/me'), api('/api/trades'), api('/api/transactions')]);
    trades = t; txs = x; $('bal').textContent = money(me.balance);
    $('uname').textContent = me.name; $('uBtn').textContent = me.name.trim()[0].toUpperCase(); $('adm').hidden = !me.is_admin; renderLeft();
  } catch (e) { if (e.status === 401) location.href = '/login.html'; }
}
async function tick() {
  try { const d = await api('/api/prices'); assets = d.assets; digitRate = d.digitPayout; updPayout(); renderMarket(); } catch {}
}
updPayout(); renderLeft(); ui(); tick(); acct();
setInterval(tick, 1000); setInterval(acct, 3000);
