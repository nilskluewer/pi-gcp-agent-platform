/**
 * Gemini image models (Nano Banana 2) on Vertex AI as a Pi image provider.
 *
 * Image models are not selectable in /model. Pi's `codemode` tool reaches them via
 * `models.getModelOfType("image", "google-vertex-images", "gemini-3.1-flash-image")`
 * and `models.generateImages(model, { input })`. Codemode passes no options, so settings go
 * in the prompt as a directive: `@aspect=16:9 @size=2K` (sizes 512|1K|2K|4K; default 1K,
 * model-chosen aspect). Directives are stripped before sending.
 */

import type { AssistantImages, ImageModel, ImagesContext, ImagesOptions } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { GoogleAuth } from "google-auth-library";

const API = "vertex-gemini-images";
const PROVIDER = "google-vertex-images";
const VERTEX_SCOPE = "https://www.googleapis.com/auth/cloud-platform";
// USD per 1M tokens, standard traffic. EU multi-region has no flex.
const PRICE = { input: 0.5, text: 3, image: 60 };
// gemini-3.1-flash-image is available in `global` and the `eu` multi-region only.
const MODELS = [{ id: "gemini-3.1-flash-image", name: "Nano Banana 2 (gemini-3.1-flash-image)" }];

let googleAuth: { keyFilename: string; client: GoogleAuth } | undefined;
let token: { keyFilename: string; value: string; expires: number } | undefined;

async function accessToken(resolveCredentialsFile?: () => string): Promise<string> {
  const keyFilename = resolveCredentialsFile
    ? resolveCredentialsFile()
    : process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (!keyFilename) {
    throw new Error(
      "No active Google Cloud credential file resolved for the selected authentication mode.",
    );
  }

  if (token && token.keyFilename === keyFilename && token.expires > Date.now()) {
    return token.value;
  }

  if (!googleAuth || googleAuth.keyFilename !== keyFilename) {
    googleAuth = {
      keyFilename,
      client: new GoogleAuth({
        keyFilename,
        scopes: [VERTEX_SCOPE],
      }),
    };
  }

  const clientToken = await googleAuth.client.getAccessToken();
  if (!clientToken) {
    throw new Error(
      `Failed to acquire Google OAuth access token from ${keyFilename}.`,
    );
  }

  token = {
    keyFilename,
    value: clientToken,
    expires: Date.now() + 30 * 60_000,
  };
  return token.value;
}

export function registerVertexImagesProvider(
  pi: ExtensionAPI,
  project: string | undefined,
  region: string,
  baseUrl: string,
  resolveCredentialsFile?: () => string,
): void {
  googleAuth = undefined;
  token = undefined;

  if (!project) return;

  pi.registerProvider(PROVIDER, {
    apiKey: "$GOOGLE_CLOUD_PROJECT",
    models: MODELS.map((m) => ({
      type: "image" as const,
      ...m,
      api: API,
      baseUrl,
      input: ["text", "image"] as ("text" | "image")[],
      output: ["text", "image"] as ("text" | "image")[],
      cost: { input: PRICE.input, output: PRICE.image, cacheRead: 0, cacheWrite: 0 },
    })),
    images: {
      [API]: {
        generateImages: async (model: ImageModel<string>, context: ImagesContext, options?: ImagesOptions) => {
          const out: AssistantImages = {
            api: model.api,
            provider: model.provider,
            model: model.id,
            output: [],
            stopReason: "stop",
            timestamp: Date.now(),
          };
          try {
            const meta = (options?.metadata ?? {}) as { aspectRatio?: string; imageSize?: string };
            const parts = context.input.map((b) => {
              if (b.type !== "text") return { inlineData: { data: b.data, mimeType: b.mimeType } };
              const text = b.text.replace(/@(aspect|size)=(\S+)/g, (_, k, v) => {
                if (k === "aspect") meta.aspectRatio = v;
                else meta.imageSize = v;
                return "";
              });
              return { text: text.trim() };
            });
            const imageConfig = { imageSize: meta.imageSize ?? "1K", ...(meta.aspectRatio && { aspectRatio: meta.aspectRatio }) };
            const url = `${baseUrl}/v1/projects/${project}/locations/${region}/publishers/google/models/${model.id}:generateContent`;
            const res = await (options?.fetch ?? fetch)(url, {
              method: "POST",
              headers: {
                Authorization: `Bearer ${await accessToken(resolveCredentialsFile)}`,
                "X-Goog-User-Project": project,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                contents: [{ role: "user", parts }],
                generationConfig: { responseModalities: ["TEXT", "IMAGE"], imageConfig },
              }),
              signal: options?.signal,
            });
            if (!res.ok) throw new Error(`Vertex ${res.status}: ${(await res.text()).slice(0, 400)}`);
            const data = (await res.json()) as any;
            for (const p of data.candidates?.[0]?.content?.parts ?? []) {
              if (p.inlineData?.data) out.output.push({ type: "image", data: p.inlineData.data, mimeType: p.inlineData.mimeType ?? "image/png" });
              else if (p.text && !p.thought) out.output.push({ type: "text", text: p.text });
            }
            if (!out.output.some((b) => b.type === "image")) throw new Error("No image returned (safety block?)");
            out.usage = usageOf(data.usageMetadata);
          } catch (error) {
            out.stopReason = options?.signal?.aborted ? "aborted" : "error";
            out.errorMessage = error instanceof Error ? error.message : String(error);
          }
          return out;
        },
      },
    },
  });
}

function usageOf(u: any) {
  const input = u?.promptTokenCount ?? 0;
  let image = 0;
  for (const d of u?.candidatesTokensDetails ?? []) if (String(d.modality).toUpperCase() === "IMAGE") image += d.tokenCount ?? 0;
  const text = (u?.candidatesTokenCount ?? 0) - image + (u?.thoughtsTokenCount ?? 0);
  const cost = {
    input: (input * PRICE.input) / 1e6,
    output: (text * PRICE.text + image * PRICE.image) / 1e6,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
  };
  cost.total = cost.input + cost.output;
  return { input, output: text + image, cacheRead: 0, cacheWrite: 0, totalTokens: u?.totalTokenCount ?? input + text + image, cost };
}
