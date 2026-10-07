import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { readFile, writeFile, mkdir, readdir, cp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve, join, dirname, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { context as buildContext } from "esbuild";
import { Store } from "./store.ts";
import { Providers } from "./providers.ts";
import { Supervisor, type RuntimeProcess } from "./supervisor.ts";
import { workspacePath } from "./runtime.ts";
import type { Selection, Session, Job } from "./types.ts";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cleanError = (e: any) =>
  String(e?.message ?? e).replace(
    /(?:eyJ[A-Za-z0-9_.-]+|sk-[A-Za-z0-9_-]{12,})/g,
    "[redacted]",
  );
export function validRequest(req: IncomingMessage) {
  const host = req.headers.host || "";
  if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) return false;
  if (req.headers.origin && req.headers.origin !== `http://${host}`)
    return false;
  if (req.headers["sec-fetch-site"] === "cross-site") return false;
  return true;
}
async function body(req: IncomingMessage) {
  if (!req.headers["content-type"]?.startsWith("application/json"))
    throw Error("JSON 요청이 필요합니다.");
  let content = "";
  for await (const chunk of req) {
    content += chunk;
    if (content.length > 2_000_000) throw Error("요청이 너무 큽니다.");
  }
  return JSON.parse(content || "{}");
}
function json(res: ServerResponse, value: any, status = 200) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(value));
}

