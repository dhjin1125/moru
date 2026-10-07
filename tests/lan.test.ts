import test from "node:test";
import assert from "node:assert/strict";
import { createServer, request, type Server } from "node:http";
import { once } from "node:events";
import { createLanServer } from "../src/lan.ts";

async function listen(server: Server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return (server.address() as { port: number }).port;
}
async function close(server: Server) {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

test(
  "LAN gateway validates origin, forwards writes and streams events without buffering",
  { timeout: 10000 },
  async () => {
    let accepted = 0;
    let finishStream: (() => void) | undefined;
    const upstream = createServer(async (req, res) => {
      accepted++;
      if (req.url === "/api/events?after=40") {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write("id: 41\ndata: 첫 이벤트\n\n");
        finishStream = () => res.end("id: 42\ndata: 다음 이벤트\n\n");
        return;
      }
      let body = "";
      for await (const chunk of req) body += chunk;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          body,
          host: req.headers.host,
          origin: req.headers.origin,
          forwarded: req.headers["x-forwarded-host"],
        }),
      );
    });
    const upstreamPort = await listen(upstream);
    const gateway = createLanServer(upstreamPort);
    const port = await listen(gateway);
    const base = `http://127.0.0.1:${port}`;
    try {
      const payload = JSON.stringify({ message: "LAN 전송 확인" });
      const response = await fetch(base + "/api/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: base,
          "X-Forwarded-Host": "evil.example",
        },
        body: payload,
      });
      assert.deepEqual(await response.json(), {
        body: payload,
        host: `127.0.0.1:${upstreamPort}`,
        origin: `http://127.0.0.1:${upstreamPort}`,
      });
      const beforeRejected = accepted;
      const rejectedHeaders: Record<string, string>[] = [
        { Origin: "https://evil.example" },
        { Host: "evil.example" },
        { "Sec-Fetch-Site": "cross-site" },
      ];
      for (const headers of rejectedHeaders) {
        const status = await new Promise<number | undefined>((resolve, reject) => {
          const req = request(base + "/api/state", { headers }, (res) => {
            res.resume();
            resolve(res.statusCode);
          });
          req.on("error", reject);
          req.end();
        });
        assert.equal(status, 403, JSON.stringify(headers));
      }
      assert.equal(accepted, beforeRejected);
      const stream = await fetch(base + "/api/events?after=40");
      const reader = stream.body!.getReader();
      assert.match(
        new TextDecoder().decode((await reader.read()).value),
        /id: 41/,
      );
      finishStream!();
      let rest = "";
      const decoder = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        rest += decoder.decode(value, { stream: true });
      }
      assert.match(rest, /다음 이벤트/);
      await close(upstream);
      assert.equal((await fetch(base + "/api/state")).status, 502);
    } finally {
      await close(gateway);
      if (upstream.listening) await close(upstream);
    }
  },
);
