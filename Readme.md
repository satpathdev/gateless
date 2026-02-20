# Gateless

Sovereign L402 payments for AI agents on Lightning.

Gateless is a JavaScript/TypeScript library that lets AI agents in Node.js autonomously pay for L402-protected web resources over the Lightning Network. You run your own node. Your agent handles payments within spending limits you define. No accounts, no API keys, no identity - payment is authentication.

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

If the server returns `402 Payment Required`, Gateless:

1. Parses the `WWW-Authenticate` header (extracts macaroon + invoice)
2. Checks spending limits
3. Pays the Lightning invoice via your LND node
4. Caches the token for reuse
5. Retries the request with the `Authorization: L402` header

Second requests to the same URL skip payment entirely and use the cached token.

## Features

**L402 Client** - Drop-in `fetch` wrapper that handles the full 402 → pay → retry flow automatically.

**Token Cache** - Stores paid macaroon+preimage pairs. Avoids double-paying for the same resource. Supports optional TTL expiry.

**Spending Controls** - Set per-payment limits, total budgets, and rate limits. An AI agent physically cannot exceed the budget you define.

**Payment Provider Interface** - Ships with an LND client over REST. Bring your own provider by implementing a simple interface:

```typescript
interface PaymentProvider {
  payInvoice(paymentRequest: string): Promise<PaymentResult>;
}
```

## How L402 Works

L402 is a protocol that uses Lightning Network payments for authentication. Instead of API keys or OAuth tokens, you pay a Lightning invoice and receive a cryptographic receipt (macaroon + preimage) that proves you paid.

```
Agent                          Server
  |                              |
  |      GET /resource           |
  |----------------------------->|
  |                              |
  |  402 Payment Required        |
  |  WWW-Authenticate: L402      |
  |    macaroon="...",           |
  |    invoice="lnbc..."         |
  |<-----------------------------|
  |                              |
  |  [pays Lightning invoice]    |
  |                              |
  |  GET /resource               |
  |  Authorization: L402         |
  |    <macaroon>:<preimage>     |
  |----------------------------->|
  |                              |
  |  200 OK                      |
  |  { data }                    |
  |<-----------------------------|
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

- [x] LND REST payment provider
- [x] L402 fetch client with automatic payment
- [x] Token caching
- [x] Spending limits and rate controls
- [ ] Nostr Wallet Connect (NWC) payment provider
- [ ] Lightning Node Connect (LNC) provider
- [ ] Nostr endpoint discovery
- [ ] React hooks (`useL402Fetch`)
- [ ] Macaroon attenuation and inspection
- [ ] Server-side middleware (Aperture alternative in JS)

## Requirements

- Node.js 18+
- An LND node (v0.16+) with REST API enabled
- A funded Lightning channel

## ⚠️ Disclaimer

Gateless is experimental software. It interacts with real Bitcoin on the Lightning Network. By using this software you accept full responsibility for any funds sent or lost. Always start with small amounts, use spending limits, and test thoroughly before deploying in any production environment. This software is provided as-is with no warranty of any kind.

## License

MIT

## Author

[satpath](https://github.com/satpathdev)
