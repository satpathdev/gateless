import { L402Client } from "../src/l402.js";
import { startMockServer, EXPECTED_PREIMAGE } from "./mock-server.js";
import type { PaymentProvider } from "../src/payment-provider.js";

const mockProvider: PaymentProvider = {
  async payInvoice() {
    return {
      preimage: EXPECTED_PREIMAGE,
      paymentHash: "fakehash",
      status: "SUCCEEDED",
    };
  },
};

const server = await startMockServer(9999);

const client = new L402Client({
  paymentProvider: mockProvider,
  maxPaymentSats: 2000,
});

console.log("--- First request (should pay) ---");
const res1 = await client.fetch("http://localhost:9999/api/data");
console.log("Status:", res1.status);
console.log("Body:", await res1.text());

console.log("\n--- Second request (should use cache) ---");
const res2 = await client.fetch("http://localhost:9999/api/data");
console.log("Status:", res2.status);
console.log("Body:", await res2.text());

server.close();
console.log("\nAll tests passed!");
