/**
 * pi-gcp-agent-platform — Claude and Gemini on Google Cloud Vertex AI / Gemini
 * Enterprise Agent Platform.
 *
 * Pi already ships the low-level google-vertex provider implementation. This
 * extension owns the shared Google Cloud project, region, auth mode (ADC,
 * service account JSON key, or service account impersonation), and prompt cache
 * TTL configuration, then registers the AnthropicVertex adapter for Claude
 * alongside Pi's native Gemini provider.
 *
 * Prerequisites:
 *   1. gcloud auth application-default login (or service account / impersonation)
 *   2. export GOOGLE_CLOUD_PROJECT=your-project-id
 *   3. export GOOGLE_CLOUD_LOCATION=global  (or eu/us; defaults to eu)
 *
 * Usage:
 *   pi --provider google-vertex --model gemini-3.8-flash
 *   pi --provider anthropic-vertex --model claude-opus-5-5
 */

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { getModels, type Api, type Model } from "@earendil-works/pi-ai/compat";
import {
  getAgentDir,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ProviderModelConfig,
} from "@earendil-works/pi-coding-agent";
import {
  registerAnthropicVertexProvider,
  type AnthropicCacheTtl,
} from "./anthropic.ts";
import { registerVertexImagesProvider } from "./images.ts";

export type { AnthropicCacheTtl } from "./anthropic.ts";
export type AuthMode = "adc" | "service-account" | "impersonation";

export type VertexSetupConfig = {
  project?: string;
  location?: string;
  authMode?: AuthMode;
  serviceAccountKeyPath?: string;
  impersonateServiceAccount?: string;
  anthropicCacheTtl?: AnthropicCacheTtl;
  geminiCacheTtlSeconds?: number;
};

export const GEMINI_CACHE_MODELS = new Set([
  "gemini-3.5-flash-lite",
  "gemini-3.8-flash",
  "gemini-4-argon",
]);

const CONFIG_FILE = join(getAgentDir(), "gcp-agent-platform.json");
const LEGACY_ANTHROPIC_CONFIG_FILE = join(
  getAgentDir(),
  "anthropic-vertex-enterprise-agent-platform.json",
);
const IMPERSONATED_ADC_FILE = join(
  getAgentDir(),
  "gcp-agent-platform-impersonated-adc.json",
);
const DEFAULT_ADC_FILE = join(
  homedir(),
  ".config",
  "gcloud",
  "application_default_credentials.json",
);
const DEFAULT_REGION = "eu";
const DEFAULT_GEMINI_CACHE_TTL_SECONDS = 300;
const EXTENSION_ID = "gcp-agent-platform";
const SA_EMAIL_PATTERN =
  /^[a-z0-9-]+@[a-z0-9-]+\.iam\.gserviceaccount\.com$/i;

const INITIAL_GOOGLE_APPLICATION_CREDENTIALS =
  process.env.GOOGLE_APPLICATION_CREDENTIALS;
const INITIAL_PI_CACHE_RETENTION = process.env.PI_CACHE_RETENTION;

let currentConfig = resolveRuntimeConfig(readSetupConfig());
applyEnvironment(currentConfig);

export default function (pi: ExtensionAPI) {
  registerSetupCommand(pi);
  registerCacheCommand(pi);
  registerAllVertexProviders(pi, currentConfig);

  pi.on("session_start", async (_event, ctx) => {
    updateStatus(ctx, currentConfig);
  });
}

export function expandPath(filePath: string): string {
  const trimmed = filePath.trim();
  if (trimmed === "~") return homedir();
  if (trimmed.startsWith("~/") || trimmed.startsWith("~\\")) {
    return join(homedir(), trimmed.slice(2));
  }
  return resolve(trimmed);
}

export function isValidServiceAccountEmail(email: string): boolean {
  return SA_EMAIL_PATTERN.test(email.trim());
}

function updateStatus(
  ctx: { ui: { setStatus(key: string, text: string | undefined): void } },
  config: Required<
    Pick<
      VertexSetupConfig,
      "location" | "authMode" | "anthropicCacheTtl" | "geminiCacheTtlSeconds"
    >
  > &
    VertexSetupConfig,
): void {
  const authBadge =
    config.authMode === "impersonation"
      ? "impersonated"
      : config.authMode === "service-account"
        ? "sa-key"
        : "adc";
  const geminiCacheLabel =
    config.geminiCacheTtlSeconds > 0
      ? `${config.geminiCacheTtlSeconds}s`
      : "off";
  ctx.ui.setStatus(
    EXTENSION_ID,
    `☁️ Google Cloud Vertex ${config.project ? config.project : "unconfigured"}/${config.location} (${authBadge}, cache: C=${config.anthropicCacheTtl} G=${geminiCacheLabel})`,
  );
}

