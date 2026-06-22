// FILE: claudeGatewayEnv.ts
// Purpose: Builds the environment passed to the Claude Agent SDK `query()` call
//          so Claude Code routes through the PeakCode gateway (Anthropic
//          Messages endpoint) when the gateway is enabled.
// Layer: Server provider support
//
// The Claude SDK (@anthropic-ai/claude-agent-sdk) reads ANTHROPIC_BASE_URL and
// ANTHROPIC_AUTH_TOKEN from its env to decide where to send /v1/messages
// requests. When the gateway is enabled we override these to point at the
// local gateway, which then forwards to the configured channel (DeepSeek, MiMo,
// a real Anthropic endpoint, ...). When the gateway is disabled we leave the
// caller's env untouched so Claude Code uses the user's own credentials.

import {
  resolveAgentModel,
  resolveGatewayActiveChannel,
  type GatewayConfig,
} from "@peakcode/contracts";
import { PEAKCODE_GATEWAY_CLIENT_API_KEY } from "./gateway";

/** Sentinel token the gateway accepts for SDK-routed requests. */
export const PEAKCODE_CLAUDE_GATEWAY_TOKEN = PEAKCODE_GATEWAY_CLIENT_API_KEY;

/**
 * Builds the gateway base URL the Claude SDK should target.
 *
 * IMPORTANT: Claude Code's SDK automatically appends "/v1/messages" to this
 * URL, so it must NOT include "/v1". The SDK constructs:
 *   {base_url}/v1/messages  →  http://127.0.0.1:{port}/gateway/anthropic/v1/messages
 * which matches the /gateway/anthropic/v1/* route registered in http.ts.
 */
export function buildClaudeGatewayBaseUrl(port: number): string {
  return `http://127.0.0.1:${port}/gateway/anthropic`;
}

export interface ClaudeGatewayEnvOptions {
  readonly gateway: GatewayConfig | undefined;
  readonly port: number;
}

/**
 * Returns the model id Claude Code should use when routed through the gateway.
 * Prefers the active channel's Claude-specific mapping; falls back to the
 * channel default. Returns null when no model is configured (caller keeps its
 * own model selection).
 */
export function resolveClaudeGatewayModel(gateway: GatewayConfig | undefined): string | null {
  if (!gateway) return null;
  const activeChannel = resolveGatewayActiveChannel(gateway);
  if (!activeChannel) return null;
  return resolveAgentModel(activeChannel, "claude");
}

/**
 * Returns true when the Claude SDK should be redirected through the gateway.
 * The gateway must be enabled AND have at least one channel configured.
 */
export function isClaudeGatewayActive(
  gateway: GatewayConfig | undefined,
): gateway is GatewayConfig {
  return gateway !== undefined && gateway.enabled && resolveGatewayActiveChannel(gateway) !== null;
}

/**
 * Produces the env object to pass to the SDK's `query({ options: { env } })`.
 *
 * The SDK's `env` option REPLACES (not merges) the subprocess environment, so
 * we always spread the incoming base env first to preserve PATH/HOME/etc, then
 * overlay the gateway redirect vars when active.
 */
export function buildClaudeQueryEnv(
  baseEnv: NodeJS.ProcessEnv,
  options: ClaudeGatewayEnvOptions,
): NodeJS.ProcessEnv {
  if (!isClaudeGatewayActive(options.gateway)) {
    return baseEnv;
  }
  return {
    ...baseEnv,
    ANTHROPIC_BASE_URL: buildClaudeGatewayBaseUrl(options.port),
    ANTHROPIC_API_KEY: PEAKCODE_CLAUDE_GATEWAY_TOKEN,
    ANTHROPIC_AUTH_TOKEN: PEAKCODE_CLAUDE_GATEWAY_TOKEN,
  };
}
