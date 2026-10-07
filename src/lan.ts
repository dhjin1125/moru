import {
  createServer,
  request,
  type IncomingMessage,
  type Server,
} from "node:http";
import { networkInterfaces } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function lanAddresses() {
  return [
    ...new Set(
      Object.values(networkInterfaces()).flatMap((entries) =>
        (entries || [])
          .filter(
            (entry) =>
              entry.family === "IPv4" &&
              !entry.internal &&
              /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.)/.test(
                entry.address,
              ),
          )
          .map((entry) => entry.address),
      ),
    ),
  ];
}

export function validLanRequest(
  req: IncomingMessage,
  address: string,
  port: number,
) {
  const authority = `${address}${port === 80 ? "" : `:${port}`}`;
  const host = req.headers.host;
  return (
    (host === authority || (port === 80 && host === `${address}:80`)) &&
    (!req.headers.origin || req.headers.origin === `http://${authority}`) &&
    req.headers["sec-fetch-site"] !== "cross-site" &&
    !!req.url?.startsWith("/") &&
    !req.url.startsWith("//")
  );
}

export function createLanServer(upstreamPort: number) {
  const server = createServer((req, res) => {
    const binding = server.address();
    if (
      !binding ||
      typeof binding === "string" ||
      !validLanRequest(req, binding.address, binding.port)
    ) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "허용되지 않은 접속 주소입니다." }));
      return;
    }
    const host = `127.0.0.1:${upstreamPort}`;
    const headers: IncomingMessage["headers"] = { ...req.headers, host };
    if (headers.origin) headers.origin = `http://${host}`;
    delete headers.forwarded;
    delete headers["x-forwarded-host"];
    delete headers["x-forwarded-for"];
    delete headers["x-forwarded-proto"];
    const upstream = request(
      {
        hostname: "127.0.0.1",
        port: upstreamPort,
        method: req.method,
        path: req.url,
        headers,
      },
      (reply) => {
        res.writeHead(reply.statusCode || 502, reply.headers);
        reply.on("error", () => res.destroy());
        reply.pipe(res);
      },
    );
    upstream.on("error", () => {
      if (res.headersSent) return res.destroy();
      res.writeHead(502, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      });
      res.end(
        JSON.stringify({ error: "Moru 호스트에 다시 연결하는 중입니다." }),
      );
    });
    req.on("aborted", () => upstream.destroy());
    res.on("close", () => upstream.destroy());
    req.pipe(upstream);
  });
  return server;
}

export function startLan(port = Number(process.env.MORU_PORT ?? 4327)) {
  const servers = new Map<string, Server>();
  const sync = () => {
    const addresses = new Set(lanAddresses());
    for (const [address, server] of servers) {
      if (!addresses.has(address)) {
        server.close();
        server.closeAllConnections();
        servers.delete(address);
      }
    }
    for (const address of addresses) {
      if (servers.has(address)) continue;
      const server = createLanServer(port);
      servers.set(address, server);
      server.on("error", (error) => {
        console.error(`LAN listener ${address}: ${error.message}`);
        server.close();
        servers.delete(address);
      });
      server.listen(port, address, () =>
        console.log(`Moru LAN: http://${address}:${port}`),
      );
    }
  };
  sync();
  const timer = setInterval(sync, 5000);
  return () => {
    clearInterval(timer);
    for (const server of servers.values()) {
      server.close();
      server.closeAllConnections();
    }
    servers.clear();
  };
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const close = startLan();
  process.once("SIGTERM", close);
  process.once("SIGINT", close);
}
