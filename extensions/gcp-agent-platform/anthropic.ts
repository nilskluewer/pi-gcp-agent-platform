/**
 * Anthropic Claude on Google Cloud Vertex AI / Gemini Enterprise Agent Platform.
 *
 * The parent extension owns Google Cloud project, region, ADC setup, and the
 * setup command. This module only adapts AnthropicVertex to Pi's built-in
 * anthropic-messages stream implementation.
 */

import { AnthropicVertex, type ClientOptions } from "@anthropic-ai/vertex-sdk";
import {
  getApiProvider,
  getModels,
  type AnthropicMessagesCompat,
  type AnthropicOptions,
  type Api,
  type Model,
  type ProviderHeaders,
  type SimpleStreamOptions,
  type ThinkingBudgets,
  type ThinkingLevel,
} from "@earendil-works/pi-ai/compat";
import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";

export type AnthropicCacheTtl = "5m" | "1h" | "off";

export const ANTHROPIC_CACHE_MODELS = new Set([
  "claude-haiku-5-5",
  "claude-sonnet-5-5",
  "claude-opus-5-5",
]);

type VertexModel = Omit<Model<Api>, "api" | "provider" | "baseUrl"> & {
  promptCache?: { short?: number; long?: number };
};

function stripVertexCompat(
  compat: AnthropicMessagesCompat | undefined,
): AnthropicMessagesCompat | undefined {
  if (!compat) return undefined;
  const { allowedFallbackModels: _allowedFallbackModels, ...vertexCompat } = compat;
  return vertexCompat;
}

export function getAnthropicVertexModels(
  anthropicCacheTtl: AnthropicCacheTtl = "5m",
): VertexModel[] {
  // Pass through catalog metadata (cost, inputLimits, ...) and apply
  // promptCache TTL configuration only to the target Claude 5.5 models.
  return getModels("anthropic").map(
    ({ api: _api, provider: _provider, baseUrl: _baseUrl, compat, ...model }) => {
      const strippedCompat = stripVertexCompat(compat);
      if (!ANTHROPIC_CACHE_MODELS.has(model.id)) {
        return {
          ...model,
          promptCache: undefined,
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
    api: "anthropic-vertex",
    models,
    streamSimple: (
      model: Model<Api>,
      context,
      options?: SimpleStreamOptions,
    ) => {
      const modelCompat = model.compat as AnthropicMessagesCompat | undefined;
      const isAdaptive = modelCompat?.forceAdaptiveThinking === true;
      const client = createVertexClient(project, region, isAdaptive, options?.headers);
      const anthropicOptions = mapStreamToAnthropicOptions(
        client,
        options,
        model,
        anthropicCacheTtl,
      );

      // The delegated provider expects the model API to match its own API.
      const patchedModel = { ...model, api: "anthropic-messages" as Api };
      return anthropicApi.stream(patchedModel, context, anthropicOptions);
    },
  });
}

export function mapStreamToAnthropicOptions(
  client: AnthropicVertex,
  options: SimpleStreamOptions | undefined,
  model: Model<Api>,
  anthropicCacheTtl: AnthropicCacheTtl = "5m",
): AnthropicOptions {
  const baseMaxTokens = options?.maxTokens;
  const cacheRetention: AnthropicOptions["cacheRetention"] = !ANTHROPIC_CACHE_MODELS.has(
    model.id,
  )
    ? "none"
    : anthropicCacheTtl === "off"
      ? "none"
      : anthropicCacheTtl === "1h"
        ? (options?.cacheRetention ?? "long")
        : (options?.cacheRetention ?? "short");

  return {
    // AnthropicVertex exposes the messages API but is not typed as Anthropic.
    client: client as unknown as AnthropicOptions["client"],
    maxTokens: baseMaxTokens,
    temperature: options?.temperature,
    signal: options?.signal,
    apiKey: options?.apiKey,
    transport: options?.transport,
    cacheRetention,
    sessionId: options?.sessionId,
    headers: options?.headers,
    onPayload: options?.onPayload,
    onResponse: options?.onResponse,
    timeoutMs: options?.timeoutMs,
    websocketConnectTimeoutMs: options?.websocketConnectTimeoutMs,
    maxRetries: options?.maxRetries,
    maxRetryDelayMs: options?.maxRetryDelayMs,
    metadata: options?.metadata,
    env: options?.env,
    ...buildThinkingOptions(baseMaxTokens, options, model),
  };
}

function buildThinkingOptions(
  maxTokens: number | undefined,
  options: SimpleStreamOptions | undefined,
  model: Model<Api>,
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

  return {
    thinkingEnabled: true,
    maxTokens: adjusted.maxTokens,
    thinkingBudgetTokens: adjusted.thinkingBudget,
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

type Profile = "adaptive" | "legacy";
const sharedClient = new Map<Profile, AnthropicVertex>();

function createVertexClient(
  project: string,
  region: string,
  isAdaptive: boolean,
  requestHeaders?: ProviderHeaders,
): AnthropicVertex {
  if (requestHeaders && Object.keys(requestHeaders).length > 0) {
    return new AnthropicVertex(
      createVertexClientOpts(project, region, isAdaptive, requestHeaders),
    );
  }

  const profile: Profile = isAdaptive ? "adaptive" : "legacy";
  let client = sharedClient.get(profile);
  if (!client) {
    client = new AnthropicVertex(
      createVertexClientOpts(project, region, isAdaptive),
    );
    sharedClient.set(profile, client);
  }

  return client;
}

export function createVertexClientOpts(
  projectId: string | undefined,
  region: string,
  isAdaptive: boolean,
  requestHeaders?: ProviderHeaders,
): ClientOptions {
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
      defaultHeaders: {
        ...requestHeaders,
        "anthropic-beta": [...new Set(betaHeaders)].join(","),
      },
    };

  if (!requestHeaders) return { projectId, region };

  const { "anthropic-beta": _ignoredBeta, ...defaultHeaders } = requestHeaders;
  return { projectId, region, defaultHeaders };
}
