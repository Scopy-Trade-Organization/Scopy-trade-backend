> Final audit corrections and current limitations: [final audit](futures-risk-management-final-audit.md). This supersedes the original cross-margin and liquidation-budgeting descriptions below.

# Futures risk management and exchange implementation

This document explains the changes in plain English. It covers the backend and
the exchange choices shown in the frontend. Only Bybit, OKX and Bitget remain.
There are no migration scripts because the database is empty.

## 1. What was wrong before

- The order calculation accepted a balance supplied by the browser. A browser
  request could therefore claim a balance that the exchange account did not have.
- The calculation used the entry-to-stop distance but did not include both
  exchange trading fees in the risk allowance.
- Quantity formatting used fixed decimal places instead of consistently using
  the actual exchange quantity increment.
- There was no complete exchange-specific leverage selection and read-back
  before opening a position.
- OKX futures needed swap instrument IDs and contract quantities. Base-coin
  quantities and spot-style instrument IDs were not correct for those orders.
- An accepted entry order did not prove that its stop loss was attached.
- Some demo headers, REST addresses and private WebSocket addresses were
  inconsistent between exchanges.
- Unsupported exchange adapters and frontend references remained in the project.
- Some close paths could substitute an entry price when the real exit price was
  unknown, which could produce incorrect profit-sharing records.

## 2. The new opening flow

The manual Pro Trader opening flow and copier opening flow use the same backend
execution service:

1. Validate the signal, connected account, supported pair and duplicate checks.
2. For a copy, require an active source trade with confirmed stop-loss protection.
3. For a copy, enforce the existing settlement-payment restriction.
4. Acquire a short database lock on the exchange connection. This prevents two
   opening requests from preparing orders against the same available money.
5. Read the exchange's available futures balance, trading fees, instrument rules,
   account mode and margin tiers.
6. Check the exchange for existing positions, entry orders and TP/SL orders on
   this symbol. Existing exposure is rejected before changing its leverage.
7. Calculate quantity and the lowest permitted leverage that fits the margin
   checks below.
8. Set leverage using that exchange's own API and read it back.
9. Read available margin again. Reject if it has fallen below the amount needed
   for this position or its 2% risk allowance.
10. Save the trade attempt, risk calculation and unique client order ID before
    sending the entry request.
11. Send one limit entry with native exchange TP/SL instructions.
12. Read the order and protection back. Repair missing protection or recover by
    cancelling the remaining entry and reducing the live position.
13. Start monitoring, reload its saved result, and return an opened-trade success
    only if protection is still confirmed. An immediate monitoring failure
    overrides the earlier acknowledgement.

The lock is released in a finally block. If a process stops unexpectedly, its
five-minute lock expires. A saved active trade also prevents a second entry for
the same account and pair. Startup creates the normal trade indexes; this is
schema setup, not a data migration.

## 3. How the 2% calculation works

**Available balance** means money the exchange says can currently support new
futures orders. It is not the total account value and is not a frontend input.

The cash risk allowance is:

```text
risk allowance = available futures balance × 0.02
price distance = absolute difference between entry and stop loss
quantity before fees = risk allowance ÷ price distance
```

The actual calculation includes a conservative trading fee on both the entry
and stop-loss exit:

```text
fee per base-coin unit = (entry price + stop-loss price) × taker fee rate
quantity including fees = risk allowance ÷ (price distance + fee per unit)
```

A **taker fee** is the fee charged when an order immediately trades against an
existing order. Even though entries are limit orders, they can execute as takers.
Assuming taker fees avoids depending on a cheaper maker execution.

The backend then converts the base-coin quantity into native exchange units and
rounds DOWN to the allowed step. It recalculates the final loss and both fees
after rounding. If the allowed quantity is below an exchange minimum, the trade
is rejected. It is never rounded up merely to make it pass.

The calculation uses `decimal.js` with 50 significant digits. Prices, fees,
contract conversion and quantity calculations retain decimal strings. The
testnet price scaling also uses decimal arithmetic.

### Worked example

For a short BTC trade with entry 64,755.1, stop loss 64,949.3, taker fee 0.06%,
quantity step 0.001 BTC, and the sample margin tier used in the automated tests:

| Available USDT | Cash allowance | Final BTC quantity | Position value in USDT | Estimated loss including both fees | Selected leverage |
| -------------: | -------------: | -----------------: | ---------------------: | ---------------------------------: | ----------------: |
|             50 |              1 |              0.003 |               194.2653 |                         0.81606792 |                5x |
|            100 |              2 |              0.007 |               453.2857 |                         1.90415848 |                5x |
|            250 |              5 |              0.018 |             1,165.5918 |                         4.89640752 |                6x |
|            500 |             10 |              0.036 |             2,331.1836 |                         9.79281504 |                6x |
|          1,000 |             20 |              0.073 |             4,727.1223 |                        19.85765272 |                6x |