function resolveProject(config: VertexSetupConfig): string | undefined {
  return (
    process.env.GOOGLE_CLOUD_PROJECT ||
    process.env.ANTHROPIC_VERTEX_PROJECT_ID ||
    process.env.GCLOUD_PROJECT ||
    config.project
  );
}

function resolveRegion(config: VertexSetupConfig): string {
  return (
    process.env.GOOGLE_CLOUD_LOCATION ||
    process.env.CLOUD_ML_REGION ||
    process.env.VERTEX_REGION ||
    config.location ||
    DEFAULT_REGION
  );
}

function resolveAuthMode(config: VertexSetupConfig): AuthMode {
  if (
    config.authMode === "adc" ||
    config.authMode === "service-account" ||
    config.authMode === "impersonation"
  ) {
    return config.authMode;
  }
  if (
    config.impersonateServiceAccount ||
    process.env.VERTEX_IMPERSONATE_SERVICE_ACCOUNT
  ) {
    return "impersonation";
  }
  const envCreds =
    INITIAL_GOOGLE_APPLICATION_CREDENTIALS &&
    INITIAL_GOOGLE_APPLICATION_CREDENTIALS !== IMPERSONATED_ADC_FILE
      ? INITIAL_GOOGLE_APPLICATION_CREDENTIALS
      : undefined;
  if (config.serviceAccountKeyPath || envCreds) {
    return "service-account";
  }
  return "adc";
}

function resolveAnthropicCacheTtl(
  config: VertexSetupConfig,
): AnthropicCacheTtl {
  if (
    config.anthropicCacheTtl === "5m" ||
    config.anthropicCacheTtl === "1h" ||
    config.anthropicCacheTtl === "off"
  ) {
    return config.anthropicCacheTtl;
  }
  return INITIAL_PI_CACHE_RETENTION === "long" ? "1h" : "5m";
}

function resolveGeminiCacheTtlSeconds(config: VertexSetupConfig): number {
  if (
    typeof config.geminiCacheTtlSeconds === "number" &&
    Number.isFinite(config.geminiCacheTtlSeconds) &&
    config.geminiCacheTtlSeconds >= 0
  ) {
    return Math.floor(config.geminiCacheTtlSeconds);
  }
  return DEFAULT_GEMINI_CACHE_TTL_SECONDS;
}

type ResolvedVertexConfig = {
  project?: string;
  location: string;
  authMode: AuthMode;
  serviceAccountKeyPath?: string;
  impersonateServiceAccount?: string;
  anthropicCacheTtl: AnthropicCacheTtl;
  geminiCacheTtlSeconds: number;
};

function resolveRuntimeConfig(config: VertexSetupConfig): ResolvedVertexConfig {
  const authMode = resolveAuthMode(config);
  const envCreds =
    INITIAL_GOOGLE_APPLICATION_CREDENTIALS &&
    INITIAL_GOOGLE_APPLICATION_CREDENTIALS !== IMPERSONATED_ADC_FILE
      ? INITIAL_GOOGLE_APPLICATION_CREDENTIALS
      : undefined;
  const serviceAccountKeyPath =
    config.serviceAccountKeyPath ||
    (authMode === "service-account" ? envCreds : undefined);
  const impersonateServiceAccount =
    config.impersonateServiceAccount ||
    process.env.VERTEX_IMPERSONATE_SERVICE_ACCOUNT;

  return {
    project: resolveProject(config),
    location: resolveRegion(config),
    authMode,
    serviceAccountKeyPath: serviceAccountKeyPath?.trim() || undefined,
    impersonateServiceAccount: impersonateServiceAccount?.trim() || undefined,
    anthropicCacheTtl: resolveAnthropicCacheTtl(config),
    geminiCacheTtlSeconds: resolveGeminiCacheTtlSeconds(config),
  };
}

function applyRuntimeConfig(next: VertexSetupConfig): ResolvedVertexConfig {
  const merged: VertexSetupConfig = {
    ...currentConfig,
    ...next,
  };
  const resolved: ResolvedVertexConfig = {
    project: merged.project ?? currentConfig.project,
    location: merged.location || DEFAULT_REGION,
    authMode: resolveAuthMode(merged),
    serviceAccountKeyPath: merged.serviceAccountKeyPath?.trim() || undefined,
    impersonateServiceAccount:
      merged.impersonateServiceAccount?.trim() || undefined,
    anthropicCacheTtl: resolveAnthropicCacheTtl(merged),
    geminiCacheTtlSeconds: resolveGeminiCacheTtlSeconds(merged),
  };
  currentConfig = resolved;
  applyEnvironment(resolved);
  return resolved;
}

