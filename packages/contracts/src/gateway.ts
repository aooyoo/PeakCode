import { Schema } from "effect";
import { TrimmedNonEmptyString, TrimmedString } from "./baseSchemas";

/**
 * Discriminator for how a gateway channel talks to its upstream.
 *
 * - `openai`: the upstream is already OpenAI-compatible; the gateway proxies
 *   the chat/completions payload verbatim (existing behavior).
 * - `mimo`: the upstream is Xiaomi MiMo's private protocol
 *   (aistudio.xiaomimimo.com/open-apis/bot/chat); the gateway translates
 *   OpenAI chat requests into MiMo's shape and converts MiMo's SSE back into
 *   OpenAI chat format.
 * - `anthropic`: the upstream speaks the Anthropic Messages API; used when
 *   Claude Code routes through the gateway.
 */
export const GatewayChannelKind = Schema.Literals(["openai", "mimo", "anthropic"]);
export type GatewayChannelKind = typeof GatewayChannelKind.Type;

export const GatewayChannelId = Schema.Literals([
  "deepseek",
  "siliconflow",
  "volcano",
  "tongyi",
  "kimi",
  "minimax",
  "mimo",
  "custom",
]);
export type GatewayChannelId = typeof GatewayChannelId.Type;

/**
 * Describes one secret slot a channel needs (e.g. an API key, or one of MiMo's
 * three cookies). The gateway reads each declared secret from the secret store
 * under `gateway.channel.<channelId>.secret.<secretDef.id>`.
 */
export const GatewayChannelSecretDef = Schema.Struct({
  id: TrimmedNonEmptyString,
  label: TrimmedNonEmptyString,
  /**
   * When true the UI renders the input as a password field and never echoes the
   * stored value back. API keys and session cookies are sensitive; opaque user
   * ids are not.
   */
  sensitive: Schema.Boolean,
});
export type GatewayChannelSecretDef = typeof GatewayChannelSecretDef.Type;

/** The single secret slot used by every OpenAI-compatible channel. */
export const DEFAULT_OPENAI_CHANNEL_SECRETS: ReadonlyArray<GatewayChannelSecretDef> = [
  { id: "apiKey", label: "API Key", sensitive: true },
];

/** The three cookie values MiMo's upstream requires. */
export const MIMO_CHANNEL_SECRETS: ReadonlyArray<GatewayChannelSecretDef> = [
  { id: "serviceToken", label: "Service Token", sensitive: true },
  { id: "userId", label: "User ID", sensitive: false },
  { id: "xiaomichatbot_ph", label: "PH Token", sensitive: true },
];

/**
 * One model exposed by a channel. A channel can declare several (e.g. a
 * DeepSeek channel offering both `deepseek-chat` and `deepseek-reasoner`).
 * The first entry is treated as the channel default.
 */
export const GatewayChannelModel = Schema.Struct({
  id: TrimmedNonEmptyString,
  label: TrimmedNonEmptyString,
});
export type GatewayChannelModel = typeof GatewayChannelModel.Type;

/**
 * Per-agent model routing for a channel. When an agent (Codex or Claude Code)
 * is wired through the gateway, it uses the mapped model id if present,
 * otherwise the channel's default model.
 */
export const GatewayAgentMappings = Schema.Struct({
  codex: Schema.optional(TrimmedNonEmptyString),
  claude: Schema.optional(TrimmedNonEmptyString),
});
export type GatewayAgentMappings = typeof GatewayAgentMappings.Type;

