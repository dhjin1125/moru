/**
 * Devin / Codeium Cascade API client.
 *
 * Two RPCs are used:
 *  1. GetUserJwt  — exchange the session token (apiKey) for a per-user JWT.
 *  2. GetChatMessage — streaming chat via the Connect protocol over HTTP/1.1.
 *
 * The session token is the value returned by the Devin OAuth CLI flow,
 * prefixed with `devin-session-token$` if not already.
 */

import { gzipSync, gunzipSync } from "node:zlib";
import { log } from "./log.js";
import { currentTrace } from "./error-trace.js";
import {
  type ChatMessagePrompt,
  type ChatToolCall,
  type ChatToolChoice,
  type ChatToolDefinition,
  type CompletionConfiguration,
  type GetChatMessageRequest,
  type GetChatMessageResponse,
  type Metadata,
  ChatMessageRequestType,
  ConversationalPlannerMode,
  CacheControlType,
  StopReason,
  encodeGetUserJwtRequest,
  encodeMetadata,
  decodeGetUserJwtResponse,
  encodeGetChatMessageRequest,
  decodeGetChatMessageResponse,
  ProtoDecoder,
  ProtoEncoder,
} from "./proto.js";

const DEVIN_API_URL = "https://server.codeium.com";
const DEVIN_AUTH_PATH = "/exa.auth_pb.AuthService/GetUserJwt";
const CHAT_MESSAGE_PATH = "/exa.api_server_pb.ApiServerService/GetChatMessage";
const CLIENT_VERSION = "0.1.0";
const SESSION_TOKEN_PREFIX = "devin-session-token$";
const CONNECT_COMPRESSED_FLAG = 0x01;
const CONNECT_END_STREAM_FLAG = 0x02;
const MAX_FRAME_PAYLOAD = 16 * 1024 * 1024;
const DEFAULT_STOP_PATTERNS = [
  "\n\nUSER:",
  "\n\nASSISTANT:",
  "<|context_request|>",
  "<|end_of_turn|>",
];

function normalizeToken(token: string): string {
  return token.startsWith(SESSION_TOKEN_PREFIX)
    ? token
    : `${SESSION_TOKEN_PREFIX}${token}`;
}

export function buildMetadata(apiKey: string, userJwt?: string): Metadata {
  return {
    ideName: "moru",
    ideType: "chisel",
    ideVersion: CLIENT_VERSION,
    extensionName: "moru",
    extensionVersion: CLIENT_VERSION,
    apiKey,
    locale: "en",
    userJwt,
  };
}

// ─── GetUserJwt ──────────────────────────────────────────────────────────────

export async function getUserJwt(
  apiKey: string,
  baseUrl: string = DEVIN_API_URL,
  signal?: AbortSignal,
): Promise<{ userJwt: string; baseUrl?: string }> {
  const token = normalizeToken(apiKey);
  const body = encodeGetUserJwtRequest(buildMetadata(token));
  const url = `${baseUrl.replace(/\/+$/, "")}${DEVIN_AUTH_PATH}`;
  log.debug(`[auth] POST ${url}`);
  currentTrace()?.add("auth", `POST ${url}`);
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/proto",
      "connect-protocol-version": "1",
      accept: "*/*",
    },
    body: new Uint8Array(body),
    signal,
  });
  const payload = new Uint8Array(await res.arrayBuffer());
  if (!res.ok) {
    const detail = new TextDecoder().decode(payload);
    log.error(
      `[auth] upstream returned ${res.status} ${res.statusText}: ${detail}`,
    );
    currentTrace()?.add(
      "auth",
      `upstream returned ${res.status} ${res.statusText}`,
      { detail },
    );
    throw new Error(`Devin auth ${res.status} ${res.statusText}: ${detail}`);
  }
  let decoded;
  try {
    decoded = decodeGetUserJwtResponse(payload);
  } catch {
    decoded = decodeGetUserJwtResponse(gunzipSync(payload));
  }
  if (!decoded.userJwt) {
    log.error("[auth] succeeded but user JWT is empty");
    currentTrace()?.add("auth", "succeeded but user JWT is empty");
    throw new Error("Devin auth: empty user JWT");
  }
  log.debug("[auth] got user JWT");
  currentTrace()?.add("auth", "got user JWT");
  const customUrl = decoded.customApiServerUrl.trim();
  return {
    userJwt: decoded.userJwt,
    ...(customUrl ? { baseUrl: customUrl.replace(/\/+$/, "") } : undefined),
  };
}