These are reproducible calculation examples, not fixed production settings.
Production quantity and leverage depend on the actual exchange's current rules,
fees, available funds and margin tiers.

The price-distance-only quantity for the 50 USDT example is about 0.005149 BTC.
That is only an intermediate calculation. Fees and downward rounding reduce the
submitted quantity to 0.003 BTC in this example.

## 4. How leverage is chosen

**Position value**, also called notional, is quantity multiplied by entry price.
**Initial margin** is the money the exchange reserves to open the position.
At 5x leverage, a 200 USDT position needs roughly 40 USDT of initial margin,
before other costs.

Leverage does not determine the cash risk budget. Quantity is calculated first
from the stop-loss distance and available money.

The backend:

- Reserves the estimated opening and closing fees.
- Reserves the maintenance margin required by the position's tier.
- Leaves another 5% of available balance as a margin cushion.
- Includes Bitget's reported opening-cost allowance when present.
- Selects the lowest legal leverage step that fits the remaining opening margin.
- Respects both the instrument's leverage limit and its position tier's limit.
- Rejects if the stop-loss loss, closing fee and maintenance reserve do not fit
  comfortably inside initial margin.
- After a fill, checks that the reported liquidation price is beyond the stop
  loss and that risk at the actual fill price still fits the saved allowance.

**Maintenance margin** is the minimum money the exchange requires to keep a
position open. A **margin tier** is an exchange rule that changes those
requirements for larger positions. **Liquidation** is the exchange forcibly
closing a position when its margin becomes inadequate.

The pre-entry liquidation check is conservative budgeting, not a full exchange
liquidation simulator. The live liquidation-price read-back provides an
additional check when that price is available.

## 5. Each exchange has its own implementation

Only request signing and HTTP transport are shared. Balance interpretation,
margin settings, leverage operations, instrument units and protection APIs are
different for each exchange.

| Item            | Bybit                                            | OKX                                    | Bitget                                         |
| --------------- | ------------------------------------------------ | -------------------------------------- | ---------------------------------------------- |
| Product         | Linear USDT perpetual                            | Linear USDT swap                       | UTA v3 USDT perpetual futures              |
| BTC symbol      | BTCUSDT                                          | BTC-USDT-SWAP                          | BTCUSDT                                        |
| Order quantity  | Base coin                                        | Number of contracts                    | Base coin                                      |
| Position mode   | One-way, position index 0                        | Net mode                               | One-way mode                                   |
| Margin mode     | Existing regular cross or isolated               | Explicit isolated margin for this swap | Explicit isolated margin              |
| Set leverage    | /v5/position/set-leverage                        | /api/v5/account/set-leverage           | /api/v3/account/set-leverage               |
| Verify leverage | /v5/position/list                                | /api/v5/account/leverage-info          | /api/v3/account/settings                    |
| Stop recovery   | Amend pending order or set position trading stop | Create position OCO protection         | Modify preset protection or set position TP/SL |

An **OCO** order means “one cancels the other”: when one protective exit
executes, the other is cancelled by the exchange.

### Bybit

Uses the Unified account API. For regular cross margin, available money is capped
by the reported total available margin and usable USDT wallet money. For isolated
margin, the calculation subtracts reserved position margin, order margin, locked
funds, bonus and reported spot borrowing from USDT wallet funds.

Other positive enabled collateral, portfolio margin and hedge positions are
rejected by this implementation. Buy and sell leverage are configured together
for one-way mode. An unchanged-leverage response is allowed, but read-back must
still confirm the requested setting.

### OKX

Uses USDT available equity, account level 2 or 3, net position mode and isolated
swap orders. Portfolio mode is rejected.

The exchange reports order size and tier size limits in contracts. For example,
if one contract represents 0.01 BTC, 0.3 contracts represents 0.003 BTC. The
backend uses the instrument's `ctVal × ctMult` to convert between these units.
Stored trade quantity stays in base coin for the existing profit calculation.

Attached TP/SL uses market execution after the trigger. In OKX requests,
`slOrdPx: "-1"` means a market stop-loss exit rather than a limit exit.

### Bitget

Uses the Unified Trading Account v3 API for account validation, assets, instruments,
fees, risk tiers, orders, protection and private WebSockets. Classic v2 accounts
are no longer supported by the Bitget adapter. See [the UTA migration notes](bitget-uta-migration.md).

