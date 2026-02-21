import { LndClient, L402Client } from "../src/index.js";

const lnd = new LndClient({
  host: "127.0.0.1",
  port: 8080,
  tlsCertPath: "./creds/tls.cert",
  macaroonPath: "./creds/admin.macaroon",
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

// Step 3: Now fetch with L402Client — should hit 402, pay, and retry
const client = new L402Client({
  paymentProvider: lnd,
  maxPaymentSats: 100,
});

console.log("\nFetching /ticker/MSFT via gateless (should pay lightning)...");

try {
  const res = await client.fetch("https://stock.l402.org/ticker/MSFT", {
    headers: { Authorization: `Bearer ${signup.id}` },
  });
  console.log("Status:", res.status);
  const data = await res.json();
  console.log("Data:", JSON.stringify(data, null, 2));
  console.log("\nLive L402 test passed!");
} catch (error) {
  console.error("Error:", error);
}
