// FILE: codexProcessEnv.ts
// Purpose: Builds the exact environment used when Peak Code launches Codex subprocesses.
// Layer: Server runtime utility
// Exports: Codex process env builder and browser-plugin overlay helpers.
// Depends on: Codex home path helpers, shared Codex config parsing, login-shell env reader.

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import {
  resolveAgentModel,
  resolveGatewayActiveChannel,
  type GatewayConfig,
} from "@peakcode/contracts";

import { readActiveCodexProviderEnvKey } from "@peakcode/shared/codexConfig";
import {
  readEnvironmentFromLoginShell,
  resolveLoginShell,
  type ShellEnvironmentReader,
} from "@peakcode/shared/shell";

import {
  resolveBaseCodexHomePath,
  resolvePeakCodeCodexHomeOverlayPath,
  shouldDisablePeakCodeBrowserPlugin,
} from "./codexHomePaths.ts";

const CODEX_PROCESS_SHELL_ENV_NAMES = ["PATH", "SSH_AUTH_SOCK"] as const;
const NODE_REPL_SANDBOX_ALLOWED_UNIX_SOCKETS = "NODE_REPL_SANDBOX_ALLOWED_UNIX_SOCKETS";
const PEAKCODE_BROWSER_PLUGIN_CONFIG_HEADER = '[plugins."peakcode-browser@local"]';

// Gateway provider overlay constants.
// When the PeakCode gateway is enabled, we inject a `peakcode` model provider
// into Codex's config.toml so Codex routes requests through the PeakCode-hosted
// local gateway endpoint (which then forwards to the upstream provider, e.g.
// DeepSeek) instead of requiring per-tool configuration.
const PEAKCODE_GATEWAY_PROVIDER_ID = "peakcode";
const PEAKCODE_GATEWAY_PROVIDER_HEADER = "[model_providers.peakcode]";
const PEAKCODE_GATEWAY_PROVIDER_AUTH_HEADER = "[model_providers.peakcode.auth]";
const PEAKCODE_GATEWAY_MODEL_PROVIDER_LINE = `model_provider = "${PEAKCODE_GATEWAY_PROVIDER_ID}"`;
// Codex reads the API key from this env var, but the gateway authenticates
// against the upstream itself using its own stored secret. The env var only
// needs to be non-empty so Codex does not refuse to start the provider.
const PEAKCODE_GATEWAY_ENV_KEY = "PEAKCODE_GATEWAY_API_KEY";
// Sentinel value injected for PEAKCODE_GATEWAY_ENV_KEY so Codex starts the
// provider; the real upstream key lives in the gateway's secret store.
const PEAKCODE_GATEWAY_ENV_SENTINEL = "peakcode-managed";

// Top-level `model` injection. When the gateway is active we also pin Codex's
// model to the active channel's Codex-mapped model (or the channel default),
// so Codex sends the right model id to the gateway on every turn. The user's
// original `model` line is stashed for restore, mirroring model_provider.
const PEAKCODE_GATEWAY_ORIGINAL_MODEL_MARKER = "# peakcode-gateway-original-model";
const PEAKCODE_GATEWAY_ORIGINAL_MODEL_REGEX = new RegExp(
  `^${PEAKCODE_GATEWAY_ORIGINAL_MODEL_MARKER}\\s*=\\s*(?:"([^"]*)"|'([^']*)')\\s*$`,
);

/**
 * Resolves the local gateway base URL Codex should talk to.
 *
 * The gateway runs inside the PeakCode server process, so its address is always
 * the server's own loopback port.
 */
export function buildGatewayBaseUrl(port: number): string {
  return `http://127.0.0.1:${port}/gateway/openai/v1`;
}

// Comment marker used to stash the user's original top-level `model_provider`
// value so it can be restored when the gateway is turned back off.
const PEAKCODE_GATEWAY_ORIGINAL_MARKER = "# peakcode-gateway-original-model-provider";
const PEAKCODE_GATEWAY_ORIGINAL_REGEX = new RegExp(
  `^${PEAKCODE_GATEWAY_ORIGINAL_MARKER}\\s*=\\s*(?:"([^"]*)"|'([^']*)')\\s*$`,
);
const MODEL_PROVIDER_LINE_REGEX = /^\s*model_provider\s*=\s*(?:"([^"]+)"|'([^']+)')\s*$/;
const MODEL_LINE_REGEX = /^\s*model\s*=\s*(?:"([^"]+)"|'([^']+)')\s*$/;
const MODEL_PROVIDERS_SECTION_REGEX =
  /^\[\s*model_providers\.(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_-]+))\s*\]$/;