Opening margin comes from the isolated `max-open-available` feasibility API,
which excludes trial funds; dashboard equity comes from `account/assets`.
The account must be in one-way mode and the symbol must explicitly use isolated
margin. The planner uses the account taker fee and keeps its conservative
first-tier-only liquidation validation until higher-tier deductions are verified.

Entries attach market TP/SL with mark-price triggers. Pending orders use the v3
modify API with the original order ID and `autoCancel=no`; filled positions use
v3 TPSL strategy orders. Both pending presets and live protection are checked
after partial fills. Reduce-only exits use the opposite side with `reduceOnly=yes`.

## 6. Copier balances and frontend inputs

A copier copies the direction and price levels, not the Pro Trader's quantity.
Every copier passes through the live balance, fee, quantity, margin and leverage
checks for their own connected account.

Subscriptions require only an exchange connection; allocation submitted by older
clients is ignored. Order sizing uses the copier's live available futures balance,
and rank eligibility uses refreshed connected-balance snapshots.

The `balance` field in an old opening request is ignored. It can be omitted,
and changing it cannot enlarge the position. No frontend leverage choice
overrides the backend calculation.

The automatic-copy worker no longer marks an interrupted or pre-existing failed
attempt as completed merely because a Trade document exists. It checks confirmed
protection and trade state. Saved attempts are not blindly resubmitted.

## 7. Stop-loss verification and recovery

An exchange returning an entry order ID is only an acknowledgement.

The backend reads back:

- The accepted order size and, while pending, its entry price.
- Pending attached TP/SL, or the live position's protective orders after fills.
- Protective prices, position direction and quantity coverage.
- Market stop execution where the relevant API exposes that setting.
- Risk at the actual fill price and the reported liquidation boundary.

Read-back is retried briefly to allow the exchange to update its records. If
protection is missing, the backend attempts one exchange-specific repair and
checks again.

If protection still cannot be confirmed:

1. Cancel the remaining entry and confirm that cancellation.
2. If there is a live position, submit an opposite reduce-only market exit.
3. Read the exit fill and confirm that the position is flat.
4. Save the protection failure and recovery result.

**Reduce-only** means an order may reduce an existing position but may not open
or reverse a position.

A cancelled unfilled attempt stays cancelled. A confirmed emergency close uses
the actual exit fill and quantity. If cancellation, protection or exit cannot be
confirmed, the trade stays in review. The response tells the user to check the
exchange. It is not returned as a successful new trade.

A pending entry has confirmed attached protection instructions, not an already
executed stop. The monitor checks protection again after fills.

## 8. Amendments, manual closes and monitoring

TP/SL amendments keep the existing position quantity. They cannot increase the
estimated loss beyond the original cash-risk allowance or increase the original
initial-margin budget. The amended protection must also pass read-back.
Copied-trade TP/SL propagation applies the same check independently to each copy.
A failed copy update is recorded for that copy.

Manual closes cancel any remaining entry first. They use actual native position
units, an opposite reduce-only order and a confirmed exit fill. They refuse to
close a position whose direction or size no longer matches the saved trade.
Partly filled entries use the actual closed quantity for local accounting.

Bybit, OKX and Bitget private streams trigger REST reconciliation. A background
check also runs every minute and on restart. This handles missed events and
checks protection after fills. Attempts with a saved client ID but no returned
order ID can be looked up without placing another entry.

For a flat position, the monitor looks for actual reduce-only exit fills after
the entry. It requires their combined quantity to match the entry's filled
quantity and uses their weighted average price. If history is incomplete or
ambiguous, it keeps the trade unresolved. It does not invent an exit price or
charge profit share from a guessed price.

History queries are bounded to the exchange's recent response page. Very old
trades, unusually many exit orders, external manual activity or incomplete
history can require manual review. Concurrent manual trading in the same symbol
outside Scopytrade is not supported as a reliable way to share one position.

## 9. Saved data and API responses

Trade now stores:

| Field                 | Plain-English meaning                           |
| --------------------- | ----------------------------------------------- |
| sizing                | The saved calculation used to prepare the order |
| leverage              | The selected and verified leverage              |
| marginMode            | The exchange margin setting used for this order |
| protectionStatus      | pending, confirmed, failed or review            |
| protectionCheckedAt   | Time of the last successful protection check    |
| protectionError       | A safe explanation of a protection problem      |
| exchangeClientOrderId | A unique ID saved before sending the order      |

