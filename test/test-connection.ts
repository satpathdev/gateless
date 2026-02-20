import { LndClient } from "../src/lnd.js";

const client = new LndClient({
  host: "127.0.0.1",
  port: 8080,
  tlsCertPath: "./creds/tls.cert",
  macaroonPath: "./creds/admin.macaroon",
});

const info = await client.getInfo();
console.log("Connected to LND!");
console.log("Alias:", info["alias"]);
console.log("Synced to chain:", info["synced_to_chain"]);
console.log("Synced to graph:", info["synced_to_graph"]);
console.log("Block height:", info["block_height"]);
