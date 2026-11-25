# Bitget Unified Trading Account migration

Bitget now uses the v3 Unified Trading Account (UTA) API throughout the backend.
This replaces the Classic adapter that returned Bitget error `40085` for UTA
accounts. Bybit and OKX keep their existing adapters.

## Account requirements

- A system-generated HMAC key with a passphrase and Read-write access to both
  UTA management (`uta_mgt`) and UTA trading (`uta_trade`). Withdrawal and
  transfer permissions are unnecessary.
- A UTA account (`unified` or `hybrid`). Connection validation reads metadata,
  account settings and assets; it does not change the exchange account mode.
- For opening trades: one-way holding mode, delta-neutral mode disabled, and
  an explicit isolated USDT futures configuration for the selected symbol.
  Basic, advanced and isolated UTA account levels are recognized. Cross-margin
  positions and hedge mode remain outside the risk planner's supported scope.

## Automatic isolated-margin setup

Connecting, updating credentials, or testing a Bitget connection prepares the
same ten pairs offered by the frontend: BTCUSDT, ETHUSDT, SOLUSDT, XRPUSDT,
DOGEUSDT, BNBUSDT, LINKUSDT, SUIUSDT, AVAXUSDT and ADAUSDT. Existing connections
can run setup using the refresh button in Exchange Settings. The connection
card shows readiness and any blocked or failed pairs.

Existing isolated settings and leverage are preserved. For a missing isolated
configuration, setup checks positions, ordinary orders and strategy orders before
each write, configures both sides through `account/set-leverage` at the instrument's
minimum leverage, then verifies isolated settings by reading `account/settings`.
An exchange acknowledgement alone does not mark a pair ready. Pairs with exposure
are left unchanged; a blocked pair does not stop setup of other pairs.

Setup and trade execution share the connection execution lock. Execution also
prepares the selected pair before risk planning, covering connections created
before this feature. The trade planner subsequently selects and verifies leverage
for the actual trade. Read-only previews do not change account settings.
One-way Mode and Delta-Neutral remain settings the account owner must configure;
automatic setup never changes them or closes positions/orders.

## API coverage

| Flow | v3 API |
| --- | --- |
| Key identity and permissions | `GET /api/v3/account/info` |
| Account mode and leverage verification | `GET /api/v3/account/settings` |
| Dashboard assets and total equity | `GET /api/v3/account/assets` |
| Available isolated trading margin | `POST /api/v3/account/max-open-available` |
| Instruments and tickers | `GET /api/v3/market/instruments`, `/tickers` |
| Maintenance tiers | `GET /api/v3/market/position-tier` |
| Account taker fee | `GET /api/v3/account/fee-rate` |
| Leverage configuration | `POST /api/v3/account/set-leverage` |
| Entry, amendment and cancellation | `POST /api/v3/trade/place-order`, `/modify-order`, `/cancel-order` |
| Order reconciliation | `GET /api/v3/trade/order-info`, `/history-orders`, `/unfilled-orders` |
| Positions | `GET /api/v3/position/current-position` |
| Position TP/SL | `POST /api/v3/trade/place-strategy-order`, `/modify-strategy-order` |
| Strategy exposure/protection checks | `GET /api/v3/trade/unfilled-strategy-orders` |

The product category is `USDT-FUTURES`; order quantity is base coin in `qty`.
Entry protection uses `takeProfit` and `stopLoss`, mark-price triggers and market
execution. Exits use the opposite side with `reduceOnly=yes`. Open orders use
`data.list`; the shared position parser accepts a `data` array or `data.list`.
Strategy orders use a `data` array. A successful `code=00000` position response
with `data.list=null` and no pagination marker is normalized to an empty list.
Missing data, `data=null`, failed responses and incomplete pages remain errors,
with data/list types logged for diagnosis without account contents.
History reconciliation follows `cursor` pagination and requires confirmed
cumulative fills before recording an exit price. Unknown order states,
unverifiable responses and changed position identity require review.

Available margin comes from the isolated feasibility API rather than total
account equity; trial funds are excluded by that endpoint. The existing 2%
risk budget, fee reserves and conservative liquidation buffer remain in force.
Only the first maintenance tier is supported for Bitget liquidation planning,
because the tier response does not expose deductions for higher tiers.

Private WebSockets use `wss://ws.bitget.com/v3/ws/private` in live mode and
`wss://wspap.bitget.com/v3/ws/private` in demo mode, subscribing to
`{"instType":"UTA","topic":"order"}`. Pushes trigger REST reconciliation;
the periodic REST reconciliation also remains active.

## Deployment and verification

1. Deploy backend and frontend changes together. Existing encrypted credentials
   do not need a database migration. Re-test each Bitget connection to refresh
   its account snapshot, verify UTA permissions and prepare supported pairs.
