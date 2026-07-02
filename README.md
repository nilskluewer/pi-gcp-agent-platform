# @nilskluewer/pi-gcp-agent-platform

Connect Pi to Google Cloud Agent Platform / Vertex AI.

This package adds a small Pi extension that prepares the Node.js runtime for Google Cloud
Agent Platform / Vertex AI usage from Pi, especially for Claude and Gemini access through
Google Cloud.

## What it does

- Supports Google OAuth / STS token calls from Pi's Node.js runtime.
- Supports `eu` and `us` Vertex AI multi-region endpoints for Anthropic Vertex clients.
- Keeps the behavior narrow and transparent: only Google auth transport and Vertex
  multi-region endpoint handling are touched.

## Install

```bash
pi install npm:@nilskluewer/pi-gcp-agent-platform
```

## Configuration

The extension honors the normal Google Cloud / Vertex environment variables used by Pi and
its providers, for example:

- `GOOGLE_CLOUD_LOCATION`
- `CLOUD_ML_REGION`
- `VERTEX_REGION`
- `ANTHROPIC_VERTEX_BASE_URL`

For `eu` and `us`, it derives the correct multi-region Vertex base URL when no explicit
custom `ANTHROPIC_VERTEX_BASE_URL` is already set.

## License

MIT
