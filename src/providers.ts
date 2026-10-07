import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import {
  createProvider,
  envApiKeyAuth,
  getSupportedThinkingLevels,
  type Model,
} from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { readFile, mkdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { FileCredentials } from "./auth.ts";
import { Store } from "./store.ts";
import { discoverModels } from "./providers/vendor/devin.ts";
import { createDevinProvider } from "./providers/devin-provider.ts";
import type { CatalogProvider, Selection } from "./types.ts";

export class Providers {
  credentials: FileCredentials;
  models;
  private devinModels: Model<any>[] = [];
  private devinError?: string;
  private devinCache = new Map<
    string,
    Awaited<ReturnType<typeof createDevinProvider>>
  >();
  private tokenModified = 0;
  readonly tokenFile =
    process.env.DEVIN_OAUTH_FILE ??
    join(homedir(), ".moru", "devin-oauth.json");
  constructor(readonly store: Store) {
    this.credentials = new FileCredentials(store.dir);
    this.models = builtinModels({ credentials: this.credentials });
    for (const config of store.get<any[]>("customProviders", []))
      this.register(config);
  }
  private register(config: any) {
    const {
      id,
      name,
      baseUrl,
      api = "openai-completions",
      keyless = false,
    } = config;
    const modelList = config.models.map((m: any) => ({
      id: m.id,
      name: m.name || m.id,
      api,
      provider: id,
      baseUrl,
      reasoning: !!m.reasoning,
      input: ["text"],
      contextWindow: m.contextWindow ?? 128000,
      maxTokens: m.maxTokens ?? 8192,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    }));
    const apis: any = {
      "openai-completions": openAICompletionsApi(),
      "openai-responses": openAIResponsesApi(),
      "anthropic-messages": anthropicMessagesApi(),
    };
    if (!apis[api]) throw Error("지원하지 않는 API 형식입니다.");
    this.models.setProvider(
      createProvider({
        id,
        name,
        baseUrl,
        models: modelList,
        auth: {
          apiKey: keyless
            ? {
                name: "인증 없음",
                resolve: async () => ({
                  auth: { apiKey: "local" },
                  source: "인증 없음",
                }),
              }
            : envApiKeyAuth(name, []),
        },
        api: apis[api],
      }),
    );
  }
  async custom(config: any) {
    if (
      !/^[a-z][a-z0-9-]{1,50}$/.test(config.id) ||
      !config.name ||
      !Array.isArray(config.models) ||
      !config.models.length
    )
      throw Error("프로바이더 ID, 이름, 모델을 입력하세요.");
    const url = new URL(config.baseUrl);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password
    )
      throw Error("올바른 API 주소를 입력하세요.");
    const configs = this.store.get<any[]>("customProviders", []);
    if (
      this.models.getProvider(config.id) &&
      !configs.some((p) => p.id === config.id)
    )
      throw Error("기본 프로바이더와 다른 ID를 사용하세요.");
    for (const m of config.models)
      if (typeof m.id !== "string" || !m.id.trim())
        throw Error("모델 ID가 필요합니다.");
    const safe = {
      id: config.id,
      name: config.name,
      baseUrl: url.href.replace(/\/$/, ""),
      api: config.api,
      keyless: !!config.keyless,
      models: config.models.map((m: any) => ({
        id: m.id.trim(),
        name: m.name || m.id.trim(),
        reasoning: !!m.reasoning,
        contextWindow: m.contextWindow,
        maxTokens: m.maxTokens,
      })),
    };
    this.register(safe);
    if (config.apiKey)
      await this.credentials.modify(safe.id, async () => ({
        type: "api_key",
        key: config.apiKey,
      }));
    this.store.set("customProviders", [
      ...configs.filter((p) => p.id !== safe.id),
      safe,
    ]);
  }
  async refreshDevin() {
    try {
      const { token } = JSON.parse(await readFile(this.tokenFile, "utf8"));
      if (!token) throw Error("Devin 인증 정보가 없습니다.");
      this.devinModels = (
        await discoverModels(token, undefined, AbortSignal.timeout(30000))
      ).map((m) => ({
        ...m,
        api: "devin-connect",
        provider: "devin",
        baseUrl: "https://server.codeium.com",
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      }));
      this.devinError = undefined;
    } catch (e: any) {
      this.devinError =
        e.code === "ENOENT"
          ? "기존 Devin 로그인 파일이 없습니다."
          : String(e.message);
    }
  }
  async catalog(): Promise<CatalogProvider[]> {
    const custom = new Set(
      this.store.get<any[]>("customProviders", []).map((p) => p.id),
    );
    const entries = await Promise.all(
      this.models.getProviders().map(async (p) => {
        let auth, error;
        try {
          auth = await this.models.checkAuth(p.id, {
            signal: AbortSignal.timeout(5000),
          });
        } catch (e: any) {
          error = e.message;
        }
        return {
          id: p.id,
          name: p.name,
          connected: !!auth,
          source: auth?.source,
          error,
          custom: custom.has(p.id),
          methods: [
            p.auth.oauth ? { type: "oauth", name: p.auth.oauth.name } : null,
            p.auth.apiKey?.login
              ? { type: "api_key", name: p.auth.apiKey.name }
              : null,
          ].filter(Boolean) as any,
          models: this.models
            .getModels(p.id)
            .map((m) => ({
              id: m.id,
              name: m.name,
              reasoning: m.reasoning,
              contextWindow: m.contextWindow,
              thinkingLevels: getSupportedThinkingLevels(m),
            })),
        };
      }),
    );
    return [
      {
        id: "devin",
        name: "Devin",
        connected: this.devinModels.length > 0 && !this.devinError,
        source: "기존 OAuth 연결",
        error: this.devinError,
        methods: [],
        models: this.devinModels.map((m) => ({
          id: m.id,
          name: m.name,
          reasoning: !!m.reasoning,
          contextWindow: m.contextWindow,
          thinkingLevels: ["off"],
        })),
      },
      ...entries,
    ].sort(
      (a, b) =>
        Number(b.connected) - Number(a.connected) ||
        (a.id === "devin"
          ? -1
          : b.id === "devin"
            ? 1
            : a.name.localeCompare(b.name)),
    );
  }
  resolve(selection: Selection): Model<any> {
    const model =
      selection.provider === "devin"
        ? this.devinModels.find((m) => m.id === selection.model)
        : this.models.getModel(selection.provider, selection.model);
    if (!model)
      throw Error(
        "선택한 모델을 찾을 수 없습니다. 모델 목록에서 다시 선택하세요.",
      );
    return selection.provider === "devin"
      ? { ...model, provider: "devin", api: "devin-connect" }
      : model;
  }
  async stream(
    selection: Selection,
    context: any,
    signal: AbortSignal,
    sessionId: string,
  ) {
    const model = this.resolve(selection);
    if (selection.provider !== "devin")
      return this.models.streamSimple(model, context, {
        signal,
        sessionId,
        reasoning:
          selection.thinking === "off"
            ? undefined
            : (selection.thinking as any),
      });
    const key = sessionId + ":" + model.id;
    const modified = (await stat(this.tokenFile)).mtimeMs;
    if (modified !== this.tokenModified) {
      this.devinCache.clear();
      this.tokenModified = modified;
    }
    let provider = this.devinCache.get(key);
    if (!provider) {
      const dir = join(
        this.store.dir,
        "provider-traces",
        sessionId,
        model.id.replace(/[^a-zA-Z0-9-]/g, "_"),
        crypto.randomUUID(),
      );
      await mkdir(dir, { recursive: true });
      provider = await createDevinProvider(dir, {
        modelId: model.id,
        tokenFile: this.tokenFile,
      });
      this.devinCache.set(key, provider);
    }
    return provider.streamFn(provider.model, context, { signal, sessionId });
  }
}