export async function createMoru(
  root = ROOT,
  port = Number(process.env.MORU_PORT ?? 4327),
  options: { skipDiscovery?: boolean } = {},
) {
  const dir = join(root, ".moru");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const lock = join(dir, "host.lock");
  if (process.env.MORU_SUCCESSOR === "1") {
    // A predecessor host is handing over: wait for it to release the lock.
    const deadline = Date.now() + 20000;
    while (existsSync(lock) && Date.now() < deadline)
      await new Promise((r) => setTimeout(r, 150));
  }
  if (existsSync(lock)) {
    let alive = false;
    try {
      const pid = Number(await readFile(join(lock, "pid"), "utf8"));
      if (pid > 0) {
        process.kill(pid, 0);
        alive = true;
      }
    } catch (e: any) {
      if (e.code === "EPERM") alive = true;
    }
    if (alive) throw Error("이 작업 공간의 Moru 호스트가 이미 실행 중입니다.");
    await rm(lock, { recursive: true, force: true });
  }
  await mkdir(lock);
  await writeFile(join(lock, "pid"), String(process.pid));
  const store = new Store(dir);
  store.recover();
  const clients = new Set<ServerResponse>();
  const wire = (e: any) =>
    `id: ${e.id}\nevent: ${e.type}\ndata: ${JSON.stringify(e.data)}\n\n`;
  function publish(type: string, data: any) {
    const event = store.event(type, data);
    for (const client of clients) {
      if (client.destroyed || client.writableLength > 2_000_000) client.end();
      else client.write(wire(event));
    }
  }
  const providers = new Providers(store);
  const supervisor = new Supervisor(root, store, publish);
  const busy = new Map<string, string>();
  const modelStreams = new Map<
    string,
    { controller: AbortController; jobId: string }
  >();
  const authFlows = new Map<string, any>();
  let catalog: any[] = [];
  let buildError: string | undefined;
  const snapshot = () => ({
    sessions: store.sessions().map(({ messages, partial, ...s }) => ({
      ...s,
      messageCount: messages.length,
    })),
    jobs: store
      .jobs()
      .filter((j) => j.status === "queued" || j.status === "running"),
    runtime: supervisor.snapshot(),
    catalog,
    defaultSelection: store.get<Selection | null>("defaultSelection", null),
    buildError,
    projectPath: root,
    eventId: store.lastEventId(),
  });
  const sessionChanged = (s: Session) => {
    store.saveSession(s);
    publish("session", s);
  };
  async function refreshCatalog() {
    catalog = await providers.catalog();
    publish("catalog", catalog);
  }
  function checkedSelection(input: any): Selection {
    if (
      !input ||
      typeof input.provider !== "string" ||
      typeof input.model !== "string"
    )
      throw Error("프로바이더와 모델을 선택하세요.");
    const model = providers.resolve(input);
    const levels = catalog
      .find((p) => p.id === input.provider)
      ?.models.find((m: any) => m.id === model.id)?.thinkingLevels || ["off"];
    const thinking = input.thinking || "off";
    if (!levels.includes(thinking))
      throw Error("이 모델에서 지원하는 추론 수준을 선택하세요.");
    return { provider: input.provider, model: input.model, thinking };
  }
  async function seedWorkspace(id: string) {
    const workspace = join(dir, "workspaces", id);
    await mkdir(join(workspace, "tools"), { recursive: true });
    await writeFile(
      join(workspace, "instructions.md"),
      "# 작업 지침\n\n사용자의 목표를 대화로 확인하고 필요한 도구를 하나씩 만든다.\n변경한 기능은 실제로 실행해서 확인한다.\n",
    );
    await writeFile(join(workspace, "notes.md"), "# 작업 기록\n\n");
    return workspace;
  }
  async function newSession(
    selection: Selection,
    title = "새 세션",
    parentId?: string,
  ) {
    const id = crypto.randomUUID();
    await seedWorkspace(id);
    const session: Session = {
      id,
      title,
      selection,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messages: [],
      status: "idle",
      parentId,
    };
    sessionChanged(session);
    return session;
  }
  function finish(p: RuntimeProcess, id: string, error?: string) {
    const job = store.job(id);
    if (!job || job.status !== "running") return;
    job.status = error ? "error" : "completed";
    job.error = error;
    store.saveJob(job);
    publish("job", job);
    const s = store.session(job.sessionId);
    s.status = error ? "error" : "idle";
    s.error = error;
    s.updatedAt = Date.now();
    delete s.partial;
    // Resolve any interrupted call before the next user turn is accepted by a provider.
    const receipts = new Set(
      s.messages
        .filter((m) => m.role === "toolResult")
        .map((m) => m.toolCallId),
    );
    for (const m of [...s.messages])
      if (m.role === "assistant")
        for (const c of m.content || [])
          if (c.type === "toolCall" && !receipts.has(c.id)) {
            s.messages.push({
              role: "toolResult",
              toolCallId: c.id,
              toolName: c.name,
              isError: true,
              content: [
                {
                  type: "text",
                  text: "Tool execution interrupted. Verify existing results before repeating external actions.",
                },
              ],
              timestamp: Date.now(),
            });
            receipts.add(c.id);
          }
    sessionChanged(s);
    busy.delete(s.id);
    p.jobs.delete(id);
    for (const [key, stream] of modelStreams)
      if (stream.jobId === id) {
        stream.controller.abort();
        modelStreams.delete(key);
      }
    supervisor.retire(p);
    publish("runtime", supervisor.snapshot());
    dispatch();
  }
  function dispatch() {
    const p = supervisor.active;
    if (!p || supervisor.closing) return;
    for (const job of store.jobs().filter((j) => j.status === "queued")) {
      if (busy.has(job.sessionId)) continue;
      const s = store.session(job.sessionId);
      try {
        const model = providers.resolve(job.selection);
        job.status = "running";
        job.version = p.version;
        store.saveJob(job);
        publish("job", job);
        busy.set(s.id, job.id);
        p.jobs.add(job.id);
        s.status = "running";
        s.error = undefined;
        s.version = p.version;
        sessionChanged(s);
        p.child.send({ type: "run", job: { ...job, model, session: s } });
      } catch (e) {
        job.status = "error";
        job.error = cleanError(e);
        store.saveJob(job);
        s.status = "error";
        s.error = job.error;
        sessionChanged(s);
      }
    }
    publish("runtime", supervisor.snapshot());
  }
  async function runtimeFile(path: string) {
    if (path !== "src/runtime.ts" && !/^app\/[a-zA-Z0-9_./-]+$/.test(path))
      throw Error("src/runtime.ts 또는 app/ 파일만 수정할 수 있습니다.");
    const full = await workspacePath(root, path);
    if (path !== "src/runtime.ts" && !full.startsWith(join(root, "app") + sep))
      throw Error("잘못된 앱 경로입니다.");
    return full;
  }
  async function handleRuntimeRpc(p: RuntimeProcess, m: any) {
    try {
      let result;
      if (m.action === "read_runtime_file")
        result = {
          path: m.input.path,
          content: await readFile(await runtimeFile(m.input.path), "utf8"),
        };
      else if (m.action === "write_runtime_file") {
        const full = await runtimeFile(m.input.path);
        await mkdir(dirname(full), { recursive: true });
        await writeFile(full, m.input.content);
        publish("files", { scope: "runtime", path: m.input.path });
        result = {
          saved: m.input.path,
          requiresRestart: m.input.path === "src/runtime.ts",
        };
      } else if (m.action === "request_runtime_restart")
        result = await supervisor.restart(m.input.reason);
      else if (m.action === "inspect_runtime")
        result = {
          ...supervisor.snapshot(),
          selection: store.job(m.jobId)?.selection,
          root,
        };
      else throw Error("알 수 없는 호스트 요청입니다.");
      if (p.child.connected)
        p.child.send({ type: "rpc_result", id: m.id, result });
    } catch (e) {
      if (p.child.connected)
        p.child.send({ type: "rpc_result", id: m.id, error: cleanError(e) });
    }
  }
  async function modelRequest(p: RuntimeProcess, m: any) {
    const job = store.job(m.jobId);
    if (!job || !p.jobs.has(job.id)) return;
    const controller = new AbortController();
    modelStreams.set(m.id, { controller, jobId: job.id });
    try {
      const stream = await providers.stream(
        job.selection,
        m.context,
        controller.signal,
        job.sessionId,
      );
      for await (const event of stream)
        if (p.child.connected)
          p.child.send({ type: "model_event", id: m.id, event });
    } catch (e) {
      const error = {
        role: "assistant",
        content: [],
        api: "unknown",
        provider: job.selection.provider,
        model: job.selection.model,
        stopReason: controller.signal.aborted ? "aborted" : "error",
        errorMessage: cleanError(e),
        timestamp: Date.now(),
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      };
      if (p.child.connected)
        p.child.send({
          type: "model_event",
          id: m.id,
          event: { type: "error", reason: error.stopReason, error },
        });
    } finally {
      modelStreams.delete(m.id);
    }
  }
  supervisor.onMessage = (p, m) => {
    if (m.type === "rpc") {
      void handleRuntimeRpc(p, m);
      return;
    }
    if (m.type === "model_request") {
      void modelRequest(p, m);
      return;
    }
    if (m.type === "cancel_stream") {
      modelStreams.get(m.id)?.controller.abort();
      return;
    }
    const job = store.job(m.jobId);
    if (!job || !p.jobs.has(job.id)) return;
    if (m.type === "job_end") {
      finish(p, job.id, m.error);
      return;
    }
    if (m.type === "notice") {
      publish("notice", { sessionId: job.sessionId, error: m.error });
      return;
    }
    if (m.type === "workspace_changed") {
      publish("files", { sessionId: job.sessionId, path: m.path });
      return;
    }
    if (m.type !== "agent_event") return;
    const s = store.session(job.sessionId);
    const e = m.event;
    if (e.type === "message_start" || e.type === "message_update") {
      if (e.message.role === "assistant") {
        s.partial = e.message;
        store.saveSession(s);
        publish("partial", { sessionId: s.id, message: e.message });
      }
    }
    if (e.type === "message_end") {
      s.messages.push({
        ...e.message,
        _moru: {
          id: `${job.id}:${s.messages.length}`,
          selection: job.selection,
          version: job.version,
        },
      });
      delete s.partial;
      s.updatedAt = Date.now();
      sessionChanged(s);
    }
    if (e.type.startsWith("tool_execution_"))
      publish("tool", { sessionId: s.id, jobId: job.id, ...e });
  };
  supervisor.onExit = (p) => {
    for (const id of [...p.jobs])
      finish(
        p,
        id,
        "런타임이 종료되었습니다. 도구 결과를 확인한 뒤 다시 요청해 주세요.",
      );
    if (p.state === "active" && !supervisor.closing) {
      const good = store.get<any>("lastGoodRuntime", null);
      const attempts = store.get<number>("runtimeRecoveryAttempts", 0) + 1;
      store.set("runtimeRecoveryAttempts", attempts);
      if (good && attempts <= 3)
        setTimeout(
          () =>
            void supervisor
              .restart("런타임 종료 후 복구", good.source)
              .then(dispatch)
              .catch(() => {}),
          500,
        );
      else {
        supervisor.status = {
          phase: "error",
          error:
            "런타임 종료가 반복되었습니다. 소스를 수정한 뒤 작업 공간에서 다시 교체하세요.",
        };
        publish("runtime", supervisor.snapshot());
      }
    }
  };
  const build = await buildContext({
    absWorkingDir: root,
    entryPoints: ["app/main.tsx"],
    bundle: true,
    outdir: "dist",
    entryNames: "app",
    format: "esm",
    platform: "browser",
    jsx: "automatic",
    sourcemap: true,
    logLevel: "silent",
    plugins: [
      {
        name: "moru-reload",
        setup(build) {
          build.onEnd((result) => {
            buildError = result.errors.length
              ? result.errors.map((e) => e.text).join("\n")
              : undefined;
            publish("build", { error: buildError });
          });
        },
      },
    ],
  });
  await build.rebuild();
  await build.watch();

  const server = createServer(async (req, res) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self' 'sha256-LM1Pa7tBgG8Qvo8McM25Yt/sdgdIXdYIaMQrQGENWAU='; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self'; frame-ancestors 'none'; object-src 'none'; base-uri 'none'",
    );
    if (!validRequest(req))
      return json(res, { error: "로컬 Moru 화면에서 접속하세요." }, 403);
    try {
      const url = new URL(req.url || "/", `http://${req.headers.host}`);
      const path = url.pathname;
      if (req.method === "GET" && path === "/api/health")
        return json(res, { ok: true, ...supervisor.snapshot() });
      if (req.method === "GET" && path === "/api/state")
        return json(res, snapshot());
      if (req.method === "GET" && path === "/api/events") {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache, no-transform",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
        });
        res.write("retry: 1000\n\n");
        const cursor = Number(
          req.headers["last-event-id"] || url.searchParams.get("after") || 0,
        );
        const latest = store.lastEventId();
        if (
          cursor &&
          Number.isSafeInteger(cursor) &&
          cursor <= latest &&
          latest - cursor <= 1000
        ) {
          for (const event of store.events(cursor)) res.write(wire(event));
        } else res.write(wire({ id: latest, type: "reset", data: snapshot() }));
        clients.add(res);
        res.on("close", () => clients.delete(res));
        return;
      }
      if (req.method === "GET" && path.startsWith("/api/sessions/"))
        return json(res, store.session(path.split("/").at(-1)!));
      if (req.method === "POST" && path === "/api/sessions") {
        const data = await body(req);
        return json(res, await newSession(checkedSelection(data.selection)));
      }
      if (req.method === "POST" && path === "/api/session") {
        const data = await body(req);
        const s = store.session(data.id);
        if (data.action === "fork") {
          if (busy.has(s.id))
            throw Error("현재 응답이 끝난 뒤 세션을 분기할 수 있습니다.");
          const fork = await newSession(s.selection, `${s.title} · 분기`, s.id);
          await cp(
            join(dir, "workspaces", s.id),
            join(dir, "workspaces", fork.id),
            { recursive: true },
          );
          fork.messages = structuredClone(s.messages);
          fork.contextCheckpoint = structuredClone(s.contextCheckpoint);
          sessionChanged(fork);
          return json(res, fork);
        }
        if (data.action === "recover-context") {
          if (
            busy.has(s.id) ||
            store
              .jobs()
              .some((j) => j.sessionId === s.id && j.status === "queued")
          )
            throw Error(
              "실행과 대기 중인 요청이 끝난 뒤 문맥을 복구할 수 있습니다.",
            );
          if (data.expectedMessageCount !== s.messages.length)
            throw Error("대화가 변경되었습니다. 최신 기록을 확인하세요.");
          if (
            typeof data.summary !== "string" ||
            !data.summary.trim() ||
            data.summary.length > 20000
          )
            throw Error("복구할 대화 요약이 필요합니다.");
          s.contextCheckpoint = {
            summary: data.summary.trim(),
            messageCount: s.messages.length,
            createdAt: Date.now(),
          };
          publish("context_checkpoint", {
            sessionId: s.id,
            ...s.contextCheckpoint,
          });
        }
        if (typeof data.archived === "boolean") {
          if (data.archived) s.archivedAt = Date.now();
          else delete s.archivedAt;
        }
        if (typeof data.title === "string")
          s.title = data.title.trim().slice(0, 100) || "새 세션";
        if (data.selection) {
          s.selection = checkedSelection(data.selection);
          store.set("defaultSelection", s.selection);
        }
        s.updatedAt = Date.now();
        sessionChanged(s);
        return json(res, s);
      }
      if (req.method === "POST" && path === "/api/messages") {
        const data = await body(req);
        if (
          typeof data.text !== "string" ||
          !data.text.trim() ||
          data.text.length > 100000
        )
          throw Error("메시지를 입력하세요.");
        if (
          typeof data.requestId !== "string" ||
          !/^[a-zA-Z0-9-]{8,100}$/.test(data.requestId)
        )
          throw Error("요청 식별자가 필요합니다.");
        const prior = store.job(data.requestId);
        if (prior) {
          if (
            prior.text !== data.text.trim() ||
            prior.sessionId !== data.sessionId
          )
            throw Error("같은 요청 식별자를 다른 메시지에 사용할 수 없습니다.");
          return json(res, prior);
        }
        const selection = checkedSelection(data.selection);
        const connected = catalog.find(
          (p) => p.id === selection.provider,
        )?.connected;
        if (!connected) throw Error("선택한 프로바이더를 먼저 연결하세요.");
        const s = data.sessionId
          ? store.session(data.sessionId)
          : await newSession(selection);
        s.selection = selection;
        if (!s.messages.length && s.title === "새 세션")
          s.title = data.text.trim().split("\n")[0].slice(0, 44);
        if (!busy.has(s.id)) s.status = "queued";
        s.updatedAt = Date.now();
        s.error = undefined;
        sessionChanged(s);
        const job: Job = {
          id: data.requestId,
          sessionId: s.id,
          text: data.text.trim(),
          selection,
          status: "queued",
          createdAt: Date.now(),
        };
        store.saveJob(job);
        store.set("defaultSelection", selection);
        publish("job", job);
        dispatch();
        return json(res, job);
      }
      if (req.method === "POST" && path === "/api/stop") {
        const data = await body(req);
        const sessionId = store.session(data.sessionId).id;
        for (const j of store
          .jobs()
          .filter((j) => j.sessionId === sessionId && j.status === "queued")) {
          j.status = "error";
          j.error = "사용자가 대기 중인 요청을 취소했습니다.";
          store.saveJob(j);
          publish("job", j);
        }
        const id = busy.get(sessionId);
        if (id)
          for (const p of supervisor.processes)
            if (p.jobs.has(id)) p.child.send({ type: "abort", jobId: id });
        return json(res, { ok: true });
      }
      if (req.method === "POST" && path === "/api/runtime/restart") {
        const data = await body(req);
        store.set("runtimeRecoveryAttempts", 0);
        const result = await supervisor.restart(data.reason);
        dispatch();
        return json(res, result);
      }
      if (req.method === "POST" && path === "/api/host/restart") {
        await body(req);
        json(res, { ok: true, restarting: true });
        setTimeout(() => void restartHost(), 250);
        return;
      }
      if (req.method === "POST" && path === "/api/providers/refresh") {
        await body(req);
        await providers.refreshDevin();
        await providers.models.refresh({ signal: AbortSignal.timeout(20000) });
        await refreshCatalog();
        return json(res, catalog);
      }
      if (req.method === "POST" && path === "/api/providers/custom") {
        await providers.custom(await body(req));
        await refreshCatalog();
        return json(res, catalog);
      }
      if (req.method === "POST" && path === "/api/auth/logout") {
        const data = await body(req);
        await providers.models.logout(data.provider);
        await refreshCatalog();
        return json(res, { ok: true });
      }
      if (req.method === "POST" && path === "/api/auth/start") {
        const data = await body(req);
        const id = crypto.randomUUID();
        const controller = new AbortController();
        if (!["api_key", "oauth"].includes(data.type))
          throw Error("인증 방식을 선택하세요.");
        const flow: any = {
          id,
          provider: data.provider,
          type: data.type,
          status: "running",
          events: [],
          controller,
        };
        authFlows.set(id, flow);
        const notify = () => publish("auth", { id });
        const timer = setTimeout(() => controller.abort(), 10 * 60 * 1000);
        timer.unref();
        void providers.models
          .login(data.provider, data.type, {
            signal: controller.signal,
            notify: (event) => {
              flow.events.push(event);
              notify();
            },
            prompt: (prompt) =>
              new Promise((resolvePrompt, reject) => {
                const token = crypto.randomUUID();
                const { signal, ...publicPrompt } = prompt;
                flow.prompt = { ...publicPrompt, token };
                const abort = () => {
                  if (flow.prompt?.token === token) {
                    delete flow.prompt;
                    delete flow.answer;
                    notify();
                  }
                  reject(Error("인증 입력이 취소되었습니다."));
                };
                flow.answer = (value: string) => {
                  signal?.removeEventListener("abort", abort);
                  controller.signal.removeEventListener("abort", abort);
                  delete flow.prompt;
                  delete flow.answer;
                  resolvePrompt(value);
                  notify();
                };
                signal?.addEventListener("abort", abort, { once: true });
                controller.signal.addEventListener("abort", abort, {
                  once: true,
                });
                notify();
              }),
          })
          .then(async () => {
            await providers.models.refresh({
              providers: [data.provider],
              signal: AbortSignal.timeout(15000),
            });
            await refreshCatalog();
            flow.status = "completed";
          })
          .catch((e) => {
            flow.status = "error";
            flow.error = cleanError(e);
          })
          .finally(() => {
            clearTimeout(timer);
            delete flow.prompt;
            delete flow.answer;
            notify();
          });
        return json(res, { id });
      }
      if (req.method === "GET" && path.startsWith("/api/auth/flow/")) {
        const flow = authFlows.get(path.split("/").at(-1)!);
        if (!flow) throw Error("인증 요청이 만료되었습니다.");
        return json(res, {
          id: flow.id,
          provider: flow.provider,
          status: flow.status,
          events: flow.events,
          prompt: flow.prompt,
          error: flow.error,
        });
      }
      if (req.method === "POST" && path === "/api/auth/answer") {
        const data = await body(req);
        const flow = authFlows.get(data.id);
        if (!flow?.answer || flow.prompt?.token !== data.token)
          throw Error("입력 단계가 변경되었습니다.");
        flow.answer(String(data.value));
        return json(res, { ok: true });
      }
      if (req.method === "POST" && path === "/api/auth/cancel") {
        const data = await body(req);
        authFlows.get(data.id)?.controller.abort();
        return json(res, { ok: true });
      }
      if (req.method === "GET" && path === "/api/files") {
        const scope = url.searchParams.get("scope") || "workspace";
        const sessionId = url.searchParams.get("sessionId");
        const base =
          scope === "runtime"
            ? root
            : join(dir, "workspaces", store.session(sessionId!).id);
        const requested = url.searchParams.get("path");
        if (requested) {
          const full =
            scope === "runtime"
              ? await runtimeFile(requested)
              : await workspacePath(base, requested);
          return json(res, {
            path: requested,
            content: await readFile(full, "utf8"),
          });
        }
        const files: { path: string; directory: boolean }[] = [];
        async function walk(folder: string, prefix = "") {
          for (const f of await readdir(folder, { withFileTypes: true })) {
            if (
              f.name === "node_modules" ||
              f.name.startsWith(".") ||
              f.isSymbolicLink()
            )
              continue;
            const path = prefix + f.name;
            files.push({ path, directory: f.isDirectory() });
            if (f.isDirectory() && files.length < 250)
              await walk(join(folder, f.name), path + "/");
          }
        }
        if (scope === "runtime") {
          files.push({ path: "src/runtime.ts", directory: false });
          await walk(join(root, "app"), "app/");
        } else await walk(base);
        return json(res, { files, root: base });
      }
      if (req.method === "POST" && path === "/api/files") {
        const data = await body(req);
        const base =
          data.scope === "runtime"
            ? root
            : join(dir, "workspaces", store.session(data.sessionId).id);
        const full =
          data.scope === "runtime"
            ? await runtimeFile(data.path)
            : await workspacePath(base, data.path);
        await mkdir(dirname(full), { recursive: true });
        await writeFile(full, String(data.content));
        publish("files", { sessionId: data.sessionId, path: data.path });
        return json(res, { ok: true });
      }
      const staticFiles: Record<string, [string, string]> = {
        "/": ["app/index.html", "text/html"],
        "/app.js": ["dist/app.js", "text/javascript"],
        "/app.css": ["dist/app.css", "text/css"],
        "/app.js.map": ["dist/app.js.map", "application/json"],
        "/app.css.map": ["dist/app.css.map", "application/json"],
      };
      if (req.method === "GET" && staticFiles[path]) {
        const [file, type] = staticFiles[path];
        const content = await readFile(join(root, file));
        res.writeHead(200, {
          "Content-Type": type + "; charset=utf-8",
          "Cache-Control": "no-cache",
        });
        res.end(content);
        return;
      }
      json(res, { error: "찾을 수 없는 경로입니다." }, 404);
    } catch (e) {
      json(res, { error: cleanError(e) }, 400);
    }
  });
  const listenDeadline =
    Date.now() + (process.env.MORU_SUCCESSOR === "1" ? 20000 : 0);
  while (true) {
    try {
      await new Promise<void>((resolveListen, rejectListen) => {
        const onError = (e: any) => rejectListen(e);
        server.once("error", onError);
        server.listen(port, "127.0.0.1", () => {
          server.removeListener("error", onError);
          resolveListen();
        });
      });
      break;
    } catch (e: any) {
      if (e.code !== "EADDRINUSE" || Date.now() > listenDeadline) throw e;
      await new Promise((r) => setTimeout(r, 150));
    }
  }
  const keepalive = setInterval(() => {
    for (const client of clients) client.write(": keepalive\n\n");
  }, 15000).unref();
  await supervisor.start().catch((error) => {
    publish("notice", { error: cleanError(error) });
  });
  catalog = await providers.catalog();
  publish("catalog", catalog);
  if (!options.skipDiscovery)
    void providers
      .refreshDevin()
      .then(refreshCatalog)
      .then(dispatch)
      .catch((e) => publish("notice", { error: cleanError(e) }));
  dispatch();
  let hostRestarting = false;
  async function restartHost() {
    if (hostRestarting) return;
    hostRestarting = true;
    supervisor.closing = true;
    // Under a supervisor that respawns on exit (launchd KeepAlive, etc.)
    // exiting is enough. Otherwise spawn a detached successor; host.lock
    // arbitrates if both race to start.
    if (!process.env.XPC_SERVICE_NAME) {
      try {
        const child = spawn(
          process.execPath,
          [...process.execArgv, process.argv[1]!],
          {
            cwd: root,
            env: { ...process.env, MORU_SUCCESSOR: "1" },
            detached: true,
            stdio: "inherit",
          },
        );
        child.on("error", () => {});
        child.unref();
      } catch {}
    }
    await close().catch(() => {});
    process.exit(0);
  }
  async function close() {
    supervisor.close();
    for (const f of authFlows.values()) f.controller.abort();
    for (const s of modelStreams.values()) s.controller.abort();
    clearInterval(keepalive);
    for (const client of clients) client.end();
    await build.dispose();
    server.close();
    await rm(lock, { recursive: true, force: true });
  }
  return {
    server,
    store,
    supervisor,
    providers,
    close,
    port: (server.address() as any).port,
  };
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  createMoru()
    .then((app) => {
      console.log(`Moru is ready at http://127.0.0.1:${app.port}`);
      const stop = () => {
        void app.close().finally(() => setTimeout(() => process.exit(0), 500));
      };
      process.on("SIGTERM", stop);
      process.on("SIGINT", stop);
    })
    .catch((error) => {
      console.error(cleanError(error));
      process.exit(1);
    });
}
