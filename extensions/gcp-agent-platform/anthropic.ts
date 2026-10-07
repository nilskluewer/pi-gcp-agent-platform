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

type VertexModel = Omit<Model<Api>, "api" | "provider" | "baseUrl">;

function stripVertexCompat(
  compat: AnthropicMessagesCompat | undefined,
): AnthropicMessagesCompat | undefined {
  if (!compat) return undefined;
  const { allowedFallbackModels: _allowedFallbackModels, ...vertexCompat } = compat;
  return vertexCompat;
}

function getAnthropicVertexModels(): VertexModel[] {
  // Pass through all catalog metadata (cost, promptCache, inputLimits, ...)
  // so new catalog fields reach Vertex models without changes here.
  // Without promptCache, Pi does not keep the prompt cache warm.
  return getModels("anthropic").map(
    ({ api: _api, provider: _provider, baseUrl: _baseUrl, compat, ...model }) => ({
      ...model,
      // Vertex does not support Anthropic's server-side `fallbacks` parameter.
      compat: stripVertexCompat(compat),
    }),
  );
}

export function registerAnthropicVertexProvider(
  pi: ExtensionAPI,
  project: string | undefined,
  region: string,
  baseUrl: string,
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

  const models = getAnthropicVertexModels();
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
      );

      // The delegated provider expects the model API to match its own API.
      const patchedModel = { ...model, api: "anthropic-messages" as Api };
      return anthropicApi.stream(patchedModel, context, anthropicOptions);
    },
  });
}

function mapStreamToAnthropicOptions(
  client: AnthropicVertex,
  options: SimpleStreamOptions | undefined,
  model: Model<Api>,
): AnthropicOptions {
  const baseMaxTokens = options?.maxTokens;

  return {
    // AnthropicVertex exposes the messages API but is not typed as Anthropic.
    client: client as unknown as AnthropicOptions["client"],
    maxTokens: baseMaxTokens,
    temperature: options?.temperature,
    signal: options?.signal,
    apiKey: options?.apiKey,
    transport: options?.transport,
    cacheRetention: options?.cacheRetention,
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
