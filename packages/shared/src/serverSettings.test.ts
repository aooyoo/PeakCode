import {
  DEFAULT_GATEWAY_CHANNELS,
  DEFAULT_OPENAI_CHANNEL_SECRETS,
  DEFAULT_SERVER_SETTINGS,
  type GatewayChannelConfig,
} from "@peakcode/contracts";
import { describe, expect, it } from "vitest";

import { applyServerSettingsPatch } from "./serverSettings";

/**
 * Builds a fresh deepseek channel from the catalog so tests don't hardcode the
 * full field list (which would drift whenever the schema gains fields).
 */
function deepseekChannel(overrides: Partial<GatewayChannelConfig> = {}): GatewayChannelConfig {
  const base = DEFAULT_GATEWAY_CHANNELS.find((channel) => channel.id === "deepseek");
  if (!base) throw new Error("deepseek channel missing from DEFAULT_GATEWAY_CHANNELS");
  return { ...base, ...overrides };
}

describe("applyServerSettingsPatch gateway channels", () => {
  it("merges full channel entries while preserving catalog fields", () => {
    const next = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      gateway: {
        channels: [deepseekChannel({ model: "deepseek-reasoner" })],
      },
    });

    expect(next.gateway.channels).toHaveLength(DEFAULT_GATEWAY_CHANNELS.length);
    expect(next.gateway.channels[0]).toEqual(deepseekChannel({ model: "deepseek-reasoner" }));
  });

  it("merges sparse channel patches by id instead of dropping unmentioned fields", () => {
    const next = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      gateway: {
        channels: [{ id: "deepseek", model: "deepseek-reasoner" }],
      },
    });

    expect(next.gateway.channels).toHaveLength(DEFAULT_GATEWAY_CHANNELS.length);
    expect(next.gateway.channels[0]).toEqual(deepseekChannel({ model: "deepseek-reasoner" }));
    expect(next.gateway.channels[0]?.kind).toBe("openai");
    expect(next.gateway.channels[0]?.secrets).toEqual(DEFAULT_OPENAI_CHANNEL_SECRETS);
  });

  it("keeps MiMo's protocol kind and cookie slots when toggling enabled", () => {
    const next = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      gateway: {
        channels: [{ id: "mimo", enabled: true }],
      },
    });

    const mimo = next.gateway.channels.find((channel) => channel.id === "mimo");
    expect(mimo?.enabled).toBe(true);
    expect(mimo?.kind).toBe("mimo");
    expect(mimo?.secrets.map((secret) => secret.id)).toEqual([
      "serviceToken",
      "userId",
      "xiaomichatbot_ph",
    ]);
  });

  it("toggles gateway.enabled without touching channels", () => {
    const next = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      gateway: { enabled: false },
    });
    expect(next.gateway.enabled).toBe(false);
    // Channels come through unchanged from the default.
    expect(next.gateway.channels.map((channel) => channel.id)).toEqual([
      "deepseek",
      "siliconflow",
      "volcano",
      "tongyi",
      "kimi",
      "minimax",
      "mimo",
    ]);
  });

  it("lists every default channel id including mimo", () => {
    // Sanity guard: if someone removes a channel from the catalog, this fails
    // loudly instead of silently shrinking the UI.
    expect(DEFAULT_GATEWAY_CHANNELS.map((channel) => channel.id)).toEqual([
      "deepseek",
      "siliconflow",
      "volcano",
      "tongyi",
      "kimi",
      "minimax",
      "mimo",
    ]);
  });

  it("declares the mimo channel with its three cookie secrets", () => {
    const mimo = DEFAULT_GATEWAY_CHANNELS.find((channel) => channel.id === "mimo");
    expect(mimo).toBeDefined();
    expect(mimo?.kind).toBe("mimo");
    expect(mimo?.secrets.map((secret) => secret.id)).toEqual([
      "serviceToken",
      "userId",
      "xiaomichatbot_ph",
    ]);
  });
});
