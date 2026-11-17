# Pro-trader earnings and TRON payouts

The earnings page is `/dashboard/pro-trader/earnings`. The withdrawals URL opens
the same page on its Withdrawals tab.

## Accounting

For 100 USDT of profitable copied trades, the copier keeps 80 USDT, the pro earns
10 USDT, and the platform receives 10 USDT. Amounts use integer USDT micro-units:
1 USDT is 1,000,000 units.

All financial records use the `Transaction` model with type `earning`,
`withdrawal`, or `settlement`. Confirmed settlement payment marks its fees
collected. Each pro earning is credited once to `User.proBalanceUnits` in the
same database transaction as its earning record. Pending fees are not available
to withdraw. The worker retries interrupted pro credits.

Copier debt is stored separately in `User.settlementOwedUnits`. New users start
with zero debt and zero available earnings. See
[settlement setup](settlement-payments-setup.md) for incoming payments.

MongoDB must support transactions (Atlas or another replica set). Startup creates
transaction indexes before accepting requests.

## Outgoing payout configuration

Set these backend environment variables:

- `PRO_PAYOUT_LIVE_ENABLED`: false until the payout wallet is configured and funded.
- `TRON_FULL_HOST`: https://api.trongrid.io
- `TRON_COMPANY_PRIVATE_KEY`: the company payout wallet's signing key, backend only.
- `TRON_PRO_API_KEY`: your TronGrid key.

Fund the company wallet with USDT and enough TRX for network fees before enabling
payouts. The adapter uses mainnet USDT and caps the contract-call fee at 100 TRX.
There are no demo payout balances or modes.

Wallet verification uses an address-bound email OTP. Adding or changing a payout
wallet starts a 24-hour withdrawal hold. Pro accounts must be active and verified.
Existing authentication, rate limits, and CSRF protection apply.

## Withdrawal requests

A request provides a decimal-string amount, OTP, and an `Idempotency-Key` header
containing 16-80 letters, numbers, underscores, or hyphens. The OTP is bound to the
amount, wallet, and request ID.

Balance reservation, OTP consumption, transaction insertion, and the audit entry
commit together. Repeating the same request returns the same withdrawal.

States are `QUEUED`, `SIGNED`, `COMPLETED`, `FAILED`, and `REVIEW`. The worker saves
the signed transaction before broadcasting. Retries send that same transaction.
Confirmed failure refunds once; unresolved receipts and expired transactions stay
reserved for review. Pausing payouts stops submission and rebroadcast without
releasing reserved funds.

Operators can inspect and reconcile withdrawals from the admin dashboard. Check
the saved hash and actual chain result before resolving a payment under review.

## Checks

Run `npm test` and `npm run build` in the backend. Tests are in `test/` and use an
isolated MongoDB replica set with mocked blockchain receipts. Tests send no real
payments and do not use the application's database. The first run may download
MongoDB's test binary. Build the frontend separately after UI changes.