export const GatewayChannelConfig = Schema.Struct({
  id: GatewayChannelId,
  name: TrimmedNonEmptyString,
  baseUrl: TrimmedString,
  model: TrimmedString,
  enabled: Schema.Boolean,
  kind: GatewayChannelKind.pipe(Schema.withDecodingDefault(() => "openai" as const)),
  secrets: Schema.Array(GatewayChannelSecretDef).pipe(
    Schema.withDecodingDefault(() => [...DEFAULT_OPENAI_CHANNEL_SECRETS]),
  ),
  /**
   * Models this channel exposes. May be empty for older configs; callers fall
   * back to the `model` field via resolveChannelDefaultModel in that case.
   */
  models: Schema.Array(GatewayChannelModel).pipe(Schema.withDecodingDefault(() => [])),
  agentMappings: GatewayAgentMappings.pipe(Schema.withDecodingDefault(() => ({}))),
});
export type GatewayChannelConfig = typeof GatewayChannelConfig.Type;

export const DEFAULT_GATEWAY_CHANNELS: ReadonlyArray<GatewayChannelConfig> = [
  {
    id: "deepseek",
    name: "DeepSeek",
    baseUrl: "https://api.deepseek.com/v1",
    model: "deepseek-chat",
    enabled: false,
    kind: "openai",
    secrets: [...DEFAULT_OPENAI_CHANNEL_SECRETS],
    models: [
      { id: "deepseek-chat", label: "DeepSeek Chat" },
      { id: "deepseek-reasoner", label: "DeepSeek Reasoner (R1)" },
    ],
    agentMappings: {},
  },
  {
    id: "siliconflow",
    name: "硅基流动",
    baseUrl: "https://api.siliconflow.cn/v1",
    model: "",
    enabled: false,
    kind: "openai",
    secrets: [...DEFAULT_OPENAI_CHANNEL_SECRETS],
    models: [],
    agentMappings: {},
  },
  {
    id: "volcano",
    name: "火山方舟",
    baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    model: "",
    enabled: false,
    kind: "openai",
    secrets: [...DEFAULT_OPENAI_CHANNEL_SECRETS],
    models: [],
    agentMappings: {},
  },
  {
    id: "tongyi",
    name: "通义千问",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    model: "",
    enabled: false,
    kind: "openai",
    secrets: [...DEFAULT_OPENAI_CHANNEL_SECRETS],
    models: [],
    agentMappings: {},
  },
  {
    id: "kimi",
    name: "Kimi",
    baseUrl: "https://api.moonshot.cn/v1",
    model: "",
    enabled: false,
    kind: "openai",
    secrets: [...DEFAULT_OPENAI_CHANNEL_SECRETS],
    models: [],
    agentMappings: {},
  },
  {
    id: "minimax",
    name: "MiniMax",
    baseUrl: "https://api.minimaxi.com/v1",
    model: "",
    enabled: false,
    kind: "openai",
    secrets: [...DEFAULT_OPENAI_CHANNEL_SECRETS],
    models: [],
    agentMappings: {},
  },
  {
    id: "mimo",
    name: "小米 MiMo",
    baseUrl: "https://aistudio.xiaomimimo.com",
    model: "mimo-v2-flash-studio",
    enabled: false,
    kind: "mimo",
    secrets: [...MIMO_CHANNEL_SECRETS],
    models: [{ id: "mimo-v2-flash-studio", label: "MiMo v2 Flash Studio" }],
    agentMappings: {},
  },
];

export const GatewayConfig = Schema.Struct({
  enabled: Schema.Boolean,
  activeChannelId: GatewayChannelId,
  channels: Schema.Array(GatewayChannelConfig),
});
export type GatewayConfig = typeof GatewayConfig.Type;

export const GatewayChannelPatch = Schema.Struct({
  id: GatewayChannelId,
  name: Schema.optionalKey(TrimmedNonEmptyString),
  baseUrl: Schema.optionalKey(TrimmedString),
  model: Schema.optionalKey(TrimmedString),
  enabled: Schema.optionalKey(Schema.Boolean),
  // `models` and `agentMappings` ARE patchable (whole-array replace) so the UI
  // editor can manage a channel's model list and per-agent routing. `kind` and
  // `secrets` stay non-patchable: kind is fixed by the catalog and the secret
  // layout must not be reordered out from under stored values.
  models: Schema.optionalKey(Schema.Array(GatewayChannelModel)),
  agentMappings: Schema.optionalKey(GatewayAgentMappings),
});
export type GatewayChannelPatch = typeof GatewayChannelPatch.Type;

