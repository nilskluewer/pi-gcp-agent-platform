/**
 * pi-gcp-agent-platform — Claude and Gemini on Google Cloud Vertex AI / Gemini
 * Enterprise Agent Platform.
 *
 * Pi already ships the low-level google-vertex provider implementation. This
 * extension owns the shared Google Cloud project, region, strict auth mode
 * (ADC, service account JSON key, or service account impersonation), and prompt
 * cache TTL configuration, then registers the AnthropicVertex adapter for Claude
 * alongside Pi's native Gemini provider.
 *
 * Strict authentication contract (never falls back to another identity):
 *   - "adc": uses only the user ADC file (~/.config/gcloud/application_default_credentials.json
 *     or $CLOUDSDK_CONFIG/application_default_credentials.json) with type="authorized_user".
 *   - "service-account": uses only the configured serviceAccountKeyPath with type="service_account".
 *   - "impersonation": uses only the generated ~/.pi/agent/gcp-agent-platform-impersonated-adc.json
 *     with type="impersonated_service_account" for target impersonateServiceAccount.
 */

import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  getApiProvider,
  getModels,
  type Api,
  type Model,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai/compat";
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

export type ResolvedVertexConfig = {
  project?: string;
  location: string;
  authMode: AuthMode;
  serviceAccountKeyPath?: string;
  impersonateServiceAccount?: string;
  anthropicCacheTtl: AnthropicCacheTtl;
  geminiCacheTtlSeconds: number;
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

const INITIAL_ENV = {
  GOOGLE_CLOUD_PROJECT: process.env.GOOGLE_CLOUD_PROJECT,
  ANTHROPIC_VERTEX_PROJECT_ID: process.env.ANTHROPIC_VERTEX_PROJECT_ID,
  GCLOUD_PROJECT: process.env.GCLOUD_PROJECT,
  GOOGLE_CLOUD_LOCATION: process.env.GOOGLE_CLOUD_LOCATION,
  CLOUD_ML_REGION: process.env.CLOUD_ML_REGION,
  VERTEX_REGION: process.env.VERTEX_REGION,
  GOOGLE_APPLICATION_CREDENTIALS:
    process.env.GOOGLE_APPLICATION_CREDENTIALS &&
    process.env.GOOGLE_APPLICATION_CREDENTIALS !== IMPERSONATED_ADC_FILE
      ? process.env.GOOGLE_APPLICATION_CREDENTIALS
      : undefined,
  VERTEX_IMPERSONATE_SERVICE_ACCOUNT:
    process.env.VERTEX_IMPERSONATE_SERVICE_ACCOUNT,
  PI_CACHE_RETENTION: process.env.PI_CACHE_RETENTION,
};

let savedConfig: VertexSetupConfig = readSetupConfig();
let currentConfig: ResolvedVertexConfig = resolveConfig(savedConfig, INITIAL_ENV);
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

function writeSecureFile(filePath: string, content: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, content, { mode: 0o600 });
  try {
    chmodSync(filePath, 0o600);
  } catch {
    // Ignore chmod errors on filesystems that do not support POSIX modes.
  }
}

