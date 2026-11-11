# pi-model-discoverer

A Pi extension that discovers and refreshes model catalogs using authentication already configured for a provider — a `/login` credential or a `models.json` `apiKey`. Targets **Earendil Pi 1.5.2+** and its native provider APIs; older Mario Zechner Pi releases are not supported.

## Install

Install from npm (requires Earendil Pi 1.5.2+):

```sh
pi install npm:pi-model-discoverer
```

Restart Pi or run `/reload`. For a one-off trial, use `pi -e npm:pi-model-discoverer`.
For local development, run `pi install .` from this directory.

```text
/discover-models
/configure-model
/model
```

`/discover-models [provider-id]` refreshes all authenticated providers that support discovery, or one exact provider ID. It does not select a model or change your default. Discovery also runs on session start (without forcing a network fetch when Pi already refreshed). After a new `/login`, run `/discover-models`; the extension does not intercept Pi's login command.

`/configure-model [provider-id]` interactively edits per-model capability overrides for discovered models: reasoning on/off, `contextWindow`, and `maxTokens`. Values are written to `modelOverrides` in `models.json` (a one-time backup is saved as `models.json.bak`; rewriting drops comments/formatting in that file). Run `/reload` afterwards to apply. Overrides are Pi's topmost layer, so they survive every catalog refresh. To choose a reasoning effort at runtime, use Pi's built-in `/thinking` (or `Shift+Tab`) once the model is marked `reasoning: true`.

## Built-in providers

No configuration is needed. The extension delegates to Pi's **native refresh pipeline**, which handles stored API keys, OAuth renewal, provider-specific endpoints, filtering, and catalog persistence. It never reads `auth.json` directly and does not replace built-in providers.

A refreshed catalog is **not proof of account entitlement**. Some native providers refresh metadata from Pi's public catalog rather than querying an account-specific endpoint; others keep a static list. Providers without a refresh implementation are reported as unsupported for native discovery and retain their existing models. Actual availability remains subject to Pi's provider policy and the upstream service.

This extension does not invent `/models` endpoints for subscription OAuth providers or send subscription tokens to generic API endpoints.

## Discovering a custom provider (models.json)

Opt a provider into discovery with the custom key **`discoverModels: true`** in its `~/.pi/agent/models.json` entry:

```json
{
  "providers": {
    "mws": {
      "baseUrl": "https://gpt.example.com/projects/abc/openai/v1",
      "api": "openai-completions",
      "apiKey": "$MWS_API_KEY",
      "discoverModels": true
    }
  }
}
```

Pi itself ignores `discoverModels`; this extension reads `models.json` at startup and registers a discovery hook for each opted-in provider. Credentials stay with Pi: the provider's `apiKey` (literal, `$ENV_VAR`, or `${ENV_VAR}`) or a key stored via `/login <provider>` is resolved by Pi's auth layer and passed to the hook. If both exist, the stored `/login` credential wins. Never put discovery-only keys anywhere else.

Reload with `/reload` after editing `models.json`, then run `/discover-models mws` and pick a model with `/model`.

### Provider fields

- `discoverModels`: `true` opts the provider into discovery. This is the extension's custom key.
- `baseUrl`: API base URL (required). HTTPS only, except HTTP on `localhost`, `127.0.0.1`, or `[::1]`.
- `api`: `openai-completions`, `openai-responses`, or `anthropic-messages` (required for discovery).
- `modelsUrl`: optional complete catalog URL; defaults to `{baseUrl}/models`. Must share `baseUrl`'s origin. URL credentials, query strings, and fragments are rejected.
- `modelApis`: optional per-model API overrides, e.g. `{ "model-a": "openai-responses" }`. Unmatched models use the provider `api`.
- `apiKey`, `headers`, `models`, `modelOverrides`, `compat`: ordinary Pi `models.json` fields, applied as usual. Handwritten `models` remain as offline fallback when discovery fails.

Only configure trusted origins: discovery necessarily sends the resolved API key to the configured endpoint. Redirects are blocked. If `models.json` changes the effective `baseUrl` origin after models were discovered, discovery refuses rather than sending the credential to the new origin.

### Catalog format

Custom endpoints must return a JSON object with `data: [{ "id": "chat-model" }]`. OpenAI-protocol providers use Bearer authentication; Anthropic uses `x-api-key` plus `anthropic-version` and supports `has_more` / `last_id` pagination. Other pagination schemes fail rather than silently installing an incomplete catalog.

Optional model metadata: `name` or `display_name`, `context_window` or `context_length`, `max_tokens` or `max_output_tokens`, boolean `reasoning`, and `input: ["text", "image"]`. Absent capabilities default to text-only, no reasoning, 128000 context / 16384 output tokens. Costs are zero placeholders (unknown, **not necessarily free**). Explicit non-chat `type` entries are excluded; an untyped `/models` response is assumed to contain chat models.

Requests are bounded to 4 MiB per page, 20 pages, and 10000 models. Duplicate IDs are collapsed. Invalid responses fail without replacing the previous catalog. An explicitly empty successful list clears the discovered catalog.

Discovered catalogs are **persisted through Pi's model store**, so they are available offline on the next start and restored before any network fetch. A failed refresh retains the previous catalog. No credentials, headers, or complete upstream responses are logged or stored by this extension.

## Development

```sh
npm install --ignore-scripts
npm test
npm run typecheck
```

Tests use mocked HTTP and temporary config directories; they do not access your saved credentials or make real authenticated provider requests.

## Publishing

```sh
npm login
npm publish --access public
```

Publishing runs tests and type checking automatically. To inspect the files that will be uploaded, run `npm pack --dry-run`. For subsequent releases, bump the version before publishing; npm does not allow overwriting a published version.

To remove the npm-installed extension, run `pi remove npm:pi-model-discoverer` (for local installs, use the source shown by `pi list`) and reload. `models.json` entries and `/login` credentials are left untouched; delete any `discoverModels` keys you no longer want honored.
