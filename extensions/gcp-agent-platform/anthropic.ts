/**
 * Anthropic Claude on Google Cloud Vertex AI / Gemini Enterprise Agent Platform.
 *
 * The parent extension owns Google Cloud project, region, strict auth credential
 * resolution, and the setup command. This module adapts AnthropicVertex to Pi's
 * built-in anthropic-messages stream implementation.
 */

import { AnthropicVertex, type ClientOptions } from "@anthropic-ai/vertex-sdk";
import {
  getApiProvider,
  getModels,
  type AnthropicMessagesCompat,
  type AnthropicOptions,
  type Api,
  type Context,
  type Model,
  type ProviderHeaders,
  type SimpleStreamOptions,
  type ThinkingBudgets,
  type ThinkingLevel,
} from "@earendil-works/pi-ai/compat";
import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { GoogleAuth } from "google-auth-library";

export type AnthropicCacheTtl = "5m" | "1h" | "off";

export const ANTHROPIC_CACHE_MODELS = new Set([
  "claude-haiku-5-5",
  "claude-sonnet-5-5",
  "claude-opus-5-5",
]);

const CONTEXT_SAFETY_TOKENS = 4096;
const MIN_MAX_TOKENS = 1;
const VERTEX_SCOPE = "https://www.googleapis.com/auth/cloud-platform";

type VertexModel = Omit<Model<Api>, "api" | "provider" | "baseUrl"> & {
  promptCache?: { short?: number; long?: number };
};

function stripVertexCompat(
  compat: AnthropicMessagesCompat | undefined,
): AnthropicMessagesCompat | undefined {
  if (!compat) return undefined;
  const { allowedFallbackModels: _allowedFallbackModels, ...vertexCompat } =
    compat;
  return vertexCompat;
}

export function getAnthropicVertexModels(
  anthropicCacheTtl: AnthropicCacheTtl = "5m",
): VertexModel[] {
  // Preserve catalog metadata (cost, inputLimits, promptCache on older models)
  // and apply the configured TTL tier specifically to the Claude 5.5 models.
  return getModels("anthropic").map(
    ({ api: _api, provider: _provider, baseUrl: _baseUrl, compat, ...model }) => {
      const strippedCompat = stripVertexCompat(compat);
      if (!ANTHROPIC_CACHE_MODELS.has(model.id)) {
        return {
          ...model,
          // Vertex does not support Anthropic's server-side `fallbacks` parameter.
          compat: strippedCompat,
        };
      }

      if (anthropicCacheTtl === "off") {
        return {
          ...model,
          promptCache: undefined,
          compat: {
            ...strippedCompat,
            supportsLongCacheRetention: false,
          },
        };
      }

      if (anthropicCacheTtl === "1h") {
        return {
          ...model,
          promptCache: { short: 3600, long: 3600 },
          compat: {
            ...strippedCompat,
            supportsLongCacheRetention: true,
          },
        };
      }

      return {
        ...model,
        promptCache: { short: 300, long: 3600 },
        compat: {
          ...strippedCompat,
          supportsLongCacheRetention: false,
        },
      };
    },
  );
}

export function registerAnthropicVertexProvider(
  pi: ExtensionAPI,
  project: string | undefined,
  region: string,
  baseUrl: string,
  anthropicCacheTtl: AnthropicCacheTtl = "5m",
  resolveCredentialsFile?: () => string,
): void {
  sharedClient.clear();

  if (!project) {
    console.warn(
      "[pi-gcp-agent-platform] Anthropic Vertex disabled: configure Google Cloud project first",
    );
    return;
  }

  const anthropicApi = getApiProvider("anthropic-messages");
  if (!anthropicApi) {
    throw new Error("Built-in anthropic-messages provider not found");
  }

  const models = getAnthropicVertexModels(anthropicCacheTtl);
  if (models.length === 0) return;

  pi.registerProvider("anthropic-vertex", {
    baseUrl,
    apiKey: "$GOOGLE_CLOUD_PROJECT",
    api: "anthropic-messages",
    models,
    streamSimple: (
      model: Model<Api>,
      context,
      options?: SimpleStreamOptions,
    ) => {
      const keyFilename = resolveCredentialsFile
        ? resolveCredentialsFile()
        : process.env.GOOGLE_APPLICATION_CREDENTIALS;
      const modelCompat = model.compat as AnthropicMessagesCompat | undefined;
      const isAdaptive = modelCompat?.forceAdaptiveThinking === true;
      const client = createVertexClient(
        project,
        region,
        isAdaptive,
        options?.headers,
        keyFilename,
      );
      const anthropicOptions = mapStreamToAnthropicOptions(
        client,
        options,
        model,
        context,
        anthropicCacheTtl,
      );

      const patchedModel = { ...model, api: "anthropic-messages" as Api };
      return anthropicApi.stream(patchedModel, context, anthropicOptions);
    },
  });
}

