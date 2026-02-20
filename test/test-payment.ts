import { LndClient } from "../src/lnd.js";

const lnd = new LndClient({
  host: "127.0.0.1",
  port: 8080,
  tlsCertPath: "./creds/tls.cert",
  macaroonPath: "./creds/admin.macaroon",
});

// To test: generate a fresh invoice on your node with:
//   lncli addinvoice --amt 1 --memo "gateless test"
// Then paste the payment_request here:
const invoice = "YOUR_INVOICE_HERE";

console.log("Decoding invoice via LND REST API...");
const decoded = await lnd.decodeInvoice(invoice);
console.log("Description:", decoded["description"]);
console.log("Amount:", decoded["num_satoshis"], "sats");
console.log("Destination:", decoded["destination"]);
console.log("\nGateless -> SSH tunnel -> LND REST API: working!");
