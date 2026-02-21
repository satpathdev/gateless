# Gateless

Sovereign L402 payments for AI agents on Lightning.

Gateless is a JavaScript/TypeScript library that lets AI agents in Node.js autonomously pay for L402-protected web resources over the Lightning Network. Supports both the classic L402 protocol (macaroon + invoice) and Fewsats L402 v0.2 (offers + payment request). You run your own node. Your agent handles payments within spending limits you define. No accounts, no API keys, no identity - payment is authentication.

## Why

AI agents need to pay for things. The emerging solutions either lock you into custodial stablecoins ([x402](https://www.x402.org/)) or require shell access to Go CLI tools ([lnget](https://github.com/lightninglabs/lightning-agent-tools)). Neither works for a web developer building an agent in TypeScript.

Gateless fills the gap: a self-contained JS/TS toolkit that connects to **your own LND node** and handles L402 payments programmatically. No custodian, no corporate infrastructure, your keys.

## Install

```bash
npm install gateless
```

## Quick Start

```typescript
import { LndClient, L402Client } from "gateless";

const lnd = new LndClient({
  host: "127.0.0.1",
  port: 8080,
  tlsCertPath: "./creds/tls.cert",
  macaroonPath: "./creds/admin.macaroon",
});

const client = new L402Client({
  paymentProvider: lnd,
  maxPaymentSats: 100,
  spendingLimits: {
    maxPerPaymentSats: 50,
    maxTotalSats: 1000,
    maxPaymentsPerMinute: 10,
  },
});

// Use it like fetch - L402 payments happen automatically
const response = await client.fetch("https://api.example.com/paid-resource");
const data = await response.json();
```

If the server returns `402 Payment Required`, Gateless automatically detects the protocol version and handles payment:

**Classic L402** - Parses the `WWW-Authenticate` header, pays the invoice, caches the macaroon+preimage token, and retries with `Authorization: L402`. Second requests reuse the cached token.

**Fewsats v0.2** - Parses the JSON offers body, selects an offer, fetches a Lightning invoice from the payment request endpoint, pays it, and retries with the original request headers (Bearer token). The server credits your account after payment.

### Fewsats v0.2

Most live L402 endpoints today use the Fewsats v0.2 protocol. Your Bearer token (obtained separately) is your credential - Gateless handles the payment when the server returns 402:

```typescript
const client = new L402Client({
  paymentProvider: lnd,
  maxPaymentSats: 100,
});

// Bearer token is passed through - Gateless pays when the server demands it
const response = await client.fetch("https://api.example.com/paid-resource", {
  headers: { Authorization: "Bearer your-api-token" },
});
const data = await response.json();
```

You can customize which offer is selected when multiple are available:

```typescript
import { L402Client, type OfferStrategy } from "gateless";

const pickMostCredits: OfferStrategy = (offers) => {
  const lightning = offers.filter((o) =>
    o.payment_methods.includes("lightning"),
  );
  if (lightning.length === 0) throw new Error("No lightning offers");
  lightning.sort((a, b) => b.balance - a.balance);
  return lightning[0]!;
};

const client = new L402Client({
  paymentProvider: lnd,
  maxPaymentSats: 100,
  offerStrategy: pickMostCredits, // default: cheapest lightning-compatible offer
});
```

## Features

**L402 Client** - Drop-in `fetch` wrapper that handles the full 402 → pay → retry flow automatically. Supports both classic L402 and Fewsats v0.2.

**Fewsats v0.2** - Automatic offer selection, payment request negotiation, and Bearer token auth. Pluggable offer strategy (default: cheapest lightning-compatible).

**Token Cache** - Stores paid macaroon+preimage pairs for classic L402. Avoids double-paying for the same resource. Supports optional TTL expiry.

**Spending Controls** - Set per-payment limits, total budgets, and rate limits. Applies to both classic and v0.2 flows. An AI agent physically cannot exceed the budget you define.

**Payment Provider Interface** - Ships with an LND client over REST. Bring your own provider by implementing a simple interface:

```typescript
interface PaymentProvider {
  payInvoice(paymentRequest: string): Promise<PaymentResult>;
}
```

## How L402 Works

L402 is a protocol that uses Lightning Network payments for authentication. Gateless supports two variants:

### Classic L402

The server returns a macaroon and invoice in the `WWW-Authenticate` header. After payment, the preimage proves you paid.

```
Agent                          Server
  |      GET /resource           |
  |----------------------------->|
  |  402 + WWW-Authenticate:     |
  |    L402 macaroon="...",      |
  |    invoice="lnbc..."         |
  |<-----------------------------|
  |  [pays Lightning invoice]    |
  |  GET /resource               |
  |  Authorization: L402         |
  |    <macaroon>:<preimage>     |
  |----------------------------->|
  |  200 OK { data }             |
  |<-----------------------------|
```

### Fewsats v0.2

The server returns a JSON body with offers. The agent selects an offer, fetches a Lightning invoice, pays it, and retries with the original Bearer token.

```
Agent                          Server            Payment Endpoint
  |      GET /resource           |                     |
  |  Authorization: Bearer ...   |                     |
  |----------------------------->|                     |
  |  402 + JSON body:            |                     |
  |    { offers, payment_        |                     |
  |      context_token,          |                     |
  |      payment_request_url }   |                     |
  |<-----------------------------|                     |
  |  POST /payment-request       |                     |
  |    { offer_id,               |-------------------->|
  |      payment_method,         |                     |
  |      payment_context_token } |                     |
  |  { lightning_invoice }       |<--------------------|
  |<-----------------------------|                     |
  |  [pays Lightning invoice]    |                     |
  |  GET /resource               |                     |
  |  Authorization: Bearer ...   |                     |
  |----------------------------->|                     |
  |  200 OK { data }             |                     |
  |<-----------------------------|                     |
```

No accounts. No passwords. No tracking. Payment is the authentication.

## Architecture

```
┌─────────────────────────────────────────┐
│          Your Application               │
│                                         │
│   const res = await client.fetch(url)   │
└────────────────┬────────────────────────┘
                 │
┌────────────────▼────────────────────────┐
│            L402Client                   │
│                                         │
│  ┌──────────┐ ┌──────────┐ ┌─────────┐  │
│  │  Token   │ │ Spending │ │ Invoice │  │
│  │  Cache   │ │ Tracker  │ │ Decoder │  │
│  └──────────┘ └──────────┘ └─────────┘  │
└────────────────┬────────────────────────┘
                 │
┌────────────────▼────────────────────────┐
│         PaymentProvider                 │
│                                         │
│  LndClient  │  (NWC - planned)          │
│  REST API   │  (LNC - planned)          │
└────────────────┬────────────────────────┘
                 │
┌────────────────▼────────────────────────┐
│          Your LND Node                  │
│          (your keys, your node)         │
└─────────────────────────────────────────┘
```

## Comparison

|                   | Gateless            | lnget (Lightning Labs) | x402 (Coinbase)        |
| ----------------- | ------------------- | ---------------------- | ---------------------- |
| Language          | TypeScript          | Go                     | Multiple               |
| Runtime           | Node.js             | CLI only               | Server SDKs            |
| Payment rail      | Lightning (Bitcoin) | Lightning (Bitcoin)    | USDC (stablecoins)     |
| Node              | Your own LND        | Your own LND           | Coinbase custody       |
| Identity required | No                  | No                     | Yes (Coinbase account) |
| npm install       | Yes                 | No                     | Yes                    |
| Self-sovereign    | Yes                 | Yes                    | No                     |

Gateless and lnget are complementary. lnget is for terminal-based agents (Claude Code, Codex). Gateless is for web developers building agents in TypeScript.

## Roadmap

- ✅ LND REST payment provider
- ✅ L402 fetch client with automatic payment
- ✅ Token caching
- ✅ Spending limits and rate controls
- ✅ Fewsats L402 v0.2 support (offers, payment requests, pluggable offer strategy)
- ⬜ Nostr Wallet Connect (NWC) payment provider
- ⬜ Lightning Node Connect (LNC) provider
- ⬜ Nostr endpoint discovery
- ⬜ React hooks (`useL402Fetch`)
- ⬜ Macaroon attenuation and inspection
- ⬜ Server-side middleware (Aperture alternative in JS)

## Requirements

- Node.js 18+
- An LND node (v0.16+) with REST API enabled
- A funded Lightning channel

### LND Credentials

Gateless needs two files from your LND node:

- **TLS certificate** — usually at `~/.lnd/tls.cert`
- **Admin macaroon** — usually at `~/.lnd/data/chain/bitcoin/mainnet/admin.macaroon`

Copy them to your project (e.g. a `creds/` directory) and point `LndClient` at them. If your node is on a different machine, use an SSH tunnel to forward the REST port:

```bash
ssh -L 8080:127.0.0.1:8080 user@your-node-ip
```

## ⚠️ Disclaimer

Gateless is experimental software. It interacts with real Bitcoin on the Lightning Network. By using this software you accept full responsibility for any funds sent or lost. Always start with small amounts, use spending limits, and test thoroughly before deploying in any production environment. This software is provided as-is with no warranty of any kind.

## License

MIT

## Author

[satpath](https://github.com/satpathdev)