function updateStatus(
  ctx: { ui: { setStatus(key: string, text: string | undefined): void } },
  config: ResolvedVertexConfig,
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

type EnvSnapshot = typeof INITIAL_ENV;

export function resolveConfig(
  saved: VertexSetupConfig,
  env?: Partial<EnvSnapshot>,
): ResolvedVertexConfig {
  const project =
    env?.GOOGLE_CLOUD_PROJECT ||
    env?.ANTHROPIC_VERTEX_PROJECT_ID ||
    env?.GCLOUD_PROJECT ||
    saved.project;

  const location =
    env?.GOOGLE_CLOUD_LOCATION ||
    env?.CLOUD_ML_REGION ||
    env?.VERTEX_REGION ||
    saved.location ||
    DEFAULT_REGION;

  // Saved explicit authMode wins when configured via /setup-gemini-vertexai;
  // otherwise environment variables determine the mode. Note: VERTEX_IMPERSONATE_SERVICE_ACCOUNT
  // belongs to pi-web-search-research-llm-gcp unless authMode="impersonation" or
  // impersonateServiceAccount is explicitly configured in gcp-agent-platform.json.
  let authMode: AuthMode;
  if (
    saved.authMode === "adc" ||
    saved.authMode === "service-account" ||
    saved.authMode === "impersonation"
  ) {
    authMode = saved.authMode;
  } else if (saved.impersonateServiceAccount) {
    authMode = "impersonation";
  } else if (
    env?.GOOGLE_APPLICATION_CREDENTIALS ||
    saved.serviceAccountKeyPath
  ) {
    authMode = "service-account";
  } else {
    authMode = "adc";
  }

  const rawKeyPath =
    authMode === "adc"
      ? undefined
      : saved.serviceAccountKeyPath || env?.GOOGLE_APPLICATION_CREDENTIALS;

  const rawImpersonate =
    authMode === "impersonation"
      ? saved.impersonateServiceAccount ||
        env?.VERTEX_IMPERSONATE_SERVICE_ACCOUNT
      : undefined;

  let anthropicCacheTtl: AnthropicCacheTtl = "5m";
  if (
    saved.anthropicCacheTtl === "5m" ||
    saved.anthropicCacheTtl === "1h" ||
    saved.anthropicCacheTtl === "off"
  ) {
    anthropicCacheTtl = saved.anthropicCacheTtl;
  } else if (env?.PI_CACHE_RETENTION === "long") {
    anthropicCacheTtl = "1h";
  } else if (env?.PI_CACHE_RETENTION === "none") {
    anthropicCacheTtl = "off";
  }

  const geminiCacheTtlSeconds =
    typeof saved.geminiCacheTtlSeconds === "number" &&
    Number.isFinite(saved.geminiCacheTtlSeconds) &&
    saved.geminiCacheTtlSeconds >= 0
      ? Math.floor(saved.geminiCacheTtlSeconds)
      : DEFAULT_GEMINI_CACHE_TTL_SECONDS;

  return {
    project: project?.trim() || undefined,
    location: location.trim() || DEFAULT_REGION,
    authMode,
    serviceAccountKeyPath: rawKeyPath?.trim() || undefined,
    impersonateServiceAccount: rawImpersonate?.trim() || undefined,
    anthropicCacheTtl,
    geminiCacheTtlSeconds,
  };
}

function updateSavedConfig(patch: Partial<VertexSetupConfig>): ResolvedVertexConfig {
  const nextSaved: VertexSetupConfig = {
    ...savedConfig,
    ...patch,
  };
  if (nextSaved.authMode === "adc") {
    delete nextSaved.serviceAccountKeyPath;
    delete nextSaved.impersonateServiceAccount;
  } else if (nextSaved.authMode === "service-account") {
    delete nextSaved.impersonateServiceAccount;
  }
  savedConfig = nextSaved;
  writeSetupConfig(savedConfig);
  // Interactive setup / cache commands explicitly set the active runtime config.
  currentConfig = resolveConfig(savedConfig, undefined);
  applyEnvironment(currentConfig);
  return currentConfig;
}

export function resolveDefaultAdcPath(): string {
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
  if (INITIAL_ENV.GOOGLE_APPLICATION_CREDENTIALS) {
    return expandPath(INITIAL_ENV.GOOGLE_APPLICATION_CREDENTIALS);
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

  if (
    unwrappedSource.type !== "service_account" &&
    unwrappedSource.type !== "authorized_user"
  ) {
    throw new Error(
      `Invalid impersonation source credentials (expected type="service_account" or "authorized_user", got "${String(unwrappedSource.type)}").`,
    );
  }

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
    const payload = buildImpersonatedAdcPayload(trimmedTarget, parsed);
    writeSecureFile(
      IMPERSONATED_ADC_FILE,
      `${JSON.stringify(payload, null, 2)}\n`,
    );
    return IMPERSONATED_ADC_FILE;
  } catch (error) {
    console.warn(
      `[pi-gcp-agent-platform] failed to build impersonated ADC credentials from ${sourcePath}: ${String(error)}`,
    );
    return undefined;
  }
}

/**
 * Validates and returns the exact credential file path for `config.authMode`.
 * Throws an Error if the selected authentication mode is not properly configured
 * or its credential file has the wrong type, preventing any silent fallback to
 * another identity.
 */
export function resolveStrictCredentialsFile(
  config: ResolvedVertexConfig = currentConfig,
): string {
  if (config.authMode === "adc") {
    const adcPath = resolveDefaultAdcPath();
    if (!existsSync(adcPath)) {
      throw new Error(
        `ADC authentication mode is active, but ${adcPath} does not exist. Run: gcloud auth application-default login`,
      );
    }
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(readFileSync(adcPath, "utf8")) as Record<
        string,
        unknown
      >;
    } catch (error) {
      throw new Error(
        `ADC authentication mode is active, but failed to parse ${adcPath}: ${String(error)}`,
      );
    }
    if (parsed.type !== "authorized_user") {
      throw new Error(
        `ADC authentication mode requires type="authorized_user" in ${adcPath}, but found type="${String(parsed.type)}". Refusing to fall back to another credential type.`,
      );
    }
    return adcPath;
  }

  if (config.authMode === "service-account") {
    if (!config.serviceAccountKeyPath) {
      throw new Error(
        "Service Account authentication mode is active, but serviceAccountKeyPath is not configured.",
      );
    }
    const keyPath = expandPath(config.serviceAccountKeyPath);
    if (!existsSync(keyPath)) {
      throw new Error(
        `Service Account authentication mode is active, but key file was not found at ${keyPath}.`,
      );
    }
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(readFileSync(keyPath, "utf8")) as Record<
        string,
        unknown
      >;
    } catch (error) {
      throw new Error(
        `Service Account authentication mode failed to parse ${keyPath}: ${String(error)}`,
      );
    }
    if (
      parsed.type !== "service_account" ||
      typeof parsed.client_email !== "string" ||
      typeof parsed.private_key !== "string"
    ) {
      throw new Error(
        `Service Account authentication mode requires type="service_account" with client_email and private_key in ${keyPath}, but found type="${String(parsed.type)}".`,
      );
    }
    return keyPath;
  }

  // config.authMode === "impersonation"
  const target = config.impersonateServiceAccount?.trim();
  if (!target || !isValidServiceAccountEmail(target)) {
    throw new Error(
      "Impersonation authentication mode is active, but impersonateServiceAccount is missing or invalid.",
    );
  }
  const sourcePath = resolveImpersonationSourcePath(
    config.serviceAccountKeyPath,
  );
  if (!sourcePath || !existsSync(sourcePath)) {
    throw new Error(
      `Impersonation authentication mode for ${target} has no source credentials at ${sourcePath ?? "ADC"}. Configure a source key or run: gcloud auth application-default login`,
    );
  }
  const impersonatedPath = writeImpersonatedAdcFile(target, sourcePath);
  if (!impersonatedPath || !existsSync(impersonatedPath)) {
    throw new Error(
      `Impersonation authentication mode failed to generate impersonated credentials for ${target} from ${sourcePath}.`,
    );
  }
  const parsed = JSON.parse(readFileSync(impersonatedPath, "utf8")) as Record<
    string,
    unknown
  >;
  const expectedUrl = `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${target}:generateAccessToken`;
  if (
    parsed.type !== "impersonated_service_account" ||
    parsed.service_account_impersonation_url !== expectedUrl
  ) {
    throw new Error(
      `Impersonation credential file ${impersonatedPath} does not match target ${target}.`,
    );
  }
  return impersonatedPath;
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

  // Never mutate global process.env.PI_CACHE_RETENTION; anthropic-vertex sets
  // cacheRetention and promptCache directly on its own models and requests.
  if (INITIAL_ENV.PI_CACHE_RETENTION !== undefined) {
    process.env.PI_CACHE_RETENTION = INITIAL_ENV.PI_CACHE_RETENTION;
  } else {
    delete process.env.PI_CACHE_RETENTION;
  }

  // Strictly bind GOOGLE_APPLICATION_CREDENTIALS to the selected mode so no
  // ambient shell variable can leak across modes. Restore VERTEX_IMPERSONATE_SERVICE_ACCOUNT
  // to its initial shell value unless impersonation mode is explicitly selected.
  if (config.authMode === "adc") {
    if (INITIAL_ENV.VERTEX_IMPERSONATE_SERVICE_ACCOUNT !== undefined) {
      process.env.VERTEX_IMPERSONATE_SERVICE_ACCOUNT =
        INITIAL_ENV.VERTEX_IMPERSONATE_SERVICE_ACCOUNT;
    } else {
      delete process.env.VERTEX_IMPERSONATE_SERVICE_ACCOUNT;
    }
    rmSync(IMPERSONATED_ADC_FILE, { force: true });
    process.env.GOOGLE_APPLICATION_CREDENTIALS = resolveDefaultAdcPath();
  } else if (config.authMode === "service-account") {
    if (INITIAL_ENV.VERTEX_IMPERSONATE_SERVICE_ACCOUNT !== undefined) {
      process.env.VERTEX_IMPERSONATE_SERVICE_ACCOUNT =
        INITIAL_ENV.VERTEX_IMPERSONATE_SERVICE_ACCOUNT;
    } else {
      delete process.env.VERTEX_IMPERSONATE_SERVICE_ACCOUNT;
    }
    rmSync(IMPERSONATED_ADC_FILE, { force: true });
    process.env.GOOGLE_APPLICATION_CREDENTIALS = config.serviceAccountKeyPath
      ? expandPath(config.serviceAccountKeyPath)
      : "";
  } else {
    // impersonation
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
      if (!impersonatedPath) {
        rmSync(IMPERSONATED_ADC_FILE, { force: true });
      }
      process.env.GOOGLE_APPLICATION_CREDENTIALS = IMPERSONATED_ADC_FILE;
    } else {
      rmSync(IMPERSONATED_ADC_FILE, { force: true });
      process.env.GOOGLE_APPLICATION_CREDENTIALS = IMPERSONATED_ADC_FILE;
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
  resolveCredentialsFile: () => string = () =>
    resolveStrictCredentialsFile(currentConfig),
): void {
  if (!project) return;
  const googleVertexApi = getApiProvider("google-vertex");
  const models = getGoogleVertexModels(
    geminiCacheTtlSeconds,
  ) as unknown as ProviderModelConfig[];
  if (models.length === 0) return;

  // Keep `{location}` template on the model baseUrl so `@google/genai` computes
  // the regional/multi-regional Vertex endpoint (`eu` -> `aiplatform.eu.rep.googleapis.com`)
  // and prepends `v1/projects/<project>/locations/<location>/...` instead of
  // switching to `ResourceScope.COLLECTION`.
  const sdkTemplateBaseUrl = "https://{location}-aiplatform.googleapis.com";

  pi.registerProvider("google-vertex", {
    baseUrl: sdkTemplateBaseUrl,
    apiKey: "$GOOGLE_CLOUD_PROJECT",
    api: "google-vertex",
    models,
    ...(googleVertexApi
      ? {
          streamSimple: (
            model: Model<Api>,
            context,
            options?: SimpleStreamOptions,
          ) => {
            const keyFilename = resolveCredentialsFile();
            const patchedModel = {
              ...model,
              baseUrl: sdkTemplateBaseUrl,
            };
            return googleVertexApi.streamSimple(patchedModel, context, {
              ...options,
              // Pass `<authenticated>` so Pi's google-vertex adapter uses GoogleAuth
              // with `keyFilename` instead of treating `$GOOGLE_CLOUD_PROJECT` as a Vertex API key.
              apiKey: "<authenticated>",
              env: {
                ...options?.env,
                GOOGLE_APPLICATION_CREDENTIALS: keyFilename,
              },
            });
          },
        }
      : {}),
  });
}