function estimateContextChars(context: Context): number {
  let chars = context.systemPrompt?.length ?? 0;
  for (const msg of context.messages ?? []) {
    if (typeof msg.content === "string") {
      chars += msg.content.length;
    } else if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if ("text" in block && typeof block.text === "string") {
          chars += block.text.length;
        } else if ("thinking" in block && typeof block.thinking === "string") {
          chars += block.thinking.length;
        }
      }
    }
  }
  return chars;
}

function clampMaxTokensToContext(
  model: Model<Api>,
  context: Context | undefined,
  maxTokens: number,
): number {
  if (!context || model.contextWindow <= 0) {
    return Math.max(MIN_MAX_TOKENS, maxTokens);
  }
  const estimatedTokens = Math.ceil(estimateContextChars(context) / 4);
  const available = model.contextWindow - estimatedTokens - CONTEXT_SAFETY_TOKENS;
  return Math.min(maxTokens, Math.max(MIN_MAX_TOKENS, available));
}

export function mapStreamToAnthropicOptions(
  client: AnthropicVertex,
  options: SimpleStreamOptions | undefined,
  model: Model<Api>,
  context?: Context,
  anthropicCacheTtl: AnthropicCacheTtl = "5m",
): AnthropicOptions {
  const baseMaxTokens = options?.maxTokens;
  const cacheRetention: AnthropicOptions["cacheRetention"] = !ANTHROPIC_CACHE_MODELS.has(
    model.id,
  )
    ? options?.cacheRetention
    : anthropicCacheTtl === "off"
      ? "none"
      : anthropicCacheTtl === "1h"
        ? (options?.cacheRetention ?? "long")
        : (options?.cacheRetention ?? "short");

  const thinkingOpts = buildThinkingOptions(baseMaxTokens, options, model, context);
  const resolvedMaxTokens =
    thinkingOpts.maxTokens ??
    (baseMaxTokens !== undefined
      ? clampMaxTokensToContext(model, context, baseMaxTokens)
      : clampMaxTokensToContext(model, context, model.maxTokens));

  return {
    // AnthropicVertex exposes the messages API but is not typed as Anthropic.
    client: client as unknown as AnthropicOptions["client"],
    maxTokens: resolvedMaxTokens,
    temperature: options?.temperature,
    signal: options?.signal,
    apiKey: options?.apiKey,
    transport: options?.transport,
    cacheRetention,
    sessionId: options?.sessionId,
    headers: options?.headers,
    toolChoice: options?.toolChoice,
    onPayload: options?.onPayload,
    onResponse: options?.onResponse,
    onProviderStreamEvent: options?.onProviderStreamEvent,
    timeoutMs: options?.timeoutMs,
    websocketConnectTimeoutMs: options?.websocketConnectTimeoutMs,
    maxRetries: options?.maxRetries,
    maxRetryDelayMs: options?.maxRetryDelayMs,
    metadata: options?.metadata,
    env: options?.env,
    ...thinkingOpts,
  };
}

function buildThinkingOptions(
  maxTokens: number | undefined,
  options: SimpleStreamOptions | undefined,
  model: Model<Api>,
  context?: Context,
): {
  thinkingEnabled: boolean;
  effort?: AnthropicOptions["effort"];
  thinkingBudgetTokens?: number;
  maxTokens?: number;
} {
  if (!options?.reasoning || !model.reasoning) {
    return { thinkingEnabled: false };
  }

  const modelCompat = model.compat as AnthropicMessagesCompat | undefined;
  if (modelCompat?.forceAdaptiveThinking === true) {
    return {
      thinkingEnabled: true,
      effort: mapThinkingLevelToEffort(model, options.reasoning),
    };
  }

  const adjusted = adjustMaxTokensForThinking(
    maxTokens,
    model.maxTokens,
    options.reasoning,
    options.thinkingBudgets,
  );
  const clampedMaxTokens = clampMaxTokensToContext(
    model,
    context,
    adjusted.maxTokens,
  );

  return {
    thinkingEnabled: true,
    maxTokens: clampedMaxTokens,
    thinkingBudgetTokens: Math.min(
      adjusted.thinkingBudget,
      Math.max(0, clampedMaxTokens - 1024),
    ),
  };
}