export function resolveCodexBrowserUsePipePath(
  input: {
    readonly env?: NodeJS.ProcessEnv;
    readonly platform?: NodeJS.Platform;
  } = {},
): string {
  const env = input.env ?? process.env;
  const configured =
    env.PEAKCODE_BROWSER_USE_PIPE_PATH?.trim() || env.PEAKCODE_BROWSER_USE_PIPE_PATH_LEGACY?.trim();
  if (configured) {
    return configured;
  }
  return (input.platform ?? process.platform) === "win32"
    ? String.raw`\\.\pipe\codex-browser-use`
    : "/tmp/codex-browser-use.sock";
}

export function disablePeakCodeBrowserPluginInCodexConfig(config: string): string {
  const lines = config.split(/\r?\n/);
  const output: string[] = [];
  let inTargetSection = false;
  let sawTargetSection = false;
  let targetSectionHasEnabled = false;

  const closeTargetSection = () => {
    if (inTargetSection && !targetSectionHasEnabled) {
      output.push("enabled = false");
    }
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
      closeTargetSection();
      inTargetSection = trimmed === PEAKCODE_BROWSER_PLUGIN_CONFIG_HEADER;
      sawTargetSection ||= inTargetSection;
      targetSectionHasEnabled = false;
      output.push(line);
      continue;
    }

    if (inTargetSection && /^\s*enabled\s*=/.test(line)) {
      output.push("enabled = false");
      targetSectionHasEnabled = true;
      continue;
    }

    output.push(line);
  }

  closeTargetSection();

  if (!sawTargetSection) {
    if (output.length > 0 && output.at(-1)?.trim()) {
      output.push("");
    }
    output.push(PEAKCODE_BROWSER_PLUGIN_CONFIG_HEADER, "enabled = false");
  }

  return output.join("\n");
}

/**
 * Returns true when the gateway overlay should be active. The gateway overlay is
 * independent of the browser-plugin overlay: it kicks in whenever the user has
 * enabled the gateway in settings, regardless of the browser-plugin toggle.
 */
function shouldApplyGatewayOverlay(gateway: GatewayConfig | undefined): gateway is GatewayConfig {
  return gateway !== undefined && gateway.enabled;
}

/**
 * Idempotently injects (or removes) the `peakcode-gateway` model provider into
 * a Codex config.toml string.
 *
 * When `gateway.enabled` is true:
 *   - Sets the top-level `model_provider` to `"peakcode-gateway"`, stashing the
 *     previous value in a comment so it can be restored later.
 *   - Pins the top-level `model` to the active channel's Codex-mapped model
 *     (or the channel default), stashing the user's original for restore.
 *   - Replaces any existing `[model_providers.peakcode-gateway]` section with a
 *     fresh one pointing at the local gateway endpoint.
 *
 * When `gateway.enabled` is false:
 *   - Removes the `peakcode-gateway` section entirely.
 *   - Restores the stashed original `model_provider` and `model` values, or
 *     removes the lines if no original existed.
 *
 * This is a pure string transform; callers write the result into the overlay
 * config.toml alongside the browser-plugin overlay.
 */
