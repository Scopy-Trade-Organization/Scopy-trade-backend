# Set up settlement payments

## How it works

At 10 USDT owed, a copier gets a settlement invoice, an email, and a dashboard
notification. New copied trades are blocked until payment is confirmed. Existing
positions continue being managed. The server never withdraws from the copier's
exchange account.

The user sends the exact invoice amount in mainnet TRC-20 USDT to your wallet,
including the displayed memo when supported. The server automatically checks
payments with invoice memos. Users can also submit a transaction hash manually,
including for payments without memos.

Withdrawals and settlements use `src/models/transactionModel.ts` in the
`transactions` collection. Settlement invoices have `settlementRecordKind: invoice`.
Permanent payment claims have
`settlementRecordKind: payment`, reference their invoice through `invoiceId`, and
use PROCESSING, CONFIRMED, and REJECTED states. A unique `network` /
`transactionHash` index protects claims. Confirmed claims must never be deleted
or expired.

Pro-trader earnings have their own schema in `src/models/earningModel.ts` and
collection `earnings`, with one unique earning per trade. Transaction `type` is
`withdrawal` or `settlement`. Amounts use integer USDT micro-units (`units`):
1 USDT is 1,000,000 units. There are no discriminators or demo finance modes.
The user model stores the total unpaid amount in `settlementOwedUnits` (the same
micro-unit format). Trade close adds fees and confirmed payment subtracts the
invoice amount, each in the same database transaction as the related records.
Summary requests read this stored balance directly. New users start with zero owed.

The invoice document's `_id` is its invoice ID. `address` holds the receiving
wallet, and `transactionId` holds the confirmed blockchain hash. Payment-claim
records store the normalized hash in `transactionHash`.

## 1. Set your receiving wallet

Choose a TRON wallet you control that can receive USDT (TRC-20). Copy its public
receiving address, usually starting with T. Put it in `SYSTEM_WALLET_ADDRESS`.
Do not use an Ethereum or BNB Chain address.

Receiving and verifying payments does not require a wallet private key. Remove
withdrawal permissions from copier exchange API keys; only trading permissions
are needed. Existing invoices keep their original wallet address if you change
this setting later.

## 2. Get your TronGrid API key

TronGrid lets your backend read blockchain data. Its API key is separate from a
wallet private key and cannot sign payments.

