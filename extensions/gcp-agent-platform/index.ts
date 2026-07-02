/**
 * gcp-agent-platform — pi extension
 *
 * Google Cloud Agent Platform / Vertex AI connection helpers for Pi.
 * Google has rebranded parts of this stack as the Gemini Enterprise Agent
 * Platform; the underlying REST surface, e.g. aiplatform.googleapis.com, is
 * unchanged, so this extension and the rest of the pi ecosystem still refer
 * to it as "Vertex" internally.
 *
 * OAuth token transport:
 * Workaround for a mid-2026 Node.js regression where node-fetch@2 (used by
 * gaxios@6 → google-auth-library) throws ERR_STREAM_PREMATURE_CLOSE on
 * Google's OAuth/STS token endpoints, breaking authentication.
 *
 * undici (Node's built-in globalThis.fetch) works fine on the same endpoints,
 * so this extension intercepts require('node-fetch') and routes ONLY Google
 * token calls through undici. All other URLs keep the real node-fetch to
 * preserve Node stream bodies used elsewhere (e.g. response streaming).
 *
 * References:
 *   - https://github.com/nodejs/node/issues/63989
 *   - https://github.com/node-fetch/node-fetch/issues/1767
 *   - https://github.com/googleapis/google-api-nodejs-client/issues/3712
 *
 * Safe to keep installed: when upstream moves to native fetch (gaxios v7),
 * the intercepted path is never hit and this becomes a no-op.
 *
 * EU/US multi-region base URL:
 * See applyAnthropicVertexMultiRegionBaseUrlFix() below. Works around
 * @anthropic-ai/vertex-sdk@0.14.4 building the wrong host for the "eu"/"us"
 * multi-region endpoints. See ~/.pi/docs/vertex-eu-fix-2026-07-01.md.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Apply patches immediately at import time (before the factory even runs)
// so they are in place as early as possible in the Node module system.
applyFetchPatch();
applyAnthropicVertexMultiRegionBaseUrlFix();

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    const endpoint = process.env.ANTHROPIC_VERTEX_BASE_URL;
    ctx.ui.setStatus(
      "gcp-agent-platform",
      endpoint
        ? `☁️ GCP Agent Platform active (${endpoint})`
        : "☁️ GCP Agent Platform active"
    );
  });
}

function applyAnthropicVertexMultiRegionBaseUrlFix() {
  const region =
    process.env.GOOGLE_CLOUD_LOCATION ||
    process.env.CLOUD_ML_REGION ||
    process.env.VERTEX_REGION;

  if (region !== "eu" && region !== "us") return;

  const correct = `https://aiplatform.${region}.rep.googleapis.com/v1`;
  const legacy = `https://${region}-aiplatform.googleapis.com/v1`;
  const legacyNoVersion = `https://${region}-aiplatform.googleapis.com`;
  const current = process.env.ANTHROPIC_VERTEX_BASE_URL;

  // @anthropic-ai/vertex-sdk versions before native multi-region support build
  // https://eu-aiplatform.googleapis.com/v1 for region="eu". Vertex multi-region
  // endpoints actually live at aiplatform.eu.rep.googleapis.com. Prefer the
  // explicit SDK env override, but do not clobber unrelated custom/proxy URLs.
  if (!current || current === legacy || current === legacyNoVersion) {
    process.env.ANTHROPIC_VERTEX_BASE_URL = correct;
  }
}

function applyFetchPatch() {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Module = require("module");
  const origLoad = Module._load;

  Module._load = function (
    request: string,
    parent: unknown,
    isMain: boolean
  ) {
    const exported = origLoad.apply(this, arguments);

    if (
      request === "node-fetch" &&
      exported &&
      !(exported as any).__undiciPatched
    ) {
      const real =
        typeof exported === "function"
          ? exported
          : (exported as any).default ?? exported;

      const wrapper = function (url: any, opts: any) {
        const href: string =
          typeof url === "string"
            ? url
            : (url && (url.href || url.url)) || "";

        // Route only Google auth endpoints through undici's global fetch
        if (
          href.includes("oauth2.googleapis.com") ||
          href.includes("sts.googleapis.com")
        ) {
          return globalThis.fetch(url, opts);
        }

        return real.call(this, url, opts);
      };

      // Preserve node-fetch exports (Headers, Request, Response, FetchError, …)
      Object.assign(wrapper, exported);
      (wrapper as any).default = wrapper;
      (wrapper as any).__undiciPatched = true;

      return wrapper;
    }

    return exported;
  };
}