The sizing snapshot includes account equity, available balance, available
balance at submission, 2% cash allowance, estimated risk, both trading fees,
quantity before fees, base quantity, native order quantity, position value,
leverage, initial and maintenance margin, reserves, rounded prices and the
exchange rules and margin tier used.

Opening responses include leverage, sizing and protection status. Decimal amounts
are strings to preserve precision. The opening response represents
`sizing.riskPercent` as `2`; the internal saved calculation represents it as
the fraction `0.02`.

Useful rejection codes include `MINIMUM_QUANTITY`, `MINIMUM_NOTIONAL`,
`INSUFFICIENT_MARGIN`, `EXISTING_EXPOSURE`, `BALANCE_CHANGED`,
`LEVERAGE_VERIFICATION_FAILED`, `STOP_LOSS_PROTECTION_FAILED` and
`ORDER_REVIEW_REQUIRED`. An unresolved exchange response must be checked before
trying to create another order.

## 10. Connection permissions and environments

Keys remain encrypted using the existing AES-256-GCM encryption.

- Bybit requires a writable derivatives key. The ContractTrade permission
  format needs both Order and Position permissions.
- OKX requires Trade permission and a passphrase.
- Bitget requires UTA management and UTA trading Read/Write permissions
  (`uta_mgt` and `uta_trade`), a passphrase, UTA account settings and readable UTA assets.

These flows do not require exchange withdrawal permission.

`.env.example` now shows all six REST and all six private WebSocket settings:

| Exchange | Live REST              | Test/demo REST                |
| -------- | ---------------------- | ----------------------------- |
| Bybit    | https://api.bybit.com  | https://api-testnet.bybit.com |
| OKX      | https://www.okx.com    | https://www.okx.com           |
| Bitget   | https://api.bitget.com | https://api.bitget.com        |

| Exchange | Live private WebSocket              | Test/demo private WebSocket               |
| -------- | ----------------------------------- | ----------------------------------------- |
| Bybit    | wss://stream.bybit.com/v5/private   | wss://stream-testnet.bybit.com/v5/private |
| OKX      | wss://ws.okx.com:8443/ws/v5/private | wss://wspap.okx.com:8443/ws/v5/private    |
| Bitget   | wss://ws.bitget.com/v3/ws/private   | wss://wspap.bitget.com/v3/ws/private      |

`EXCHANGE_MODE=testnet` selects Bybit testnet and OKX/Bitget demo trading.
OKX uses the simulated-trading header; Bitget uses the demo-trading header.
Those headers are omitted in live mode. Demo REST hosts can be the same as live
hosts: the demo key and request header select the demo account.

Bybit testnet does not fall back to the live REST override. Optional test/demo
endpoint overrides have their own `*_TEST_API_URL` and `*_TEST_WS_URL` names.
Use credentials created for the selected environment.

The existing optional testnet signal-price rebasing remains: test prices can be
scaled to the exchange's test market while preserving relative TP/SL distance.
It never changes the available balance or the 2% allowance.

## 11. Removed exchange code and preserved settlement behavior

Removed unsupported exchange types, connection validation, order/status/price/
balance adapters, monitor code and frontend exchange choices, guides and sample
references. The unused commented-out WebSocket manager was also deleted.

The old unsupported-exchange TRX price dependency in withdrawal fee estimation
now uses OKX's public TRX-USDT ticker. Its existing fail-safe behavior remains.
The payout documentation was updated to name that source.

Settlements and withdrawals remain Transaction records. Pro Trader earnings
remain in the separate Earning model. The existing user-paid settlement fees
and withdrawal behavior remain: entered withdrawal amount is the total debit,
and the network fee is deducted from the payout. There is no SettlementPayment
model and no migration code.

## 12. File map

