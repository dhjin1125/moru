import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, stat, mkdir, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileCredentials } from "../src/auth.ts";
import { Store } from "../src/store.ts";
import { workspacePath } from "../src/runtime.ts";
import { validRequest } from "../src/host.ts";

test("credential refresh writes serialize and metadata never contains secrets", async () => {
  const dir = await mkdtemp(join(tmpdir(), "moru-auth-"));
  try {
    const store = new FileCredentials(dir);
    await store.modify("test", async () => ({
      type: "oauth",
      refresh: "refresh-0",
      access: "secret-0",
      expires: 0,
      revision: 0,
    }));
    const observed: number[] = [];
    await Promise.all(
      Array.from({ length: 4 }, () =>
        store.modify("test", async (current: any) => {
          observed.push(current.revision);
          await new Promise((resolve) => setTimeout(resolve, 5));
          return {
            ...current,
            revision: current.revision + 1,
            access: "secret-" + (current.revision + 1),
          };
        }),
      ),
    );
    assert.deepEqual(observed, [0, 1, 2, 3]);
    assert.deepEqual(await store.list(), [
      { providerId: "test", type: "oauth" },
    ]);
    assert.equal(
      ((await new FileCredentials(dir).read("test")) as any)?.access,
      "secret-4",
    );
    assert.equal((await stat(join(dir, "auth.json"))).mode & 0o777, 0o600);
    await assert.rejects(
      store.modify("test", async () => {
        throw Error("refresh failed");
      }),
      /refresh failed/,
    );
    assert.equal(((await store.read("test")) as any)?.access, "secret-4");
    await store.delete("test");
    assert.equal(await store.read("test"), undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("host restart preserves queued work and marks uncertain running tool results without replay", async () => {
  const dir = await mkdtemp(join(tmpdir(), "moru-state-"));
  const store = new Store(dir);
  try {
    const selection = { provider: "p", model: "m", thinking: "off" };
    store.saveSession({
      id: "s",
      title: "test",
      selection,
      createdAt: 1,
      updatedAt: 1,
      status: "running",
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "send-1",
              name: "external_action",
              arguments: {},
            },
          ],
        },
      ],
    });
    store.saveJob({
      id: "running",
      sessionId: "s",
      text: "run",
      selection,
      status: "running",
      createdAt: 1,
    });
    store.saveJob({
      id: "queued",
      sessionId: "s",
      text: "next",
      selection,
      status: "queued",
      createdAt: 2,
    });
    store.recover();
    store.recover();
    assert.equal(store.job("running")?.status, "error");
    assert.equal(store.job("queued")?.status, "queued");
    const messages = store.session("s").messages;
    assert.equal(messages.length, 2);
    assert.equal(messages[1].isError, true);
    assert.match(messages[1].content[0].text, /unknown/);
    const e1 = store.event("one", { value: "첫 이벤트 😀" });
    const e2 = store.event("two", { value: "둘" });
    assert.deepEqual(
      store.events(e1.id).map((e) => e.id),
      [e2.id],
    );
    store.close();
    const reopened = new Store(dir);
    assert.equal(reopened.lastEventId(), e2.id);
    reopened.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("workspace paths reject traversal and symlinks outside the session", async () => {
  const base = await mkdtemp(join(tmpdir(), "moru-path-"));
  const canonical = await import("node:fs/promises").then((fs) =>
    fs.realpath(base),
  );
  try {
    await mkdir(join(canonical, "tools"));
    assert.equal(
      await workspacePath(canonical, "tools/new.mjs"),
      join(canonical, "tools/new.mjs"),
    );
    await assert.rejects(workspacePath(canonical, "../secret"), /상대 경로/);
    await symlink(tmpdir(), join(canonical, "outside"));
    await assert.rejects(workspacePath(canonical, "outside/file"), /링크/);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("host rejects cross-origin writes and DNS rebinding host names", () => {
  assert.equal(
    validRequest({
      headers: { host: "127.0.0.1:4327", origin: "http://127.0.0.1:4327" },
    } as any),
    true,
  );
  assert.equal(
    validRequest({ headers: { host: "evil.example:4327" } } as any),
    false,
  );
  assert.equal(
    validRequest({
      headers: { host: "127.0.0.1:4327", origin: "https://evil.example" },
    } as any),
    false,
  );
});
