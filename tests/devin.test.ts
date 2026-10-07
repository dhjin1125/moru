import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { Type, type Context } from "@earendil-works/pi-ai";
import { createDevinProvider } from "../src/providers/devin-provider.ts";
import { ProtoEncoder, ProtoDecoder } from "../src/providers/vendor/proto.ts";

function proto(write: (e: ProtoEncoder) => void) {
  const e = new ProtoEncoder();
  write(e);
  return new Uint8Array(e.finish());
}
function frame(payload: Uint8Array, flag = 0) {
  const b = Buffer.alloc(5 + payload.length);
  b[0] = flag;
  b.writeUInt32BE(payload.length, 1);
  b.set(payload, 5);
  return b;
}
function values(data: Uint8Array) {
  const d = new ProtoDecoder(data);
  const out = new Map<number, (Uint8Array | bigint | number)[]>();
  while (!d.done) {
    const { field, wire } = d.readTag();
    const value = wire === 2 ? d.readBytes() : wire === 0 ? d.readVarint() : d.readDouble();
    out.set(field, [...(out.get(field) ?? []), value]);
  }
  return out;
}
const str = (v: unknown) => Buffer.from(v as Uint8Array).toString();

test("Devin preserves reasoning and a signature-only frame through storage and the next protobuf request", async () => {
  const dir = await mkdtemp(join(tmpdir(), "moru-devin-"));
  const originalFetch = globalThis.fetch;
  const requests: Uint8Array[] = [];
  try {
    const tokenFile = join(dir, "token.json");
    await writeFile(tokenFile, JSON.stringify({ token: "test-token" }));
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      if (url.endsWith("/GetCliModelConfigs")) return new Response(proto((e) => {
        e.message(1, (m) => {
          m.string(1, "SWE-2 Max");
          m.uint64(18, 262000);
          m.string(22, "swe-2-max");
        });
      }));
      if (url.endsWith("/GetUserJwt")) return new Response(proto((e) => e.string(1, "test-jwt")));
      assert(url.endsWith("/GetChatMessage"));
      const body = Buffer.from(init!.body as Uint8Array);
      requests.push(body[0] & 1 ? gunzipSync(body.subarray(5)) : body.subarray(5));
      const chunks = requests.length === 1 ? [
        frame(proto((e) => e.string(9, "Read the requested file. "))),
        frame(proto((e) => {
          e.string(9, "Then use its result.");
          e.message(6, (t) => {
            t.string(1, "read_0"); t.string(2, "read_file");
            t.string(3, '{"path":"sample.txt"}');
          });
        })),
        frame(proto((e) => { e.string(10, "sealed.v1.test-"); })),
        frame(proto((e) => { e.string(10, "signature"); e.string(21, "sealed"); e.uint32(5, 10); })),
      ] : [frame(proto((e) => e.string(3, "marker-7429")))];
      chunks.push(frame(Buffer.from("{}"), 2));
      return new Response(new ReadableStream({ start(controller) {
        for (const b of chunks) controller.enqueue(b);
        controller.close();
      } }), { headers: { "content-type": "application/connect+proto" } });
    };
    const provider = await createDevinProvider(dir, { tokenFile, modelId: "swe-2-max" });
    const context: Context = {
      systemPrompt: "Read the file and answer from its contents.",
      messages: [{ role: "user", content: "Read sample.txt", timestamp: 1 }],
      tools: [{ name: "read_file", description: "Read a file", parameters: Type.Object({ path: Type.String() }) }],
    };
    const first = await (await provider.streamFn(provider.model, context, {})).result();
    assert.equal(first.stopReason, "toolUse");
    const thinking = first.content.find((c) => c.type === "thinking");
    assert.equal(thinking?.thinking, "Read the requested file. Then use its result.");
    assert.deepEqual(JSON.parse(thinking!.thinkingSignature!), {
      v: 1, provider: "devin", signature: "sealed.v1.test-signature", signatureType: "sealed",
    });
    const call = first.content.find((c) => c.type === "toolCall")!;
    // Persisted sessions cross a JSON boundary before a worker resumes them.
    context.messages.push(JSON.parse(JSON.stringify(first)), {
      role: "toolResult", toolCallId: call.id, toolName: call.name,
      content: [{ type: "text", text: "marker-7429" }], isError: false, timestamp: 2,
    });
    const second = await (await provider.streamFn(provider.model, context, {})).result();
    assert.equal(second.stopReason, "stop");
    const messages = values(requests[1]).get(3)!.map((v) => values(v as Uint8Array));
    assert.equal(messages.length, 3);
    const assistant = messages[1];
    assert.equal(str(assistant.get(11)![0]), thinking!.thinking);
    assert.equal(str(assistant.get(12)![0]), "sealed.v1.test-signature");
    assert.equal(str(assistant.get(18)![0]), "sealed");
    const toolCall = values(assistant.get(6)![0] as Uint8Array);
    assert.equal(str(toolCall.get(1)![0]), str(messages[2].get(7)![0]));
    assert.equal(str(messages[2].get(3)![0]), "marker-7429");
  } finally {
    globalThis.fetch = originalFetch;
    await rm(dir, { recursive: true, force: true });
  }
});