export function injectGatewayProviderIntoCodexConfig(
  config: string,
  options: {
    readonly gateway: GatewayConfig;
    readonly port: number;
    readonly authMode?: "env" | "command";
  },
): string {
  const enabled = options.gateway.enabled;
  const baseUrl = buildGatewayBaseUrl(options.port);
  const authMode = options.authMode ?? "env";
  const lines = config.split(/\r?\n/);

  // Pass 1: strip every line that belongs to a previous peakcode-gateway overlay
  // (the section body) and capture the original model_provider + model values,
  // while also removing our injected top-level lines when disabling.
  let originalModelProvider: string | undefined;
  let originalModel: string | undefined;
  let inGatewaySection = false;
  const stripped: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();

    // Restore-marker comments: capture the stashed originals in either mode.
    const markerMatch = trimmed.match(PEAKCODE_GATEWAY_ORIGINAL_REGEX);
    if (markerMatch) {
      originalModelProvider = markerMatch[1] ?? markerMatch[2] ?? originalModelProvider;
      continue; // drop the marker line; re-added below when enabling
    }
    const modelMarkerMatch = trimmed.match(PEAKCODE_GATEWAY_ORIGINAL_MODEL_REGEX);
    if (modelMarkerMatch) {
      originalModel = modelMarkerMatch[1] ?? modelMarkerMatch[2] ?? originalModel;
      continue;
    }

    if (trimmed === PEAKCODE_GATEWAY_PROVIDER_AUTH_HEADER) {
      inGatewaySection = true;
      continue;
    }

    // Section header tracking.
    const sectionMatch = trimmed.match(MODEL_PROVIDERS_SECTION_REGEX);
    if (sectionMatch) {
      const sectionName = sectionMatch[1] ?? sectionMatch[2] ?? sectionMatch[3];
      inGatewaySection = sectionName === PEAKCODE_GATEWAY_PROVIDER_ID;
      if (inGatewaySection) {
        continue; // drop the gateway section header
      }
      stripped.push(line);
      continue;
    }

    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
      inGatewaySection = false;
      stripped.push(line);
      continue;
    }

    // Inside the gateway section: drop its body lines.
    if (inGatewaySection) {
      continue;
    }

    // Top-level model_provider line handling.
    const providerMatch = trimmed.match(MODEL_PROVIDER_LINE_REGEX);
    if (providerMatch) {
      const value = providerMatch[1] ?? providerMatch[2];
      if (value === PEAKCODE_GATEWAY_PROVIDER_ID) {
        // This is our injected line. Drop it; re-added below when enabling.
        continue;
      }
      // A user-supplied provider. When enabling we replace it with the gateway
      // provider, so stash the original (for later restore) and drop the line.
      // When disabling we keep the user's line untouched.
      if (enabled) {
        if (originalModelProvider === undefined) {
          originalModelProvider = value;
        }
        continue; // drop the line; gateway provider is injected in pass 2
      }
      stripped.push(line);
      continue;
    }

    // Top-level model line handling (mirrors model_provider). When enabling we
    // pin the model to the gateway-resolved Codex model, stashing the user's
    // original for restore. When disabling we keep the user's line untouched.
    const modelMatch = trimmed.match(MODEL_LINE_REGEX);
    if (modelMatch) {
      if (enabled) {
        if (originalModel === undefined) {
          originalModel = modelMatch[1] ?? modelMatch[2];
        }
        continue; // drop; re-injected as the gateway model below
      }
      stripped.push(line);
      continue;
    }

    stripped.push(line);
  }

  // Pass 2: re-inject the overlay when enabled.
  if (!enabled) {
    // When disabling, restore the stashed original top-level model_provider.
    if (originalModelProvider !== undefined) {
      return restoreTopLevelModelProvider(stripped, originalModelProvider);
    }
    return stripped.join("\n");
  }

  // The top-level model_provider key must appear before any [section], so we
  // emit it first, followed by the stashed-original marker. Then we copy the
  // remaining stripped lines (which start at the top level and may include
  // section headers further down).
  const withProviderHeader: string[] = [PEAKCODE_GATEWAY_MODEL_PROVIDER_LINE];
  if (originalModelProvider !== undefined) {
    withProviderHeader.push(`${PEAKCODE_GATEWAY_ORIGINAL_MARKER} = "${originalModelProvider}"`);
  }

  // Pin the model to the active channel's Codex-mapped model so Codex sends
  // the right model id through the gateway. The restore marker preserves the
  // user's original model for when the gateway is turned back off.
  const activeChannel = resolveGatewayActiveChannel(options.gateway);
  const codexModel =
    (activeChannel ? resolveAgentModel(activeChannel, "codex") : null) ?? originalModel;
  if (codexModel) {
    withProviderHeader.push(`model = "${codexModel}"`);
    if (originalModel !== undefined && originalModel !== codexModel) {
      withProviderHeader.push(`${PEAKCODE_GATEWAY_ORIGINAL_MODEL_MARKER} = "${originalModel}"`);
    }
  } else if (originalModel !== undefined) {
    // No channel model resolved; keep the user's original model line.
    withProviderHeader.push(`model = "${originalModel}"`);
  }

  // Drop leading blank lines from stripped so the provider block stays compact
  // and the output is stable across repeated invocations (idempotency).
  let firstNonBlank = 0;
  while (firstNonBlank < stripped.length && stripped[firstNonBlank]?.trim() === "") {
    firstNonBlank += 1;
  }
  const remaining = stripped.slice(firstNonBlank);
  if (remaining.length > 0) {
    withProviderHeader.push(""); // blank line separates keys from the rest
    withProviderHeader.push(...remaining);
  }

  // Append the gateway provider section at the end, separated by a blank line.
  if (withProviderHeader.length > 0 && withProviderHeader.at(-1)?.trim()) {
    withProviderHeader.push("");
  }
  withProviderHeader.push(
    PEAKCODE_GATEWAY_PROVIDER_HEADER,
    `name = "PeakCode"`,
    `base_url = "${baseUrl}"`,
    `wire_api = "responses"`,
  );
  if (authMode === "command") {
    withProviderHeader.push(
      "",
      PEAKCODE_GATEWAY_PROVIDER_AUTH_HEADER,
      `command = "/bin/echo"`,
      `args = ["${PEAKCODE_GATEWAY_ENV_SENTINEL}"]`,
      `refresh_interval_ms = 300000`,
    );
  } else {
    withProviderHeader.push(`env_key = "${PEAKCODE_GATEWAY_ENV_KEY}"`);
  }

  return withProviderHeader.join("\n");
}

