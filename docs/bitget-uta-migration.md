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
Strategy orders use a `data` array. Missing or null position data remains an
error, with data/list types logged for diagnosis without account contents.
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
   its account snapshot and verify UTA permissions.
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

## Official references

- [Classic-to-UTA API migration guide](https://www.bitget.com/legacy-docs/classic/uta-api-upgrade-guide)
- [Account identity, permissions, settings and leverage](https://www.bitget.com/docs/catalog/account/account-settings)
- [Assets](https://www.bitget.com/legacy-docs/uta/account/Get-Account)
- [Isolated available margin](https://www.bitget.com/legacy-docs/uta/trade/Get-Max-Open-Available)
- [Order placement and native protection](https://www.bitget.com/legacy-docs/uta/trade/Place-Order)
- [Position TP/SL strategies](https://www.bitget.com/legacy-docs/uta/strategy/Place-Strategy-Order)
- [Private order stream](https://www.bitget.com/legacy-docs/uta/websocket/private/Order-Channel)
- [UTA risk and liquidation formulas](https://www.bitget.com/support/articles/12560603895767)