| File                                            | Responsibility                                                                                                |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| src/services/tradeRiskService.ts                | Decimal sizing, fees, rounding, margin budgeting and amendment risk validation                                |
| src/services/futuresExchangeService.ts          | Each exchange's balance, account mode, instrument/tier rules and leverage configuration/read-back             |
| src/services/exchangeApiService.ts              | Signed transport, environment headers and safe errors; mutations are not automatically retried                |
| src/services/tradeProtectionService.ts          | Order/position read-back, protective-order repair, cancellation/close recovery and actual-exit reconciliation |
| src/services/tradeExecutionService.ts           | Common Pro Trader and copier opening flow, database lock and saved attempt                                    |
| src/services/tradeService.ts                    | Exchange-native entry, amendment, close, price and display-balance operations                                 |
| src/services/tradeMonitorService.ts             | Private WebSockets, restart recovery and periodic reconciliation                                              |
| src/services/automaticCopyService.ts            | Confirmed-source fan-out, independent copier execution and accurate job outcomes                              |
| src/services/copiedTradeUpdateService.ts        | Per-copy protection amendments and close propagation                                                          |
| src/controllers/proTraderDashboardController.ts | Pro Trader amendments/closes and safe error responses                                                         |
| src/models/tradeModel.ts                        | Risk/protection fields and unique active account/pair index                                                   |
| src/models/exchangeConnectionModel.ts           | Three-exchange restriction and opening lock                                                                   |
| src/services/exchangeConnectionService.ts       | Key permission validation and existing credential encryption                                                  |
| src/services/exchangeEnvironment.ts             | Matching live/test REST and WebSocket selection                                                               |
| src/services/withdrawalFeeService.ts            | Supported-exchange TRX price source for the existing withdrawal-fee quote                                     |
| src/app.ts                                      | Create trade indexes before resuming monitoring                                                               |
| src/types/index.ts                              | Only the three supported exchange IDs/account types                                                           |
| .env.example                                    | Explicit live and demo/test endpoints                                                                         |

Frontend changes cover the exchange connection modal, integrations list,
landing-page exchange section, exchange setup/connection examples, linked
exchange examples, trade-history filters/sample rows and privacy policy.
The setup permission wording now refers to futures trading.

## 13. Validation and practical limits

The automated backend suite covers:

- 50, 100, 250, 500 and 1,000 USDT balances.
- Fee-inclusive risk at or below 2%, downward quantity steps and long/short prices.
- Minimum quantity, minimum value, margin and leverage-limit rejection.
- Native OKX contract conversion and contract-based tier limits.
- Available balance rather than total equity on all three exchanges.
- Each exchange's own leverage mutation and read-back.
- Existing symbol exposure and unsupported account modes.
- Demo/live headers, endpoint selection and no automatic POST retries.
- Futures key permissions, including Bitget position permission.
- Ignored/tampered frontend balances and independently sized actual copier flows.
- Saved client IDs, duplicate rejection, changed balance and failed leverage.
- Missing-stop cancellation, emergency reduce-only closure and successful
  protection repair for all three exchanges.
- Manual reduce-only close and confirmed exit prices for all three exchanges.
- Weighted actual exit reconciliation and incomplete-history rejection.
- Amendment risk limits and the existing settlement, earning and withdrawal tests.

Run backend checks with `npm test` and `npm run build`.
The backend now has `npm run lint` for source, tests and scripts, alongside TypeScript compilation. The frontend has ESLint and a production build.

Original implementation validation (before the final audit): 78 backend tests passed, the backend TypeScript build passed,
the frontend production build passed, and ESLint passed for all changed frontend
files with no errors or warnings.

Automated tests use mocked exchange responses and temporary local MongoDB
databases. They do not prove real exchange execution. No live orders or real
demo-account trades were submitted during this implementation. Before enabling
live trading, verify the connect → leverage → entry → attached stop → triggered
exit cycle with the intended account mode on each exchange's demo/test account.

The 2% figure is the planned loss at the configured stop price including estimated
opening and closing trading fees. A stop is a trigger, not a guaranteed fill
price. Market gaps, slippage, funding payments, exchange outages and future fee
changes can make realized loss larger. The implementation checks and recovers
protection failures; it cannot promise an absolute loss cap.

## 14. Official API references used

- [Bybit API-key permissions](https://bybit-exchange.github.io/docs/v5/user/apikey-info)
- [Bybit available balances](https://bybit-exchange.github.io/docs/v5/account/wallet-balance)
- [Bybit leverage configuration](https://bybit-exchange.github.io/docs/v5/position/leverage)
- [Bybit risk limits](https://bybit-exchange.github.io/docs/v5/market/risk-limit)
- [Bybit position read-back](https://bybit-exchange.github.io/docs/v5/position)
- [OKX API documentation: instruments, leverage, tiers, orders and attached TP/SL](https://www.okx.com/docs-v5/en/)
- [Bitget Classic futures account APIs](https://www.bitget.com/docs/catalog/classic-contract-account/classic-contract-account)
- [Bitget Classic futures instrument/tier APIs](https://www.bitget.com/docs/catalog/classic-contract-market/classic-contract-market)
- [Bitget Classic futures order APIs](https://www.bitget.com/docs/catalog/classic-contract-trade/classic-contract-trade)
- [Bitget Classic TP/SL and pending-plan APIs](https://www.bitget.com/docs/catalog/classic-contract-plan/classic-contract-plan)
- [Bitget pending-order replacement behavior](https://www.bitget.com/api-doc/classic/contract/trade/Modify-Order)