// Restores a top-level `model_provider = "<value>"` line, placing it before the
// first section header (matching TOML top-level key placement). If a top-level
// model_provider already exists, it is left untouched.
function restoreTopLevelModelProvider(lines: string[], value: string): string {
  const hasTopLevelProvider = lines.some((line) => MODEL_PROVIDER_LINE_REGEX.test(line.trim()));
  if (hasTopLevelProvider) {
    return lines.join("\n");
  }
  const out: string[] = [];
  let inserted = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!inserted && trimmed.startsWith("[") && trimmed.endsWith("]")) {
      out.push(`model_provider = "${value}"`);
      inserted = true;
    }
    out.push(line);
  }
  if (!inserted) {
    out.push(`model_provider = "${value}"`);
  }
  return out.join("\n");
}

/**
 * Builds the transformed config.toml content for the overlay by applying every
 * active config override in a fixed order. Each transform is idempotent on its
 * own, and the composition stays idempotent because the gateway transform
 * strips any prior gateway overlay before re-injecting.
 */
function buildOverlayConfigContent(
  sourceConfig: string,
  input: {
    readonly disableBrowserPlugin: boolean;
    readonly gateway: GatewayConfig | undefined;
    readonly port: number;
  },
): string {
  let config = sourceConfig;
  if (input.disableBrowserPlugin) {
    config = disablePeakCodeBrowserPluginInCodexConfig(config);
  }
  if (shouldApplyGatewayOverlay(input.gateway)) {
    config = injectGatewayProviderIntoCodexConfig(config, {
      gateway: input.gateway,
      port: input.port,
    });
  }
  return config;
}

function preparePeakCodeCodexHomeOverlay(input: {
  readonly env: NodeJS.ProcessEnv;
  readonly homePath?: string;
  readonly gateway: GatewayConfig | undefined;
  readonly port: number;
}): string | undefined {
  const sourceHomePath = resolveBaseCodexHomePath(input.env, input.homePath);
  const overlayHomePath = resolvePeakCodeCodexHomeOverlayPath(input.env, sourceHomePath);
  if (path.resolve(sourceHomePath) === path.resolve(overlayHomePath)) {
    return undefined;
  }

  mkdirSync(overlayHomePath, { recursive: true });

  try {
    for (const entry of readdirSync(sourceHomePath)) {
      if (entry === "config.toml") {
        continue;
      }
      const sourcePath = path.join(sourceHomePath, entry);
      const targetPath = path.join(overlayHomePath, entry);
      if (existsSync(targetPath)) {
        continue;
      }
      const stat = lstatSync(sourcePath);
      symlinkSync(sourcePath, targetPath, stat.isDirectory() ? "dir" : "file");
    }
  } catch {
    // If the source home is partially missing, Codex can still start with the
    // overlay config and create any required state lazily.
  }

  const disableBrowserPlugin = shouldDisablePeakCodeBrowserPlugin(input.env);
  const sourceConfigPath = path.join(sourceHomePath, "config.toml");
  const sourceConfig = existsSync(sourceConfigPath) ? readFileSync(sourceConfigPath, "utf8") : "";
  const overlayConfig = buildOverlayConfigContent(sourceConfig, {
    disableBrowserPlugin,
    gateway: input.gateway,
    port: input.port,
  });
  writeFileSync(path.join(overlayHomePath, "config.toml"), overlayConfig, "utf8");

  return overlayHomePath;
}

