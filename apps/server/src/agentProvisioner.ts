// FILE: agentProvisioner.ts
// Purpose: Writes the PeakCode gateway configuration into local AI coding-agent
//          config files, so agents launched manually by the user (outside of
// PeakCode's process) still route through the gateway.
// Layer: Server provisioning (filesystem IO)
//
// Modeled on composer-api's AgentProvisioner.swift. Every agent is pointed at
// the local gateway — Codex and Claude Code via protocol conversion, OpenAI-
// compatible agents (OpenCode/Kilo/Cursor/pi/Cline) via the gateway's OpenAI
// Chat passthrough. The real upstream secret lives in the gateway; each agent
// receives a fixed sentinel key ("peakcode-managed").
//
// Writes are atomic (temp file + rename) and preceded by a timestamped backup.

import { Effect } from "effect";
import { FileSystem, Path } from "effect";
import { homedir } from "node:os";

import {
  resolveAgentModel,
  resolveGatewayActiveChannel,
  type GatewayChannelConfig,
  type GatewayConfig,
} from "@peakcode/contracts";
import { resolveBaseCodexHomePath } from "./codexHomePaths";
import { PEAKCODE_GATEWAY_CLIENT_API_KEY } from "./gateway";

/** Sentinel API key written to every agent config. The gateway authenticates upstream itself. */
export const PEAKCODE_AGENT_SENTINEL_KEY = PEAKCODE_GATEWAY_CLIENT_API_KEY;

/** Provider id used inside agent config files to identify the gateway. */
export const PEAKCODE_AGENT_PROVIDER_ID = "peakcode-gateway";

export type AgentProvisionId =
  | "codex"
  | "claude"
  | "opencode"
  | "kilo"
  | "cursor"
  | "pi"
  | "cline";

export interface AgentProvisionStatus {
  readonly id: AgentProvisionId;
  /** Display name shown in the UI. */
  readonly name: string;
  /** Target config file path (best-effort; empty when undeterminable). */
  readonly configPath: string;
  /** True when the gateway config is present and current. */
  readonly installed: boolean;
  /** Human-readable detail (e.g. "Not configured", "Installed → ~/.codex"). */
  readonly detail: string;
}

export interface AgentProvisionContext {
  readonly gateway: GatewayConfig;
  readonly port: number;
  readonly env?: NodeJS.ProcessEnv;
}

// ------------------------------------------------------------------
// Shared path helpers
// ------------------------------------------------------------------

function homeDir(env: NodeJS.ProcessEnv | undefined): string {
  return env?.HOME?.trim() || homedir();
}

/** $XDG_CONFIG_HOME if absolute & non-empty, else ~/.config. */
function configHome(env: NodeJS.ProcessEnv | undefined): string {
  const xdg = env?.XDG_CONFIG_HOME?.trim();
  if (xdg && xdg.startsWith("/")) return xdg;
  return `${homeDir(env)}/.config`;
}

/** Gateway OpenAI Chat endpoint (Codex / OpenAI-compatible agents). */
function gatewayOpenAiBaseUrl(port: number): string {
  return `http://127.0.0.1:${port}/gateway/openai/v1`;
}

/** Gateway Anthropic Messages endpoint (Claude Code). */
function gatewayAnthropicBaseUrl(port: number): string {
  return `http://127.0.0.1:${port}/gateway/anthropic/v1`;
}

/** Active channel resolved for an agent (mapped model or channel default). */
function activeChannel(gateway: GatewayConfig): GatewayChannelConfig | undefined {
  return resolveGatewayActiveChannel(gateway) ?? undefined;
}

// ------------------------------------------------------------------
// Filesystem primitives (atomic write + backup)
// ------------------------------------------------------------------

function backupFile(filePath: string): Effect.Effect<void, never, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const exists = yield* fs.exists(filePath).pipe(Effect.orElseSucceed(() => false));
    if (!exists) return;
    const stamp = Date.now();
    const backupPath = `${filePath}.peakcode-backup.${stamp}`;
    // A failed backup must not block the install — the original is still
    // recoverable from the new write.
    yield* fs.copyFile(filePath, backupPath).pipe(Effect.orElseSucceed(() => undefined));
  });
}

/**
 * Reads a JSON config file. Returns the parsed object, or `defaultValue` when
 * the file is missing OR contains unparseable JSON (so a corrupt config never
 * blocks a fresh install). Strips JSONC line comments first.
 */