function registerAllVertexProviders(
  pi: ExtensionAPI,
  config: ResolvedVertexConfig,
): void {
  const baseUrl = getVertexBaseUrl(config.location);
  const strictResolver = () => resolveStrictCredentialsFile(config);
  registerGoogleVertexProvider(
    pi,
    config.project,
    baseUrl,
    config.geminiCacheTtlSeconds,
    strictResolver,
  );
  registerAnthropicVertexProvider(
    pi,
    config.project,
    config.location,
    baseUrl,
    config.anthropicCacheTtl,
    strictResolver,
  );
  registerVertexImagesProvider(
    pi,
    config.project,
    config.location,
    baseUrl,
    strictResolver,
  );
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
  writeSecureFile(CONFIG_FILE, `${JSON.stringify(payload, null, 2)}\n`);
}

export function checkCredentials(
  config: ResolvedVertexConfig = currentConfig,
): {
  ok: boolean;
  message: string;
} {
  try {
    const credPath = resolveStrictCredentialsFile(config);
    const parsed = JSON.parse(readFileSync(credPath, "utf8")) as Record<
      string,
      unknown
    >;
    if (config.authMode === "adc") {
      return {
        ok: true,
        message: `Google ADC (authorized_user) verified at ${credPath}.`,
      };
    }
    if (config.authMode === "service-account") {
      return {
        ok: true,
        message: `Service Account key verified (${String(parsed.client_email)} at ${credPath}).`,
      };
    }
    const sourceType =
      typeof parsed.source_credentials === "object" &&
      parsed.source_credentials !== null
        ? String(
            (parsed.source_credentials as Record<string, unknown>).client_email ??
              (parsed.source_credentials as Record<string, unknown>).type ??
              "ADC",
          )
        : "ADC";
    return {
      ok: true,
      message: `Service Account impersonation verified for ${config.impersonateServiceAccount} (source: ${sourceType}).`,
    };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

function runApplicationDefaultLogin(): void {
  const env = { ...process.env };
  delete env.CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE;
  delete env.GOOGLE_APPLICATION_CREDENTIALS;
  spawnSync("gcloud", ["auth", "application-default", "login"], {
    stdio: "inherit",
    env,
  });
}

export function parseSetupArgs(args: string): Partial<VertexSetupConfig> {
  const tokens = args.trim().split(/\s+/).filter(Boolean);
  const parsed: Partial<VertexSetupConfig> = {};
  const positional: string[] = [];

  const applyFlag = (flag: string, value: string): void => {
    switch (flag) {
      case "--auth":
        if (
          value === "adc" ||
          value === "service-account" ||
          value === "impersonation"
        ) {
          parsed.authMode = value;
        }
        break;
      case "--key":
      case "--sa-key":
        parsed.serviceAccountKeyPath = value;
        parsed.authMode ??= "service-account";
        break;
      case "--impersonate":
        parsed.impersonateServiceAccount = value;
        parsed.authMode = "impersonation";
        break;
      case "--anthropic-ttl":
        if (value === "5m" || value === "1h" || value === "off") {
          parsed.anthropicCacheTtl = value;
        }
        break;
      case "--gemini-ttl":
        parsed.geminiCacheTtlSeconds =
          value === "off" ? 0 : Math.max(0, Number.parseInt(value, 10) || 0);
        break;
    }
  };

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (!token.startsWith("--")) {
      positional.push(token);
      continue;
    }
    const eqIdx = token.indexOf("=");
    if (eqIdx !== -1) {
      applyFlag(token.slice(0, eqIdx), token.slice(eqIdx + 1));
    } else if (tokens[i + 1] !== undefined) {
      applyFlag(token, tokens[++i]!);
    }
  }

  if (positional[0]) parsed.project = positional[0];
  if (positional[1]) parsed.location = positional[1];
  return parsed;
}

async function promptAnthropicTtl(
  ctx: ExtensionCommandContext,
  current: AnthropicCacheTtl,
): Promise<AnthropicCacheTtl | undefined> {
  const choice = await ctx.ui.select(
    "Anthropic 5.5 (Haiku/Sonnet/Opus) prompt cache TTL",
    [
      "5m (short — 1.25x write, 90-95% read discount)",
      "1h (long — 2.0x write, 90-95% read discount)",
      "off (disable prompt caching)",
    ],
  );
  if (!choice) return undefined;
  if (choice.startsWith("1h")) return "1h";
  if (choice.startsWith("off")) return "off";
  if (choice.startsWith("5m")) return "5m";
  return current;
}

async function promptGeminiTtl(
  ctx: ExtensionCommandContext,
  current: number,
): Promise<number | undefined> {
  const choice = await ctx.ui.select(
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
  if (!choice) return undefined;
  if (choice.startsWith("off")) return 0;
  if (choice.startsWith("custom")) {
    const customInput = await ctx.ui.input(
      "Gemini cache TTL in seconds (0 to disable)",
      String(current),
    );
    const parsedCustom = Number.parseInt(customInput?.trim() ?? "", 10);
    if (!Number.isFinite(parsedCustom) || parsedCustom < 0) {
      return undefined;
    }
    return parsedCustom;
  }
  const parsedPreset = Number.parseInt(choice, 10);
  return Number.isFinite(parsedPreset) && parsedPreset >= 0
    ? parsedPreset
    : current;
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
        if (
          !targetSaInput?.trim() ||
          !isValidServiceAccountEmail(targetSaInput)
        ) {
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
    } else {
      // Clear irrelevant fields when switching authMode via CLI flags
      if (authMode === "adc") {
        serviceAccountKeyPath = undefined;
        impersonateServiceAccount = undefined;
      } else if (authMode === "service-account") {
        impersonateServiceAccount = undefined;
      } else if (authMode === "impersonation" && !cli.serviceAccountKeyPath) {
        serviceAccountKeyPath = undefined;
      }
    }

    let anthropicCacheTtl: AnthropicCacheTtl =
      cli.anthropicCacheTtl ?? currentConfig.anthropicCacheTtl;
    let geminiCacheTtlSeconds: number =
      cli.geminiCacheTtlSeconds ?? currentConfig.geminiCacheTtlSeconds;

    if (!hasCliArgs && ctx.hasUI) {
      const chosenAnthropic = await promptAnthropicTtl(ctx, anthropicCacheTtl);
      if (chosenAnthropic) anthropicCacheTtl = chosenAnthropic;

      const chosenGemini = await promptGeminiTtl(ctx, geminiCacheTtlSeconds);
      if (chosenGemini !== undefined) geminiCacheTtlSeconds = chosenGemini;
    }

    const updated = updateSavedConfig({
      project,
      location: region,
      authMode,
      serviceAccountKeyPath,
      impersonateServiceAccount,
      anthropicCacheTtl,
      geminiCacheTtlSeconds,
    });
    registerAllVertexProviders(pi, updated);
    updateStatus(ctx, updated);

    let credCheck = checkCredentials(updated);
    if (
      !credCheck.ok &&
      ctx.hasUI &&
      (updated.authMode === "adc" ||
        (updated.authMode === "impersonation" &&
          !updated.serviceAccountKeyPath))
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
        ctx.ui.notify("Usage: /vertex-cache anthropic <5m|1h|off>", "error");
        return;
      }
      const updated = updateSavedConfig({ anthropicCacheTtl: val });
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
        ctx.ui.notify("Usage: /vertex-cache gemini <seconds|off>", "error");
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
      const updated = updateSavedConfig({ geminiCacheTtlSeconds: seconds });
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
        const anthropicCacheTtl = await promptAnthropicTtl(
          ctx,
          currentConfig.anthropicCacheTtl,
        );
        if (!anthropicCacheTtl) return;
        const updated = updateSavedConfig({ anthropicCacheTtl });
        registerAllVertexProviders(pi, updated);
        updateStatus(ctx, updated);
        ctx.ui.notify(
          `Anthropic 5.5 Vertex prompt cache TTL set to ${anthropicCacheTtl}.`,
          "info",
        );
        return;
      }

      const geminiCacheTtlSeconds = await promptGeminiTtl(
        ctx,
        currentConfig.geminiCacheTtlSeconds,
      );
      if (geminiCacheTtlSeconds === undefined) {
        ctx.ui.notify("Invalid cache TTL seconds.", "error");
        return;
      }

      const updated = updateSavedConfig({ geminiCacheTtlSeconds });
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