export function buildCodexProcessEnv(
  input: {
    readonly env?: NodeJS.ProcessEnv;
    readonly homePath?: string;
    readonly platform?: NodeJS.Platform;
    readonly readEnvironment?: ShellEnvironmentReader;
    /**
     * Gateway provider settings. When enabled, a `peakcode-gateway` model
     * provider is injected into the Codex config overlay pointing at the local
     * gateway endpoint. Omit when the gateway feature is inactive.
     */
    readonly gateway?: GatewayConfig;
    /**
     * The server's resolved listening port. Used to build the gateway base_url.
     * Only read when `gateway` is enabled.
     */
    readonly gatewayPort?: number;
  } = {},
): NodeJS.ProcessEnv {
  const baseEnv = { ...(input.env ?? process.env) };
  const gateway = input.gateway;
  const needsOverlayEnv =
    shouldDisablePeakCodeBrowserPlugin(baseEnv) || shouldApplyGatewayOverlay(gateway);
  const overlayHomePath = needsOverlayEnv
    ? preparePeakCodeCodexHomeOverlay({
        env: baseEnv,
        ...(input.homePath ? { homePath: input.homePath } : {}),
        ...(gateway !== undefined ? { gateway } : { gateway: undefined }),
        port: input.gatewayPort ?? 0,
      })
    : undefined;
  const effectiveEnv =
    overlayHomePath || input.homePath
      ? { ...baseEnv, CODEX_HOME: overlayHomePath ?? input.homePath }
      : baseEnv;

  // Codex requires the provider's env_key to be set and non-empty, otherwise it
  // refuses to start the provider. The gateway authenticates upstream itself, so
  // we inject a fixed sentinel when the gateway overlay is active.
  if (shouldApplyGatewayOverlay(gateway)) {
    effectiveEnv[PEAKCODE_GATEWAY_ENV_KEY] = PEAKCODE_GATEWAY_ENV_SENTINEL;
  }
  const platform = input.platform ?? process.platform;

  if (platform === "darwin" || platform === "linux") {
    try {
      const shell = resolveLoginShell(platform, effectiveEnv.SHELL);
      const providerEnvKey = readActiveCodexProviderEnvKey(effectiveEnv);
      if (shell && providerEnvKey && !effectiveEnv[providerEnvKey]?.trim()) {
        const shellEnvironment = (input.readEnvironment ?? readEnvironmentFromLoginShell)(shell, [
          ...CODEX_PROCESS_SHELL_ENV_NAMES,
          providerEnvKey,
        ]);

        if (shellEnvironment.PATH) {
          effectiveEnv.PATH = shellEnvironment.PATH;
        }
        if (!effectiveEnv.SSH_AUTH_SOCK && shellEnvironment.SSH_AUTH_SOCK) {
          effectiveEnv.SSH_AUTH_SOCK = shellEnvironment.SSH_AUTH_SOCK;
        }
        if (shellEnvironment[providerEnvKey]) {
          effectiveEnv[providerEnvKey] = shellEnvironment[providerEnvKey];
        }
      }
    } catch {
      // Keep inherited environment if shell lookup fails.
    }
  }

  if (platform !== "win32") {
    const browserUsePipePath = resolveCodexBrowserUsePipePath({ env: effectiveEnv, platform });
    const allowedSockets =
      effectiveEnv[NODE_REPL_SANDBOX_ALLOWED_UNIX_SOCKETS]
        ?.split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0) ?? [];
    if (!allowedSockets.includes(browserUsePipePath)) {
      effectiveEnv[NODE_REPL_SANDBOX_ALLOWED_UNIX_SOCKETS] = [
        ...allowedSockets,
        browserUsePipePath,
      ].join(",");
    }
  }

  return effectiveEnv;
}