function readJsonObject<T extends Record<string, unknown>>(
  filePath: string,
  defaultValue: T,
): Effect.Effect<T, never, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const text = yield* fs.readFileString(filePath).pipe(Effect.orElseSucceed(() => ""));
    if (!text) return defaultValue;
    const stripped = stripJsonComments(text);
    try {
      const parsed = JSON.parse(stripped) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return { ...defaultValue, ...(parsed as Record<string, unknown>) } as T;
      }
      return defaultValue;
    } catch {
      return defaultValue;
    }
  });
}

function readJsonArray<T extends Record<string, unknown>>(
  filePath: string,
  defaultValue: T[],
): Effect.Effect<T[], never, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const text = yield* fs.readFileString(filePath).pipe(Effect.orElseSucceed(() => ""));
    if (!text) return defaultValue;
    const stripped = stripJsonComments(text);
    try {
      const parsed = JSON.parse(stripped) as unknown;
      if (Array.isArray(parsed)) return parsed as T[];
      return defaultValue;
    } catch {
      return defaultValue;
    }
  });
}

/** Minimal JSONC comment stripper (// line + /* block *\/). */
function stripJsonComments(text: string): string {
  let out = "";
  let i = 0;
  let inString = false;
  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];
    if (inString) {
      out += ch;
      if (ch === "\\" && next !== undefined) {
        out += next;
        i += 2;
        continue;
      }
      if (ch === '"') inString = false;
      i += 1;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      i += 1;
      continue;
    }
    if (ch === "/" && next === "/") {
      // line comment
      while (i < text.length && text[i] !== "\n") i += 1;
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i += 1;
      i += 2;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

function writeJsonFile(
  filePath: string,
  value: unknown,
): Effect.Effect<void, AgentProvisionError, FileSystem.FileSystem | Path.Path> {
  return Effect.gen(function* () {
    const path = yield* Path.Path;
    const contents = `${JSON.stringify(value, null, 2)}\n`;
    const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    const fs = yield* FileSystem.FileSystem;
    const toErr = () => provisionError("codex", `Failed to write ${filePath}`); // tag overwritten by caller context
    yield* fs.makeDirectory(path.dirname(filePath), { recursive: true }).pipe(Effect.mapError(toErr));
    yield* fs.writeFileString(tempPath, contents).pipe(Effect.mapError(toErr));
    yield* fs.rename(tempPath, filePath).pipe(Effect.mapError(toErr));
  });
}

// ------------------------------------------------------------------
// Errors
// ------------------------------------------------------------------

export type AgentProvisionError = {
  readonly _tag: "AgentProvisionError";
  readonly agent: AgentProvisionId;
  readonly message: string;
};

function provisionError(agent: AgentProvisionId, message: string): AgentProvisionError {
  return { _tag: "AgentProvisionError", agent, message };
}

// ------------------------------------------------------------------
// Status helpers (shared)
// ------------------------------------------------------------------

function fileExists(filePath: string): Effect.Effect<boolean, never, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return yield* fs.exists(filePath).pipe(Effect.orElseSucceed(() => false));
  });
}

// ==================================================================
// CODEX
// ==================================================================

function codexConfigPath(env: NodeJS.ProcessEnv | undefined): string {
  return `${resolveBaseCodexHomePath(env ?? {})}/config.toml`;
}

function readCodexConfig(filePath: string): Effect.Effect<string, never, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return yield* fs.readFileString(filePath).pipe(Effect.orElseSucceed(() => ""));
  });
}

function writeCodexConfig(
  filePath: string,
  contents: string,
): Effect.Effect<void, AgentProvisionError, FileSystem.FileSystem | Path.Path> {
  return Effect.gen(function* () {
    const path = yield* Path.Path;
    const fs = yield* FileSystem.FileSystem;
    const toErr = () => provisionError("codex", `Failed to write ${filePath}`);
    yield* fs.makeDirectory(path.dirname(filePath), { recursive: true }).pipe(Effect.mapError(toErr));
    const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    yield* fs.writeFileString(tempPath, contents).pipe(Effect.mapError(toErr));
    yield* fs.rename(tempPath, filePath).pipe(Effect.mapError(toErr));
  });
}

/**
 * Codex install. Reuses the TOML injection logic from codexProcessEnv (which is
 * already unit-tested) but writes to the REAL ~/.codex/config.toml rather than
 * an overlay. The injected model is the active channel's Codex mapping.
 */