// ─── GetChatMessage (streaming) ──────────────────────────────────────────────

export interface ChatParams {
  onResponseFrame?: (frame: GetChatMessageResponse) => void;
  apiKey: string;
  modelUid: string;
  systemPrompt: string;
  messages: ChatMessagePrompt[];
  tools: ChatToolDefinition[];
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  stopSequences?: string[];
  cascadeId?: string;
  baseUrl?: string;
  signal?: AbortSignal;
  /**
   * Maximum time without model progress before aborting. Default 120000 ms.
   * Text, thinking, tool arguments and advancing usage reset the timer.
   * Transport keepalive frames do not count as model progress.
   */
  upstreamIdleTimeoutMs?: number;
  /** Tool choice override; defaults to `{ optionName: "auto" }`. */
  toolChoice?: ChatToolChoice;
}

export interface ChatStreamEvent {
  type:
    "text" | "thinking" | "toolcall" | "usage" | "done" | "error" | "billing";
  creditCost?: number;
  actualModelUid?: string;
  deltaText?: string;
  deltaThinking?: string;
  deltaSignature?: string;
  deltaSignatureType?: string;
  toolCalls?: ChatToolCall[];
  stopReason?: number;
  usage?: GetChatMessageResponse["usage"];
  error?: string;
  /** Upstream Connect error code (e.g. "permission_denied") when the error came from an end-stream trailer. */
  code?: string;
}