function resolveDefaultAdcPath(): string {
  const cloudsdkConfig = process.env.CLOUDSDK_CONFIG;
  if (cloudsdkConfig) {
    return join(cloudsdkConfig, "application_default_credentials.json");
  }
  return DEFAULT_ADC_FILE;
}

function resolveImpersonationSourcePath(
  serviceAccountKeyPath: string | undefined,
): string | undefined {
  if (serviceAccountKeyPath) {
    return expandPath(serviceAccountKeyPath);
  }
  if (
    INITIAL_GOOGLE_APPLICATION_CREDENTIALS &&
    INITIAL_GOOGLE_APPLICATION_CREDENTIALS !== IMPERSONATED_ADC_FILE
  ) {
    return expandPath(INITIAL_GOOGLE_APPLICATION_CREDENTIALS);
  }
  const currentEnvCreds = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (currentEnvCreds && currentEnvCreds !== IMPERSONATED_ADC_FILE) {
    return expandPath(currentEnvCreds);
  }
  return resolveDefaultAdcPath();
}

export function buildImpersonatedAdcPayload(
  targetServiceAccount: string,
  sourceCredentials: Record<string, unknown>,
): Record<string, unknown> {
  const trimmedTarget = targetServiceAccount.trim();
  if (!isValidServiceAccountEmail(trimmedTarget)) {
    throw new Error(
      `Invalid target service account email "${trimmedTarget}". Expected <name>@<project>.iam.gserviceaccount.com`,
    );
  }
  const unwrappedSource =
    sourceCredentials.type === "impersonated_service_account" &&
    typeof sourceCredentials.source_credentials === "object" &&
    sourceCredentials.source_credentials !== null
      ? (sourceCredentials.source_credentials as Record<string, unknown>)
      : sourceCredentials;

  return {
    type: "impersonated_service_account",
    service_account_impersonation_url: `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${trimmedTarget}:generateAccessToken`,
    source_credentials: unwrappedSource,
  };
}

function writeImpersonatedAdcFile(
  targetServiceAccount: string,
  sourcePath: string | undefined,
): string | undefined {
  const trimmedTarget = targetServiceAccount.trim();
  if (!isValidServiceAccountEmail(trimmedTarget)) {
    console.warn(
      `[pi-gcp-agent-platform] invalid impersonateServiceAccount email: ${trimmedTarget}`,
    );
    return undefined;
  }
  if (!sourcePath || !existsSync(sourcePath)) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(readFileSync(sourcePath, "utf8")) as Record<
      string,
      unknown
    >;
    const expectedUrl = `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${trimmedTarget}:generateAccessToken`;
    if (
      parsed.type === "impersonated_service_account" &&
      parsed.service_account_impersonation_url === expectedUrl &&
      parsed.source_credentials
    ) {
      return sourcePath;
    }

    const payload = buildImpersonatedAdcPayload(trimmedTarget, parsed);
    mkdirSync(dirname(IMPERSONATED_ADC_FILE), { recursive: true });
    writeFileSync(IMPERSONATED_ADC_FILE, `${JSON.stringify(payload, null, 2)}\n`, {
      mode: 0o600,
    });
    return IMPERSONATED_ADC_FILE;
  } catch (error) {
    console.warn(
      `[pi-gcp-agent-platform] failed to build impersonated ADC credentials from ${sourcePath}: ${String(error)}`,
    );
    return undefined;
  }
}

export function applyEnvironment(config: ResolvedVertexConfig): void {
  if (config.project) {
    process.env.GOOGLE_CLOUD_PROJECT = config.project;
    process.env.ANTHROPIC_VERTEX_PROJECT_ID = config.project;
    process.env.GCLOUD_PROJECT = config.project;
  }
  process.env.GOOGLE_CLOUD_LOCATION = config.location;
  process.env.CLOUD_ML_REGION = config.location;
  process.env.VERTEX_REGION = config.location;

  if (config.anthropicCacheTtl === "1h") {
    process.env.PI_CACHE_RETENTION = "long";
  } else {
    delete process.env.PI_CACHE_RETENTION;
  }

  if (config.authMode === "service-account") {
    delete process.env.VERTEX_IMPERSONATE_SERVICE_ACCOUNT;
    if (config.serviceAccountKeyPath) {
      process.env.GOOGLE_APPLICATION_CREDENTIALS = expandPath(
        config.serviceAccountKeyPath,
      );
    }
  } else if (config.authMode === "impersonation") {
    if (config.impersonateServiceAccount) {
      process.env.VERTEX_IMPERSONATE_SERVICE_ACCOUNT =
        config.impersonateServiceAccount;
      const sourcePath = resolveImpersonationSourcePath(
        config.serviceAccountKeyPath,
      );
      const impersonatedPath = writeImpersonatedAdcFile(
        config.impersonateServiceAccount,
        sourcePath,
      );
      if (impersonatedPath) {
        process.env.GOOGLE_APPLICATION_CREDENTIALS = impersonatedPath;
      }
    }
  } else {
    delete process.env.VERTEX_IMPERSONATE_SERVICE_ACCOUNT;
    if (
      process.env.GOOGLE_APPLICATION_CREDENTIALS === IMPERSONATED_ADC_FILE ||
      (config.serviceAccountKeyPath &&
        process.env.GOOGLE_APPLICATION_CREDENTIALS ===
          expandPath(config.serviceAccountKeyPath))
    ) {
      delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
    }
  }
}