export function installCodex(ctx: AgentProvisionContext): Effect.Effect<void, AgentProvisionError, FileSystem.FileSystem | Path.Path> {
  return Effect.gen(function* () {
    const filePath = codexConfigPath(ctx.env);
    const existing = yield* readCodexConfig(filePath);
    // Lazy-import the injector to avoid a static cycle (codexProcessEnv pulls
    // in process-env concerns we don't need here).
    const { injectGatewayProviderIntoCodexConfig } = yield* Effect.promise(() =>
      import("./codexProcessEnv.ts"),
    );
    const next = injectGatewayProviderIntoCodexConfig(existing, {
      gateway: ctx.gateway,
      port: ctx.port,
      authMode: "command",
    });
    yield* backupFile(filePath);
    yield* writeCodexConfig(filePath, next);
  });
}

export function codexStatus(ctx: AgentProvisionContext): Effect.Effect<AgentProvisionStatus, never, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const filePath = codexConfigPath(ctx.env);
    const text = yield* readCodexConfig(filePath);
    const installed = text.includes('model_provider = "peakcode-gateway"');
    return {
      id: "codex",
      name: "Codex",
      configPath: filePath,
      installed,
      detail: installed ? `Installed → ${filePath}` : "Not configured",
    };
  });
}

// ==================================================================
// CLAUDE CODE
// ==================================================================

function claudeSettingsPath(env: NodeJS.ProcessEnv | undefined): string {
  return `${homeDir(env)}/.claude/settings.json`;
}

interface ClaudeSettings {
  readonly env?: Record<string, string>;
  [key: string]: unknown;
}

export function installClaude(ctx: AgentProvisionContext): Effect.Effect<void, AgentProvisionError, FileSystem.FileSystem | Path.Path> {
  return Effect.gen(function* () {
    const filePath = claudeSettingsPath(ctx.env);
    const baseUrl = gatewayAnthropicBaseUrl(ctx.port);
    const existing = yield* readJsonObject<ClaudeSettings>(filePath, {});
    const merged: Record<string, unknown> = { ...existing };
    const envBlock: Record<string, string> = {
      ...(existing.env ?? {}),
      ANTHROPIC_BASE_URL: baseUrl,
      ANTHROPIC_API_KEY: PEAKCODE_AGENT_SENTINEL_KEY,
      ANTHROPIC_AUTH_TOKEN: PEAKCODE_AGENT_SENTINEL_KEY,
    };
    merged.env = envBlock;
    yield* backupFile(filePath);
    yield* writeJsonFile(filePath, merged);
  });
}

export function claudeStatus(ctx: AgentProvisionContext): Effect.Effect<AgentProvisionStatus, never, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const filePath = claudeSettingsPath(ctx.env);
    const settings = yield* readJsonObject<ClaudeSettings>(filePath, {});
    const baseUrl = settings.env?.ANTHROPIC_BASE_URL ?? "";
    const installed =
      (baseUrl.includes("127.0.0.1") || baseUrl.includes("localhost")) &&
      baseUrl.includes(String(ctx.port));
    return {
      id: "claude",
      name: "Claude Code",
      configPath: filePath,
      installed,
      detail: installed ? `Installed → ${filePath}` : "Not configured",
    };
  });
}

// ==================================================================
// OPENCODE
// ==================================================================

function openCodeConfigPath(env: NodeJS.ProcessEnv | undefined): string {
  return `${configHome(env)}/opencode/opencode.json`;
}

interface OpenCodeModelDef {
  readonly name: string;
  readonly cost: { input: number; output: number };
  readonly limit: { context: number; output: number };
}

function channelModelsForOpenAi(channel: GatewayChannelConfig | undefined): Record<string, OpenCodeModelDef> {
  if (!channel) return {};
  const models = channel.models.length > 0 ? channel.models : [];
  const defs: Record<string, OpenCodeModelDef> = {};
  for (const m of models) {
    defs[m.id] = {
      name: m.label,
      cost: { input: 0, output: 0 },
      limit: { context: 200_000, output: 65_536 },
    };
  }
  return defs;
}

