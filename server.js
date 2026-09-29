const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const Database = require('better-sqlite3');
const path = require('path');

const app = express();
const db = new Database(path.join(__dirname, 'tradepulse.db'));
db.pragma('journal_mode = WAL');
db.exec(`
CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL, password TEXT NOT NULL,
  balance REAL NOT NULL DEFAULT 10000, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS trades(
  id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL,
  asset TEXT NOT NULL, direction TEXT NOT NULL, stake REAL NOT NULL,
  entry REAL NOT NULL, exit_price REAL, expires_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'open', payout REAL NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP);
`);

try { db.exec('ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0'); } catch (e) {}
db.exec(`CREATE TABLE IF NOT EXISTS transactions(
  id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL,
  type TEXT NOT NULL, amount REAL NOT NULL, method TEXT, reference TEXT,
  status TEXT NOT NULL DEFAULT 'pending', created_at TEXT DEFAULT CURRENT_TIMESTAMP, processed_at TEXT);`);
for (const [column, type] of [
  ['phone_number', 'TEXT'], ['mpesa_amount', 'INTEGER'], ['checkout_request_id', 'TEXT'],
  ['merchant_request_id', 'TEXT'], ['mpesa_receipt', 'TEXT'],
]) {
  try { db.exec(`ALTER TABLE transactions ADD COLUMN ${column} ${type}`); } catch (e) {}
}
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_transactions_checkout_request ON transactions(checkout_request_id) WHERE checkout_request_id IS NOT NULL');
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_transactions_mpesa_receipt ON transactions(mpesa_receipt) WHERE mpesa_receipt IS NOT NULL');
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || '').toLowerCase().trim();
if (ADMIN_EMAIL) db.prepare('UPDATE users SET is_admin=1 WHERE email=?').run(ADMIN_EMAIL);
const MIN_DEPOSIT = 2, MIN_WITHDRAW = 5;
const MPESA_BASE_URL = process.env.MPESA_BASE_URL || (process.env.MPESA_ENV === 'production'
  ? 'https://api.safaricom.co.ke' : 'https://sandbox.safaricom.co.ke');

function mpesaConfiguration() {
  const callbackURL = process.env.MPESA_CALLBACK_URL;
  let secureCallback = false;
  try { secureCallback = new URL(callbackURL).protocol === 'https:'; } catch (e) {}
  const rate = Number(process.env.MPESA_KES_PER_USD);
  if (!process.env.MPESA_CONSUMER_KEY || !process.env.MPESA_CONSUMER_SECRET ||
      !process.env.MPESA_SHORTCODE || !process.env.MPESA_PASSKEY ||
      !process.env.MPESA_CALLBACK_TOKEN || process.env.MPESA_CALLBACK_TOKEN.length < 32 ||
      !secureCallback || !(rate > 0)) {
    throw new Error('M-Pesa payments are not configured. Contact support.');
  }
  return {
    consumerKey: process.env.MPESA_CONSUMER_KEY,
    consumerSecret: process.env.MPESA_CONSUMER_SECRET,
    shortcode: process.env.MPESA_SHORTCODE,
    passkey: process.env.MPESA_PASSKEY,
    callbackURL,
    rate,
  };
}

function normalizeMpesaPhone(value) {
  let phone = String(value || '').replace(/\D/g, '');
  if (phone.startsWith('0')) phone = '254' + phone.slice(1);
  return /^254[17]\d{8}$/.test(phone) ? phone : null;
}

