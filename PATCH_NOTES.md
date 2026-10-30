# Patch notes

## 0.4.0

### Three authentication methods

Use `/setup-gemini-vertexai` to choose how Claude, Gemini, and Gemini image generation authenticate with Google Cloud Vertex AI:

- **Application Default Credentials (ADC):** sign in with your Google user account through `gcloud auth application-default login`.
- **Service Account JSON key:** provide the path to your Service Account key file.
- **Service Account impersonation:** provide a target Service Account email and use a source key or user ADC credentials. The source identity must have permission to impersonate the target.

### Setup improvements

- The wizard asks for the **authentication method first**, then the **project ID** and **location**, followed by credential details and cache settings.
- Press **Enter** at the project or location prompt to keep the current value.
- Press **Escape** at the authentication, project, or location prompt to cancel without saving.
- `/setup-vertexai` remains an alias for `/setup-gemini-vertexai`.
- Added the authentication selector screenshot to the README.

### Authentication safety

- Requests use the selected authentication method. Missing or invalid credentials stop requests instead of falling back to another credential source.
- Failed impersonation does not fall back to the source Service Account or user account.
- Removed the image provider's fallback to ambient `gcloud` credentials.
- Generated impersonation credentials and saved setup files use restrictive file permissions.

### Cache settings

- Added `/vertex-cache` to view and change cache settings without repeating setup.
- Claude Haiku, Sonnet, and Opus 5.5 support `5m`, `1h`, or `off` cache retention settings.
- Gemini `3.5-flash-lite`, `3.8-flash`, and `4-argon` support configurable cache-warming intervals in seconds, or `off`. These settings do not set a server-side implicit cache lifetime.

### Verification

- Added regression tests for wizard order, keeping the current project and location, changing authentication methods, and cancellation.
- The package smoke test loads the packed npm package in Pi and checks its setup and cache commands.
