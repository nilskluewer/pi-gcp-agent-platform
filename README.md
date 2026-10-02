# @nilskluewer/pi-gcp-agent-platform

## Overview

Use Claude and Gemini models through Google Cloud Vertex AI / Gemini Enterprise Agent
Platform in [pi](https://github.com/earendil-works/pi).

This package contains both Vertex model adapters:

- `anthropic-vertex` uses Anthropic's `AnthropicVertex` client for Claude.
- `google-vertex` uses pi's native Google Vertex provider for Gemini.

The Google Cloud project, location, and Application Default Credentials setup are shared
by both providers.

## Getting Started

```bash
pi install npm:@nilskluewer/pi-gcp-agent-platform
pi
/setup-gemini-vertexai your-project-id eu
/model google-vertex/gemini-3.1-flash-lite
```

Select Claude in the same session with:

```text
/model anthropic-vertex/claude-opus-5
```

The legacy `/setup-vertexai` command remains available as an alias.

## Structure

```text
.
├── extensions/
│   └── gcp-agent-platform/
│       ├── index.ts       # shared setup and provider registration
│       └── anthropic.ts    # AnthropicVertex adapter for Claude
├── LICENSE
├── README.md
└── package.json
```

## Setup

Requirements:

- Google Cloud project with the Vertex AI API enabled.
- Claude and/or Gemini models enabled and available in Vertex AI / Gemini Enterprise
  Agent Platform.
- `gcloud` installed for Google Application Default Credentials.

Run the setup command in pi:

```text
/setup-gemini-vertexai <google-cloud-project> [location]
```

Examples:

```text
/setup-gemini-vertexai my-project-id eu
/setup-gemini-vertexai my-project-id global
```

The command stores the shared project and location in:

```text
~/.pi/agent/gcp-agent-platform.json
```

It also checks Google Application Default Credentials and can start:

```bash
gcloud auth application-default login
```

Environment variables override the saved setup:

| Name | Description | Default |
|------|-------------|---------|
| `GOOGLE_CLOUD_PROJECT` | Google Cloud project ID. | Saved setup value |
| `ANTHROPIC_VERTEX_PROJECT_ID` | Claude-compatible project ID fallback. | Optional |
| `GCLOUD_PROJECT` | Google Cloud project ID fallback. | Optional |
| `GOOGLE_CLOUD_LOCATION` | Vertex region or multi-region. | Saved setup value or `eu` |
| `CLOUD_ML_REGION` | Region fallback. | Optional |
| `VERTEX_REGION` | Additional region fallback. | Optional |

The package reads the former Anthropic Vertex setup file as a migration fallback, but
new configuration is written only to `gcp-agent-platform.json`.

## Endpoints and model availability

| Location | Endpoint |
|----------|----------|
| `global` | `https://aiplatform.googleapis.com` |
| `eu` | EU multi-region Vertex endpoint |
| `us` | US multi-region Vertex endpoint |
| other regions | Regional Vertex endpoint |

Model availability depends on the selected location and the Google Cloud project. For
example, some Gemini models available on `global` are not available in `eu`.

## Models

Use any Claude model exposed by pi's Anthropic catalog and available in the project:

```text
/model anthropic-vertex/claude-opus-5
/model anthropic-vertex/claude-sonnet-5
/model anthropic-vertex/claude-opus-4-8
```

Use any Gemini model exposed by pi's Google Vertex catalog and available in the project:

```text
/model google-vertex/gemini-3.1-flash-lite
/model google-vertex/gemini-3.5-flash
```

### Image model

`google-vertex-images/gemini-3.1-flash-image` (Nano Banana 2) is registered as a pi image
model. Image models are not in `/model`; scripts reach them through the `codemode` tool
(`defaultTools: ["+codemode"]`). `eu` and `global` serve it; usage counts toward session cost.
Codemode passes no options, so put settings in the prompt: `@aspect=16:9 @size=2K`
(sizes `512`, `1K`, `2K`, `4K`). Images are not saved; the script must write them to disk.

```js
const m = await models.getModelOfType("image", "google-vertex-images", "gemini-3.1-flash-image");
const r = await models.generateImages(m, { input: [{ type: "text", text: "@aspect=16:9 A red fox" }] });
for (const b of r.output) if (b.type === "image") image(b);
```

Vertex AI does not support Anthropic's server-side `fallbacks` request parameter. The
Claude adapter removes that Anthropic-only model metadata before sending requests.

## Run without installing

```bash
pi -e npm:@nilskluewer/pi-gcp-agent-platform
```

## Migration from the standalone packages

Use this package as the single canonical Vertex package. The former standalone
Anthropic package is no longer needed in pi settings.

```bash
pi remove /path/to/pi-anthropic-vertex-enterprise-agent-platform
pi install npm:@nilskluewer/pi-gcp-agent-platform
```

`pi-vertex-gemini-search` is a separate optional web-search extension and is not part of
this model package.

## License

MIT
