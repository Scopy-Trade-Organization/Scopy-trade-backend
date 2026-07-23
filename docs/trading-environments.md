# Futures trading environments

The trade flow supports Binance USD-M Futures and Bybit linear perpetuals.
Environment selection is configuration-based; no code needs to be commented or
uncommented.

## Testnet (default outside production)

```env
EXCHANGE_MODE=testnet
BINANCE_FUTURES_TEST_API_URL=https://testnet.binancefuture.com
BINANCE_FUTURES_TEST_WS_URL=wss://fstream.binancefuture.com
BYBIT_TEST_API_URL=https://api-testnet.bybit.com
BYBIT_TEST_WS_URL=wss://stream-testnet.bybit.com/v5/private
TESTNET_REBASE_SIGNAL_PRICES=true
```

Testnet rebasing anchors the order entry to the selected exchange's testnet
price, then scales TP and SL by the same ratio. This preserves the signal's
percentage risk/reward even when a testnet market has drifted away from live.
The original signal prices are retained in `rawOrderResponse`.

Set `TESTNET_REBASE_SIGNAL_PRICES=false` to test the live-style entry-deviation
guard against testnet prices.

## Live

```env
EXCHANGE_MODE=live
BINANCE_API_URL=https://fapi.binance.com
BINANCE_WS_URL=wss://fstream.binance.com
BYBIT_API_URL=https://api.bybit.com
BYBIT_WS_URL=wss://stream.bybit.com/v5/private
```

Live mode never rebases signal prices. It rejects an initiation when the
exchange price exceeds `TRADE_ENTRY_DEVIATION_LIMIT` from the signal entry
(2% by default).

API keys must be created in the matching environment and must have derivatives
trading permission. The current order implementation assumes one-way position
mode on both exchanges.
