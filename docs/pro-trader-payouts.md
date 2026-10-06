# Pro-trader earnings and TRON payouts

The page is /dashboard/pro-trader/earnings (the withdrawals URL opens the same page on the Withdrawals tab). It shows all profitable closed copied trades belonging to the signed-in pro, with the copier profit, total fee, actual pro share, and collection/credit status. Historical recorded payouts remain visible as LEGACY_SUBMITTED because their blockchain finality was not stored.

## Accounting

For 100 USDT of copier profit: copier keeps 80, pro earns 5, platform keeps 15. New fee splits use integer micro-USDT and round the pro share down; any fractional micro-unit remainder in the collected fee stays with the platform. Financial balances use integer micro-USDT, with safe-integer bounds.

A completed settlement creates a unique ProEarning for the copied trade and credits the appropriate user balance in the same MongoDB transaction. Simulated and exchange-demo/testnet settlements credit proDemoUnits; explicitly recorded live settlements credit proLiveUnits. Older settlements with unknown funding provenance remain unallocated until reconciled. Pending fees are displayed but cannot be withdrawn. The worker retries interrupted pro credits.

MongoDB must be a replica set (including Atlas) or a sharded cluster. Standalone MongoDB cannot support these transactions. Startup creates the unique earning and withdrawal indexes before HTTP traffic is accepted.

## Demo

Set:
```dotenv
PRO_PAYOUT_MODE=demo
PRO_PAYOUT_LIVE_ENABLED=false
PRO_DEMO_FUNDING_ENABLED=true
```
Keep existing OTP/email configuration working. Sign in as an active, verified pro, visit the earnings page, choose Add demo funds, add a TRON address, verify it by email, and request a withdrawal. Each account can receive the fixed 100 USDT demo grant once. Demo withdrawals reserve only demo balances and the worker confirms them without constructing a TRON client. No key or company wallet funding is needed. Demo funds cannot convert to live funds.

## Live configuration

```dotenv
PRO_PAYOUT_MODE=live
PRO_PAYOUT_LIVE_ENABLED=true
PRO_DEMO_FUNDING_ENABLED=false
TRON_FULL_HOST=https://api.trongrid.io
TRON_COMPANY_PRIVATE_KEY=<server-side signing secret>
TRON_USDT_CONTRACT_ADDRESS=TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t
TRON_PRO_API_KEY=<optional provider API key>
```

The live adapter pins the mainnet USDT contract. Use a trusted mainnet HTTPS RPC endpoint. The company key must control the funded TRON payout wallet; the wallet needs USDT plus sufficient TRX/Energy/Bandwidth. The fee cap is 100 TRX per contract call; the company pays network costs. Secrets belong in your secret manager/environment and never in the frontend. No live transfer was used to test this implementation.

The existing PROFIT_WITHDRAWAL_MODE controls copier-to-platform exchange collection; it is separate from PRO_PAYOUT_MODE, which controls platform-to-pro payouts. These settings do not turn demo credits into live balances.

Wallet saves require an address-bound email OTP. Live payouts have a fixed 24-hour hold after wallet verification/change. OTP issue requests are throttled in the database (one minute per user), verification allows at most five failed attempts, and mutations also have per-account HTTP rate limits. Existing session authentication, pro role checks, verified/active status checks, and global CSRF protections apply.

## Withdrawal state and recovery

The request must provide an Idempotency-Key (16-80 alphanumeric, underscore or dash characters), amount as a decimal string, mode, and OTP. OTP context includes user email, action, exact integer amount, destination, mode and request ID.

Reservation, OTP consumption, durable withdrawal insertion and audit log commit in one transaction. Conditional balance updates prevent overdrafts. The same key and payload return the same record even after a response is lost.

QUEUED -> SIGNED -> CONFIRMED / FAILED / REVIEW.

The worker persists the signed transaction and txID before broadcast. Concurrent workers may prepare transactions, but only the compare-and-set winner can persist and send one. Retries broadcast only the persisted transaction, never a newly signed replacement. Confirmation uses the solidified receipt and checks the exact USDT Transfer event sender, recipient and amount. A definitive on-chain execution failure refunds exactly once in a transaction. Timeouts, missing receipts and expired transactions do not release funds.

REVIEW holds the reservation. An operator must investigate the persisted transaction ID against the trusted mainnet chain; never blindly reset SIGNED/REVIEW to QUEUED or refund because an RPC call timed out. Reconciliation must establish that the original transaction cannot execute and whether USDT actually moved. Document and audit any manual resolution. Monitor queued/signed age, REVIEW counts, company balances/resources, worker failures and unapplied credits. Changing the live switch pauses live submission/rebroadcast; it does not release reserved funds.

## Existing installations

The former proEarningsBalance mixed real and simulated settlement credits and did not persist a complete payout ledger. It is deliberately retained and displayed separately, not automatically imported into spendable live units. Before releasing historical money, reconcile each completed Settlement, credited Trade, old Withdrawal Executed audit entry, and actual chain/exchange transfer. Allocate only verified net outstanding obligations to live balance, document the reconciliation, and archive/clear the legacy display amount. Do not simply copy the legacy number into the new live field.

Missing historical payout audit entries cannot be reconstructed safely from the old balance alone. Historical credited rows without a new ledger are labeled legacy credit. New collection credits use the new ledger automatically.

Interrupted copier-fee settlement submissions also remain held for reconciliation instead of becoming retryable automatically; this prevents duplicate collection after a lost exchange response.

## Validation

Run npm test and npm run build in the backend. The pro-finance integration suite starts an isolated MongoDB replica set via mongodb-memory-server and never loads your .env or connects to the configured platform database. Initial test setup downloads the MongoDB binary. Tests exercise concurrent reservations, idempotency, OTP context, insufficient funds, wallet verification, isolated demo grants, credits, refunds and durable broadcast retries.

Run node node_modules/typescript/bin/tsc --noEmit and the scoped ESLint command in the frontend.

TRON references:
- [Broadcast signed transactions](https://tronweb.network/docu/docs/API%20List/trx/sendRawTransaction/)
- [Solidified receipts and confirmation](https://developers.tron.network/re/reference/gettransactioninfobyid-1)
