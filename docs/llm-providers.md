# Skippy provider settings

This guide describes the current source UI and adapter configuration. It does
not establish live provider availability, real Keychain operation, current
model support or release clearance. See [credential hygiene](credential-hygiene.md)
and the development records for their separate acceptance limits.

## Enter a key through Settings

1. Open **Provider settings** using the gear in the Skippy header.
2. Choose the provider row. **Key saved**, **No key saved** and **No key needed**
   describe the row's saved-key configuration, not a tested connection.
3. Enter your own key in the password field and choose **Save**. The visibility
   button reveals only the text you entered.
4. Leave the API-key field empty to retain an existing saved key. Use
   **Forget key** to request removal of that saved credential.
5. Read the row's progress or full error message. Saving updates settings; it
   does not perform a connection test.

The Settings status response does not include a saved key or its suffix. Its mask
is a fixed placeholder. Entered text is cleared after a successful save; the
source code does not refill it from the stored credential.

Use the Settings input for entry. Keep actual credentials out of terminal
commands, scripts, project configuration, chat messages and bug reports.

## Source provider catalog

The following flags and endpoints come from
[providers.js](../companion-app/electron/llm/providers.js). They describe this
adapter implementation, not the capabilities or availability of an external
provider's current products.

| Provider ID | Row | API-key field required | Source default endpoint | Tool flag |
| --- | --- | --- | --- | --- |
| `anthropic` | Anthropic Claude | Yes | SDK default | Enabled |
| `openai` | OpenAI | Yes | `https://api.openai.com/v1` | Disabled |
| `google` | Google Gemini | Yes | SDK default | Disabled |
| `openrouter` | OpenRouter | Yes | `https://openrouter.ai/api/v1` | Disabled |
| `xai` | xAI Grok | Yes | `https://api.x.ai/v1` | Disabled |
| `lmstudio` | LM Studio | No | `http://localhost:1234/v1` | Disabled |
| `ollama` | Ollama | No | `http://localhost:11434` | Disabled |

The dispatcher uses IDs shaped as `providerId/apiModelId`; routed model IDs can
contain further slashes. Model choices are curated in the
[provider catalog](../companion-app/electron/llm/providers.js) and
[renderer constants](../companion-app/src/constants.ts). A displayed name does
not verify that a server accepts that model ID.

The editor selects the catalog entry from its saved configuration, including
after host configuration arrives. If a saved ID is absent from this build's
catalog, the picker shows **Choose a model**. Sending and automatic compaction
stay blocked until you choose an entry; the draft is retained. The editor does
not silently substitute a default provider for an unknown saved choice.

The source catalog currently enables tool dispatch for the Anthropic adapter.
Tool authority, operation approval, actual execution and provider acceptance
still require their own checks.

## Endpoints and local backends

Settings can store a custom base URL where the row exposes an endpoint field.
Endpoint settings are plaintext. Authentication belongs in the API-key field:
user information, query strings and fragments are rejected by the current
validator, and secrets must not be placed in URL paths.

For a local backend, configure a server and model separately under the relevant
operator's authority, then align the endpoint and model ID. Saving a URL does
not start a server, install a model, discover available models or confirm a
connection. Subsequent chat, compaction or tool requests can contact the
configured backend.

## Storage implementation and audit boundary

The main-process [credential module](../companion-app/electron/keychain.js) uses
macOS Keychain through keytar, with service `com.vapoursynth.resolveofx` and a
provider account name. Endpoint overrides use
`~/Library/Application Support/VapourSynth-OFX/endpoints.json`.

The source does not import API keys from legacy plaintext files or inherited
API-key environment variables. It also does not migrate or delete those legacy
files. The UI's **Forget key** action targets the selected Keychain entry; it
is not a cleanup operation for every historical copy of a credential.

These are implementation contracts. Mocked tests, saved-key status and a clean
pattern scan do not establish live storage behavior or prove the absence of
every private credential. A public release still needs the exact candidate,
history and packaged artifacts checked under the
[release gates](notices-index.md).
