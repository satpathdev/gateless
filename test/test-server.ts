import { createHash } from "node:crypto";

import { L402Server } from "../src/server/l402-server.js";
import type {
  CreateInvoiceOptions,
  Invoice,
  InvoiceProvider,
} from "../src/server/invoice-provider.js";
import { L402Client } from "../src/l402.js";
import type { PaymentProvider } from "../src/payment-provider.js";
import { startCustomServer } from "./server-fixtures.js";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

const KNOWN_PREIMAGE =
  "a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1";
const KNOWN_PAYMENT_HASH = createHash("sha256")
  .update(Buffer.from(KNOWN_PREIMAGE, "hex"))
  .digest("hex");

const fakeProvider: InvoiceProvider = {
  async createInvoice(options: CreateInvoiceOptions): Promise<Invoice> {
    return {
      paymentRequest: `lnbc${options.amountSats * 10}n1fake`,
      paymentHash: KNOWN_PAYMENT_HASH,
      amountSats: options.amountSats,
    };
  },
};

// ============================================================
// Unit tests for L402Server core
// ============================================================

console.log("--- Server: issueChallenge returns well-formed challenge ---");
{
  const server = new L402Server({
    secret: "test-secret",
    invoiceProvider: fakeProvider,
  });
  const challenge = await server.issueChallenge(100);
  assert(challenge.status === 402, "status is 402");
  assert(challenge.invoice.startsWith("lnbc"), "invoice is BOLT11");
  assert(
    challenge.paymentHash === KNOWN_PAYMENT_HASH,
    "paymentHash flows through",
  );
  assert(
    challenge.wwwAuthenticate.includes(`macaroon="${challenge.macaroon}"`),
    "WWW-Authenticate contains macaroon",
  );
  assert(
    challenge.wwwAuthenticate.includes(`invoice="${challenge.invoice}"`),
    "WWW-Authenticate contains invoice",
  );
}
console.log("PASS");

console.log("\n--- Server: valid macaroon + preimage verifies ---");
{
  const server = new L402Server({
    secret: "test-secret",
    invoiceProvider: fakeProvider,
  });
  const challenge = await server.issueChallenge(100);
  const authHeader = `L402 ${challenge.macaroon}:${KNOWN_PREIMAGE}`;
  const result = server.verifyAuthorization(authHeader);
  assert(result.ok, "should be ok");
  if (result.ok) {
    assert(result.priceSats === 100, "priceSats preserved");
    assert(result.paymentHash === KNOWN_PAYMENT_HASH, "paymentHash preserved");
  }
}
console.log("PASS");

console.log("\n--- Server: wrong preimage rejected ---");
{
  const server = new L402Server({
    secret: "test-secret",
    invoiceProvider: fakeProvider,
  });
  const challenge = await server.issueChallenge(100);
  const badPreimage = "b".repeat(64);
  const result = server.verifyAuthorization(
    `L402 ${challenge.macaroon}:${badPreimage}`,
  );
  assert(!result.ok, "should fail");
  if (!result.ok) {
    assert(
      result.reason.includes("preimage"),
      `reason mentions preimage: ${result.reason}`,
    );
  }
}
console.log("PASS");

console.log("\n--- Server: macaroon signed by different secret rejected ---");
{
  const server = new L402Server({
    secret: "secret-a",
    invoiceProvider: fakeProvider,
  });
  const otherServer = new L402Server({
    secret: "secret-b",
    invoiceProvider: fakeProvider,
  });
  const challenge = await server.issueChallenge(100);
  const result = otherServer.verifyAuthorization(
    `L402 ${challenge.macaroon}:${KNOWN_PREIMAGE}`,
  );
  assert(!result.ok, "should fail with wrong secret");
}
console.log("PASS");

console.log("\n--- Server: malformed auth headers rejected ---");
{
  const server = new L402Server({
    secret: "test-secret",
    invoiceProvider: fakeProvider,
  });
  assert(!server.verifyAuthorization(null).ok, "null fails");
  assert(!server.verifyAuthorization("").ok, "empty fails");
  assert(!server.verifyAuthorization("Bearer foo").ok, "bearer fails");
  assert(
    !server.verifyAuthorization("L402 nomacaroon").ok,
    "missing colon fails",
  );
  assert(
    !server.verifyAuthorization("L402 foo:nothex").ok,
    "non-hex preimage fails",
  );
}
console.log("PASS");

console.log("\n--- Server: expired macaroon rejected ---");
{
  const server = new L402Server({
    secret: "test-secret",
    invoiceProvider: fakeProvider,
    defaultExpirySeconds: -1, // already expired
  });
  const challenge = await server.issueChallenge(100);
  const result = server.verifyAuthorization(
    `L402 ${challenge.macaroon}:${KNOWN_PREIMAGE}`,
  );
  assert(!result.ok, "expired macaroon should fail");
}
console.log("PASS");

