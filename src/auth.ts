import { readFile, writeFile, rename, mkdir, chmod } from "node:fs/promises";
import { join } from "node:path";
import type { Credential, CredentialStore } from "@earendil-works/pi-ai";

export class FileCredentials implements CredentialStore {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(readonly dir: string) {}
  private async all(): Promise<Record<string, Credential>> {
    try {
      return JSON.parse(await readFile(join(this.dir, "auth.json"), "utf8"));
    } catch (e: any) {
      if (e.code === "ENOENT") return {};
      throw e;
    }
  }
  async read(id: string) {
    await this.queue;
    return (await this.all())[id];
  }
  async list() {
    await this.queue;
    return Object.entries(await this.all()).map(([providerId, c]) => ({
      providerId,
      type: c.type,
    }));
  }
  private locked<T>(fn: () => Promise<T>): Promise<T> {
    const task = this.queue.then(fn);
    this.queue = task.catch(() => {});
    return task;
  }
  private async save(data: Record<string, Credential>) {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const target = join(this.dir, "auth.json");
    const tmp = target + ".tmp";
    await writeFile(tmp, JSON.stringify(data), { mode: 0o600 });
    await chmod(tmp, 0o600);
    await rename(tmp, target);
  }
  modify(
    id: string,
    fn: (c: Credential | undefined) => Promise<Credential | undefined>,
  ) {
    return this.locked(async () => {
      const data = await this.all();
      const result = await fn(data[id]);
      if (result !== undefined) {
        data[id] = result;
        await this.save(data);
      }
      return data[id];
    });
  }
  delete(id: string) {
    return this.locked(async () => {
      const data = await this.all();
      delete data[id];
      await this.save(data);
    });
  }
}
