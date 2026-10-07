import { modelTelemetry, modelTelemetryContext } from "./telemetry.ts";
import { RequestPerformance } from "./performance.ts";
import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Model,
  type Context,
} from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import {
  streamChat,
  discoverModels,
  type ChatStreamEvent,
} from "./vendor/devin.ts";
import {
  openaiToInternal,
  openaiToolsToDevin,
  toDevinPrompts,
  type OpenAIMessage,
} from "./vendor/convert.ts";

export function toMessages(context: Context): OpenAIMessage[] {
  return context.messages.map((m) => {
    if (m.role === "user")
      return {
        role: "user",
        content:
          typeof m.content === "string"
            ? m.content
            : m.content
                .filter((c) => c.type === "text")
                .map((c) => c.text)
                .join("\n"),
      };
    if (m.role === "toolResult")
      return {
        role: "tool",
        tool_call_id: m.toolCallId,
        name: m.toolName,
        content: (m.isError ? "Tool failed: " : "") + m.content
          .filter((c) => c.type === "text")
          .map((c) => c.text)
          .join("\n"),
      };
    const thinking =
      m.api === "devin-connect"
        ? m.content.filter((c) => c.type === "thinking")
        : [];
    let signature: { signature?: string; signatureType?: string } = {};
    for (const part of thinking) {
      if (!part.thinkingSignature) continue;
      try {
        const saved = JSON.parse(part.thinkingSignature);
        if (saved.provider === "devin" && saved.v === 1) signature = saved;
      } catch {}
    }
    return {
      role: "assistant",
      ...(thinking.length
        ? {
            devinReasoning: {
              thinking: thinking.map((c) => c.thinking).join(""),
              signature: signature.signature,
              signatureType: signature.signatureType,
            },
          }
        : {}),
      content: m.content
        .filter((c) => c.type === "text")
        .map((c) => c.text)
        .join("\n"),
      tool_calls: m.content
        .filter((c) => c.type === "toolCall")
        .map((c) => ({
          id: c.id,
          type: "function",
          function: { name: c.name, arguments: JSON.stringify(c.arguments) },
        })),
    };
  });
}
export class ToolCallAccumulator {
  private calls = new Map<string, { id: string; name: string; raw: string }>();
  private currentId = "";
  add(tc: { id: string; name: string; argumentsJson: string }) {
    // Parallel calls are disabled upstream; unnamed deltas continue the current call.
    if (tc.id) this.currentId = tc.id;
    if (!this.currentId)
      throw new Error("Tool argument delta has no preceding call ID");
    const old = this.calls.get(this.currentId);
    this.calls.set(this.currentId, {
      id: this.currentId,
      name: tc.name || old?.name || "",
      raw: (old?.raw ?? "") + tc.argumentsJson,
    });
  }
  finish() {
    return [...this.calls.values()].map((tc) => ({
      type: "toolCall" as const,
      id: tc.id,
      name: tc.name,
      arguments: JSON.parse(tc.raw),
    }));
  }
}