export const GatewayConfigPatch = Schema.Struct({
  enabled: Schema.optionalKey(Schema.Boolean),
  activeChannelId: Schema.optionalKey(GatewayChannelId),
  channels: Schema.optionalKey(Schema.Array(GatewayChannelPatch)),
});
export type GatewayConfigPatch = typeof GatewayConfigPatch.Type;

/** Identifier of a single secret slot within a channel. */
export const GatewaySecretId = TrimmedNonEmptyString;
export type GatewaySecretId = typeof GatewaySecretId.Type;

export const GatewaySetApiKeyInput = Schema.Struct({
  channelId: GatewayChannelId,
  secretId: GatewaySecretId.pipe(Schema.withDecodingDefault(() => "apiKey")),
  apiKey: TrimmedNonEmptyString,
});
export type GatewaySetApiKeyInput = typeof GatewaySetApiKeyInput.Type;

export const GatewayRemoveApiKeyInput = Schema.Struct({
  channelId: GatewayChannelId,
  secretId: GatewaySecretId.pipe(Schema.withDecodingDefault(() => "apiKey")),
});
export type GatewayRemoveApiKeyInput = typeof GatewayRemoveApiKeyInput.Type;

export const GatewaySecretStatus = Schema.Struct({
  channelId: GatewayChannelId,
  secretId: GatewaySecretId,
  hasApiKey: Schema.Boolean,
});
export type GatewaySecretStatus = typeof GatewaySecretStatus.Type;

export const GatewaySecretStatusResult = Schema.Struct({
  secrets: Schema.Array(GatewaySecretStatus),
});
export type GatewaySecretStatusResult = typeof GatewaySecretStatusResult.Type;

// ------------------------------------------------------------------
// Model resolution helpers
// ------------------------------------------------------------------
// These centralize the "models array, falling back to the legacy `model`
// field" rule so server (gateway routing, Codex/Claude injection) and web
// (UI pickers) stay consistent.

/**
 * Returns the effective list of models for a channel. Prefers the `models`
 * array; if empty (older configs), derives a single-entry list from the
 * legacy `model` field so every channel always has at least a default model.
 */
export function resolveChannelModels(channel: GatewayChannelConfig): GatewayChannelModel[] {
  if (channel.models.length > 0) return [...channel.models];
  return channel.model ? [{ id: channel.model, label: channel.model }] : [];
}

/**
 * The channel's default model id (first declared model, or the legacy `model`
 * field). Returns null when the channel exposes no model at all.
 */
export function resolveChannelDefaultModel(channel: GatewayChannelConfig): string | null {
  if (channel.models.length > 0) return channel.models[0]!.id;
  return channel.model || null;
}

export function isGatewayChannelRoutable(channel: GatewayChannelConfig): boolean {
  return (
    channel.enabled &&
    Boolean(channel.baseUrl.trim()) &&
    resolveChannelDefaultModel(channel) !== null
  );
}

export function resolveGatewayActiveChannel(config: GatewayConfig): GatewayChannelConfig | null {
  const activeChannel =
    config.channels.find((channel) => channel.id === config.activeChannelId) ?? null;
  if (activeChannel && isGatewayChannelRoutable(activeChannel)) {
    return activeChannel;
  }
  return config.channels.find(isGatewayChannelRoutable) ?? null;
}

/**
 * Resolves the model id an agent (Codex or Claude Code) should use when
 * routing through this channel. Prefers the per-agent mapping; otherwise the
 * channel default. Returns null if no model is configured.
 */
export function resolveAgentModel(
  channel: GatewayChannelConfig,
  agent: "codex" | "claude",
): string | null {
  const mapped = channel.agentMappings[agent];
  if (mapped) return mapped;
  return resolveChannelDefaultModel(channel);
}
