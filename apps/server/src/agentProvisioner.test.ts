import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, FileSystem, Layer, Path } from "effect";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  installAgentConfig,
  getAllAgentStatuses,
  type AgentProvisionContext,
} from "./agentProvisioner";
import type { GatewayConfig } from "@peakcode/contracts";

// ------------------------------------------------------------------
// Test harness
// ------------------------------------------------------------------

let tempHome: string;

function makeCtx(env: NodeJS.ProcessEnv, port = 58190): AgentProvisionContext {
  const gateway: GatewayConfig = {
    enabled: true,
    activeChannelId: "deepseek",
    channels: [
      {
        id: "deepseek",
        name: "DeepSeek",
        baseUrl: "https://api.deepseek.com/v1",
        model: "deepseek-chat",
        enabled: true,
        kind: "openai",
        secrets: [{ id: "apiKey", label: "API Key", sensitive: true }],
        models: [
          { id: "deepseek-chat", label: "DeepSeek Chat" },
          { id: "deepseek-reasoner", label: "DeepSeek Reasoner" },
        ],
        agentMappings: { codex: "deepseek-chat", claude: "deepseek-chat" },
      },
    ],
  };
  return { gateway, port, env };
}

/** Runs an Effect against a temp HOME with the Node filesystem layer. */
async function runWithTempHome<A, E>(
  effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>,
): Promise<A> {
  return effect.pipe(Effect.provide(NodeServices.layer), Effect.runPromise);
}

beforeEach(() => {
  tempHome = mkdtempSync(path.join(tmpdir(), "peakcode-provision-"));
});

afterEach(() => {
  rmSync(tempHome, { recursive: true, force: true });
});

// ------------------------------------------------------------------
// Claude Code
// ------------------------------------------------------------------

