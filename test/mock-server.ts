import http from "node:http";

const MOCK_MACAROON =
  "0200000000000000000000000000000000000000000000000000000000000000";
const EXPECTED_PREIMAGE =
  "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";

export function startMockServer(port: number): Promise<http.Server> {
  const server = http.createServer((req, res) => {
    const auth = req.headers["authorization"];

    if (auth) {
      const match = auth.match(/^L402 (.+):(.+)$/);
      if (match?.[1] && match[2] === EXPECTED_PREIMAGE) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({ data: "You paid! Here is your secret content." }),
        );
        return;
      }
    }

    res.writeHead(402, {
      "WWW-Authenticate": `L402 macaroon="${MOCK_MACAROON}", invoice="lnbc10u1fakeinvoice"`,
    });
    res.end("Payment Required");
  });

  return new Promise((resolve) => {
    server.listen(port, () => {
      console.log(`Mock L402 server running on port ${port}`);
      resolve(server);
    });
  });
}

export { MOCK_MACAROON, EXPECTED_PREIMAGE };