1. Visit [TronGrid](https://www.trongrid.io/).
2. Register an account, verify it if requested, and log in.
3. Open the console's **API Keys** / API key list page.
4. Create a key named something like `scopytrade-backend`.
5. Copy that key into your backend environment as `TRON_PRO_API_KEY`.
6. Check the console's current request quota. If you restrict allowed APIs,
   permit TRC-20 account history and the `/walletsolidity/` transaction and
   receipt endpoints. See [TRON confirmation semantics](https://developers.tron.network/docs/confirmation-semantics).
7. Restart the backend after saving your environment settings.

Production requests need a working API key. Anonymous access can be limited or
rejected. If you do not have a key yet, keep automatic verification disabled.
Invoices, email, and notifications still work, but hash verification also needs
working blockchain API access.

Official reference: [TronGrid API keys](https://developers.tron.network/reference/select-network).

## 3. Configure the backend environment

Set these in your real `.env` or hosting provider settings. Editing `.env.example`
alone does not configure the application.

```dotenv
SYSTEM_WALLET_ADDRESS=YOUR_PUBLIC_TRON_ADDRESS
TRON_FULL_HOST=https://api.trongrid.io
TRON_PRO_API_KEY=YOUR_TRONGRID_KEY
SETTLEMENT_AUTO_VERIFY_ENABLED=true
FRONTEND_URL=https://YOUR_FRONTEND_DOMAIN

GMAIL_CLIENT_ID=YOUR_EXISTING_GMAIL_CLIENT_ID
GMAIL_CLIENT_SECRET=YOUR_EXISTING_GMAIL_CLIENT_SECRET
GMAIL_REFRESH_TOKEN=YOUR_EXISTING_GMAIL_REFRESH_TOKEN
GMAIL_SENDER_EMAIL=YOUR_AUTHORIZED_SENDER_EMAIL
GMAIL_SENDER_NAME=SCopyTrade

ENABLE_TEMPORARY_TEST_ENDPOINTS=false
PRO_PAYOUT_LIVE_ENABLED=false
```

Use `TRON_FULL_HOST` for both settlement verification and pro payouts. The network
and mainnet USDT contract are fixed in code. Exchange trading uses one
`EXCHANGE_MODE` setting; `testnet` selects the test/simulated environment for all
exchanges and `live` selects real accounts. `BITGET_API_URL` is the single Bitget
REST override. Authentication uses `JWT_SECRET` for both token kinds; access and
refresh tokens retain their separate types and expiration settings.

Keep your existing MongoDB, authentication, encryption, and exchange settings.
The email integration uses your existing Gmail OAuth credentials with the
`gmail.send` scope. Reuse the credentials that already send OTP messages.
For a new Gmail sender, follow [Google's OAuth setup](https://developers.google.com/identity/protocols/oauth2/web-server)
and [sending guide](https://developers.google.com/workspace/gmail/api/guides/sending).

`PRO_PAYOUT_LIVE_ENABLED` controls outgoing pro-trader withdrawals only. Leave it
false until you configure `TRON_COMPANY_PRIVATE_KEY` and fund that wallet with
USDT and TRX. There are no simulated payouts or demo-credit endpoints.

## 4. Deploy

1. Back up your database and stop all old backend instances.
2. Use MongoDB Atlas or another replica set; database transactions require it.
3. Run `npm run build` in the backend and deploy the matching frontend changes.
4. Start the backend with `npm start`.

The server creates transaction, earning, and notification indexes before accepting
requests. The database account needs permission to create those indexes.

## 5. Paying an invoice

The copier dashboard displays the amount, receiving wallet, and unique memo.
Users should send the **exact** amount on TRON and attach that memo as actual
transaction metadata when their wallet supports it. A note saved only inside a wallet app is not a blockchain
memo. Keep enough TRX in the sending wallet for network fees.

Settlement users pay all network, gas, and exchange withdrawal fees separately.
The full invoice amount must arrive at the company wallet. If an exchange
deducts its transfer fee from the amount sent, increase the exchange withdrawal
so that the receiving amount still exactly matches the invoice. Network fees
do not reduce the settlement debt or earn payment credit.

The backend worker checks every minute when automatic verification is enabled.
The dashboard refreshes payment state every 30 seconds and the notification bell
every minute. There are no push notifications or notification WebSockets.

If automatic detection misses the payment, paste its 64-character transaction
hash into **Verify payment**. Verification checks confirmed execution, the USDT
contract, recipient, exact amount, invoice creation time, and any existing memo. A transfer
cannot be used twice.

If a wallet or exchange omitted the memo, submit the hash directly. No wallet
signature or routine admin approval is required. The first account that claims
the hash and passes verification receives credit. A public memo-less transaction
cannot establish which Scopy Trade user initiated it. An existing nonempty memo
must match the invoice. Wrong memos, partial payments, overpayments, and
wrong-network payments are rejected; exact amounts remain required.

Claims are created atomically before blockchain verification. Concurrent claims
are protected by the unique database index. Failures leave REJECTED records and
can be retried; PROCESSING leases expire after two minutes to recover interrupted
requests. Claim tokens prevent an older request from confirming after takeover.
CONFIRMED records remain permanently unavailable to other invoices. Repeating a
successful submission for the same invoice is idempotent. Previously confirmed
invoice hashes remain protected by the existing transaction index and lookup.

The invoice stays fixed if more trades close. Those later fees may produce a
second invoice if they reach 10 USDT. Confirmed payment credits each pro earning
once. Dashboard notifications are stored even if email delivery fails; failed
emails retry.

## 6. Verify the installation

Run `npm test` and `npm run build` in the backend. Tests use an isolated MongoDB
replica set and mocked receipts; they send no payments or emails. The first test
run may download MongoDB's test binary. Build the frontend as usual too.

Use staging users to check that reaching 10 USDT creates one invoice, blocks new
copies, sends email, and updates the bell. Final live acceptance needs a deliberate
mainnet payment and working Gmail/TronGrid credentials. Testnet tokens are not
accepted as real USDT.

Main endpoints:

- `GET /api/copy-trader/dashboard/profit-share`: totals and current invoice.
- `POST /api/copy-trader/dashboard/profit-share/verify`: accepts `settlementId`,
  `transactionHash`.
- `GET /api/copy-trader/dashboard/notifications`: notices and unread count.
- `PATCH /api/copy-trader/dashboard/notifications/:id/read`: mark a notice read.
- `GET /api/admin/dashboard/settlements`: settlement inspection.

These use normal authentication and existing CSRF protection for writes. The old
settlement approval route only returns the invoice; it cannot withdraw money.
The old `/api/temporary/withdraw-usdt` route returns HTTP 410.

The automatic scanner checks up to 20 invoices per run and five pages of 200
transfers per invoice, persisting each fully processed page's fingerprint and
fixed timestamp window on the invoice. Subsequent runs and restarts resume that
window instead of starting over. A failed page is replayed. A rejected expired
provider cursor restarts only the same window; payment claims prevent duplicate
credit. Invoice scan leases coordinate backend instances.

Once a window is drained, the scanner advances with a one-minute overlap and a
two-minute indexing delay allowance. Longer TronGrid indexing delays or repeated
provider cursor expiry can still delay or miss automatic discovery; manual hash
verification remains available for every valid payment. Memo-less transfers are
never automatically assigned. Monitor provider quotas and worker logs.

Deployment must stop older backend instances before starting the corrected
version. Index creation deliberately fails if existing data assigns one trade
fee to multiple invoices; reconcile those historical inconsistencies before
restarting. Do not remove unique indexes to bypass an initialization failure.