2. Keep `EXCHANGE_MODE=live` for live keys or `testnet` for Bitget Demo API Keys.
   Demo requests retain `paptrading: 1`; there is no fallback between modes.
3. Update `BITGET_WS_URL` and `BITGET_TEST_WS_URL` to the v3 endpoints above if
   explicitly configured. The backend also normalizes old official v2 private
   URLs to v3. Custom proxy URLs are left as configured.
4. Review any existing Classic trades on the exchange before changing account
   mode. The backend never upgrades a Bitget account or resubmits an unresolved
   entry. Historical orders that cannot be verified remain under review.
5. Exercise connection, balance reads, a small demo entry, partial fills,
   TP/SL amendment, cancellation, reduce-only close and restart reconciliation
   against an actual Bitget Demo account before enabling production trading.

Automated tests use mocked v3 responses and local database fixtures. They do not
establish that real exchange orders or account settings have been verified.

The execution integration test includes the reported LINKUSDT short payload
(`entry=8.618`, `tp=8.561`, `sl=8.65`). It uses public LINK instrument/tier
fields checked on 2026-11-25, simulated available margin of 51.24649142 USDT,
and a simulated account taker fee of 0.0006. The real execution pipeline selects
24 LINK at 5x, keeping estimated entry/stop risk including fees at 1.0166592
USDT against a 1.0249298284 USDT budget. Both a protected pending limit order
and an immediately filled, protected short return 201 and persist the exchange
order ID. The test also verifies duplicate submissions are blocked.

These are conditional sizing results: the backend ignores the submitted
`balance` field and reads available isolated margin from Bitget. Actual account
fees, reserved margin, existing exposure, account settings and current prices
can change the outcome. An accepted limit entry may remain pending until filled.
Bitget HTTP rejection codes are retained in safe errors. Codes `40010`, `40725`
and `45001` remain unconfirmed requests requiring client-ID reconciliation;
they do not authorize a second entry.

## Diagnosing protection failures

`STOP_LOSS_PROTECTION_FAILED` with `recovery=closed` means the entry was
accepted but native protection could not be verified, and recovery confirmed a
reduce-only close with an actual exit price. The 502 is generated by the trade
execution service. It does not by itself identify the original exchange failure.

Failures now persist and return `protectionDiagnostics`, with verification or
repair stages, mismatch reasons, and safe exchange rejection codes. Raw transport
errors and signed request contents are excluded. Failures are also logged with
the exchange order ID. Historical failures cannot acquire these details
retroactively. Read-back failures after a successful repair receive the same
three verification attempts as the initial check before recovery runs.

Bitget rejection diagnostics include `request.endpoint`, `request.method` and
`request.exchangeCode`. For `40019`, recognized parameter names from Bitget's
"Parameter ... cannot be empty" message are retained in `request.parameter` and
the safe message. Other raw exchange message text is excluded.
Native protection mismatches include `details.expected` and selected observed
entry, position and strategy fields, plus individual TP/SL confirmation results
for position checks. Strategy snapshots are limited to 20 rows and indicate
truncation. These details follow the existing persistence, response and logging
paths; they do not relax verification or change recovery behavior.

The reported LINKUSDT short response exposed two adapter issues: a correct
pending buy-to-close TP/SL strategy returned `posSide=long`, while the live
one-way position correctly returned `posSide=short`; and protection placement
rejected a missing `posSide` with `40019`. For verified one-way positions,
strategy matching now uses the opposite closing `side`, accepting either valid
strategy position-side label. The held position direction, quantity, prices,
mark triggers, market execution and pending strategy status remain checked.
New TP/SL strategy requests explicitly include the held position's `posSide`.
Regression fixtures reproduce the reported 3 LINK short and mirror the long
case, including repair and invalid-protection cases. These mocked checks do not
replace verification against Bitget Demo.

## Official references

- [Classic-to-UTA API migration guide](https://www.bitget.com/legacy-docs/classic/uta-api-upgrade-guide)
- [Account identity, permissions, settings and leverage](https://www.bitget.com/docs/catalog/account/account-settings)
- [Assets](https://www.bitget.com/legacy-docs/uta/account/Get-Account)
- [Isolated available margin](https://www.bitget.com/legacy-docs/uta/trade/Get-Max-Open-Available)
- [Order placement and native protection](https://www.bitget.com/legacy-docs/uta/trade/Place-Order)
- [Position TP/SL strategies](https://www.bitget.com/legacy-docs/uta/strategy/Place-Strategy-Order)
- [Private order stream](https://www.bitget.com/legacy-docs/uta/websocket/private/Order-Channel)
- [UTA risk and liquidation formulas](https://www.bitget.com/support/articles/12560603895767)