describe("installAgentConfig (claude)", () => {
  it("writes Anthropic gateway env into ~/.claude/settings.json", async () => {
    const env = { HOME: tempHome };
    await runWithTempHome(installAgentConfig("claude", makeCtx(env, 58190)));
    const settingsPath = path.join(tempHome, ".claude/settings.json");
    expect(existsSync(settingsPath)).toBe(true);
    const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as {
      env?: Record<string, string>;
    };
    expect(settings.env?.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:58190/gateway/anthropic/v1");
    expect(settings.env?.ANTHROPIC_API_KEY).toBe("peakcode-managed");
    expect(settings.env?.ANTHROPIC_AUTH_TOKEN).toBe("peakcode-managed");
  });

  it("preserves existing settings fields", async () => {
    const env = { HOME: tempHome };
    const settingsPath = path.join(tempHome, ".claude/settings.json");
    mkdirSync(path.dirname(settingsPath), { recursive: true });
    writeFileSync(settingsPath, JSON.stringify({ theme: "dark", env: { FOO: "bar" } }));
    await runWithTempHome(installAgentConfig("claude", makeCtx(env)));
    const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as {
      theme?: string;
      env?: Record<string, string>;
    };
    expect(settings.theme).toBe("dark");
    expect(settings.env?.FOO).toBe("bar");
    expect(settings.env?.ANTHROPIC_BASE_URL).toContain("127.0.0.1");
  });

  it("reports installed=true in status after writing", async () => {
    const env = { HOME: tempHome };
    const ctx = makeCtx(env, 58200);
    await runWithTempHome(installAgentConfig("claude", ctx));
    const statuses = await runWithTempHome(getAllAgentStatuses(ctx));
    const claude = statuses.find((s) => s.id === "claude");
    expect(claude?.installed).toBe(true);
  });

  it("reports installed=false before writing", async () => {
    const env = { HOME: tempHome };
    const statuses = await runWithTempHome(getAllAgentStatuses(makeCtx(env)));
    const claude = statuses.find((s) => s.id === "claude");
    expect(claude?.installed).toBe(false);
  });

  it("is idempotent (reinstall produces same result)", async () => {
    const env = { HOME: tempHome };
    const ctx = makeCtx(env);
    await runWithTempHome(installAgentConfig("claude", ctx));
    await runWithTempHome(installAgentConfig("claude", ctx));
    const settings = JSON.parse(
      readFileSync(path.join(tempHome, ".claude/settings.json"), "utf8"),
    ) as { env?: Record<string, string> };
    expect(settings.env?.ANTHROPIC_BASE_URL).toContain("58190");
  });
});

// ------------------------------------------------------------------
// Codex
// ------------------------------------------------------------------

describe("installAgentConfig (codex)", () => {
  it("injects model_provider and a [model_providers.peakcode-gateway] section", async () => {
    const codexHome = path.join(tempHome, ".codex");
    const env = { HOME: tempHome, CODEX_HOME: codexHome };
    await runWithTempHome(installAgentConfig("codex", makeCtx(env, 58190)));
    const configPath = path.join(codexHome, "config.toml");
    const text = readFileSync(configPath, "utf8");
    expect(text).toContain('model_provider = "peakcode-gateway"');
    expect(text).toContain("[model_providers.peakcode-gateway]");
    expect(text).toContain("http://127.0.0.1:58190/gateway/openai/v1");
    expect(text).toContain('wire_api = "responses"');
    expect(text).toContain("[model_providers.peakcode-gateway.auth]");
    expect(text).toContain('args = ["peakcode-managed"]');
    expect(text).not.toContain('env_key = "PEAKCODE_GATEWAY_API_KEY"');
    expect(text).toContain('model = "deepseek-chat"');
  });

  it("reports installed=true after writing", async () => {
    const env = { HOME: tempHome, CODEX_HOME: path.join(tempHome, ".codex") };
    const ctx = makeCtx(env, 58300);
    await runWithTempHome(installAgentConfig("codex", ctx));
    const statuses = await runWithTempHome(getAllAgentStatuses(ctx));
    const codex = statuses.find((s) => s.id === "codex");
    expect(codex?.installed).toBe(true);
  });
});

// ------------------------------------------------------------------
// OpenCode / Kilo (OpenAI-compatible, JSON provider block)
// ------------------------------------------------------------------

describe("installAgentConfig (opencode)", () => {
  it("writes provider.peakcode-gateway with baseURL + apiKey + models", async () => {
    const env = { HOME: tempHome };
    await runWithTempHome(installAgentConfig("opencode", makeCtx(env, 58190)));
    const configPath = path.join(tempHome, ".config/opencode/opencode.json");
    const config = JSON.parse(readFileSync(configPath, "utf8")) as {
      provider?: Record<string, unknown>;
    };
    const provider = config.provider?.["peakcode-gateway"] as {
      options?: { baseURL?: string; apiKey?: string };
      models?: Record<string, unknown>;
    };
    expect(provider?.options?.baseURL).toBe("http://127.0.0.1:58190/gateway/openai/v1");
    expect(provider?.options?.apiKey).toBe("peakcode-managed");
    expect(Object.keys(provider?.models ?? {})).toEqual(
      expect.arrayContaining(["deepseek-chat", "deepseek-reasoner"]),
    );
  });
});

// ------------------------------------------------------------------
// getAllAgentStatuses
// ------------------------------------------------------------------

describe("getAllAgentStatuses", () => {
  it("returns one entry per supported agent", async () => {
    const env = { HOME: tempHome, CODEX_HOME: path.join(tempHome, ".codex") };
    const statuses = await runWithTempHome(getAllAgentStatuses(makeCtx(env)));
    const ids = statuses.map((s) => s.id).sort();
    expect(ids).toEqual(["claude", "cline", "codex", "cursor", "kilo", "opencode", "pi"]);
    // None installed on a fresh temp home (some agents ignore HOME and read
    // global paths, so we only assert the ones that respect HOME/ctx.env).
    for (const s of statuses) {
      if (["claude", "codex", "opencode", "kilo"].includes(s.id)) {
        expect(s.installed, `${s.id} should not be installed`).toBe(false);
      }
    }
  });
});

// ------------------------------------------------------------------
// Backup
// ------------------------------------------------------------------

describe("backup", () => {
  it("creates a timestamped backup before overwriting", async () => {
    const env = { HOME: tempHome };
    const settingsPath = path.join(tempHome, ".claude/settings.json");
    mkdirSync(path.dirname(settingsPath), { recursive: true });
    writeFileSync(settingsPath, JSON.stringify({ original: true }));
    await runWithTempHome(installAgentConfig("claude", makeCtx(env)));
    const backups = readdirSync(path.dirname(settingsPath)).filter((f) =>
      f.startsWith("settings.json.peakcode-backup."),
    );
    expect(backups.length).toBe(1);
    const backupName = backups[0];
    expect(backupName).toBeDefined();
    const backupContent = JSON.parse(
      readFileSync(path.join(path.dirname(settingsPath), backupName!), "utf8"),
    ) as { original?: boolean };
    expect(backupContent.original).toBe(true);
  });
});
