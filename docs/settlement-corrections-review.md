# Settlement and withdrawal corrections review

## Preserved protections

The original implementation already provided transactional invoice creation,
transactional trade-close fee accrual, one open settlement per user, unique
invoice memos and transaction IDs, fixed invoice amounts, and idempotent pro
credits. It verified solidified TRON transactions, official mainnet USDT,
receiving wallet, exact transfer amount, receipt logs, and invoice creation time.
Those protections remain. Authentication, rate limits, wallet verification,
withdrawal OTPs, wallet-change holds, and durable signed payout retries remain.

## Final storage

- `Transaction` / `transactions`: withdrawals, settlement invoices, and settlement
  payment claims. Settlement records use `settlementRecordKind` to distinguish
  invoices from claims; admin invoice lists exclude claim records.
- `Earning` / `earnings`: confirmed pro-trader credits, with a unique trade index.
  Credit insertion, available balance changes, and trade credit status commit
  together. Earnings summaries read this collection; trade history still shows
  pending prospective earnings.
- No `SettlementPayment` model and no data migration service or startup migration.

## Settlement corrections

| Requirement | Final behavior |
| --- | --- |
| Memo-less payments | Manual hash verification accepts them without wallet signatures or routine admin approval. First valid submission wins. |
| Existing memos | Nonempty memos must match the invoice; malformed memos are rejected. |
| Permanent hash protection | Normalized hashes are atomically claimed before verification. A unique `(network, transactionHash)` database index protects concurrent submissions. Confirmed claims never expire. |
| Failures and restarts | Claims use PROCESSING, CONFIRMED, and REJECTED states. Failed claims can be retried. Expiring processing leases recover interrupted work; claim tokens prevent stale requests from confirming or releasing another request's claim. |
| Atomic confirmation | Claim, invoice, user debt, assigned trade fees, and notification commit together. Copying access is derived from the committed debt and processing-fee state. |
| Fee reconciliation | Assignment checks ownership, unassigned batch status, and modified counts. Confirmation checks every assigned trade and their exact total. A unique trade-ID index prevents assigning one trade fee to multiple invoices. |
| Automatic detection | Only explicit invoice memos are matched. Fully processed page cursors and fixed timestamp windows are stored on invoices and survive restarts; incomplete pages are retried. |
| Copy restrictions | Subscription start remains guarded. The automatic copy worker independently checks immediately before execution, and the shared trade service rechecks immediately before placing an order. |

## User-paid transfer costs

Settlement senders cover their wallet's gas and exchange transfer fees. The
full invoice amount must arrive; these costs never reduce settlement debt.

For withdrawals, the entered amount is the total reservation. The user approves
the wallet payout and network-fee reserve before confirming the OTP. The OTP
binds the entire quote. The wallet receives the reservation minus the reserve;
after confirmation, actual gas is charged and any unused reserve returns to the
user's balance. Failed transfers refund unsent funds minus gas consumed.

Fees use current TRON resource prices and Energy estimation, with contract
simulation when estimation is unavailable. A live TRX/USDT rate is locked at
quote time. Transaction size and Energy limits bound costs; changed bandwidth
prices prevent rebroadcast. Exceptional confirmed overruns remain user charges
or outstanding network-fee debt, repaid from future credits before withdrawals.
Worker confirmation and admin reconciliation use the same atomic accounting.

## Verification and practical limits

The automated suite covers concurrent hash submissions, confirmed reuse,
memo and memo-less receipts, invalid token/recipient/amount/status, unavailable
receipts and APIs, claim recovery and stale claims, invoice reconciliation
rollback, duplicate trade allocation, conflicting invoice payments, scanner
progress beyond 1,000 transfers, and copy-worker/shared-service restrictions.
Withdrawal tests cover quotes and estimation fallback, fee rounding, signed
size limits, actual fees, zero gas, refunds, overruns, reconciliation, concurrent
OTP approval, quote expiry, fee tampering, and atomic rollback on missing users.

Tests use isolated MongoDB replica sets and mocked chain/price responses. Real
mainnet payments, funded payout wallets, provider permissions, price-provider
reachability, and email delivery still need deployment acceptance checks.
Quotes fail safely if prices or chain estimates cannot be obtained.

The scanner uses a two-minute indexing allowance and a one-minute overlap.
Longer indexing delays can miss automatic discovery; persistent provider cursor
expiry can force window replay. Manual verification remains available.
Exact amounts, mainnet USDT, direct transfers, and payments made after invoice
creation remain required. Partial payments and overpayments remain rejected.
MongoDB must support transactions and allow startup index creation.
