import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";

export interface CustomServer {
  port: number;
  close: () => void;
}

/**
 * Spins up a tiny HTTP server with a user-supplied request handler. Used by
 * server-side tests that need real HTTP I/O against L402Server.
 */
export function startCustomServer(
  port: number,
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<void> | void,
): Promise<CustomServer> {
  return new Promise((resolve) => {
    const httpServer = createServer((req, res) => {
      Promise.resolve(handler(req, res)).catch((err: unknown) => {
        res.writeHead(500);
        res.end(err instanceof Error ? err.message : String(err));
      });
    });

    httpServer.listen(port, () => {
      const addr = httpServer.address() as AddressInfo | null;
      resolve({
        port: addr ? addr.port : port,
        close: () => httpServer.close(),
      });
    });
  });
}
