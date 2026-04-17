/**
 * Live server test. Starts a local HTTP server that uses your real LND node
 * (via SSH tunnel) to issue L402 challenges with real BOLT11 invoices.
 *
 * Prerequisites:
 *   1. SSH tunnel to your LND node:
 *        ssh -L 8080:127.0.0.1:8080 hodl@192.168.68.58
 *   2. creds/tls.cert and creds/admin.macaroon present (same files as test-live.ts)
 *   3. Compile: npx tsc
 *
 * Run: node dist/test/test-server-live.js
 *
 * Then in another terminal:
 *   curl -i http://localhost:8787/premium
 *     → expect 402 with WWW-Authenticate header containing a real BOLT11 invoice
 *
 *   (optional) pay the invoice from any external wallet, grab the preimage:
 *   curl -i -H "Authorization: L402 <macaroon>:<preimage>" http://localhost:8787/premium
 *     → expect 200 and the paid content
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";

import { LndClient } from "../src/lnd.js";
import { L402Server } from "../src/server/l402-server.js";

const PORT = Number(process.env["PORT"] ?? 8787);
const PRICE_SATS = Number(process.env["PRICE_SATS"] ?? 10);
const SECRET = process.env["L402_SECRET"] ?? randomBytes(32).toString("hex");

const lnd = new LndClient({
  host: "127.0.0.1",
  port: 8080,
  tlsCertPath: "./creds/tls.cert",
  macaroonPath: "./creds/admin.macaroon",
});

// Quick sanity check before accepting requests
try {
  const info = await lnd.getInfo();
  console.log(`Connected to LND: ${info["alias"] ?? "(unknown alias)"}`);
} catch (err) {
  console.error("Could not reach LND. Is the SSH tunnel up?");
  console.error("  ssh -L 8080:127.0.0.1:8080 hodl@192.168.68.58");
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}

const l402 = new L402Server({
  secret: SECRET,
  invoiceProvider: lnd,
  defaultMemo: "gateless live test",
  defaultExpirySeconds: 600,
});

const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  const method = req.method ?? "GET";
  const url = req.url ?? "/";

  if (url !== "/premium") {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not Found\n");
    console.log(`${method} ${url} → 404`);
    return;
  }

  const authHeader = req.headers["authorization"];
  const auth = Array.isArray(authHeader) ? authHeader[0] : authHeader;

  if (auth) {
    const result = l402.verifyAuthorization(auth);
    if (result.ok) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          data: "You paid for this. Well done.",
          paymentHash: result.paymentHash,
          priceSats: result.priceSats,
        }) + "\n",
      );
      console.log(`${method} ${url} → 200 (verified, paymentHash=${result.paymentHash.slice(0, 16)}...)`);
      return;
    }
    console.log(`${method} ${url} → verification failed: ${result.reason}`);
    // Fall through to issue a fresh challenge
  }

  try {
    const challenge = await l402.issueChallenge(PRICE_SATS);
    res.writeHead(402, {
      "Content-Type": "text/plain",
      "WWW-Authenticate": challenge.wwwAuthenticate,
    });
    res.end("Payment Required\n");
    console.log(`${method} ${url} → 402`);
    console.log(`  invoice:  ${challenge.invoice}`);
    console.log(`  macaroon: ${challenge.macaroon}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.writeHead(500, { "Content-Type": "text/plain" });
    res.end(`Server error: ${msg}\n`);
    console.error(`${method} ${url} → 500: ${msg}`);
  }
});

httpServer.listen(PORT, () => {
  console.log(`\nL402 server listening on http://localhost:${PORT}`);
  console.log(`Price: ${PRICE_SATS} sats, expiry: 600s`);
  console.log(`Secret: ${SECRET.slice(0, 8)}... (set L402_SECRET env to reuse across runs)`);
  console.log(`\nTry:  curl -i http://localhost:${PORT}/premium`);
  console.log(`Ctrl-C to stop.\n`);
});
