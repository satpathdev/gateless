import { L402Client } from "../src/l402.js";
import {
  startMockServer,
  EXPECTED_PREIMAGE,
  paidBearerTokens,
  resetV02State,
  getLastOfferId,
} from "./mock-server.js";
import type { PaymentProvider } from "../src/payment-provider.js";
import type { OfferStrategy } from "../src/fewsats.js";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

async function assertThrows(
  fn: () => Promise<unknown>,
  errorName: string,
  messageIncludes?: string,
): Promise<void> {
  try {
    await fn();
    throw new Error(`Expected ${errorName} but no error was thrown`);
  } catch (error) {
    if (error instanceof Error && error.name === errorName) {
      if (messageIncludes && !error.message.includes(messageIncludes)) {
        throw new Error(
          `Expected error message to include "${messageIncludes}" but got "${error.message}"`,
        );
      }
      return;
    }
    throw error;
  }
}

const mockProvider: PaymentProvider = {
  async payInvoice() {
    return {
      preimage: EXPECTED_PREIMAGE,
      paymentHash: "fakehash",
      status: "SUCCEEDED",
    };
  },
};

/** Creates a mock provider that credits a bearer token on payment */
function v02Provider(bearerToken: string): PaymentProvider {
  return {
    async payInvoice() {
      paidBearerTokens.add(bearerToken);
      return {
        preimage: EXPECTED_PREIMAGE,
        paymentHash: "fakehash",
        status: "SUCCEEDED",
      };
    },
  };
}

const server = await startMockServer(9999);

// ============================================================
// Classic L402 tests (existing)
// ============================================================

console.log("--- Classic L402: First request (should pay) ---");
const client = new L402Client({
  paymentProvider: mockProvider,
  maxPaymentSats: 2000,
});

const res1 = await client.fetch("http://localhost:9999/api/data");
assert(res1.status === 200, `Expected 200, got ${res1.status}`);
const body1 = await res1.text();
assert(body1.includes("secret content"), `Unexpected body: ${body1}`);
console.log("PASS");

console.log("\n--- Classic L402: Second request (should use cache) ---");
const res2 = await client.fetch("http://localhost:9999/api/data");
assert(res2.status === 200, `Expected 200, got ${res2.status}`);
const body2 = await res2.text();
assert(body2.includes("secret content"), `Unexpected body: ${body2}`);
console.log("PASS");

// ============================================================
// Fewsats v0.2 tests
// ============================================================

console.log("\n--- v0.2: Happy path ---");
resetV02State();
const token1 = "test-bearer-1";
const v02Client1 = new L402Client({
  paymentProvider: v02Provider(token1),
  maxPaymentSats: 2000,
});

const v02res1 = await v02Client1.fetch("http://localhost:9999/v02/data", {
  headers: { Authorization: `Bearer ${token1}` },
});
assert(v02res1.status === 200, `Expected 200, got ${v02res1.status}`);
const v02body1 = (await v02res1.json()) as { data: string };
assert(
  v02body1.data === "Fewsats v0.2 premium content",
  `Unexpected body: ${v02body1.data}`,
);
console.log("PASS");

console.log("\n--- v0.2: Second request reuses Bearer (no second payment) ---");
let payCount = 0;
const countingProvider: PaymentProvider = {
  async payInvoice() {
    payCount++;
    paidBearerTokens.add("test-bearer-count");
    return {
      preimage: EXPECTED_PREIMAGE,
      paymentHash: "fakehash",
      status: "SUCCEEDED",
    };
  },
};
resetV02State();
const v02Client2 = new L402Client({
  paymentProvider: countingProvider,
  maxPaymentSats: 2000,
});
const headers2 = { Authorization: "Bearer test-bearer-count" };

await v02Client2.fetch("http://localhost:9999/v02/data", { headers: headers2 });
assert(payCount === 1, `Expected 1 payment, got ${payCount}`);

const v02res2b = await v02Client2.fetch("http://localhost:9999/v02/data", {
  headers: headers2,
});
assert(v02res2b.status === 200, `Expected 200, got ${v02res2b.status}`);
assert(payCount === 1, `Expected still 1 payment, got ${payCount}`);
console.log("PASS");

console.log("\n--- v0.2: Offer selection (cheapest lightning) ---");
resetV02State();
const token3 = "test-bearer-3";
const v02Client3 = new L402Client({
  paymentProvider: v02Provider(token3),
  maxPaymentSats: 2000,
});

await v02Client3.fetch("http://localhost:9999/v02/data-multi", {
  headers: { Authorization: `Bearer ${token3}` },
});
assert(
  getLastOfferId() === "offer_cheap",
  `Expected offer_cheap, got ${getLastOfferId()}`,
);
console.log("PASS");

console.log("\n--- v0.2: Custom offer strategy ---");
resetV02State();
const token4 = "test-bearer-4";
const expensiveFirst: OfferStrategy = (offers) => {
  const lightning = offers.filter((o) =>
    o.payment_methods.includes("lightning"),
  );
  lightning.sort((a, b) => b.amount - a.amount);
  const pick = lightning[0];
  if (!pick) throw new Error("no lightning offers");
  return pick;
};
const v02Client4 = new L402Client({
  paymentProvider: v02Provider(token4),
  maxPaymentSats: 2000,
  offerStrategy: expensiveFirst,
});

await v02Client4.fetch("http://localhost:9999/v02/data-multi", {
  headers: { Authorization: `Bearer ${token4}` },
});
assert(
  getLastOfferId() === "offer_expensive",
  `Expected offer_expensive, got ${getLastOfferId()}`,
);
console.log("PASS");

console.log("\n--- v0.2: No lightning offers → L402ProtocolError ---");
resetV02State();
const v02Client5 = new L402Client({
  paymentProvider: mockProvider,
  maxPaymentSats: 2000,
});

await assertThrows(
  () =>
    v02Client5.fetch("http://localhost:9999/v02/data-no-lightning", {
      headers: { Authorization: "Bearer no-lightning" },
    }),
  "L402ProtocolError",
  "No offers support lightning",
);
console.log("PASS");

console.log("\n--- v0.2: Budget limit → L402BudgetError ---");
resetV02State();
const v02Client6 = new L402Client({
  paymentProvider: v02Provider("test-bearer-budget"),
  maxPaymentSats: 5, // invoice is 1000 sats (lnbc10u = 10 * 100 = 1000)
});

await assertThrows(
  () =>
    v02Client6.fetch("http://localhost:9999/v02/data", {
      headers: { Authorization: "Bearer test-bearer-budget" },
    }),
  "L402BudgetError",
  "exceeds limit",
);
console.log("PASS");

server.close();
console.log("\nAll tests passed!");
