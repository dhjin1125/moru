import { DatabaseSync } from "node:sqlite";
import { mkdirSync, chmodSync } from "node:fs";
import { join } from "node:path";
import type { Job, Session } from "./types.ts";

export class Store {
  db: DatabaseSync;
  constructor(readonly dir: string) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(join(dir, "moru.sqlite"));
    chmodSync(join(dir, "moru.sqlite"), 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, updated INTEGER, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, created INTEGER, status TEXT, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT, data TEXT, at INTEGER);
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, data TEXT NOT NULL);`);
  }
  sessions(): Session[] {
    return this.db
      .prepare("SELECT data FROM sessions ORDER BY updated DESC")
      .all()
      .map((r: any) => JSON.parse(r.data));
  }
  session(id: string): Session {
    const row: any = this.db
      .prepare("SELECT data FROM sessions WHERE id=?")
      .get(id);
    if (!row) throw Error("세션을 찾을 수 없습니다.");
    return JSON.parse(row.data);
  }
  saveSession(s: Session) {
    this.db
      .prepare(
        "INSERT INTO sessions VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET updated=excluded.updated,data=excluded.data",
      )
      .run(s.id, s.updatedAt, JSON.stringify(s));
  }
  saveJob(j: Job) {
    this.db
      .prepare(
        "INSERT INTO jobs VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,data=excluded.data",
      )
      .run(j.id, j.createdAt, j.status, JSON.stringify(j));
  }
  job(id: string): Job | undefined {
    const r: any = this.db.prepare("SELECT data FROM jobs WHERE id=?").get(id);
    return r ? JSON.parse(r.data) : undefined;
  }
  jobs(): Job[] {
    return this.db
      .prepare("SELECT data FROM jobs ORDER BY created")
      .all()
      .map((r: any) => JSON.parse(r.data));
  }
  event(type: string, data: unknown) {
    const at = Date.now();
    const result = this.db
      .prepare("INSERT INTO events(type,data,at) VALUES (?,?,?)")
      .run(type, JSON.stringify(data), at);
    return { id: Number(result.lastInsertRowid), type, data, at };
  }
  events(after = 0, limit = 1000): any[] {
    return this.db
      .prepare("SELECT * FROM events WHERE id>? ORDER BY id LIMIT ?")
      .all(after, limit)
      .map((r: any) => ({ ...r, data: JSON.parse(r.data) }));
  }
  lastEventId() {
    return Number(
      (this.db.prepare("SELECT max(id) AS id FROM events").get() as any).id ??
        0,
    );
  }
  get<T>(key: string, fallback: T): T {
    const r: any = this.db
      .prepare("SELECT data FROM settings WHERE key=?")
      .get(key);
    return r ? JSON.parse(r.data) : fallback;
  }
  set(key: string, value: unknown) {
    this.db
      .prepare(
        "INSERT INTO settings VALUES (?,?) ON CONFLICT(key) DO UPDATE SET data=excluded.data",
      )
      .run(key, JSON.stringify(value));
  }
  recover() {
    for (const j of this.jobs().filter((j) => j.status === "running")) {
      j.status = "error";
      j.error =
        "호스트가 재시작되었습니다. 완료된 기록을 확인한 뒤 이어서 요청해 주세요.";
      this.saveJob(j);
      const s = this.session(j.sessionId);
      s.status = "error";
      s.error = j.error;
      // An unfinished tool call is retained as a failed receipt so a later turn has a valid transcript.
      const answered = new Set(
        s.messages
          .filter((m) => m.role === "toolResult")
          .map((m) => m.toolCallId),
      );
      for (const m of [...s.messages])
        if (m.role === "assistant")
          for (const c of m.content ?? [])
            if (c.type === "toolCall" && !answered.has(c.id)) {
              s.messages.push({
                role: "toolResult",
                toolCallId: c.id,
                toolName: c.name,
                isError: true,
                content: [
                  {
                    type: "text",
                    text: "Execution was interrupted. The external effect is unknown; inspect existing results before retrying.",
                  },
                ],
                timestamp: Date.now(),
              });
              answered.add(c.id);
            }
      delete s.partial;
      this.saveSession(s);
    }
  }
  close() {
    this.db.close();
  }
}