function mpesaTimestamp() {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Africa/Nairobi', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date());
  const value = Object.fromEntries(parts.filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
  return `${value.year}${value.month}${value.day}${value.hour}${value.minute}${value.second}`;
}

async function mpesaAccessToken(config) {
  const authorization = Buffer.from(`${config.consumerKey}:${config.consumerSecret}`).toString('base64');
  const response = await fetch(`${MPESA_BASE_URL}/oauth/v1/generate?grant_type=client_credentials`, {
    headers: { Authorization: `Basic ${authorization}` },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.access_token) throw new Error('M-Pesa authentication failed.');
  return data.access_token;
}

async function sendMpesaStkPush(config, transactionId, amount, phone) {
  const token = await mpesaAccessToken(config);
  const timestamp = mpesaTimestamp();
  const password = Buffer.from(`${config.shortcode}${config.passkey}${timestamp}`).toString('base64');
  const callbackURL = new URL(config.callbackURL);
  callbackURL.searchParams.set('token', process.env.MPESA_CALLBACK_TOKEN);
  const response = await fetch(`${MPESA_BASE_URL}/mpesa/stkpush/v1/processrequest`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      BusinessShortCode: config.shortcode,
      Password: password,
      Timestamp: timestamp,
      TransactionType: process.env.MPESA_TRANSACTION_TYPE || 'CustomerPayBillOnline',
      Amount: amount,
      PartyA: phone,
      PartyB: config.shortcode,
      PhoneNumber: phone,
      CallBackURL: callbackURL.toString(),
      AccountReference: `TD${transactionId}`.slice(0, 12),
      TransactionDesc: 'TRADEON',
    }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || String(data.ResponseCode) !== '0' || !data.CheckoutRequestID) {
    throw new Error('M-Pesa did not accept the payment request.');
  }
  return data;
}

// ---- Simulated price feed (demo only) ----
const PAYOUT = 0.85, DIGIT_PAYOUT = 0.9522;
const feed = {
  'Volatility 10 (1s) Index': { p: 9190.91, vol: 1.6, dec: 2 },
  'Volatility 25 (1s) Index': { p: 2450.35, vol: 1.0, dec: 2 },
  'Volatility 50 (1s) Index': { p: 720.15, vol: 0.4, dec: 2 },
  'Volatility 100 (1s) Index': { p: 1180.6, vol: 1.1, dec: 2 },
  'EUR/USD': { p: 1.085, vol: 0.00012, dec: 5 },
  'GBP/USD': { p: 1.27, vol: 0.00014, dec: 5 },
  'BTC/USD': { p: 65000, vol: 18, dec: 2 },
  'XAU/USD': { p: 2350, vol: 0.6, dec: 2 },
  'USD/KES': { p: 129.2, vol: 0.02, dec: 3 },
};
const price = k => +feed[k].p.toFixed(feed[k].dec);
const digitOf = (p, dec) => +p.toFixed(dec).slice(-1);
const step = k => { feed[k].p = Math.max(feed[k].vol * 5, feed[k].p + (Math.random() - 0.5) * 2 * feed[k].vol); };
const ticks = {}; // per market: [{t, p}] one tick per second
for (const k in feed) {
  ticks[k] = [];
  for (let i = 1000; i > 0; i--) { step(k); ticks[k].push({ t: Date.now() - i * 1000, p: price(k) }); }
}
setInterval(() => {
  for (const k in feed) { step(k); ticks[k].push({ t: Date.now(), p: price(k) }); if (ticks[k].length > 1500) ticks[k].shift(); }
}, 1000);

// ---- Middleware ----
app.use(express.json());
app.use(session({
  secret: process.env.SESSION_SECRET || 'change-this-secret',
  resave: false, saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', maxAge: 7 * 24 * 3600 * 1000 },
}));
const auth = (req, res, next) =>
  req.session.uid ? next() : res.status(401).json({ error: 'Please log in first.' });

// ---- Auth ----
app.post('/api/register', (req, res) => {
  const { name, email, password } = req.body || {};
  if (!name || !email || !password) return res.status(400).json({ error: 'Fill in all fields.' });
  if (!/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ error: 'Enter a valid email address.' });
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  try {
    const info = db.prepare('INSERT INTO users(name,email,password,balance,is_admin) VALUES(?,?,?,0,?)')
      .run(name.trim(), email.toLowerCase().trim(), bcrypt.hashSync(password, 10), email.toLowerCase().trim() === ADMIN_EMAIL ? 1 : 0);
    req.session.uid = info.lastInsertRowid;
    res.json({ ok: true });
  } catch (e) {
    res.status(409).json({ error: 'That email is already registered.' });
  }
});

app.post('/api/login', (req, res) => {
  const { email, password } = req.body || {};
  const u = db.prepare('SELECT * FROM users WHERE email=?').get((email || '').toLowerCase().trim());
  if (!u || !bcrypt.compareSync(password || '', u.password))
    return res.status(401).json({ error: 'Incorrect email or password.' });
  req.session.uid = u.id;
  res.json({ ok: true });
});

app.post('/api/logout', (req, res) => req.session.destroy(() => res.json({ ok: true })));

app.get('/api/me', auth, (req, res) => {
  settle(req.session.uid);
  const u = db.prepare('SELECT id,name,email,balance,is_admin FROM users WHERE id=?').get(req.session.uid);
  res.json(u);
});

