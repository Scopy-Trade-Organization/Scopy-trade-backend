# Trader subscriptions and ranks

Copy traders now discover active pro trader profiles, open profile details, and subscribe using an owned, active supported exchange connection and a USDT allocation. One active subscription is allowed per copier/pro pair. Onboarding, trade monitoring/history and withdrawal mechanics are preserved. Old per-trade discovery routes are removed; manual copy submission returns HTTP 410.

The allocation is the balance used by the existing 2% stop-loss risk calculation for each future trade. It is not a deposit or reserved balance. Concurrent trades can increase aggregate exposure. Live connected balance is verified before each automatic order; an insufficient balance results in a notification. Starting or restarting a subscription never copies existing pro positions. Stopping prevents queued and future orders; an exchange submission already in flight may still finish. Existing positions continue receiving protection updates and pro closures.

## Automatic execution

`initiateTrade` calls `triggerAutomaticCopies` without awaiting it after a successful pro order. The helper creates durable `CopyExecution` records, with a unique source-trade/connection key. Eight workers claim jobs atomically. Accounts are locked while submitting an order; competing jobs wait for a later poll. Existing active-pair and source-copy checks still apply in the shared execution service.

Startup and the 15-second recovery poll recover source trades whose durable `copyFanoutAt` marker has not been set, including trades that closed during downtime. Fan-out is marked complete only after all job records have been persisted. Subscriptions must predate a source order. Failed orders are never automatically resubmitted. Persisted failure notifications appear under Copy Notifications and are also queued through the existing email service. Email delivery requires the existing Gmail configuration. Notification persistence is retried independently of order execution.

An interrupted processing job is reconciled after ten minutes. A locally persisted copied trade completes the job; otherwise it is marked failed and the user is notified to inspect exchange history. An uncertain placement response retains its account lock. Operators must verify the actual exchange order, persist/reconcile any missing trade record, and only then remove the corresponding `CopyExecutionLock`. Do not unlock and blindly resubmit an uncertain order.

## Rank policy

All pro traders begin at level 0, Newcomer. Rank requirements and bonuses:

| Level | Name | Active copiers | Closed trades | Win rate | Max drawdown | One-time bonus |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| 1 | Starter | 50 | 50 | >=70% | <25% | $50 |
| 2 | Growth | 200 | 50 | >=70% | <25% | $200 |
| 3 | Pro | 500 | 50 | >=70% | <25% | $500 |
| 4 | Elite | 1000 | 60 | >=70% | <25% | $1200 |
| 5 | Legend | 2000 | 60 | >=70% | <25% | $2400 |

A rank-active copier has an active subscription, an active account, at least $100 on the selected active exchange connection (verified within 24 hours), at least 15 filled/closed copies for that pro created in the current UTC calendar month, and at least $10 total generated fees closed that month. Pending unfilled and cancelled orders do not count. Balance snapshots refresh in the background. Fees awaiting collection count as generated fees; bonus payout still requires platform earnings verification.

Win rate and trade count use all closed pro trades. Drawdown uses a normalized closed-trade equity curve compounded from realized PnL divided by recorded sizing balance, ordered by close time. It is not intraday mark-to-market drawdown. Missing sizing/PnL data produces unknown drawdown and prevents promotion. This convention is exposed in the rank UI because the reference does not specify a drawdown calculation or performance window.

Ranks are evaluated on profile/rank reads and every five minutes. Qualification creates one unique `RankAward` per user/level. Badges require at least 50% of that level's active copier count to remain visible. Earned awards persist through badge loss, restoration, and monthly activity resets.

Admins review pending awards under Rank Bonuses. `GET /api/admin/dashboard/pro/rank-awards` lists the first 100 pending awards; `POST /api/admin/dashboard/pro/rank-awards/:id/verify` requires `platformEarningsVerified: true`. Verification and credit to the current demo/live payout balance commit together in a MongoDB transaction. Repeated or concurrent verification cannot credit twice. Credits appear in the pro rank award status and total earned balance and use existing withdrawal controls. MongoDB transactions require a replica set, as existing finance operations already do.

New profitable copies use the reference's 20% total fee: 10% trader, 10% platform. Previously recorded trade fees and earnings are preserved.

## Checks

Run `npm run build` and `npm test` in the backend. Integration tests create their own disposable MongoDB replica set and stub exchange execution; they never use the application database or submit real trades. The first test run may download a MongoDB binary. Run `npm run build` in the frontend. Live exchange placement, configured email delivery and visual browser QA still need an environment with those capabilities.