export function installOpenCode(ctx: AgentProvisionContext): Effect.Effect<void, AgentProvisionError, FileSystem.FileSystem | Path.Path> {
  return Effect.gen(function* () {
    const filePath = openCodeConfigPath(ctx.env);
    const existing = yield* readJsonObject<Record<string, unknown>>(filePath, {});
    const provider = (existing.provider as Record<string, unknown> | undefined) ?? {};
    const channel = activeChannel(ctx.gateway);
    provider[PEAKCODE_AGENT_PROVIDER_ID] = {
      npm: "@ai-sdk/openai-compatible",
      name: "PeakCode Gateway",
      options: {
        baseURL: gatewayOpenAiBaseUrl(ctx.port),
        apiKey: PEAKCODE_AGENT_SENTINEL_KEY,
      },
      models: channelModelsForOpenAi(channel),
    };
    const merged: Record<string, unknown> = { ...existing, provider };
    yield* backupFile(filePath);
    yield* writeJsonFile(filePath, merged);
  });
}

export function openCodeStatus(ctx: AgentProvisionContext): Effect.Effect<AgentProvisionStatus, never, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const filePath = openCodeConfigPath(ctx.env);
    const existing = yield* readJsonObject<Record<string, unknown>>(filePath, {});
    const provider = existing.provider as Record<string, unknown> | undefined;
    const entry = provider?.[PEAKCODE_AGENT_PROVIDER_ID] as
      | { options?: { baseURL?: string } }
      | undefined;
    const baseUrl = entry?.options?.baseURL ?? "";
    const installed = baseUrl.includes(String(ctx.port));
    return {
      id: "opencode",
      name: "OpenCode",
      configPath: filePath,
      installed,
      detail: installed ? `Installed → ${filePath}` : "Not configured",
    };
  });
}

// ==================================================================
// KILO CODE
// ==================================================================

function kiloConfigPath(env: NodeJS.ProcessEnv | undefined): string {
  return `${configHome(env)}/kilo/kilo.jsonc`;
}

export function installKilo(ctx: AgentProvisionContext): Effect.Effect<void, AgentProvisionError, FileSystem.FileSystem | Path.Path> {
  return Effect.gen(function* () {
    const filePath = kiloConfigPath(ctx.env);
    const existing = yield* readJsonObject<Record<string, unknown>>(filePath, {
      $schema: "https://app.kilo.ai/config.json",
    });
    const provider = (existing.provider as Record<string, unknown> | undefined) ?? {};
    const channel = activeChannel(ctx.gateway);
    provider[PEAKCODE_AGENT_PROVIDER_ID] = {
      options: {
        baseURL: gatewayOpenAiBaseUrl(ctx.port),
        apiKey: PEAKCODE_AGENT_SENTINEL_KEY,
      },
      models: channelModelsForOpenAi(channel),
    };
    const merged: Record<string, unknown> = { ...existing, provider };
    yield* backupFile(filePath);
    yield* writeJsonFile(filePath, merged);
  });
}

export function kiloStatus(ctx: AgentProvisionContext): Effect.Effect<AgentProvisionStatus, never, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const filePath = kiloConfigPath(ctx.env);
    const existing = yield* readJsonObject<Record<string, unknown>>(filePath, {});
    const provider = existing.provider as Record<string, unknown> | undefined;
    const entry = provider?.[PEAKCODE_AGENT_PROVIDER_ID] as
      | { options?: { baseURL?: string } }
      | undefined;
    const baseUrl = entry?.options?.baseURL ?? "";
    const installed = baseUrl.includes(String(ctx.port));
    return {
      id: "kilo",
      name: "Kilo Code",
      configPath: filePath,
      installed,
      detail: installed ? `Installed → ${filePath}` : "Not configured",
    };
  });
}

// ==================================================================
// CURSOR / VS Code (chatLanguageModels.json)
// ==================================================================

const VS_CODE_PROFILES = ["Code", "Code - Insiders", "VSCodium", "Cursor", "Windsurf"] as const;

function vsCodeChatModelsPath(profile: string, env: NodeJS.ProcessEnv | undefined): string {
  return `${homeDir(env)}/Library/Application Support/${profile}/User/chatLanguageModels.json`;
}

/** Picks the first VS Code-family profile whose config file already exists. */
function selectedVsCodeProfile(env: NodeJS.ProcessEnv | undefined): Effect.Effect<string, never, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    for (const profile of VS_CODE_PROFILES) {
      const exists = yield* fileExists(vsCodeChatModelsPath(profile, env));
      if (exists) return profile;
    }
    return VS_CODE_PROFILES[0];
  });
}

