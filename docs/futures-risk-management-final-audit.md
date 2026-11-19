# Futures risk management final audit

Audit date: 19 November 2026. This document supersedes the original implementation's approximate liquidation check and its support for cross-margin opening.

## Preview and execution

`tradePlanningService.planTrade()` is the read-only planner used by preview and the existing manual/copier execution flow. It retrieves market data and the exchange context, applies the same entry-deviation guard and decimal testnet rebasing, and calls `calculateTradeRisk()`. Connection ownership and credential decryption remain server-side. Legacy `balance` input is optional and ignored.

Authenticated `POST /trades/preview` accepts `sourceTradeId` and `exchangeConnectionId`. It requires an active, protected source trade and active signal. Legacy preview fields remain, but now report the final rounded quantity, actual available futures balance and fee-inclusive estimated loss. Additional fields expose native order quantity, notional, leverage, initial margin and the full sizing snapshot. Preview neither changes leverage nor submits orders. Execution retains its account lock, duplicate guards, leverage verification, submission-time balance refresh, saved attempt, protection/recovery and monitoring.

## Liquidation models

Definitions: `E` = entry price, `q` = base quantity (native contracts multiplied by contract size for OKX), `M` = initial margin before closing-fee allocation, `r` = maintenance rate, `f` = taker rate, `d` = maintenance deduction. Existing exposure in this symbol is rejected before planning. No added isolated margin is assumed.

For additional conservatism, the implementation replaces `M` with `C = M - q*(E+SL)*f`: both opening and planned closing trading fees are withheld from supporting collateral. These are estimated boundaries with extra reserves, not predictions of an exact exchange-displayed price.

### Bybit USDT linear, Unified isolated

Long: `(q*E - C - d)/(q*(1-r))`. Short: `(q*E + C + d)/(q*(1+r))`. This uses Bybit's published isolated no-added-margin formula; bankruptcy closing-fee terms cancel between its initial and maintenance margin accounting. The live risk API supplies `mmDeduction`. Missing deductions fail closed. Candidate boundaries must fall within their notional tier; the nearer boundary is used if multiple candidates apply.

Sources: [Bybit liquidation formulas](https://www.bybit.com/en/help-center/article/UTA-Trading-Rules-Liquidation-Process), [risk-tier API](https://bybit-exchange.github.io/docs/v5/market/risk-limit).

### OKX linear USDT swap, isolated net positions

Solve `C + direction*q*(P-E) = q*P*(r+f)`. Long: `(q*E-C)/(q*(1-r-f))`; short: `(q*E+C)/(q*(1+r+f))`. The fee term represents the liquidation/deleveraging fee in the maintenance-ratio denominator. Maintenance tiers are selected in native contracts, not base quantity or dollar notional.

Sources: [OKX isolated maintenance and liquidation rules](https://www.okx.com/en-gb/help/frequently-issues-of-contracts-for-compulsory-liquidation), [API specifications](https://www.okx.com/docs-v5/en/).

### Bitget Classic v2 USDT perpetual, single-asset isolated

Use its Classic isolated equation `(C+d-q*E*direction)/(q*(r+f-direction))`. Classic v2 tier responses expose the rate and notional range but no maintenance deduction. Only the first tier beginning at zero, with zero deduction, is supported. Entry and the estimated boundary must remain within that tier. Higher-tier cases are rejected rather than assigned an invented deduction. UTA formulas are not used for Classic accounts.

Sources: [Bitget liquidation mechanism, official French version](https://www.bitget.com/fr/support/articles/12560603895826), [Classic position-tier API](https://www.bitget.com/docs/catalog/classic-contract-position/classic-contract-position).

## Safety and rejection behavior

The long boundary must be below the stop; the short boundary must be above it. Clearance must strictly exceed both one price tick and `abs(E-SL) * LIQUIDATION_SAFETY_BUFFER_RATE`. The default buffer rate is `0.1`, meaning 10% of entry-to-stop distance. Configuration must be greater than zero and less than one. Amendments also revalidate liquidation clearance without enlarging the original risk or margin allowance.

Cross, portfolio, hedge and unsupported account modes are rejected: account-wide liquidation cannot be established from one position's initial margin. No account margin mode is silently switched. Missing, malformed or failed balance, fee, tier and market responses cannot produce an assumed-safe preview or entry. Minimum-size orders are never rounded upward to fit an exchange minimum.

## Validation and limits

Automated tests mock exchange responses; database-backed tests use temporary local MongoDB replica sets. Test files run serially with a longer database startup allowance to avoid concurrent startup failures on slower hosts. The backend now has an ESLint command checking source, tests and scripts for structural JavaScript/TypeScript errors, alongside strict TypeScript compilation.

Coverage includes manipulated preview balances, $50/$100 examples, preview/execution sizing parity, no preview mutations, minimum rejection, long/short calculations on every exchange, unsafe boundaries, configurable clearance, missing tiers/deductions, unsupported modes, API failures, and the existing copy, protection, settlement and withdrawal regressions.

Final validation: TypeScript build passed; backend ESLint passed; the complete suite passed 106/106 tests. After the final missing-tier regression was added, the affected exchange suite passed 12/12 tests, including that new case (107 distinct tests verified overall). `git diff --check` passed. The first concurrent run failed during temporary database startup; serial execution with the longer startup allowance passed. Existing settlement tests log missing test email configuration without failing.

No live or demo orders were submitted. Stops remain subject to slippage, gaps, funding and outages. The buffer cannot guarantee a mark-price versus last-price relationship; in particular, Bitget Classic preset entry TP/SL does not expose a selectable trigger basis in the place-order schema. Existing recovery uses mark-price protection. Real account testing remains necessary to confirm actual fills, margin allocation and protection behavior. API pagination or incomplete tier tables may cause conservative rejection when no verified tier covers the boundary. Accounts whose APIs omit the required available-balance or reserved-margin fields are rejected; isolated balance availability has not been demonstrated with a live Bybit account.

Older saved trades without the required isolated-mode/deduction snapshot cannot safely pass a new amendment liquidation check; they retain their existing close and reconciliation paths. Binance remains unsupported.

## Files changed

- Planning and execution: `src/services/tradePlanningService.ts`, `src/services/tradeExecutionService.ts`.
- Preview: `src/controllers/tradeController.ts`, `src/routes/tradeRoutes.ts`.
- Risk and exchange rules: `src/services/tradeRiskService.ts`, `src/services/futuresExchangeService.ts`.
- Tests: `test/liquidationSafety.test.ts`, `test/tradeRiskService.test.ts`, `test/futuresExchangeService.test.ts`, `test/tradeExecutionService.test.ts`; startup allowance only in `test/settlementPaymentService.test.ts`.
- Configuration and test runner: `.env.example`, `eslint.config.mjs`, `package.json`, `package-lock.json`, `scripts/run-tests.mjs`.
- Documentation: this report and `docs/futures-risk-management-implementation.md`.