export async function* streamChat(
  params: ChatParams,
): AsyncGenerator<ChatStreamEvent> {
  const token = normalizeToken(params.apiKey);
  const baseUrl = (params.baseUrl ?? DEVIN_API_URL).replace(/\/+$/, "");

  // Resolve user JWT first. Auth is a quick handshake — cap it at 30s so a
  // stalled Codeium auth endpoint surfaces as an explicit error, not a hang.
  const authTimeout = AbortSignal.timeout(30_000);
  let auth;
  try {
    auth = await getUserJwt(
      token,
      baseUrl,
      params.signal
        ? AbortSignal.any([params.signal, authTimeout])
        : authTimeout,
    );
  } catch (err) {
    if (authTimeout.aborted) {
      log.error("[chat] auth timed out after 30s");
      currentTrace()?.add("auth", "timed out after 30s");
      throw new Error("Devin auth timed out after 30s");
    }
    log.error("[chat] auth failed:", err);
    currentTrace()?.add("auth", "failed", {
      error: String((err as Error).message ?? err),
    });
    throw err;
  }
  const chatBaseUrl = auth.baseUrl ?? baseUrl;

  const cascadeId = params.cascadeId ?? crypto.randomUUID();
  const stopPatterns = [
    ...DEFAULT_STOP_PATTERNS,
    ...(params.stopSequences ?? []),
  ];
  // Codeium's upstream rejects temperature=0 with invalid_argument for some
  // models (e.g. glm-5-2). proto3 omits the field when it equals the default
  // (0.0), so the server sees an unset temperature and errors. Clamp 0 to a
  // negligible positive value that is indistinguishable from deterministic
  // output but keeps the upstream happy.
  const temperature =
    params.temperature === 0 ? 0.01 : (params.temperature ?? 0.4);

  const configuration: CompletionConfiguration = {
    numCompletions: 1n,
    ...(params.maxTokens === undefined
      ? {}
      : { maxTokens: BigInt(params.maxTokens) }),
    temperature,
    firstTemperature: temperature,
    topK: 50n,
    topP: params.topP ?? 1,
    stopPatterns,
    fimEotProbThreshold: 1,
  };

  const request: GetChatMessageRequest = {
    metadata: buildMetadata(token, auth.userJwt),
    prompt: params.systemPrompt,
    chatMessagePrompts: params.messages,
    chatModelUid: params.modelUid,
    configuration,
    tools: params.tools,
    disableParallelToolCalls: true,
    toolChoice: params.toolChoice ?? { optionName: "auto" },
    cascadeId,
    executionId: crypto.randomUUID(),
  };

  const reqBytes = encodeGetChatMessageRequest(request);
  const gz = gzipSync(reqBytes);
  const frame = Buffer.alloc(5 + gz.length);
  frame[0] = CONNECT_COMPRESSED_FLAG;
  frame.writeUInt32BE(gz.length, 1);
  frame.set(gz, 5);

  // Model progress resets this guard; empty transport keepalives do not.
  const UPSTREAM_IDLE_MS = params.upstreamIdleTimeoutMs ?? 120_000;
  const chatController = new AbortController();
  const chatSignal = params.signal
    ? AbortSignal.any([params.signal, chatController.signal])
    : chatController.signal;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const armIdleTimer = (): void => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(
      () => chatController.abort(new Error("upstream idle timeout")),
      UPSTREAM_IDLE_MS,
    );
  };

  let response: Response;
  try {
    armIdleTimer();
    log.debug(
      `[chat] POST ${chatBaseUrl}${CHAT_MESSAGE_PATH} model=${params.modelUid} cascade=${cascadeId}`,
    );
    currentTrace()?.add("chat", `POST ${chatBaseUrl}${CHAT_MESSAGE_PATH}`, {
      model: params.modelUid,
      cascadeId,
    });
    response = await fetch(`${chatBaseUrl}${CHAT_MESSAGE_PATH}`, {
      method: "POST",
      headers: {
        "content-type": "application/connect+proto",
        "connect-protocol-version": "1",
        "connect-content-encoding": "gzip",
        "accept-encoding": "identity",
        "user-agent": "connect-go/1.18.1 (go1.26.3)",
        "connect-accept-encoding": "gzip",
      },
      body: frame,
      signal: chatSignal,
    });
  } catch (err) {
    clearTimeout(idleTimer);
    if (chatController.signal.aborted) {
      log.error(
        `[chat] timed out: no response within ${UPSTREAM_IDLE_MS / 1000}s`,
      );
      currentTrace()?.add(
        "chat",
        `timed out: no response within ${UPSTREAM_IDLE_MS / 1000}s`,
      );
      throw new Error(
        `Devin stream timed out: no response within ${UPSTREAM_IDLE_MS / 1000}s`,
      );
    }
    log.error("[chat] fetch failed:", err);
    currentTrace()?.add("chat", "fetch failed", {
      error: String((err as Error).message ?? err),
    });
    throw err;
  }

  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    if (!response.ok) {
      const text = await response.text();
      log.error(
        `[chat] upstream returned ${response.status} ${response.statusText}: ${text}`,
      );
      currentTrace()?.add(
        "chat",
        `upstream returned ${response.status} ${response.statusText}`,
        { response: text },
      );
      throw new Error(
        `Devin API ${response.status} ${response.statusText}: ${text}`,
      );
    }
    if (!response.body) {
      log.error("[chat] upstream returned empty body");
      currentTrace()?.add("chat", "upstream returned empty body");
      throw new Error("Devin API: empty response body");
    }

    reader = response.body.getReader();
    let pending = Buffer.alloc(0);
    let lastStopReason = 0;
    let lastUsage: GetChatMessageResponse["usage"] = null;

    for (;;) {
      let done: boolean, value: Uint8Array | undefined;
      try {
        ({ done, value } = await reader.read());
      } catch (err) {
        clearTimeout(idleTimer);
        if (chatController.signal.aborted) {
          log.error(
            `[chat] stream timed out: no model progress for ${UPSTREAM_IDLE_MS / 1000}s`,
          );
          currentTrace()?.add(
            "chat",
            `stream timed out: no model progress for ${UPSTREAM_IDLE_MS / 1000}s`,
          );
          throw new Error(
            `Devin stream timed out: no model progress for ${UPSTREAM_IDLE_MS / 1000}s`,
          );
        }
        log.error("[chat] stream read failed:", err);
        currentTrace()?.add("chat", "stream read failed", {
          error: String((err as Error).message ?? err),
        });
        throw err;
      }
      if (value && value.length > 0) {
        pending = Buffer.concat([pending, value]);
      }

      while (pending.length >= 5) {
        const flag = pending[0];
        const len = pending.readUInt32BE(1);
        if (len > MAX_FRAME_PAYLOAD) {
          clearTimeout(idleTimer);
          log.error(
            `[chat] frame length ${len} exceeds ${MAX_FRAME_PAYLOAD} bytes`,
          );
          currentTrace()?.add(
            "chat",
            `frame length ${len} exceeds ${MAX_FRAME_PAYLOAD} bytes`,
          );
          throw new Error(
            `Connect frame length ${len} exceeds ${MAX_FRAME_PAYLOAD} bytes`,
          );
        }
        if (pending.length < 5 + len) break;
        const payload = pending.subarray(5, 5 + len);
        pending = pending.subarray(5 + len);

        if (flag & CONNECT_END_STREAM_FLAG) {
          const trailerBytes =
            flag & CONNECT_COMPRESSED_FLAG ? gunzipSync(payload) : payload;
          const trailer = trailerBytes.toString("utf8").trim();
          if (trailer) {
            let parsed;
            try {
              parsed = JSON.parse(trailer);
            } catch {
              throw new Error("Invalid Connect end-stream trailer");
            }
            if (parsed?.error?.code) {
              yield {
                type: "error",
                error: `Devin stream error ${parsed.error.code}: ${parsed.error.message ?? ""}`,
                code: parsed.error.code,
              };
            }
          }
          yield { type: "done", stopReason: lastStopReason, usage: lastUsage };
          return;
        }

        const raw =
          flag & CONNECT_COMPRESSED_FLAG ? gunzipSync(payload) : payload;
        const msg = decodeGetChatMessageResponse(raw);
        params.onResponseFrame?.(msg);
        const usageAdvanced =
          msg.usage && JSON.stringify(msg.usage) !== JSON.stringify(lastUsage);
        if (
          msg.deltaText ||
          msg.deltaThinking ||
          msg.deltaToolCalls.length ||
          usageAdvanced ||
          msg.stopReason
        )
          armIdleTimer();

        if (msg.creditCost !== undefined || msg.actualModelUid) {
          yield {
            type: "billing",
            creditCost: msg.creditCost,
            actualModelUid: msg.actualModelUid,
          };
        }
        if (msg.deltaText) {
          yield { type: "text", deltaText: msg.deltaText };
        }
        if (msg.deltaThinking || msg.deltaSignature || msg.deltaSignatureType) {
          yield {
            type: "thinking",
            deltaThinking: msg.deltaThinking,
            deltaSignature: msg.deltaSignature,
            deltaSignatureType: msg.deltaSignatureType,
          };
        }
        if (msg.deltaToolCalls.length > 0) {
          yield { type: "toolcall", toolCalls: msg.deltaToolCalls };
        }
        if (msg.usage) {
          lastUsage = msg.usage;
          yield { type: "usage", usage: msg.usage };
        }
        if (msg.stopReason !== 0) {
          lastStopReason = msg.stopReason;
        }
      }

      if (done) break;
    }

    clearTimeout(idleTimer);
    yield { type: "done", stopReason: lastStopReason, usage: lastUsage };
  } finally {
    clearTimeout(idleTimer);
    if (reader) {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
}

// ─── Model discovery (optional) ──────────────────────────────────────────────
export interface DiscoveredModel {
  costTier: number;
  promo?: { active: boolean; label: string; endUnix?: number };
  id: string;
  name: string;
  contextWindow: number;
  maxTokens: number;
  reasoning: boolean;
  /** True when the model accepts image inputs. */
  supportsImages: boolean;
}

const GET_CLI_MODEL_CONFIGS_PATH =
  "/exa.api_server_pb.ApiServerService/GetCliModelConfigs";

export async function discoverModels(
  apiKey: string,
  baseUrl: string = DEVIN_API_URL,
  signal?: AbortSignal,
): Promise<DiscoveredModel[]> {
  const token = normalizeToken(apiKey);
  const enc = new ProtoEncoder();
  enc.message(1, (e) => encodeMetadata(e, buildMetadata(token)));
  const url = `${baseUrl.replace(/\/+$/, "")}${GET_CLI_MODEL_CONFIGS_PATH}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/proto",
      "connect-protocol-version": "1",
      accept: "*/*",
    },
    body: new Uint8Array(enc.finish()),
    signal,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    log.error(
      `[discover] upstream returned ${res.status} ${res.statusText}: ${text}`,
    );
    currentTrace()?.add(
      "discover",
      `upstream returned ${res.status} ${res.statusText}`,
      { response: text },
    );
    throw new Error(
      `Devin model discovery ${res.status} ${res.statusText}: ${text}`,
    );
  }
  const data = new Uint8Array(await res.arrayBuffer());
  // Decode GetCliModelConfigsResponse and its repeated ClientModelConfig field.
  // Field numbers follow the reference Codeium proto; malformed payloads fail closed.
  try {
    return parseCliModelConfigs(data);
  } catch (err) {
    log.warn(
      `[discover] failed to parse model configs: ${(err as Error).message ?? err}`,
    );
    currentTrace()?.add("discover", "failed to parse model configs", {
      error: String((err as Error).message ?? err),
    });
    return [];
  }
}

function parseCliModelConfigs(data: Uint8Array): DiscoveredModel[] {
  const models: DiscoveredModel[] = [];
  const decoder = new ProtoDecoder(data);

  while (!decoder.done) {
    const { field, wire } = decoder.readTag();
    if (field === 1 && wire === 2) {
      const model = decoder.readMessage(parseClientModelConfig);
      if (model) models.push(model);
    } else {
      decoder.skip(wire);
    }
  }
  return models;
}

/** Label wording that implies a thinking / reasoning-effort variant. */
const REASONING_LABEL_PATTERN =
  /think|thinking|minimal|high|medium|low|xhigh|max|reasoning/i;
const NO_REASONING_LABEL_PATTERN = /\bno thinking\b/i;

/** Parse `ModelFeatures` (field 6 of `ModelInfo`) for `supports_thinking` (field 15). */
function parseModelFeaturesThinking(decoder: ProtoDecoder): boolean {
  while (!decoder.done) {
    const { field, wire } = decoder.readTag();
    if (field === 15 && wire === 0) {
      return decoder.readVarint() !== 0n;
    }
    decoder.skip(wire);
  }
  return false;
}

/** Parse `ModelInfo` (field 23 of `ClientModelConfig`) for its `model_features` (field 6). */
function parseModelInfoThinking(decoder: ProtoDecoder): boolean {
  while (!decoder.done) {
    const { field, wire } = decoder.readTag();
    if (field === 6 && wire === 2) {
      return decoder.readMessage(parseModelFeaturesThinking);
    }
    decoder.skip(wire);
  }
  return false;
}

function parseClientModelConfig(decoder: ProtoDecoder): DiscoveredModel | null {
  let id = "";
  let costTier = 0;
  let promo: DiscoveredModel["promo"];
  let label = "";
  let disabled = false;
  let configuredMaxTokens = 0;
  let supportsImages = false;
  let supportsThinking = false;

  while (!decoder.done) {
    const { field, wire } = decoder.readTag();
    if (field === 1 && wire === 2) {
      label = decoder.readString();
    } else if (field === 4 && wire === 0) {
      disabled = decoder.readVarint() !== 0n;
    } else if (field === 5 && wire === 0) {
      supportsImages = decoder.readVarint() !== 0n;
    } else if (field === 18 && wire === 0) {
      configuredMaxTokens = Number(decoder.readVarint());
    } else if (field === 22 && wire === 2) {
      id = decoder.readString();
    } else if (field === 24 && wire === 0) {
      costTier = Number(decoder.readVarint());
    } else if (field === 19 && wire === 2) {
      promo = decoder.readMessage((d) => {
        const p = {
          active: false,
          label: "",
          endUnix: undefined as number | undefined,
        };
        while (!d.done) {
          const t = d.readTag();
          if (t.field === 1 && t.wire === 0) p.active = d.readVarint() !== 0n;
          else if (t.field === 3 && t.wire === 2) p.label = d.readString();
          else if (t.field === 2 && t.wire === 2)
            p.endUnix = d.readMessage((x) => {
              let sec = 0;
              while (!x.done) {
                const q = x.readTag();
                if (q.field === 1 && q.wire === 0) sec = Number(x.readVarint());
                else x.skip(q.wire);
              }
              return sec;
            });
          else d.skip(t.wire);
        }
        return p;
      });
    } else if (field === 23 && wire === 2) {
      supportsThinking = decoder.readMessage(parseModelInfoThinking);
    } else {
      decoder.skip(wire);
    }
  }

  if (disabled || !id.trim()) return null;

  const reasoning =
    !NO_REASONING_LABEL_PATTERN.test(label) &&
    (supportsThinking || REASONING_LABEL_PATTERN.test(label));
  const contextWindow = configuredMaxTokens > 0 ? configuredMaxTokens : 200_000;
  const maxTokens = Math.min(
    configuredMaxTokens > 0 ? configuredMaxTokens : 64_000,
    64_000,
  );
  return {
    costTier,
    ...(promo ? { promo } : {}),
    id: id.trim(),
    name: label.trim() || id.trim(),
    contextWindow,
    maxTokens,
    reasoning,
    supportsImages,
  };
}
