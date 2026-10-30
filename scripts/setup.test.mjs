// Regression: Enter keeps the current project; Escape cancels without saving.
// Exercises the registered setup command with controlled UI responses. No GCP calls.
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = mkdtempSync(join(tmpdir(), "vertex-setup-test-"));
try {
  process.env.PI_CODING_AGENT_DIR = tmp;
  for (const name of ["GOOGLE_CLOUD_PROJECT", "ANTHROPIC_VERTEX_PROJECT_ID", "GCLOUD_PROJECT", "GOOGLE_APPLICATION_CREDENTIALS", "VERTEX_IMPERSONATE_SERVICE_ACCOUNT"]) {
    delete process.env[name];
  }
  const configPath = join(tmp, "gcp-agent-platform.json");
  const keyPath = join(tmp, "key.json");
  writeFileSync(configPath, JSON.stringify({ project: "existing-project", location: "eu" }));
  writeFileSync(keyPath, JSON.stringify({ type: "service_account", client_email: "test@example.iam.gserviceaccount.com", private_key: "test-only-not-a-real-key" }));
  const { default: extension } = await import("../extensions/gcp-agent-platform/index.ts");
  const commands = new Map();
  extension({ registerCommand: (name, command) => commands.set(name, command), registerProvider() {}, on() {} });
  let prompts = [];
  const run = async (projectInput, authChoice = 1, cancelAt) => {
    const notices = [];
    prompts = [];
    await commands.get("setup-gemini-vertexai").handler("", {
      hasUI: true,
      ui: {
        input: async (title) => {
          prompts.push(title);
          if (title === cancelAt) return undefined;
          if (title === "Google Cloud project ID") return projectInput;
          if (title.includes("key file path") || title.startsWith("Source Service Account")) return keyPath;
          if (title === "Target Service Account email to impersonate") return "target@example.iam.gserviceaccount.com";
          return "";
        },
        select: async (title, choices) => {
          prompts.push(title);
          if (title === cancelAt) return undefined;
          return title === "Vertex AI authentication method" ? choices[authChoice] : choices[0];
        },
        notify: (message) => notices.push(message),
        setStatus() {},
        confirm: async () => false,
      },
    });
    return notices;
  };
  const notices = await run("");
  assert.ok(!notices.some((message) => message.startsWith("Usage:")), "Enter must continue setup, not show usage");
  let saved = JSON.parse(readFileSync(configPath, "utf8"));
  assert.equal(saved.project, "existing-project");
  assert.equal(saved.authMode, "service-account", "Enter must allow switching authentication");
  assert.equal(saved.location, "eu", "Enter must keep the current location");
  assert.deepEqual(prompts.slice(0, 3), ["Vertex AI authentication method", "Google Cloud project ID", "Vertex AI location (eu, global, us, ...)"]);
  for (const [choice, mode] of [[0, "adc"], [2, "impersonation"], [1, "service-account"]]) {
    await run("", choice);
    saved = JSON.parse(readFileSync(configPath, "utf8"));
    assert.equal(saved.authMode, mode);
    assert.equal(saved.project, "existing-project");
    assert.deepEqual(prompts.slice(0, 3), ["Vertex AI authentication method", "Google Cloud project ID", "Vertex AI location (eu, global, us, ...)"]);
  }
  await run("  replacement-project  ");
  saved = JSON.parse(readFileSync(configPath, "utf8"));
  assert.equal(saved.project, "replacement-project", "Explicit input must replace the current project and trim whitespace");
  const beforeCancel = readFileSync(configPath, "utf8");
  const cancelledNotices = await run(undefined);
  assert.equal(readFileSync(configPath, "utf8"), beforeCancel, "Escape must not save changes");
  assert.deepEqual(cancelledNotices, [], "Escape must cancel without a usage error");
  for (const title of ["Vertex AI authentication method", "Vertex AI location (eu, global, us, ...)"]) {
    await run("", 1, title);
    assert.equal(readFileSync(configPath, "utf8"), beforeCancel, `Cancel at ${title} must not save changes`);
  }
  console.log("setup regression ok: auth → project → location for all modes; Enter keeps defaults; explicit project replaces default; Escape cancels");
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
