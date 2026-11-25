# Exchange connection setup

The frontend connection modal contains separate Bybit, OKX and Bitget guides.
Each guide explains the API creation form's fields before the user submits it.
These connections use system-generated HMAC keys, rather than RSA keys or an
exchange's registered third-party app binding flow.

## Bitget Unified Trading Account

Bitget connections now use UTA v3. Enable UTA management and UTA trading
Read-write permissions. Trading requires One-way Mode and isolated margin for
each USDT futures symbol; Classic Single-asset Mode instructions no longer apply.
See [the migration and deployment notes](bitget-uta-migration.md).

## Public server IP endpoint

`GET /api/exchanges/server-ip` requires no login and returns:

```json
{ "success": true, "ips": ["198.51.100.1", "203.0.113.2"] }
```

The example IPs are documentation placeholders. The frontend retrieves the real
addresses from this endpoint and lets users copy them into the exchange's IP
allowlist. Every returned address must be added.

Set `EXCHANGE_OUTBOUND_IPS` to the server's stable public outbound addresses,
separated by commas or spaces. For production deployments with multiple workers,
NAT gateways or different routes to exchanges, configure the complete egress
list explicitly and verify that requests to each exchange use those addresses.
The frontend hostname, inbound proxy IP and user's IP are not substitutes.

If the variable is empty, the backend discovers its outbound IPv4 using
`https://api.ipify.org`, with a five-second timeout and a five-minute in-process
cache. Concurrent lookups share the same request. Discovery reflects the route
to that service; it cannot enumerate other workers or exchange-specific routes.
Invalid configuration or unavailable discovery returns HTTP 503 with
`success: false`; the frontend offers Retry and displays no fallback address.

If egress IPs change, existing exchange API allowlists must be updated too.

## Guide references

- [Bybit creation guide and screenshots](https://www.bybit.com/en/help-center/article/How-to-create-your-API-key)
- [OKX API creation FAQ](https://www.okx.com/help/api-faq)
- [Bitget illustrated API creation walkthrough](https://www.bitget.com/academy/trade-crypto-on-bitget-using-twm-one)

Exchange labels can vary by account and region. Keep the field mappings in
`lib/exchangeConnectionGuides.ts` in the frontend repository aligned with these
sources and the backend's required futures permissions.
