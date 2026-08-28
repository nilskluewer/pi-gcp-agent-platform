/**
 * pi-gcp-agent-platform — Claude and Gemini on Google Cloud Vertex AI / Gemini
 * Enterprise Agent Platform.
 *
 * Pi already ships the low-level google-vertex provider implementation. This
 * extension owns the shared Google Cloud project, region, and ADC setup, then
 * registers the AnthropicVertex adapter for Claude alongside Pi's native Gemini
 * provider.
 *
 * Prerequisites:
 *   1. gcloud auth application-default login
 *   2. export GOOGLE_CLOUD_PROJECT=your-project-id
 *   3. export GOOGLE_CLOUD_LOCATION=global  (or eu/us; defaults to eu)
 *
 * Usage:
 *   pi --provider google-vertex --model gemini-3.1-flash-lite
 *   pi --provider anthropic-vertex --model claude-opus-5
 */

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  getAgentDir,
  type ExtensionAPI,
  type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { registerAnthropicVertexProvider } from "./anthropic.ts";

type VertexSetupConfig = {
  project?: string;
  location?: string;
};

const CONFIG_FILE = join(getAgentDir(), "gcp-agent-platform.json");
const LEGACY_ANTHROPIC_CONFIG_FILE = join(
  getAgentDir(),
  "anthropic-vertex-enterprise-agent-platform.json",
);
const DEFAULT_REGION = "eu";
const EXTENSION_ID = "gcp-agent-platform";

const savedConfig = readSetupConfig();
let currentProject = resolveProject(savedConfig);
let currentRegion = resolveRegion(savedConfig);
applyEnvironment(currentProject, currentRegion);

export default function (pi: ExtensionAPI) {
  registerSetupCommand(pi);
  registerAnthropicVertexProvider(
    pi,
    currentProject,
    currentRegion,
    getVertexBaseUrl(currentRegion),
  );

  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.setStatus(
      EXTENSION_ID,
      `☁️ Google Cloud Vertex ${currentProject ? currentProject : "unconfigured"}/${currentRegion}`,
    );
  });
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

function applyRuntimeConfig(project: string, region: string): void {
  currentProject = project;
  currentRegion = region;
  applyEnvironment(project, region);
}

function applyEnvironment(project: string | undefined, region: string): void {
  if (project) {
    process.env.GOOGLE_CLOUD_PROJECT = project;
    process.env.ANTHROPIC_VERTEX_PROJECT_ID ||= project;
    process.env.GCLOUD_PROJECT ||= project;
  }
  process.env.GOOGLE_CLOUD_LOCATION = region;
  process.env.CLOUD_ML_REGION ||= region;
  process.env.VERTEX_REGION ||= region;
}

function getVertexBaseUrl(region: string): string {
  if (region === "eu" || region === "us")
    return `https://aiplatform.${region}.rep.googleapis.com`;
  if (region === "global") return "https://aiplatform.googleapis.com";
  return `https://${region}-aiplatform.googleapis.com`;
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

function writeSetupConfig(config: Required<VertexSetupConfig>): void {
  mkdirSync(dirname(CONFIG_FILE), { recursive: true });
  writeFileSync(CONFIG_FILE, `${JSON.stringify(config, null, 2)}\n`, {
    mode: 0o600,
  });
}

function checkApplicationDefaultCredentials(): boolean {
  try {
    execFileSync("gcloud", ["auth", "application-default", "print-access-token"], {
      stdio: "ignore",
      timeout: 15_000,
    });
    return true;
  } catch {
    return false;
  }
}

function runApplicationDefaultLogin(): void {
  spawnSync("gcloud", ["auth", "application-default", "login"], {
    stdio: "inherit",
  });
}

function registerSetupCommand(pi: ExtensionAPI): void {
  const handler = async (args: string, ctx: ExtensionCommandContext) => {
    const [projectArg, regionArg] = args.trim().split(/\s+/).filter(Boolean);
    const project =
      projectArg ||
      (ctx.hasUI
        ? await ctx.ui.input(
            "Google Cloud project ID",
            currentProject || "your-project-id",
          )
        : undefined);
    if (!project) {
      ctx.ui.notify(
        "Usage: /setup-gemini-vertexai <google-cloud-project> [location]",
        "error",
      );
      return;
    }

    const region =
      regionArg ||
      (ctx.hasUI
        ? await ctx.ui.input("Vertex AI location", currentRegion || DEFAULT_REGION)
        : undefined) ||
      DEFAULT_REGION;

    writeSetupConfig({ project, location: region });
    applyRuntimeConfig(project, region);
    registerAnthropicVertexProvider(
      pi,
      project,
      region,
      getVertexBaseUrl(region),
    );

    const authOk = checkApplicationDefaultCredentials();
    if (!authOk && ctx.hasUI) {
      const runLogin = await ctx.ui.confirm(
        "Google ADC is not configured",
        "Run `gcloud auth application-default login` now?",
      );
      if (runLogin) runApplicationDefaultLogin();
    }

    const authStatus = checkApplicationDefaultCredentials()
      ? "Google ADC is available."
      : "Google ADC is not available. Run: gcloud auth application-default login";
    ctx.ui.notify(
      `Google Cloud Vertex AI configured: project=${project}, location=${region}, endpoint=${getVertexBaseUrl(region)}. ${authStatus}`,
      authStatus.startsWith("Google ADC is available") ? "info" : "warning",
    );
  };

  const command = {
    description: "Configure Google Cloud Vertex AI project, endpoint location, and ADC auth",
    handler,
  };
  pi.registerCommand("setup-gemini-vertexai", command);
  pi.registerCommand("setup-vertexai", {
    ...command,
    description: "Alias for /setup-gemini-vertexai",
  });
}
