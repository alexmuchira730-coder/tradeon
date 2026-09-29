# TRADEON (demo binary trading site)
1. Install Node.js 18+
2. `npm install`
3. `SESSION_SECRET=your-long-random-string npm start`  (Windows: `set SESSION_SECRET=...` then `npm start`)
4. Open http://localhost:3000

Database: SQLite file `tradepulse.db` is created automatically.
Prices and trades are simulated. M-Pesa deposits charge real money when Daraja is configured.

## Admin
Set your admin email, then register with that exact email (or run the SQL below):
  ADMIN_EMAIL=you@example.com SESSION_SECRET=long-random npm start
Admin panel: http://localhost:3000/admin.html

## Direct database access
  sqlite3 tradepulse.db
  .tables
  SELECT id,email,balance,is_admin FROM users;
  UPDATE users SET is_admin=1 WHERE email='you@example.com';
GUI option: DB Browser for SQLite (open tradepulse.db).

## Wallet rules
Minimum deposit $2, minimum withdrawal $5 (enforced on the server). Deposits are credited only after a successful M-Pesa callback;
withdrawals are held from the balance immediately and refunded if rejected.

## M-Pesa STK Push
Create a Daraja app and configure its credentials as environment variables before starting the server. The callback URL must be public HTTPS (for local testing, expose the server with a trusted HTTPS tunnel). Set the conversion rate to the current KES amount charged per USD credited.

PowerShell example (replace every placeholder; do not commit credentials):
  $env:MPESA_ENV = 'sandbox'
  $env:MPESA_CONSUMER_KEY = 'YOUR_CONSUMER_KEY'
  $env:MPESA_CONSUMER_SECRET = 'YOUR_CONSUMER_SECRET'
  $env:MPESA_SHORTCODE = 'YOUR_SHORTCODE'
  $env:MPESA_PASSKEY = 'YOUR_PASSKEY'
  $env:MPESA_CALLBACK_URL = 'https://your-public-host/api/mpesa/callback'
  $env:MPESA_CALLBACK_TOKEN = 'YOUR_RANDOM_SECRET_AT_LEAST_32_CHARACTERS'
  $env:MPESA_KES_PER_USD = 'YOUR_NUMERIC_RATE'
  npm start

## Dashboard
/dashboard.html: Even/Odd last-digit trading on Volatility indices, Auto mode (target profit, target loss, loss multiple)
and Manual mode. Deposit, Withdraw, and History are available on /deposit.html, /withdraw.html, and /wallet.html.
