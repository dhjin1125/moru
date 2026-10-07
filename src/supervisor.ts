import { fork, type ChildProcess } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { Store } from "./store.ts";

export type RuntimeProcess = {
  child: ChildProcess;
  version: string;
  state: "active" | "draining" | "starting";
  jobs: Set<string>;
  startedAt: number;
};
export class Supervisor {
  active?: RuntimeProcess;
  processes = new Set<RuntimeProcess>();
  private changing?: Promise<any>;
  closing = false;
  status: { phase: string; error?: string; reason?: string } = {
    phase: "starting",
  };
  onMessage: (p: RuntimeProcess, m: any) => void = () => {};
  onExit: (p: RuntimeProcess) => void = () => {};
  constructor(
    readonly root: string,
    readonly store: Store,
    readonly publish: (type: string, data: any) => void,
  ) {}
  snapshot() {
    return {
      ...this.status,
      activeVersion: this.active?.version,
      hostPid: process.pid,
      processes: [...this.processes].map((p) => ({
        version: p.version,
        pid: p.child.pid,
        state: p.state,
        jobs: p.jobs.size,
        startedAt: p.startedAt,
      })),
    };
  }
  async prepare(source?: string): Promise<RuntimeProcess> {
    const code =
      source ?? (await readFile(join(this.root, "src/runtime.ts"), "utf8"));
    const digest = createHash("sha256").update(code).digest("hex").slice(0, 8);
    const version = `${Date.now().toString(36)}-${digest}`;
    const release = join(this.store.dir, "releases", version);
    await mkdir(release, { recursive: true });
    await writeFile(join(release, "runtime.ts"), code);
    const child = fork(join(release, "runtime.ts"), [], {
      cwd: this.root,
      execArgv: ["--import", "tsx"],
      env: {
        PATH: process.env.PATH,
        TMPDIR: process.env.TMPDIR,
        MORU_ROOT: this.root,
        MORU_VERSION: version,
      },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      serialization: "advanced",
    });
    const p: RuntimeProcess = {
      child,
      version,
      state: "starting",
      jobs: new Set(),
      startedAt: Date.now(),
    };
    this.processes.add(p);
    let stderr = "";
    child.stdout?.on("data", () => {});
    child.stderr?.on("data", (b) => {
      stderr = (stderr + b).slice(-12000);
    });
    child.on("exit", () => {
      this.processes.delete(p);
      if (this.active === p) this.active = undefined;
      this.onExit(p);
      this.publish("runtime", this.snapshot());
    });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill();
        reject(Error("새 런타임이 준비 신호를 보내지 않았습니다."));
      }, 15000);
      const fail = () => {
        clearTimeout(timer);
        reject(Error(stderr || "런타임 시작에 실패했습니다."));
      };
      child.once("exit", fail);
      child.once("error", reject);
      child.on("message", (m: any) => {
        if (m.type === "ready") {
          clearTimeout(timer);
          child.removeListener("exit", fail);
          if (m.protocol !== 1 || m.stateSchema !== 1) {
            child.kill();
            reject(Error("호스트와 호환되지 않는 실행·상태 형식입니다."));
          } else resolve();
        } else this.onMessage(p, m);
      });
    });
    return p;
  }
  restart(reason = "사용자가 런타임 교체를 요청했습니다.", source?: string) {
    if (this.changing) return this.changing;
    this.changing = (async () => {
      this.status = { phase: "preparing", reason };
      this.publish("runtime", this.snapshot());
      try {
        const next = await this.prepare(source);
        const previous = this.active;
        next.state = "active";
        this.active = next;
        this.store.set("lastGoodRuntime", {
          version: next.version,
          source: await readFile(
            join(this.store.dir, "releases", next.version, "runtime.ts"),
            "utf8",
          ),
        });
        if (previous) {
          previous.state = "draining";
          this.retire(previous);
        }
        this.status = { phase: "ready", reason };
        this.publish("runtime", this.snapshot());
        return {
          version: next.version,
          previousVersion: previous?.version,
          status: "ready",
        };
      } catch (e: any) {
        this.status = {
          phase: this.active ? "ready" : "error",
          reason,
          error: e.message,
        };
        this.publish("runtime", this.snapshot());
        throw e;
      } finally {
        this.changing = undefined;
      }
    })();
    return this.changing;
  }
  retire(p: RuntimeProcess) {
    if (p.state === "draining" && !p.jobs.size) p.child.kill("SIGTERM");
  }
  async start() {
    try {
      await this.restart("Moru 시작");
    } catch (e) {
      const good = this.store.get<any>("lastGoodRuntime", null);
      if (!good) throw e;
      await this.restart("마지막으로 기동된 버전으로 복구", good.source);
    }
  }
  close() {
    this.closing = true;
    for (const p of this.processes) p.child.kill();
  }
}