export function getVertexBaseUrl(region: string): string {
  if (region === "eu" || region === "us")
    return `https://aiplatform.${region}.rep.googleapis.com`;
  if (region === "global") return "https://aiplatform.googleapis.com";
  return `https://${region}-aiplatform.googleapis.com`;
}

type GeminiVertexModel = Omit<Model<Api>, "provider" | "baseUrl"> & {
  promptCache?: { short?: number; long?: number };
};

export function getGoogleVertexModels(
  geminiCacheTtlSeconds: number = DEFAULT_GEMINI_CACHE_TTL_SECONDS,
): GeminiVertexModel[] {
  const ttl =
    Number.isFinite(geminiCacheTtlSeconds) && geminiCacheTtlSeconds > 0
      ? Math.floor(geminiCacheTtlSeconds)
      : 0;
  return getModels("google-vertex").map(
    ({ provider: _provider, baseUrl: _baseUrl, ...model }) => ({
      ...model,
      promptCache:
        GEMINI_CACHE_MODELS.has(model.id) && ttl > 0
          ? { short: ttl, long: ttl }
          : undefined,
    }),
  );
}

export function registerGoogleVertexProvider(
  pi: ExtensionAPI,
  project: string | undefined,
  baseUrl: string,
  geminiCacheTtlSeconds: number = DEFAULT_GEMINI_CACHE_TTL_SECONDS,
): void {
  if (!project) return;
  const models = getGoogleVertexModels(
    geminiCacheTtlSeconds,
  ) as unknown as ProviderModelConfig[];
  if (models.length === 0) return;

  // Override baseUrl and model metadata (promptCache TTL on target Gemini models)
  // without passing apiKey or streamSimple so Pi's native google-vertex auth and
  // stream implementation remain intact.
  pi.registerProvider("google-vertex", {
    baseUrl,
    models,
  });
}

function registerAllVertexProviders(
  pi: ExtensionAPI,
  config: ResolvedVertexConfig,
): void {
  const baseUrl = getVertexBaseUrl(config.location);
  registerGoogleVertexProvider(
    pi,
    config.project,
    baseUrl,
    config.geminiCacheTtlSeconds,
  );
  registerAnthropicVertexProvider(
    pi,
    config.project,
    config.location,
    baseUrl,
    config.anthropicCacheTtl,
  );
  registerVertexImagesProvider(pi, config.project, config.location, baseUrl);
}

function readSetupConfig(): VertexSetupConfig {
  return {
    ...readJsonConfig(LEGACY_ANTHROPIC_CONFIG_FILE),
    ...readJsonConfig(CONFIG_FILE),
  };
}

function readJsonConfig(path: string): VertexSetupConfig {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8")) as VertexSetupConfig;
  } catch (error) {
    console.warn(
      `[pi-gcp-agent-platform] ignoring invalid config ${path}: ${String(error)}`,
    );
    return {};
  }
}

function writeSetupConfig(config: VertexSetupConfig): void {
  mkdirSync(dirname(CONFIG_FILE), { recursive: true });
  const payload: VertexSetupConfig = {
    project: config.project,
    location: config.location,
    authMode: config.authMode,
    ...(config.serviceAccountKeyPath
      ? { serviceAccountKeyPath: config.serviceAccountKeyPath }
      : {}),
    ...(config.impersonateServiceAccount
      ? { impersonateServiceAccount: config.impersonateServiceAccount }
      : {}),
    anthropicCacheTtl: config.anthropicCacheTtl,
    geminiCacheTtlSeconds: config.geminiCacheTtlSeconds,
  };
  writeFileSync(CONFIG_FILE, `${JSON.stringify(payload, null, 2)}\n`, {
    mode: 0o600,
  });
}

