import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, cp, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { once } from "node:events";
import { createMoru, ROOT } from "../src/host.ts";

async function until<T>(
  fn: () => Promise<T> | T,
  predicate: (v: T) => boolean,
  timeout = 12000,
): Promise<T> {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await fn();
    if (predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 35));
  }
  throw Error("Expected state did not arrive");
}

test(
  "real worker: dynamic tools, hot handoff, selection, replay, fork and failed startup",
  { timeout: 45000 },
  async () => {
    await mkdir(join(ROOT, ".moru"), { recursive: true });
    const root = await mkdtemp(join(ROOT, ".moru", "integration-"));
    await cp(join(ROOT, "app"), join(root, "app"), { recursive: true });
    await mkdir(join(root, "src"));
    await cp(join(ROOT, "src/runtime.ts"), join(root, "src/runtime.ts"));
    const requests: any[] = [];
    let release: (() => void) | undefined;
    let replyNumber = 0;
    const fake = createServer(async (req, res) => {
      if (req.url !== "/v1/chat/completions") {
        res.writeHead(404).end();
        return;
      }
      let data = "";
      for await (const chunk of req) data += chunk;
      const request = JSON.parse(data);
      requests.push(request);
      if (requests.length === 1)
        await new Promise<void>((r) => {
          release = r;
        });
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const chunk = (delta: any, finish_reason: string | null = null) =>
        res.write(
          "data: " +
            JSON.stringify({
              id: "chat-test",
              object: "chat.completion.chunk",
              created: 1,
              model: "test-model",
              choices: [{ index: 0, delta, finish_reason }],
            }) +
            "\n\n",
        );
      chunk({ role: "assistant" });
      const n = replyNumber++;
      if (n === 0) {
        chunk({
          tool_calls: [
            {
              index: 0,
              id: "call-write",
              type: "function",
              function: {
                name: "write_file",
                arguments: JSON.stringify({
                  path: "tools/sum.mjs",
                  content:
                    'export default { name: "sum", description: "Add two numbers", parameters: {type:"object",properties:{a:{type:"number"},b:{type:"number"}},required:["a","b"]}, async execute({a,b}) { return {total:a+b}; } };',
                }),
              },
            },
          ],
        });
        chunk({}, "tool_calls");
      } else if (n === 1) {
        assert(
          request.tools.some((t: any) => t.function.name === "sum"),
          "new tool is registered before the next request",
        );
        chunk({
          tool_calls: [
            {
              index: 0,
              id: "call-sum",
              type: "function",
              function: { name: "sum", arguments: '{"a":17,"b":25}' },
            },
          ],
        });
        chunk({}, "tool_calls");
      } else {
        chunk({
          content: "# 완료 😀\n\n| 결과 | 값 |\n|---|---|\n| 합계 | **42** |",
        });
        chunk({}, "stop");
      }
      res.write("data: [DONE]\n\n");
      res.end();
    });
    fake.listen(0, "127.0.0.1");
    await once(fake, "listening");
    const app = await createMoru(root, 0, { skipDiscovery: true });
    const base = "http://127.0.0.1:" + app.port;
    async function post(path: string, data: any, expected = 200) {
      const res = await fetch(base + "/api" + path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      const value = await res.json();
      assert.equal(res.status, expected, JSON.stringify(value));
      return value;
    }
    const selection = {
      provider: "test-provider",
      model: "test-model",
      thinking: "off",
    };
    try {
      await post("/providers/custom", {
        id: selection.provider,
        name: "Test provider",
        baseUrl: `http://127.0.0.1:${(fake.address() as any).port}/v1`,
        api: "openai-completions",
        keyless: true,
        models: [{ id: selection.model }],
      });
      const s = await post("/sessions", { selection });
      const requestId = crypto.randomUUID();
      const job = await post("/messages", {
        sessionId: s.id,
        requestId,
        selection,
        text: "Create a tool",
      });
      await until(
        () => release,
        (x) => !!x,
      );
      const old = app.supervisor.active!;
      await post(
        "/session",
        {
          id: s.id,
          action: "recover-context",
          expectedMessageCount: app.store.session(s.id).messages.length,
          summary: "Do not replace context while a response is in flight.",
        },
        400,
      );
      const beforeEvents = app.store.lastEventId();
      const replacement = await post("/runtime/restart", {
        reason: "test handoff while a model response is in flight",
      });
      assert.notEqual(replacement.version, old.version);
      assert.equal(old.state, "draining");
      assert.equal(old.jobs.size, 1);
      assert.equal(old.child.exitCode, null);
      const duplicate = await post("/messages", {
        sessionId: s.id,
        requestId,
        selection,
        text: "Create a tool",
      });
      assert.equal(duplicate.id, job.id);
      await post(
        "/messages",
        { sessionId: s.id, requestId, selection, text: "Different payload" },
        400,
      );
      await post(
        "/messages",
        {
          sessionId: s.id,
          requestId: crypto.randomUUID(),
          selection: { ...selection, model: "nonexistent" },
          text: "No fallback",
        },
        400,
      );
      release!();
      const done = await until(
        () => app.store.session(s.id),
        (s) => s.status === "idle" || s.status === "error",
      );
      assert.equal(done.status, "idle", done.error);
      assert.deepEqual(
        requests
          .slice(0, 3)
          .map((request) =>
            request.messages
              .filter(
                (message: any) =>
                  !["system", "developer"].includes(message.role),
              )
              .map((message: any) => message.role),
          ),
        [
          ["user"],
          ["user", "assistant", "tool"],
          ["user", "assistant", "tool", "assistant", "tool"],
        ],
        "each completed assistant and tool result reaches the provider exactly once after dynamic reload",
      );
      assert.equal(done.messages.filter((m) => m.role === "user").length, 1);
      const receipt = done.messages.find(
        (m) => m.role === "toolResult" && m.toolName === "sum",
      );
      assert.equal(JSON.parse(receipt.content[0].text).total, 42);
      assert(
        done.messages
          .filter((m) => m.role === "assistant")
          .every(
            (m) =>
              m._moru.selection.model === selection.model &&
              m._moru.version === old.version,
          ),
      );
      assert(requests.every((r) => r.model === "test-model"));
      await until(
        () => app.supervisor.processes.has(old),
        (v) => !v,
      );
      await post("/messages", {
        sessionId: s.id,
        requestId: crypto.randomUUID(),
        selection,
        text: "Continue after handoff",
      });
      await until(
        () => app.store.session(s.id),
        (s) => s.status === "idle",
      );
      assert.equal(
        app.store.session(s.id).messages.at(-1)._moru.version,
        replacement.version,
      );
      const originalMessages = structuredClone(
        app.store.session(s.id).messages,
      );
      const recoverySummary =
        "The user requested a sum tool. Its verified result is 42. Keep the selected model and the complete audit history.";
      await post(
        "/session",
        {
          id: s.id,
          action: "recover-context",
          expectedMessageCount: 0,
          summary: recoverySummary,
        },
        400,
      );
      const recovered = await post("/session", {
        id: s.id,
        action: "recover-context",
        expectedMessageCount: originalMessages.length,
        summary: recoverySummary,
      });
      assert.deepEqual(recovered.messages, originalMessages);
      assert.equal(
        recovered.contextCheckpoint.messageCount,
        originalMessages.length,
      );
      await post("/messages", {
        sessionId: s.id,
        requestId: crypto.randomUUID(),
        selection,
        text: "Continue from the recovered context",
      });
      await until(
        () => app.store.session(s.id),
        (s) => s.status === "idle",
      );
      const afterRecovery = requests.at(-1).messages;
      const messageText = (message: any) => typeof message.content === "string"
        ? message.content
        : message.content.filter((part: any) => part.type === "text").map((part: any) => part.text).join("\n");
      assert.deepEqual(
        afterRecovery
          .filter((m: any) => !["system", "developer"].includes(m.role))
          .map(messageText),
        ["Continue from the recovered context"],
      );
      assert(
        afterRecovery.some(
          (m: any) =>
            ["system", "developer"].includes(m.role) &&
            messageText(m).includes(recoverySummary),
        ),
      );
      assert.deepEqual(
        app.store.session(s.id).messages.slice(0, originalMessages.length),
        originalMessages,
      );
      await post("/messages", {
        sessionId: s.id,
        requestId: crypto.randomUUID(),
        selection,
        text: "Keep the new context",
      });
      await until(
        () => app.store.session(s.id),
        (s) => s.status === "idle",
      );
      assert.deepEqual(
        requests
          .at(-1)
          .messages.filter(
            (m: any) => !["system", "developer"].includes(m.role),
          )
          .map((m: any) => m.role),
        ["user", "assistant", "user"],
      );
      const fork = await post("/session", { id: s.id, action: "fork" });
      assert.equal(fork.parentId, s.id);
      assert.deepEqual(fork.contextCheckpoint, recovered.contextCheckpoint);
      assert.equal(
        fork.messages.length,
        app.store.session(s.id).messages.length,
      );
      assert.equal(
        app.store.jobs().filter((j) => j.sessionId === fork.id).length,
        0,
      );
      assert.match(
        await readFile(
          join(root, ".moru/workspaces", fork.id, "tools/sum.mjs"),
          "utf8",
        ),
        /total:a\+b/,
      );
      await post("/providers/custom", {
        id: "login-fixture",
        name: "Login fixture",
        baseUrl: `http://127.0.0.1:${(fake.address() as any).port}/v1`,
        api: "openai-completions",
        keyless: false,
        models: [{ id: "auth-model" }],
      });
      const flow = await post("/auth/start", {
        provider: "login-fixture",
        type: "api_key",
      });
      const prompt = await until(
        async () => (await fetch(base + "/api/auth/flow/" + flow.id)).json(),
        (f) => !!f.prompt,
      );
      assert.equal(prompt.prompt.type, "secret");
      await post("/auth/answer", {
        id: flow.id,
        token: prompt.prompt.token,
        value: "fixture-secret-never-in-ui",
      });
      await until(
        async () => (await fetch(base + "/api/auth/flow/" + flow.id)).json(),
        (f) => f.status === "completed",
      );
      const authedState = await (await fetch(base + "/api/state")).json();
      assert.equal(
        authedState.catalog.find((p: any) => p.id === "login-fixture")
          .connected,
        true,
      );
      assert(
        !JSON.stringify(authedState).includes("fixture-secret-never-in-ui"),
      );
      assert(
        !JSON.stringify(app.store.events()).includes(
          "fixture-secret-never-in-ui",
        ),
      );
      const controller = new AbortController();
      const stream = await fetch(base + "/api/events", {
        headers: { "Last-Event-ID": String(beforeEvents) },
        signal: controller.signal,
      });
      const reader = stream.body!.getReader();
      const decoder = new TextDecoder();
      let wire = "";
      const timeout = setTimeout(() => controller.abort(), 5000);
      while (!wire.includes("😀")) {
        const part = await reader.read();
        if (part.done) break;
        wire += decoder.decode(part.value, { stream: true });
      }
      clearTimeout(timeout);
      controller.abort();
      assert.match(wire, /event: runtime/);
      assert.match(wire, /event: partial/);
      assert.match(wire, /😀/);
      const stable = app.supervisor.active!.version;
      await writeFile(
        join(root, "src/runtime.ts"),
        "this is not valid TypeScript !!!",
      );
      await post("/runtime/restart", { reason: "invalid candidate" }, 400);
      assert.equal(app.supervisor.active!.version, stable);
      const response = await fetch(
        base + "/api/files?scope=runtime&path=src%2F..%2F.moru%2Fauth.json",
      );
      assert.equal(response.status, 400);
      assert(
        !JSON.stringify(
          await (await fetch(base + "/api/state")).json(),
        ).includes("auth.json"),
      );
      await assert.rejects(
        createMoru(root, 0, { skipDiscovery: true }),
        /이미 실행/,
      );
    } finally {
      release?.();
      await app.close();
      await new Promise((resolve) => setTimeout(resolve, 150));
      fake.closeAllConnections();
      await new Promise<void>((r) => fake.close(() => r()));
      app.store.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);