export function installCursor(ctx: AgentProvisionContext): Effect.Effect<void, AgentProvisionError, FileSystem.FileSystem | Path.Path> {
  return Effect.gen(function* () {
    const profile = yield* selectedVsCodeProfile(ctx.env);
    const filePath = vsCodeChatModelsPath(profile, ctx.env);
    const existing = yield* readJsonArray<Record<string, unknown>>(filePath, []);
    const filtered = existing.filter((item) => {
      const name = typeof item.name === "string" ? item.name : "";
      return name !== PEAKCODE_AGENT_PROVIDER_ID && name !== "PeakCode Gateway";
    });
    const channel = activeChannel(ctx.gateway);
    const modelIds = (channel?.models ?? []).map((m) => m.id);
    filtered.push({
      name: "PeakCode Gateway",
      provider: "openai-compatible",
      baseUrl: gatewayOpenAiBaseUrl(ctx.port),
      models: modelIds.length > 0 ? modelIds : ["peakcode-model"],
    });
    yield* backupFile(filePath);
    yield* writeJsonFile(filePath, filtered);
  });
}

export function cursorStatus(ctx: AgentProvisionContext): Effect.Effect<AgentProvisionStatus, never, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const profile = yield* selectedVsCodeProfile(ctx.env);
    const filePath = vsCodeChatModelsPath(profile, ctx.env);
    const existing = yield* readJsonArray<Record<string, unknown>>(filePath, []);
    const match = existing.find((item) => {
      const baseUrl = typeof item.baseUrl === "string" ? item.baseUrl : "";
      return baseUrl.includes(String(ctx.port));
    });
    return {
      id: "cursor",
      name: "Cursor / VS Code",
      configPath: filePath,
      installed: Boolean(match),
      detail: match ? `Installed → ${filePath}` : "Not configured",
    };
  });
}

// ==================================================================
// PI
// ==================================================================

function piConfigPath(env: NodeJS.ProcessEnv | undefined): string {
  return `${homeDir(env)}/.pi/agent/models.json`;
}

export function installPi(ctx: AgentProvisionContext): Effect.Effect<void, AgentProvisionError, FileSystem.FileSystem | Path.Path> {
  return Effect.gen(function* () {
    const filePath = piConfigPath(ctx.env);
    const existing = yield* readJsonObject<Record<string, unknown>>(filePath, {});
    const providers = (existing.providers as Record<string, unknown> | undefined) ?? {};
    const channel = activeChannel(ctx.gateway);
    const models = (channel?.models ?? []).map((m) => ({
      id: m.id,
      name: m.label,
      api: "openai-completions",
      reasoning: false,
      input: ["text"],
      contextWindow: 200_000,
      maxTokens: 65_536,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      limit: { context: 200_000, output: 65_536 },
      compat: {
        supportsUsageInStreaming: true,
        maxTokensField: "max_tokens",
        requiresAssistantAfterToolResult: false,
      },
    }));
    providers[PEAKCODE_AGENT_PROVIDER_ID] = {
      baseUrl: gatewayOpenAiBaseUrl(ctx.port),
      apiKey: PEAKCODE_AGENT_SENTINEL_KEY,
      authHeader: true,
      api: "openai-completions",
      models,
    };
    const merged: Record<string, unknown> = { ...existing, providers };
    yield* backupFile(filePath);
    yield* writeJsonFile(filePath, merged);
  });
}

export function piStatus(ctx: AgentProvisionContext): Effect.Effect<AgentProvisionStatus, never, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const filePath = piConfigPath(ctx.env);
    const existing = yield* readJsonObject<Record<string, unknown>>(filePath, {});
    const providers = existing.providers as Record<string, unknown> | undefined;
    const entry = providers?.[PEAKCODE_AGENT_PROVIDER_ID] as
      | { baseUrl?: string }
      | undefined;
    const baseUrl = entry?.baseUrl ?? "";
    const installed = baseUrl.includes(String(ctx.port));
    return {
      id: "pi",
      name: "pi",
      configPath: filePath,
      installed,
      detail: installed ? `Installed → ${filePath}` : "Not configured",
    };
  });
}

// ==================================================================
// CLINE
// ==================================================================

function clineGlobalStatePath(env: NodeJS.ProcessEnv | undefined): string {
  return `${homeDir(env)}/.cline/data/globalState.json`;
}

function clineSecretsPath(env: NodeJS.ProcessEnv | undefined): string {
  return `${homeDir(env)}/.cline/data/secrets.json`;
}