export function checkCredentials(config: ResolvedVertexConfig): {
  ok: boolean;
  message: string;
} {
  if (config.authMode === "service-account") {
    if (!config.serviceAccountKeyPath) {
      return {
        ok: false,
        message:
          "Service Account mode selected, but serviceAccountKeyPath is not configured.",
      };
    }
    const keyPath = expandPath(config.serviceAccountKeyPath);
    if (!existsSync(keyPath)) {
      return {
        ok: false,
        message: `Service Account JSON key file not found at ${keyPath}.`,
      };
    }
    try {
      const parsed = JSON.parse(readFileSync(keyPath, "utf8")) as Record<
        string,
        unknown
      >;
      if (
        parsed.type !== "service_account" ||
        typeof parsed.client_email !== "string" ||
        typeof parsed.private_key !== "string"
      ) {
        return {
          ok: false,
          message: `Invalid Service Account JSON key file at ${keyPath} (missing type="service_account", client_email, or private_key).`,
        };
      }
      return {
        ok: true,
        message: `Service Account key loaded (${parsed.client_email}).`,
      };
    } catch (error) {
      return {
        ok: false,
        message: `Failed to parse Service Account JSON key file at ${keyPath}: ${String(error)}`,
      };
    }
  }

  if (config.authMode === "impersonation") {
    const target = config.impersonateServiceAccount;
    if (!target || !isValidServiceAccountEmail(target)) {
      return {
        ok: false,
        message:
          "Impersonation mode selected, but impersonateServiceAccount is missing or invalid.",
      };
    }
    if (
      process.env.GOOGLE_APPLICATION_CREDENTIALS &&
      existsSync(process.env.GOOGLE_APPLICATION_CREDENTIALS)
    ) {
      return {
        ok: true,
        message: `Service Account impersonation configured for ${target}.`,
      };
    }
    try {
      execFileSync(
        "gcloud",
        [
          "auth",
          "print-access-token",
          `--impersonate-service-account=${target}`,
        ],
        {
          stdio: "ignore",
          timeout: 15_000,
        },
      );
      return {
        ok: true,
        message: `Service Account impersonation verified via gcloud for ${target}.`,
      };
    } catch {
      return {
        ok: false,
        message: `Service Account impersonation for ${target} has no source ADC credentials. Run: gcloud auth application-default login`,
      };
    }
  }

  const adcPath =
    process.env.GOOGLE_APPLICATION_CREDENTIALS || resolveDefaultAdcPath();
  if (existsSync(adcPath)) {
    return { ok: true, message: "Google ADC is available." };
  }
  try {
    execFileSync(
      "gcloud",
      ["auth", "application-default", "print-access-token"],
      {
        stdio: "ignore",
        timeout: 15_000,
      },
    );
    return { ok: true, message: "Google ADC is available." };
  } catch {
    return {
      ok: false,
      message:
        "Google ADC is not available. Run: gcloud auth application-default login",
    };
  }
}

function runApplicationDefaultLogin(): void {
  spawnSync("gcloud", ["auth", "application-default", "login"], {
    stdio: "inherit",
  });
}

function parseSetupArgs(args: string): Partial<VertexSetupConfig> {
  const tokens = args.trim().split(/\s+/).filter(Boolean);
  const parsed: Partial<VertexSetupConfig> = {};
  const positional: string[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token === "--auth" && tokens[i + 1]) {
      const mode = tokens[++i]!;
      if (
        mode === "adc" ||
        mode === "service-account" ||
        mode === "impersonation"
      ) {
        parsed.authMode = mode;
      }
    } else if (token.startsWith("--auth=")) {
      const mode = token.slice("--auth=".length);
      if (
        mode === "adc" ||
        mode === "service-account" ||
        mode === "impersonation"
      ) {
        parsed.authMode = mode;
      }
    } else if ((token === "--key" || token === "--sa-key") && tokens[i + 1]) {
      parsed.serviceAccountKeyPath = tokens[++i]!;
      parsed.authMode ??= "service-account";
    } else if (token.startsWith("--key=")) {
      parsed.serviceAccountKeyPath = token.slice("--key=".length);
      parsed.authMode ??= "service-account";
    } else if (token.startsWith("--sa-key=")) {
      parsed.serviceAccountKeyPath = token.slice("--sa-key=".length);
      parsed.authMode ??= "service-account";
    } else if (token === "--impersonate" && tokens[i + 1]) {
      parsed.impersonateServiceAccount = tokens[++i]!;
      parsed.authMode = "impersonation";
    } else if (token.startsWith("--impersonate=")) {
      parsed.impersonateServiceAccount = token.slice("--impersonate=".length);
      parsed.authMode = "impersonation";
    } else if (token === "--anthropic-ttl" && tokens[i + 1]) {
      const ttl = tokens[++i]!;
      if (ttl === "5m" || ttl === "1h" || ttl === "off") {
        parsed.anthropicCacheTtl = ttl;
      }
    } else if (token.startsWith("--anthropic-ttl=")) {
      const ttl = token.slice("--anthropic-ttl=".length);
      if (ttl === "5m" || ttl === "1h" || ttl === "off") {
        parsed.anthropicCacheTtl = ttl;
      }
    } else if (token === "--gemini-ttl" && tokens[i + 1]) {
      const raw = tokens[++i]!;
      parsed.geminiCacheTtlSeconds =
        raw === "off" ? 0 : Math.max(0, Number.parseInt(raw, 10) || 0);
    } else if (token.startsWith("--gemini-ttl=")) {
      const raw = token.slice("--gemini-ttl=".length);
      parsed.geminiCacheTtlSeconds =
        raw === "off" ? 0 : Math.max(0, Number.parseInt(raw, 10) || 0);
    } else if (!token.startsWith("--")) {
      positional.push(token);
    }
  }

  if (positional[0]) parsed.project = positional[0];
  if (positional[1]) parsed.location = positional[1];
  return parsed;
}