function mapThinkingLevelToEffort(
  model: Model<Api>,
  level: SimpleStreamOptions["reasoning"],
): AnthropicOptions["effort"] {
  const mapped = level ? model.thinkingLevelMap?.[level] : undefined;
  if (typeof mapped === "string") return mapped as AnthropicOptions["effort"];

  switch (level) {
    case "minimal":
    case "low":
      return "low";
    case "medium":
      return "medium";
    case "high":
      return "high";
    default:
      return "high";
  }
}

function adjustMaxTokensForThinking(
  baseMaxTokens: number | undefined,
  modelMaxTokens: number,
  reasoningLevel: ThinkingLevel,
  customBudgets?: ThinkingBudgets,
): { maxTokens: number; thinkingBudget: number } {
  const defaultBudgets: ThinkingBudgets = {
    minimal: 1024,
    low: 2048,
    medium: 8192,
    high: 16384,
  };
  const budgets = { ...defaultBudgets, ...customBudgets };
  const minOutputTokens = 1024;
  const level = (
    reasoningLevel === "xhigh" ? "high" : reasoningLevel
  ) as keyof ThinkingBudgets;
  let thinkingBudget = budgets[level]!;
  const maxTokens =
    baseMaxTokens === undefined
      ? modelMaxTokens
      : Math.min(baseMaxTokens + thinkingBudget, modelMaxTokens);

  if (maxTokens <= thinkingBudget) {
    thinkingBudget = Math.max(0, maxTokens - minOutputTokens);
  }

  return { maxTokens, thinkingBudget };
}

const sharedClient = new Map<string, AnthropicVertex>();

function createVertexClient(
  project: string,
  region: string,
  isAdaptive: boolean,
  requestHeaders?: ProviderHeaders,
  keyFilename?: string,
): AnthropicVertex {
  if (requestHeaders && Object.keys(requestHeaders).length > 0) {
    return new AnthropicVertex(
      createVertexClientOpts(
        project,
        region,
        isAdaptive,
        requestHeaders,
        keyFilename,
      ),
    );
  }

  const profileKey = `${isAdaptive ? "adaptive" : "legacy"}:${keyFilename ?? ""}`;
  let client = sharedClient.get(profileKey);
  if (!client) {
    client = new AnthropicVertex(
      createVertexClientOpts(
        project,
        region,
        isAdaptive,
        undefined,
        keyFilename,
      ),
    );
    sharedClient.set(profileKey, client);
  }

  return client;
}

export function createVertexClientOpts(
  projectId: string | undefined,
  region: string,
  isAdaptive: boolean,
  requestHeaders?: ProviderHeaders,
  keyFilename?: string,
): ClientOptions {
  const googleAuth = keyFilename
    ? new GoogleAuth({
        keyFilename,
        scopes: [VERTEX_SCOPE],
      })
    : undefined;
  const betaHeaders: string[] = [];
  if (!isAdaptive) betaHeaders.push("interleaved-thinking-2025-05-14");

  if (requestHeaders?.["anthropic-beta"])
    betaHeaders.push(
      ...requestHeaders["anthropic-beta"]
        .split(",")
        .map((item) => item.trim())
        .filter((value) => value.length > 0),
    );

  if (betaHeaders.length > 0)
    return {
      projectId,
      region,
      ...(googleAuth ? { googleAuth } : {}),
      defaultHeaders: {
        ...requestHeaders,
        "anthropic-beta": [...new Set(betaHeaders)].join(","),
      },
    };

  if (!requestHeaders) {
    return {
      projectId,
      region,
      ...(googleAuth ? { googleAuth } : {}),
    };
  }

  const { "anthropic-beta": _ignoredBeta, ...defaultHeaders } = requestHeaders;
  return {
    projectId,
    region,
    ...(googleAuth ? { googleAuth } : {}),
    defaultHeaders,
  };
}