export function installCline(ctx: AgentProvisionContext): Effect.Effect<void, AgentProvisionError, FileSystem.FileSystem | Path.Path> {
  return Effect.gen(function* () {
    const channel = activeChannel(ctx.gateway);
    const modelId =
      (channel ? resolveAgentModel(channel, "codex") : null) ?? "peakcode-model";
    const globalStatePath = clineGlobalStatePath(ctx.env);
    const secretsPath = clineSecretsPath(ctx.env);

    const globalState = yield* readJsonObject<Record<string, unknown>>(globalStatePath, {});
    globalState.actModeApiProvider = "openai";
    globalState.planModeApiProvider = "openai";
    globalState.actModeOpenAiModelId = modelId;
    globalState.planModeOpenAiModelId = modelId;
    globalState.actModeOpenAiModelInfo = {
      maxTokens: 65_536,
      contextWindow: 200_000,
      supportsImages: true,
      supportsPromptCache: false,
      inputPrice: 0,
      outputPrice: 0,
      temperature: 0,
      supportsTools: true,
      supportsStreaming: true,
      systemRole: "system",
    };
    globalState.planModeOpenAiModelInfo = globalState.actModeOpenAiModelInfo;
    globalState.openAiHeaders = {};
    globalState.openAiBaseUrl = gatewayOpenAiBaseUrl(ctx.port);
    globalState.welcomeViewCompleted = true;

    const secrets = yield* readJsonObject<Record<string, unknown>>(secretsPath, {});
    secrets.openAiApiKey = PEAKCODE_AGENT_SENTINEL_KEY;

    yield* backupFile(globalStatePath);
    yield* writeJsonFile(globalStatePath, globalState);
    yield* backupFile(secretsPath);
    yield* writeJsonFile(secretsPath, secrets);
  });
}

export function clineStatus(ctx: AgentProvisionContext): Effect.Effect<AgentProvisionStatus, never, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const filePath = clineGlobalStatePath(ctx.env);
    const existing = yield* readJsonObject<Record<string, unknown>>(filePath, {});
    const baseUrl = typeof existing.openAiBaseUrl === "string" ? existing.openAiBaseUrl : "";
    const installed =
      existing.actModeApiProvider === "openai" && baseUrl.includes(String(ctx.port));
    return {
      id: "cline",
      name: "Cline",
      configPath: filePath,
      installed,
      detail: installed ? `Installed → ${filePath}` : "Not configured",
    };
  });
}

// ==================================================================
// Dispatcher
// ==================================================================

const INSTALLERS: Record<
  AgentProvisionId,
  (ctx: AgentProvisionContext) => Effect.Effect<void, AgentProvisionError, FileSystem.FileSystem | Path.Path>
> = {
  codex: installCodex,
  claude: installClaude,
  opencode: installOpenCode,
  kilo: installKilo,
  cursor: installCursor,
  pi: installPi,
  cline: installCline,
};

const STATUS_CHECKS: Record<
  AgentProvisionId,
  (ctx: AgentProvisionContext) => Effect.Effect<AgentProvisionStatus, never, FileSystem.FileSystem>
> = {
  codex: codexStatus,
  claude: claudeStatus,
  opencode: openCodeStatus,
  kilo: kiloStatus,
  cursor: cursorStatus,
  pi: piStatus,
  cline: clineStatus,
};

export const AGENT_PROVISION_ORDER: readonly AgentProvisionId[] = [
  "codex",
  "claude",
  "opencode",
  "kilo",
  "cursor",
  "pi",
  "cline",
];

/** Installs the gateway config into one agent's local config file. */
export function installAgentConfig(
  agent: AgentProvisionId,
  ctx: AgentProvisionContext,
): Effect.Effect<void, AgentProvisionError, FileSystem.FileSystem | Path.Path> {
  const installer = INSTALLERS[agent];
  if (!installer) {
    return Effect.fail(provisionError(agent, `Unknown agent '${agent}'`));
  }
  return installer(ctx);
}

/** Reads the install status of every supported agent. */
export function getAllAgentStatuses(
  ctx: AgentProvisionContext,
): Effect.Effect<AgentProvisionStatus[], never, FileSystem.FileSystem> {
  return Effect.all(AGENT_PROVISION_ORDER.map((id) => STATUS_CHECKS[id](ctx)), {
    concurrency: "unbounded",
  });
}