function registerSetupCommand(pi: ExtensionAPI): void {
  const handler = async (args: string, ctx: ExtensionCommandContext) => {
    const cli = parseSetupArgs(args);
    const hasCliArgs = args.trim().length > 0;

    const project =
      cli.project ||
      (ctx.hasUI
        ? await ctx.ui.input(
            "Google Cloud project ID",
            currentConfig.project || "your-project-id",
          )
        : undefined);
    if (!project) {
      ctx.ui.notify(
        "Usage: /setup-gemini-vertexai <google-cloud-project> [location] [--auth adc|service-account|impersonation] [--key <path>] [--impersonate <sa-email>] [--anthropic-ttl 5m|1h|off] [--gemini-ttl <seconds|off>]",
        "error",
      );
      return;
    }

    const region =
      cli.location ||
      (!hasCliArgs && ctx.hasUI
        ? await ctx.ui.input(
            "Vertex AI location (eu, global, us, ...)",
            currentConfig.location || DEFAULT_REGION,
          )
        : undefined) ||
      currentConfig.location ||
      DEFAULT_REGION;

    let authMode: AuthMode = cli.authMode ?? currentConfig.authMode;
    let serviceAccountKeyPath =
      cli.serviceAccountKeyPath ?? currentConfig.serviceAccountKeyPath;
    let impersonateServiceAccount =
      cli.impersonateServiceAccount ?? currentConfig.impersonateServiceAccount;

    if (!hasCliArgs && ctx.hasUI) {
      const authSelection = await ctx.ui.select(
        "Vertex AI authentication method",
        [
          "adc (Application Default Credentials)",
          "service-account (Service Account JSON key file)",
          "impersonation (Impersonate a Service Account)",
        ],
      );
      if (authSelection?.startsWith("service-account")) {
        authMode = "service-account";
        const keyInput = await ctx.ui.input(
          "Service Account JSON key file path",
          serviceAccountKeyPath || "~/.config/gcp-agent/key.json",
        );
        if (!keyInput?.trim()) {
          ctx.ui.notify(
            "Service Account JSON key file path is required for service-account auth mode.",
            "error",
          );
          return;
        }
        serviceAccountKeyPath = keyInput.trim();
        impersonateServiceAccount = undefined;
      } else if (authSelection?.startsWith("impersonation")) {
        authMode = "impersonation";
        const targetSaInput = await ctx.ui.input(
          "Target Service Account email to impersonate",
          impersonateServiceAccount ||
            `sa-name@${project}.iam.gserviceaccount.com`,
        );
        if (!targetSaInput?.trim() || !isValidServiceAccountEmail(targetSaInput)) {
          ctx.ui.notify(
            "Valid target Service Account email (<name>@<project>.iam.gserviceaccount.com) is required for impersonation mode.",
            "error",
          );
          return;
        }
        impersonateServiceAccount = targetSaInput.trim();
        const sourceKeyInput = await ctx.ui.input(
          "Source Service Account JSON key file (leave blank to use default ADC)",
          serviceAccountKeyPath || "",
        );
        serviceAccountKeyPath = sourceKeyInput?.trim() || undefined;
      } else {
        authMode = "adc";
        serviceAccountKeyPath = undefined;
        impersonateServiceAccount = undefined;
      }
    }

    let anthropicCacheTtl: AnthropicCacheTtl =
      cli.anthropicCacheTtl ?? currentConfig.anthropicCacheTtl;
    let geminiCacheTtlSeconds: number =
      cli.geminiCacheTtlSeconds ?? currentConfig.geminiCacheTtlSeconds;

    if (!hasCliArgs && ctx.hasUI) {
      const anthropicChoice = await ctx.ui.select(
        "Anthropic 5.5 (Haiku/Sonnet/Opus) prompt cache TTL",
        [
          "5m (short — 1.25x write, 90-95% read discount)",
          "1h (long — 2.0x write, 90-95% read discount)",
          "off (disable prompt caching)",
        ],
      );
      if (anthropicChoice?.startsWith("1h")) {
        anthropicCacheTtl = "1h";
      } else if (anthropicChoice?.startsWith("off")) {
        anthropicCacheTtl = "off";
      } else if (anthropicChoice?.startsWith("5m")) {
        anthropicCacheTtl = "5m";
      }

      const geminiChoice = await ctx.ui.select(
        "Gemini (3.5-flash-lite / 3.8-flash / 4-argon) cache TTL",
        [
          "300s (5m default implicit cache warming)",
          "600s (10m)",
          "1800s (30m)",
          "3600s (1h)",
          "custom (enter seconds)",
          "off (disable cache warming)",
        ],
      );
      if (geminiChoice?.startsWith("off")) {
        geminiCacheTtlSeconds = 0;
      } else if (geminiChoice?.startsWith("custom")) {
        const customInput = await ctx.ui.input(
          "Gemini cache TTL in seconds (0 to disable)",
          String(geminiCacheTtlSeconds),
        );
        const parsedCustom = Number.parseInt(customInput?.trim() ?? "", 10);
        if (Number.isFinite(parsedCustom) && parsedCustom >= 0) {
          geminiCacheTtlSeconds = parsedCustom;
        }
      } else if (geminiChoice) {
        const parsedPreset = Number.parseInt(geminiChoice, 10);
        if (Number.isFinite(parsedPreset) && parsedPreset >= 0) {
          geminiCacheTtlSeconds = parsedPreset;
        }
      }
    }

    const updated = applyRuntimeConfig({
      project,
      location: region,
      authMode,
      serviceAccountKeyPath,
      impersonateServiceAccount,
      anthropicCacheTtl,
      geminiCacheTtlSeconds,
    });
    writeSetupConfig(updated);
    registerAllVertexProviders(pi, updated);
    updateStatus(ctx, updated);

    let credCheck = checkCredentials(updated);
    if (
      !credCheck.ok &&
      ctx.hasUI &&
      (updated.authMode === "adc" ||
        (updated.authMode === "impersonation" && !updated.serviceAccountKeyPath))
    ) {
      const runLogin = await ctx.ui.confirm(
        "Google ADC is not configured",
        "Run `gcloud auth application-default login` now?",
      );
      if (runLogin) {
        runApplicationDefaultLogin();
        applyEnvironment(updated);
        credCheck = checkCredentials(updated);
      }
    }

    const geminiTtlSummary =
      updated.geminiCacheTtlSeconds > 0
        ? `${updated.geminiCacheTtlSeconds}s`
        : "off";
    ctx.ui.notify(
      `Google Cloud Vertex AI configured: project=${updated.project}, location=${updated.location}, auth=${updated.authMode}, anthropicCache=${updated.anthropicCacheTtl}, geminiCache=${geminiTtlSummary}, endpoint=${getVertexBaseUrl(updated.location)}. ${credCheck.message}`,
      credCheck.ok ? "info" : "warning",
    );
  };

  const command = {
    description:
      "Configure Google Cloud Vertex AI project, location, auth (ADC / Service Account / Impersonation), and cache TTLs",
    handler,
  };
  pi.registerCommand("setup-gemini-vertexai", command);
  pi.registerCommand("setup-vertexai", {
    ...command,
    description: "Alias for /setup-gemini-vertexai",
  });
}

