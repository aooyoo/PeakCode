# Agent Gateway Requirements

PeakCode exposes a local gateway so external coding agents can use the model
channels configured in Settings without copying upstream API keys into each
agent.

## User Flow

- A model channel is disabled by default until the user configures the required
  secret slots and at least one model id.
- Disabled channels are editable. Enabled channels lock Base URL, model list,
  and agent model mappings; the user disables a channel before editing live
  routing.
- The local gateway can be enabled only when at least one complete channel is
  enabled.
- When the user enables the first complete channel, PeakCode makes it the active
  default channel. If the active channel is disabled, PeakCode moves the default
  to another enabled complete channel.
- The Agent Setup Update action writes the current local gateway endpoint and
  model mapping into the selected agent's local config file.

## Protocol Routing

- Codex is configured as an OpenAI-compatible provider using the Responses API:
  `/gateway/openai/v1/responses`.
- Claude Code is configured with Anthropic Messages API environment variables:
  `/gateway/anthropic/v1/messages`.
- OpenAI-compatible agents are configured with the OpenAI Chat endpoint:
  `/gateway/openai/v1/chat/completions`.
- The upstream secret stays in PeakCode's secret store. Agent config files use
  the fixed local sentinel key `peakcode-managed`.

## Gateway Behavior

- `/gateway/openai/v1/models` lists every model exposed by enabled complete
  channels.
- A requested model may be prefixed as `<channel>/<model>` to select a channel
  explicitly.
- Unprefixed requests use the active enabled channel, falling back to the first
  enabled complete channel if needed.
- The gateway accepts the sentinel key only from loopback requests. Upstream
  requests still use the real secret from PeakCode storage.

## Config Writes

- Codex writes to `CODEX_HOME/config.toml` or `~/.codex/config.toml`.
- Claude Code writes to `~/.claude/settings.json`.
- OpenCode and Kilo write OpenAI-compatible provider blocks under XDG config.
- Cursor / VS Code writes `chatLanguageModels.json`.
- Pi writes `~/.pi/agent/models.json`.
- Cline writes its global state and secret files.
- Writes are atomic and create timestamped backups when a target file already
  exists.