// ---- Market + trading ----
app.get('/api/prices', (req, res) => {
  const out = {};
  for (const k in feed) {
    const log = ticks[k], last = log.slice(-120), win = log.slice(-1000), counts = Array(10).fill(0);
    win.forEach(x => counts[digitOf(x.p, feed[k].dec)]++);
    out[k] = {
      price: price(k), dec: feed[k].dec, history: last.map(x => x.p), times: last.map(x => x.t),
      digits: counts.map(c => +((c / win.length) * 100).toFixed(1)), lastDigit: digitOf(log[log.length - 1].p, feed[k].dec),
    };
  }
  res.json({ payout: PAYOUT, digitPayout: DIGIT_PAYOUT, assets: out });
});

function settle(uid) {
  const now = Date.now();
  const open = db.prepare("SELECT * FROM trades WHERE user_id=? AND status='open' AND expires_at<=?").all(uid, now);
  db.transaction(() => {
    for (const t of open) {
      const log = ticks[t.asset];
      let tk = log.find(x => x.t >= t.expires_at);           // first tick at/after expiry
      if (!tk) { if (now - t.expires_at < 5000) continue; tk = log[log.length - 1]; }
      const exit = tk.p, digit = t.direction === 'even' || t.direction === 'odd';
      let status = 'lost', payout = 0, win;
      if (digit) win = (digitOf(exit, feed[t.asset].dec) % 2 === 0) === (t.direction === 'even');
      else if (exit === t.entry) { status = 'tie'; payout = t.stake; }
      else win = (t.direction === 'call' && exit > t.entry) || (t.direction === 'put' && exit < t.entry);
      if (win) { status = 'won'; payout = +(t.stake * (1 + (digit ? DIGIT_PAYOUT : PAYOUT))).toFixed(2); }
      db.prepare('UPDATE trades SET exit_price=?,status=?,payout=? WHERE id=?').run(exit, status, payout, t.id);
      if (payout) db.prepare('UPDATE users SET balance=balance+? WHERE id=?').run(payout, uid);
    }
  })();
}

app.post('/api/trade', auth, (req, res) => {
  const { asset, direction, stake, seconds } = req.body || {};
  const s = +Number(stake).toFixed(2), secs = Number(seconds), digit = ['even', 'odd'].includes(direction);
  if (!feed[asset] || !['call', 'put', 'even', 'odd'].includes(direction)) return res.status(400).json({ error: 'Invalid trade.' });
  if (digit ? !(Number.isInteger(secs) && secs >= 1 && secs <= 10) : ![30, 60, 120, 300].includes(secs))
    return res.status(400).json({ error: 'Invalid expiry.' });
  if (!(s >= 1 && s <= 1000)) return res.status(400).json({ error: 'Stake must be between 1 and 1,000.' });
  const id = db.transaction(() => {
    const u = db.prepare('SELECT balance FROM users WHERE id=?').get(req.session.uid);
    if (u.balance < s) return null;
    db.prepare('UPDATE users SET balance=balance-? WHERE id=?').run(s, req.session.uid);
    return db.prepare('INSERT INTO trades(user_id,asset,direction,stake,entry,expires_at) VALUES(?,?,?,?,?,?)')
      .run(req.session.uid, asset, direction, s, price(asset), Date.now() + secs * 1000).lastInsertRowid;
  })();
  if (id === null) return res.status(400).json({ error: 'Not enough balance. Deposit to continue.' });
  res.json({ ok: true, id: Number(id) });
});

app.get('/api/trades', auth, (req, res) => {
  settle(req.session.uid);
  res.json(db.prepare('SELECT * FROM trades WHERE user_id=? ORDER BY id DESC LIMIT 50').all(req.session.uid));
});

// ---- Wallet ----
const admin = (req, res, next) => {
  const u = req.session.uid && db.prepare('SELECT is_admin FROM users WHERE id=?').get(req.session.uid);
  u && u.is_admin ? next() : res.status(403).json({ error: 'Admins only.' });
};
const clean = (v, n) => String(v || '').trim().slice(0, n);

