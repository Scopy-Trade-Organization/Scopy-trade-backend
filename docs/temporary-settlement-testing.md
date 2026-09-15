# Temporary trade-close and settlement test endpoints

Set `ENABLE_TEMPORARY_TEST_ENDPOINTS=true` only in the test environment. Both
routes use the normal user session cookie, role checks, global CSRF middleware,
rate limiter, and request sanitizer.

## Postman authentication and CSRF setup

Logging in is not enough for a state-changing request. The login response sets
both `user_token` and `csrf_token` cookies. Postman must send both cookies back,
and the request must also include this header:

```text
X-CSRF-Token: <the exact value of the csrf_token cookie>
```

Do not use the `user_token` value in this header. In Postman, open **Cookies**
for `scopy-trade-backend-1.onrender.com`, copy the value of `csrf_token`, create
an environment variable named `csrf_token`, and add this header to both
temporary requests:

```text
X-CSRF-Token: {{csrf_token}}
```

Keep the requests in the same Postman cookie jar used for login. If you log in
again or refresh the session, update the variable because a new CSRF cookie is
issued. A missing cookie, missing header, or different values correctly returns
HTTP 403 with `Invalid CSRF token`.

## 1. Create and close a pro trade plus its copies

`POST /api/temporary/trade-close` must be called while authenticated as the pro
trader. `requestId` is idempotent for that pro. Send one to four copiers; every
exchange connection must already exist, be active, and belong to the stated
user.

```json
{
  "requestId": "close-test-001",
  "pair": "BTCUSDT",
  "direction": "buy",
  "entryPrice": "100",
  "exitPrice": "120",
  "tp": "120",
  "sl": "90",
  "closedVia": "tp",
  "proTrade": {
    "exchangeConnectionId": "PRO_CONNECTION_OBJECT_ID",
    "quantity": "1"
  },
  "copiers": [
    {
      "userId": "COPY_TRADER_OBJECT_ID",
      "exchangeConnectionId": "COPY_CONNECTION_OBJECT_ID",
      "quantity": "3"
    }
  ]
}
```

With the example prices and copy quantity, copied PnL is 60 USDT, settlement is
12 USDT (20%), platform share is 9 USDT (15%), and pro share is 3 USDT (5%).
The response exposes those computed records and totals. Repeating the same
request returns the original data without creating more trades.

Verify the stored outcome through:

- Copy trader: `GET /api/copy-trader/dashboard/profit-share` and
  `GET /api/trades?status=history`
- Pro trader: `GET /api/pro-trader/dashboard/trades?status=history` and
  `GET /api/pro-trader/dashboard/trades/:tradeId/copiers`
- Admin: `GET /api/admin/dashboard/trades?status=history`

## 2. Simulate the copy trader's approved withdrawal

`POST /api/temporary/withdraw-usdt` must be called while authenticated as the
copy trader. It decrypts that user's stored credentials and makes the real,
signed credential and withdrawal-account balance requests. It validates the
account type and available USDT, but it does **not** submit a withdrawal. After
preflight succeeds it records a simulated completed settlement and applies the
same trade/pro-credit database changes as a confirmed live withdrawal.

```json
{
  "requestId": "settlement-test-001",
  "exchangeConnectionId": "COPY_CONNECTION_OBJECT_ID"
}
```

Repeat the exact request to verify idempotency. It returns the same settlement
with `idempotent: true` and does not credit the pro twice.

Verify the result through:

- Copy trader profit-share endpoint (pending amount decreases)
- Pro trader trades endpoint (`creditedProTraderShare`) and wallet endpoint
  (`proEarningsBalance`)
- Admin: `GET /api/admin/dashboard/settlements`

Live settlement accepts `Idempotency-Key` (or body `requestId`) on
`POST /api/copy-trader/dashboard/profit-share/approve`. The durable settlement
state machine is `PROCESSING -> SUBMITTED -> COMPLETED`; terminal exchange
failure becomes `FAILED`. A polling timeout remains `SUBMITTED` and is never
automatically resent.
