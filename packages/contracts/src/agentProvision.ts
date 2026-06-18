import { Schema } from "effect";

import { TrimmedNonEmptyString } from "./baseSchemas";

/**
 * Which agent client to install gateway config into. Mirrors
 * AgentProvisionId in apps/server/src/agentProvisioner.ts (kept in sync by
 * contract tests).
 */
export const AgentProvisionId = Schema.Literals([
  "codex",
  "claude",
  "opencode",
  "kilo",
  "cursor",
  "pi",
  "cline",
]);
export type AgentProvisionId = typeof AgentProvisionId.Type;

export const AgentInstallInput = Schema.Struct({
  agent: AgentProvisionId,
});
export type AgentInstallInput = typeof AgentInstallInput.Type;

export const AgentProvisionStatus = Schema.Struct({
  id: AgentProvisionId,
  name: TrimmedNonEmptyString,
  configPath: Schema.String,
  installed: Schema.Boolean,
  detail: TrimmedNonEmptyString,
});
export type AgentProvisionStatus = typeof AgentProvisionStatus.Type;

export const AgentProvisionStatusResult = Schema.Struct({
  agents: Schema.Array(AgentProvisionStatus),
});
export type AgentProvisionStatusResult = typeof AgentProvisionStatusResult.Type;

/** Result of an install call — the fresh status after writing. */
export const AgentInstallResult = AgentProvisionStatusResult;
export type AgentInstallResult = typeof AgentInstallResult.Type;