export async function createDevinProvider(
  dir: string,
  config: {
    maxOutputTokens?: number;
    modelId?: string;
    tokenFile?: string;
  } = {},
) {
  const telemetry = modelTelemetry(dir);
  const providerConversationId = crypto.randomUUID();
  const maxOutputTokens = config.maxOutputTokens;
  if (
    maxOutputTokens !== undefined &&
    (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 1)
  )
    throw new Error(
      "maxOutputTokens must be a positive safe integer when explicitly set",
    );
  const { token } = JSON.parse(
    await readFile(
      config.tokenFile ??
        process.env.DEVIN_OAUTH_FILE ??
        join(homedir(), ".moru", "devin-oauth.json"),
      "utf8",
    ),
  );
  const available = await discoverModels(
    token,
    undefined,
    AbortSignal.timeout(30000),
  );
  const selected = available.find(
    (m) =>
      m.id === (config.modelId ?? process.env.DEVIN_MODEL ?? "swe-2-medium"),
  );
  if (!selected)
    throw new Error(
      "선택 모델이 계정 모델 목록에 없습니다. npm run models로 확인하세요.",
    );
  const model: Model<"devin-connect"> = {
    ...selected,
    name: selected.name,
    api: "devin-connect",
    provider: "devin-oauth",
    baseUrl: "https://server.codeium.com",
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  const evidence: {
    requests: number;
    responses: number;
    nativeToolCalls: number;
    usageReported: boolean;
    model: string;
    transport: string;
    costKnown: boolean;
    creditCostSamples: number[];
    actualModelUids: string[];
  } = {
    requests: 0,
    responses: 0,
    nativeToolCalls: 0,
    usageReported: false,
    model: selected.id,
    transport: "oauth-connect-protobuf",
    costKnown: false,
    creditCostSamples: [],
    actualModelUids: [],
  };
  let persistence: Promise<void> = Promise.resolve();
  const persist = () => {
    const snapshot = JSON.stringify(evidence, null, 2);
    return (persistence = persistence.then(() =>
      writeFile(`${dir}/provider-evidence.json`, snapshot),
    ));
  };
  const streamFn: StreamFn = (_model, context, options) => {
    const stream = createAssistantMessageEventStream();
    const operation = modelTelemetryContext();
    void (async () => {
      const requestId = crypto.randomUUID();
      let lastDeltaAt = 0;
      let lastProgressAt = 0;
      let pendingText = "";
      let reasoningSignature = "";
      let reasoningSignatureType: string | undefined;
      const performance = new RequestPerformance();
      const msg: AssistantMessage = {
        role: "assistant",
        content: [],
        api: model.api,
        provider: model.provider,
        model: model.id,
        timestamp: Date.now(),
        stopReason: "stop",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      };
      try {
        evidence.requests++;
        const n = evidence.requests;
        const cascadeId = operation?.conversationId ?? providerConversationId;
        const events: ChatStreamEvent[] = [];
        const pendingCalls = new ToolCallAccumulator();
        const signal = options?.signal;
        stream.push({ type: "start", partial: structuredClone(msg) });
        await persist();
        const input = toMessages(context);
        let role = context.tools?.some((t) => t.name === "propose_candidate")
          ? "improver"
          : "trader";
        try {
          role = JSON.parse(String(input.at(-1)?.content)).role ?? role;
        } catch {}
        await telemetry({
          kind: "request",
          requestId,
          sequence: n,
          model: model.id,
          role,
          conversationId: cascadeId,
          ...operation,
          systemPrompt: context.systemPrompt,
          messages: input,
        });
        for await (const event of streamChat({
          apiKey: token,
          modelUid: model.id,
          systemPrompt: context.systemPrompt ?? "",
          messages: toDevinPrompts(
            openaiToInternal(toMessages(context)),
            cascadeId,
          ),
          tools: openaiToolsToDevin(
            context.tools?.map((t) => ({
              type: "function",
              function: {
                name: t.name,
                description: t.description,
                parameters: t.parameters as Record<string, unknown>,
              },
            })),
          ),
          maxTokens: maxOutputTokens,
          cascadeId,
          signal,
          upstreamIdleTimeoutMs: 120000,
        })) {
          events.push(event);
          if (
            ["text", "thinking", "toolcall"].includes(event.type) &&
            Date.now() - lastProgressAt > 5000
          ) {
            await telemetry({ kind: "progress", requestId, stage: event.type });
            lastProgressAt = Date.now();
          }
          if (event.type === "text") performance.output(event.deltaText ?? "");
          if (event.type === "toolcall")
            for (const call of event.toolCalls ?? [])
              performance.output(call.argumentsJson);
          if (event.type === "billing") {
            if (event.creditCost !== undefined)
              evidence.creditCostSamples.push(event.creditCost);
            if (
              event.actualModelUid &&
              !evidence.actualModelUids.includes(event.actualModelUid)
            )
              evidence.actualModelUids.push(event.actualModelUid);
          }
          if (event.type === "error")
            throw new Error(event.error ?? "Devin upstream error");
          if (event.type === "thinking") {
            let index = msg.content.findIndex((c) => c.type === "thinking");
            if (index < 0) {
              index = msg.content.length;
              msg.content.push({ type: "thinking", thinking: "" });
              stream.push({
                type: "thinking_start",
                contentIndex: index,
                partial: structuredClone(msg),
              });
            }
            const part = msg.content[index];
            if (part.type === "thinking") {
              part.thinking += event.deltaThinking ?? "";
              reasoningSignature += event.deltaSignature ?? "";
              reasoningSignatureType =
                event.deltaSignatureType || reasoningSignatureType;
              if (reasoningSignature || reasoningSignatureType) {
                // Preserve opaque continuation data across session serialization.
                part.thinkingSignature = JSON.stringify({
                  v: 1,
                  provider: "devin",
                  signature: reasoningSignature,
                  signatureType: reasoningSignatureType,
                });
              }
            }
            stream.push({
              type: "thinking_delta",
              contentIndex: index,
              delta: event.deltaThinking ?? "",
              partial: structuredClone(msg),
            });
          }
          if (event.type === "text" && event.deltaText) {
            pendingText += event.deltaText;
            if (Date.now() - lastDeltaAt > 300) {
              await telemetry({ kind: "delta", requestId, text: pendingText });
              pendingText = "";
              lastDeltaAt = Date.now();
            }
            let index = msg.content.findIndex((c) => c.type === "text");
            if (index < 0) {
              index = msg.content.length;
              msg.content.push({ type: "text", text: "" });
              stream.push({
                type: "text_start",
                contentIndex: index,
                partial: structuredClone(msg),
              });
            }
            const part = msg.content[index];
            if (part.type === "text") part.text += event.deltaText;
            stream.push({
              type: "text_delta",
              contentIndex: index,
              delta: event.deltaText,
              partial: structuredClone(msg),
            });
          }
          if (event.type === "toolcall")
            for (const tc of event.toolCalls ?? []) {
              pendingCalls.add(tc);
            }
          if (event.type === "usage" && event.usage) {
            performance.usage(
              event.usage.inputTokens,
              event.usage.outputTokens,
            );
            evidence.usageReported = true;
            msg.usage = {
              ...msg.usage,
              input: event.usage.inputTokens,
              output: event.usage.outputTokens,
              cacheRead: event.usage.cacheReadTokens,
              cacheWrite: event.usage.cacheWriteTokens,
              totalTokens:
                event.usage.inputTokens +
                event.usage.outputTokens +
                event.usage.cacheReadTokens +
                event.usage.cacheWriteTokens,
            };
          }
        }
        await writeFile(
          `${dir}/upstream-${n}.json`,
          JSON.stringify(events, null, 2),
        );
        msg.content.push(...pendingCalls.finish().map(call => ({ ...call, id: requestId + "_" + call.id })));
        if (!msg.content.length)
          throw new Error("모델이 빈 응답을 반환했습니다.");
        const calls = msg.content.filter((c) => c.type === "toolCall");
        evidence.responses++;
        evidence.nativeToolCalls += calls.length;
        msg.stopReason = calls.length ? "toolUse" : "stop";
        msg.content.forEach((part, contentIndex) => {
          if (part.type === "thinking")
            stream.push({
              type: "thinking_end",
              contentIndex,
              content: part.thinking,
              partial: structuredClone(msg),
            });
        });
        await writeFile(
          `${dir}/upstream-${n}.json`,
          JSON.stringify(events, null, 2),
        );
        if (pendingText)
          await telemetry({ kind: "delta", requestId, text: pendingText });
        await telemetry({
          kind: "complete",
          requestId,
          message: msg,
          performance: performance.finish(),
        });
        await persist();
        stream.push({ type: "done", reason: msg.stopReason, message: msg });
        stream.end(msg);
      } catch (e) {
        msg.stopReason = options?.signal?.aborted ? "aborted" : "error";
        msg.errorMessage = (e as Error).message.replace(
          /eyJ[A-Za-z0-9_.-]+/g,
          "[redacted]",
        );
        if (pendingText)
          await telemetry({ kind: "delta", requestId, text: pendingText });
        await telemetry({
          kind: "error",
          requestId,
          error: msg.errorMessage,
          performance: performance.finish(),
        });
        await persist();
        stream.push({ type: "error", reason: msg.stopReason, error: msg });
        stream.end(msg);
      }
    })();
    return stream;
  };
  return { model, streamFn, evidence };
}
