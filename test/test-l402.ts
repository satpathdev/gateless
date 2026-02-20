// Manual integration test — requires:
// 1. LND node running with REST API on localhost:8080 (SSH tunnel)
// 2. A working L402 endpoint (update URL below)
// Run: npx tsc && node dist/test/test-l402.js

import { LndClient } from "../src/lnd.js";
import { L402Client } from "../src/l402.js";

const lnd = new LndClient({
  host: "127.0.0.1",
  port: 8080,
  tlsCertPath: "./creds/tls.cert",
  macaroonPath: "./creds/admin.macaroon",
});

const client = new L402Client({
  paymentProvider: lnd,
  maxPaymentSats: 10,
});

const L402_ENDPOINT = "https://example.com/l402-resource"; // Replace with a live L402 endpoint

const res = await client.fetch(L402_ENDPOINT);
console.log("Status:", res.status);
console.log("Body:", (await res.text()).slice(0, 200));