app.post('/api/deposit', auth, (req, res) => {
  const requestedAmount = Number(req.body?.amount);
  const phone = normalizeMpesaPhone(req.body?.phone_number);
  if (!Number.isFinite(requestedAmount)) return res.status(400).json({ error: 'Enter a valid deposit amount.' });
  const amount = +requestedAmount.toFixed(2);
  if (!(amount >= MIN_DEPOSIT)) return res.status(400).json({ error: `Minimum deposit is $${MIN_DEPOSIT}.` });
  if (amount > 100000) return res.status(400).json({ error: 'Amount is too large.' });
  if (!phone) return res.status(400).json({ error: 'Enter a valid Kenyan M-Pesa phone number.' });

  let config;
  try { config = mpesaConfiguration(); }
  catch (err) { return res.status(503).json({ error: err.message }); }
  const mpesaAmount = Math.round(amount * config.rate);
  if (!Number.isSafeInteger(mpesaAmount) || mpesaAmount < 1) return res.status(400).json({ error: 'The converted M-Pesa amount is invalid.' });

  const transactionId = Number(db.prepare(`INSERT INTO transactions
    (user_id,type,amount,method,reference,phone_number,mpesa_amount,status)
    VALUES(?,'deposit',?,'M-Pesa',?,?,?,'pending')`).run(req.session.uid, amount, phone, phone, mpesaAmount).lastInsertRowid);
  sendMpesaStkPush(config, transactionId, mpesaAmount, phone).then(result => {
    db.prepare('UPDATE transactions SET checkout_request_id=?,merchant_request_id=? WHERE id=? AND status=\'pending\'')
      .run(result.CheckoutRequestID, result.MerchantRequestID || null, transactionId);
    res.json({ ok: true, message: `STK Push sent to ${phone}. Enter your M-Pesa PIN to complete the deposit.` });
  }).catch(err => {
    console.error('M-Pesa STK Push failed:', err.message);
    db.prepare("UPDATE transactions SET status='rejected',processed_at=CURRENT_TIMESTAMP WHERE id=? AND status='pending'").run(transactionId);
    res.status(502).json({ error: 'Could not start M-Pesa payment. Please try again.' });
  });
});

app.post('/api/mpesa/callback', (req, res) => {
  const configToken = process.env.MPESA_CALLBACK_TOKEN;
  if (!configToken || req.query.token !== configToken) return res.sendStatus(404);
  const callback = req.body?.Body?.stkCallback;
  if (!callback?.CheckoutRequestID) return res.json({ ResultCode: 0, ResultDesc: 'Accepted' });

  const transaction = db.prepare(`SELECT * FROM transactions
    WHERE checkout_request_id=? AND type='deposit' AND method='M-Pesa' AND status='pending'`)
    .get(clean(callback.CheckoutRequestID, 100));
  if (!transaction) return res.json({ ResultCode: 0, ResultDesc: 'Accepted' });

  if (Number(callback.ResultCode) !== 0) {
    db.prepare("UPDATE transactions SET status='rejected',processed_at=CURRENT_TIMESTAMP WHERE id=? AND status='pending'").run(transaction.id);
    return res.json({ ResultCode: 0, ResultDesc: 'Accepted' });
  }

  const items = callback.CallbackMetadata?.Item || [];
  const metadata = Object.fromEntries(items.map(item => [item.Name, item.Value]));
  const paidAmount = Number(metadata.Amount);
  const paidPhone = normalizeMpesaPhone(metadata.PhoneNumber);
  const receipt = clean(metadata.MpesaReceiptNumber, 32);
  if (paidAmount !== Number(transaction.mpesa_amount) || paidPhone !== transaction.phone_number || !receipt) {
    const review = `Review required: ${receipt || 'missing receipt'}, KES ${Number.isFinite(paidAmount) ? paidAmount : 'unknown'}`;
    db.prepare("UPDATE transactions SET status='review',mpesa_receipt=?,reference=?,processed_at=CURRENT_TIMESTAMP WHERE id=? AND status='pending'")
      .run(receipt || null, review, transaction.id);
    console.error(`M-Pesa callback requires review for transaction ${transaction.id}.`);
    return res.json({ ResultCode: 0, ResultDesc: 'Accepted' });
  }

  const credited = db.transaction(() => {
    const pending = db.prepare("SELECT * FROM transactions WHERE id=? AND status='pending'").get(transaction.id);
    if (!pending) return false;
    db.prepare("UPDATE transactions SET status='approved',mpesa_receipt=?,reference=?,processed_at=CURRENT_TIMESTAMP WHERE id=?")
      .run(receipt, receipt, transaction.id);
    db.prepare('UPDATE users SET balance=balance+? WHERE id=?').run(pending.amount, pending.user_id);
    return true;
  })();
  if (credited) console.info(`Credited M-Pesa deposit transaction ${transaction.id}.`);
  res.json({ ResultCode: 0, ResultDesc: 'Accepted' });
});

