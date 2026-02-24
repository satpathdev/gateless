import { NwcClient } from "../src/nwc.js";
import { L402Client } from "../src/l402.js";

// Get a connection string from any NWC-compatible wallet:
//   - Alby Hub: App Connections → Create New → copy connection string
//   - Mutiny:   Settings → Wallet Connections → Nostr Wallet Connect
//   - Any NIP-47 wallet that provides a nostr+walletconnect:// URI
const nwc = new NwcClient({
  connectionString: "nostr+walletconnect://hidden",
});

// Step 1: Sign up for a bearer token
const signupRes = await fetch("https://stock.l402.org/signup");
const signup = (await signupRes.json()) as { id: string; credits: number };
console.log("Bearer token:", signup.id);
console.log("Free credits:", signup.credits);

// Step 2: Burn the free credit
const freeRes = await fetch("https://stock.l402.org/ticker/AAPL", {
  headers: { Authorization: `Bearer ${signup.id}` },
});
console.log("Free request status:", freeRes.status);
await freeRes.json();

// Step 3: Now fetch with NWC-backed L402Client
const client = new L402Client({
  paymentProvider: nwc,
  maxPaymentSats: 100,
});

console.log(
  "\nFetching /ticker/MSFT via gateless+NWC (should pay lightning)...",
);

try {
  const res = await client.fetch("https://stock.l402.org/ticker/MSFT", {
    headers: { Authorization: `Bearer ${signup.id}` },
  });
  console.log("Status:", res.status);
  const data = await res.json();
  console.log("Data:", JSON.stringify(data, null, 2));
  console.log("\nLive NWC test passed!");
} catch (error) {
  console.error("Error:", error);
} finally {
  nwc.close();
}