// ============================================================
// Middleware tests
// ============================================================

interface MockRes {
  statusCode?: number;
  headers: Record<string, string>;
  body?: string;
  locals: Record<string, unknown>;
  status(code: number): MockRes;
  setHeader(name: string, value: string): void;
  send(body?: string): MockRes;
}

function mockRes(): MockRes {
  const res: MockRes = {
    headers: {},
    locals: {},
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    setHeader(name: string, value: string) {
      this.headers[name.toLowerCase()] = value;
    },
    send(body?: string) {
      if (body !== undefined) this.body = body;
      return this;
    },
  };
  return res;
}

async function runMiddleware(
  mw: (req: unknown, res: unknown, next: (err?: unknown) => void) => void,
  req: unknown,
  res: unknown,
): Promise<{ nextCalled: boolean; error?: unknown }> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (v: { nextCalled: boolean; error?: unknown }) => {
      if (!settled) {
        settled = true;
        resolve(v);
      }
    };

    mw(req, res, (err?: unknown) => {
      if (err !== undefined) {
        settle({ nextCalled: true, error: err });
      } else {
        settle({ nextCalled: true });
      }
    });

    // Middleware may respond directly without calling next - give it a moment
    setTimeout(() => settle({ nextCalled: false }), 100);
  });
}

console.log("\n--- Middleware: unauthenticated request returns 402 ---");
{
  const server = new L402Server({
    secret: "test-secret",
    invoiceProvider: fakeProvider,
  });
  const mw = server.protect({ priceSats: 50 });
  const res = mockRes();
  const { nextCalled } = await runMiddleware(
    mw as (r: unknown, s: unknown, n: (e?: unknown) => void) => void,
    { headers: {} },
    res,
  );
  assert(!nextCalled, "next should not be called");
  assert(res.statusCode === 402, `expected 402, got ${res.statusCode}`);
  assert(
    res.headers["www-authenticate"]?.startsWith("L402 ") ?? false,
    "WWW-Authenticate header set",
  );
}
console.log("PASS");

console.log("\n--- Middleware: valid token calls next + sets res.locals ---");
{
  const server = new L402Server({
    secret: "test-secret",
    invoiceProvider: fakeProvider,
  });
  const challenge = await server.issueChallenge(50);
  const mw = server.protect({ priceSats: 50 });
  const res = mockRes();
  const { nextCalled, error } = await runMiddleware(
    mw as (r: unknown, s: unknown, n: (e?: unknown) => void) => void,
    {
      headers: {
        authorization: `L402 ${challenge.macaroon}:${KNOWN_PREIMAGE}`,
      },
    },
    res,
  );
  assert(nextCalled, "next should be called");
  assert(error === undefined, `no error: ${String(error)}`);
  const stamped = res.locals["l402"] as
    | { priceSats: number; paymentHash: string }
    | undefined;
  assert(stamped?.priceSats === 50, "res.locals.l402.priceSats set");
  assert(stamped?.paymentHash === KNOWN_PAYMENT_HASH, "paymentHash set");
}
console.log("PASS");

// ============================================================
// End-to-end: L402Client talks to L402Server over HTTP
// ============================================================

console.log("\n--- E2E: L402Client pays L402Server-issued challenge ---");
{
  const server = new L402Server({
    secret: "e2e-secret",
    invoiceProvider: fakeProvider,
  });

  // Mock payment provider that just returns the known preimage
  const mockPayer: PaymentProvider = {
    async payInvoice() {
      return {
        preimage: KNOWN_PREIMAGE,
        paymentHash: KNOWN_PAYMENT_HASH,
        status: "SUCCEEDED",
      };
    },
  };

  const httpServer = await startCustomServer(0, async (req, res) => {
    const auth = req.headers["authorization"];
    const authStr = Array.isArray(auth) ? auth[0] : auth;
    if (authStr) {
      const result = server.verifyAuthorization(authStr);
      if (result.ok) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ data: "paid content" }));
        return;
      }
    }
    const challenge = await server.issueChallenge(75);
    res.writeHead(402, { "WWW-Authenticate": challenge.wwwAuthenticate });
    res.end("Payment Required");
  });

  const port = httpServer.port;

  const client = new L402Client({
    paymentProvider: mockPayer,
    maxPaymentSats: 1000,
  });

  const response = await client.fetch(`http://localhost:${port}/`);
  assert(response.status === 200, `expected 200, got ${response.status}`);
  const body = (await response.json()) as { data: string };
  assert(body.data === "paid content", `unexpected body: ${body.data}`);

  // Second request uses the cached token - no second "payment"
  const response2 = await client.fetch(`http://localhost:${port}/`);
  assert(response2.status === 200, `second fetch: got ${response2.status}`);

  httpServer.close();
}
console.log("PASS");

console.log("\nAll server tests passed!");
process.exit(0);