app.post('/api/withdraw', auth, (req, res) => {
  const amount = +Number(req.body.amount).toFixed(2), method = clean(req.body.method, 40), dest = clean(req.body.reference, 80);
  if (!(amount >= MIN_WITHDRAW)) return res.status(400).json({ error: `Minimum withdrawal is $${MIN_WITHDRAW}.` });
  if (!dest) return res.status(400).json({ error: 'Enter the account or phone number to send money to.' });
  const ok = db.transaction(() => {
    const u = db.prepare('SELECT balance FROM users WHERE id=?').get(req.session.uid);
    if (u.balance < amount) return false;
    db.prepare('UPDATE users SET balance=balance-? WHERE id=?').run(amount, req.session.uid); // held until admin decides
    db.prepare("INSERT INTO transactions(user_id,type,amount,method,reference) VALUES(?,'withdrawal',?,?,?)").run(req.session.uid, amount, method, dest);
    return true;
  })();
  if (!ok) return res.status(400).json({ error: 'Not enough balance for that withdrawal.' });
  res.json({ ok: true, message: 'Withdrawal requested. The amount is held until it is processed.' });
});

app.get('/api/transactions', auth, (req, res) =>
  res.json(db.prepare('SELECT id,type,amount,method,status,created_at FROM transactions WHERE user_id=? ORDER BY id DESC LIMIT 20').all(req.session.uid)));

// ---- Admin ----
app.get('/api/admin/stats', auth, admin, (req, res) => res.json({
  users: db.prepare('SELECT COUNT(*) c FROM users').get().c,
  balances: db.prepare('SELECT COALESCE(SUM(balance),0) s FROM users').get().s,
  pendingDeposits: db.prepare("SELECT COUNT(*) c FROM transactions WHERE type='deposit' AND status IN ('pending','review')").get().c,
  pendingWithdrawals: db.prepare("SELECT COUNT(*) c FROM transactions WHERE type='withdrawal' AND status='pending'").get().c,
}));
app.get('/api/admin/users', auth, admin, (req, res) =>
  res.json(db.prepare('SELECT id,name,email,balance,is_admin,created_at FROM users ORDER BY id DESC LIMIT 200').all()));
app.get('/api/admin/transactions', auth, admin, (req, res) =>
  res.json(db.prepare(`SELECT t.*,u.email FROM transactions t JOIN users u ON u.id=t.user_id
    ORDER BY (t.status='pending') DESC, t.id DESC LIMIT 200`).all()));
app.get('/api/admin/trades', auth, admin, (req, res) =>
  res.json(db.prepare('SELECT t.*,u.email FROM trades t JOIN users u ON u.id=t.user_id ORDER BY t.id DESC LIMIT 100').all()));

app.post('/api/admin/transactions/:id/:action', auth, admin, (req, res) => {
  const { id, action } = req.params;
  if (!['approve', 'reject'].includes(action)) return res.status(400).json({ error: 'Invalid action.' });
  const done = db.transaction(() => {
    const t = db.prepare("SELECT * FROM transactions WHERE id=? AND status IN ('pending','review')").get(id);
    if (!t) return false;
    if (t.method === 'M-Pesa' && t.status !== 'review') return false;
    const status = action === 'approve' ? 'approved' : 'rejected';
    db.prepare("UPDATE transactions SET status=?,processed_at=CURRENT_TIMESTAMP WHERE id=?").run(status, id);
    if (t.type === 'deposit' && status === 'approved') db.prepare('UPDATE users SET balance=balance+? WHERE id=?').run(t.amount, t.user_id);
    if (t.type === 'withdrawal' && status === 'rejected') db.prepare('UPDATE users SET balance=balance+? WHERE id=?').run(t.amount, t.user_id); // refund
    return true;
  })();
  done ? res.json({ ok: true }) : res.status(404).json({ error: 'Transaction not found or already processed.' });
});

// ---- Static pages ----
app.use(express.static(path.join(__dirname, 'public')));
app.use((req, res) => res.status(404).sendFile(path.join(__dirname, 'public', 'index.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`TRADEON running on http://localhost:${PORT}`));