function registerCacheCommand(pi: ExtensionAPI): void {
  const handler = async (args: string, ctx: ExtensionCommandContext) => {
    const tokens = args.trim().split(/\s+/).filter(Boolean);
    const subcommand = tokens[0]?.toLowerCase();

    if (subcommand === "status") {
      const geminiLabel =
        currentConfig.geminiCacheTtlSeconds > 0
          ? `${currentConfig.geminiCacheTtlSeconds}s`
          : "off";
      ctx.ui.notify(
        `Vertex cache TTLs — Anthropic (claude-haiku-5-5, claude-sonnet-5-5, claude-opus-5-5): ${currentConfig.anthropicCacheTtl} | Gemini (gemini-3.5-flash-lite, gemini-3.8-flash, gemini-4-argon): ${geminiLabel}`,
        "info",
      );
      return;
    }

    if (subcommand === "anthropic") {
      const val = tokens[1]?.toLowerCase();
      if (val !== "5m" && val !== "1h" && val !== "off") {
        ctx.ui.notify(
          "Usage: /vertex-cache anthropic <5m|1h|off>",
          "error",
        );
        return;
      }
      const updated = applyRuntimeConfig({ anthropicCacheTtl: val });
      writeSetupConfig(updated);
      registerAllVertexProviders(pi, updated);
      updateStatus(ctx, updated);
      ctx.ui.notify(
        `Anthropic 5.5 Vertex prompt cache TTL set to ${val}.`,
        "info",
      );
      return;
    }

    if (subcommand === "gemini") {
      const raw = tokens[1]?.toLowerCase();
      if (!raw) {
        ctx.ui.notify(
          "Usage: /vertex-cache gemini <seconds|off>",
          "error",
        );
        return;
      }
      const seconds =
        raw === "off" ? 0 : Number.parseInt(raw.replace(/s$/, ""), 10);
      if (!Number.isFinite(seconds) || seconds < 0) {
        ctx.ui.notify(
          "Usage: /vertex-cache gemini <seconds|off> (e.g., 300, 600, 1800, 3600, off)",
          "error",
        );
        return;
      }
      const updated = applyRuntimeConfig({ geminiCacheTtlSeconds: seconds });
      writeSetupConfig(updated);
      registerAllVertexProviders(pi, updated);
      updateStatus(ctx, updated);
      ctx.ui.notify(
        `Gemini Vertex cache TTL set to ${seconds > 0 ? `${seconds}s` : "off"}.`,
        "info",
      );
      return;
    }

    if (!subcommand && ctx.hasUI) {
      const target = await ctx.ui.select("Configure Vertex AI cache TTL", [
        `Anthropic 5.5 (Haiku/Sonnet/Opus) — current: ${currentConfig.anthropicCacheTtl}`,
        `Gemini (3.5-flash-lite / 3.8-flash / 4-argon) — current: ${currentConfig.geminiCacheTtlSeconds > 0 ? `${currentConfig.geminiCacheTtlSeconds}s` : "off"}`,
      ]);
      if (!target) return;

      if (target.startsWith("Anthropic")) {
        const choice = await ctx.ui.select(
          "Anthropic 5.5 (Haiku/Sonnet/Opus) prompt cache TTL",
          [
            "5m (short — 1.25x write, 90-95% read discount)",
            "1h (long — 2.0x write, 90-95% read discount)",
            "off (disable prompt caching)",
          ],
        );
        if (!choice) return;
        const anthropicCacheTtl: AnthropicCacheTtl = choice.startsWith("1h")
          ? "1h"
          : choice.startsWith("off")
            ? "off"
            : "5m";
        const updated = applyRuntimeConfig({ anthropicCacheTtl });
        writeSetupConfig(updated);
        registerAllVertexProviders(pi, updated);
        updateStatus(ctx, updated);
        ctx.ui.notify(
          `Anthropic 5.5 Vertex prompt cache TTL set to ${anthropicCacheTtl}.`,
          "info",
        );
        return;
      }

      const geminiChoice = await ctx.ui.select(
        "Gemini (3.5-flash-lite / 3.8-flash / 4-argon) cache TTL",
        [
          "300s (5m default implicit cache warming)",
          "600s (10m)",
          "1800s (30m)",
          "3600s (1h)",
          "custom (enter seconds)",
          "off (disable cache warming)",
        ],
      );
      if (!geminiChoice) return;
      let geminiCacheTtlSeconds = currentConfig.geminiCacheTtlSeconds;
      if (geminiChoice.startsWith("off")) {
        geminiCacheTtlSeconds = 0;
      } else if (geminiChoice.startsWith("custom")) {
        const customInput = await ctx.ui.input(
          "Gemini cache TTL in seconds (0 to disable)",
          String(geminiCacheTtlSeconds),
        );
        const parsedCustom = Number.parseInt(customInput?.trim() ?? "", 10);
        if (!Number.isFinite(parsedCustom) || parsedCustom < 0) {
          ctx.ui.notify("Invalid cache TTL seconds.", "error");
          return;
        }
        geminiCacheTtlSeconds = parsedCustom;
      } else {
        geminiCacheTtlSeconds = Number.parseInt(geminiChoice, 10);
      }

      const updated = applyRuntimeConfig({ geminiCacheTtlSeconds });
      writeSetupConfig(updated);
      registerAllVertexProviders(pi, updated);
      updateStatus(ctx, updated);
      ctx.ui.notify(
        `Gemini Vertex cache TTL set to ${geminiCacheTtlSeconds > 0 ? `${geminiCacheTtlSeconds}s` : "off"}.`,
        "info",
      );
      return;
    }

    ctx.ui.notify(
      "Usage: /vertex-cache [status | anthropic <5m|1h|off> | gemini <seconds|off>]",
      "info",
    );
  };

  pi.registerCommand("vertex-cache", {
    description:
      "View or configure Vertex AI prompt cache TTL for Anthropic 5.5 (5m/1h/off) and Gemini (3.5-flash-lite/3.8-flash/4-argon)",
    handler,
  });
}
