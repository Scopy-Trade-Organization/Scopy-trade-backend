# Pro-trader earnings and TRON payouts

The earnings page is `/dashboard/pro-trader/earnings`. The withdrawals URL opens
the same page on its Withdrawals tab.

## Accounting

For 100 USDT of profitable copied trades, the copier keeps 80 USDT, the pro earns
10 USDT, and the platform receives 10 USDT. Amounts use integer USDT micro-units:
1 USDT is 1,000,000 units.

Pro-trader credits use the dedicated `Earning` model and `earnings` collection,
with a unique trade ID. Withdrawals and settlements use `Transaction` with type
`withdrawal` or `settlement`. Confirmed settlement payment marks its fees
collected. Each pro earning is credited once to `User.proBalanceUnits` in the
same database transaction as its earning record. Pending fees are not available
to withdraw. The worker retries interrupted pro credits.

Copier debt is stored separately in `User.settlementOwedUnits`. New users start
with zero debt and zero available earnings. See
[settlement setup](settlement-payments-setup.md) for incoming payments.

MongoDB must support transactions (Atlas or another replica set). Startup creates
transaction and earning indexes before accepting requests. No data migration is
needed for a blank database.

## Outgoing payout configuration

Set these backend environment variables:

- `PRO_PAYOUT_LIVE_ENABLED`: false until the payout wallet is configured and funded.
- `TRON_FULL_HOST`: https://api.trongrid.io
- `TRON_COMPANY_PRIVATE_KEY`: the company payout wallet's signing key, backend only.
- `TRON_PRO_API_KEY`: your TronGrid key.

Fund the company wallet with USDT and enough TRX for network fees before enabling
payouts. The adapter uses mainnet USDT and caps the contract-call fee at 100 TRX.
There are no demo payout balances or modes.

The provider API key must allow chain parameters and Energy estimation or
constant-contract simulation as well as transaction creation, broadcasting, and
solidified receipts. The backend also needs access to OKX's public
`TRX-USDT` spot ticker endpoint for fee conversion.

Wallet verification uses an address-bound email OTP. Adding or changing a payout
wallet starts a 24-hour withdrawal hold. Pro accounts must be active and verified.
Existing authentication, rate limits, and CSRF protection apply.

## Withdrawal requests

A request provides a decimal-string amount, OTP, and an `Idempotency-Key` header
containing 16-80 letters, numbers, underscores, or hyphens. The OTP is bound to the
amount, wallet, and request ID.

The entered amount is the total balance reservation. Network fees are deducted
from it; the remainder is sent to the user's wallet. The OTP request returns a
quote with `amount`, `payoutAmount`, `networkFeeReserve`, and `quoteExpiresAt`.
The dashboard and OTP email display these amounts before confirmation.

Quotes expire after ten minutes and use live TRON Energy estimates, current
chain resource prices (with contract simulation when the estimation endpoint is
disabled), a 25% Energy allowance, and a 1,024-byte bandwidth budget.
TRX costs are converted to USDT using OKX's public live TRX/USDT spot price,
rounded up to micro-units and locked to the quote. Estimation or pricing errors
prevent approval; there is no free-fee fallback. The quote must leave a positive
payout. The Energy budget remains capped at 100 TRX.

Unapproved quotes have status `QUOTED` and reserve no funds. OTP consumption,
the transition to `QUEUED`, gross balance reservation, and the audit entry commit
together. The OTP binds the payout, fee reserve, conversion rate, wallet, total,
and request ID. Repeating a submitted request returns the same withdrawal.

States are `QUEUED`, `SIGNED`, `COMPLETED`, `FAILED`, and `REVIEW`. The worker saves
the signed transaction before broadcasting. Retries send that same transaction.
After confirmation, the receipt's total burned TRX fee is charged at the locked
conversion rate. Successful transfers refund the unused fee reserve to the
user's balance. Failed transfers refund unsent funds minus gas actually consumed.
Zero-cost execution returns the entire fee reserve. Confirmation, fees, refunds,
balance changes, and audit records commit atomically, including admin
reconciliation. Unresolved receipts and expired transactions stay reserved for
review. Pausing payouts stops submission and rebroadcast without releasing funds.

The company wallet still needs TRX because TRON charges the transaction sender;
the withdrawal's USDT deduction recovers that cost from the withdrawing user.
The worker verifies the signed transaction's size, payout, fee limit, and current
bandwidth price before broadcasting. Unexpected costs above the reserve are
charged to available user funds; any unpaid remainder is stored as
`proNetworkFeeOwedUnits`. Earnings and rank credits first cover that debt, and
further withdrawals are blocked while it remains. Costs are never silently
written off as a platform expense.

See [TRON resource payment rules](https://developers.tron.network/docs/paying-for-resources)
and [Energy estimation](https://developers.tron.network/reference/estimateenergy).

Operators can inspect and reconcile withdrawals from the admin dashboard. Check
the saved hash and actual chain result before resolving a payment under review.

## Checks

Run `npm test` and `npm run build` in the backend. Tests are in `test/` and use an
isolated MongoDB replica set with mocked blockchain receipts. Tests send no real
payments and do not use the application's database. The first run may download
MongoDB's test binary. Build the frontend separately after UI changes.
