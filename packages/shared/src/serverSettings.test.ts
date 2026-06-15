import { DEFAULT_SERVER_SETTINGS } from "@peakcode/contracts";
import { describe, expect, it } from "vitest";

import { applyServerSettingsPatch } from "./serverSettings";

describe("applyServerSettingsPatch gateway channels", () => {
  it("patches an existing channel without dropping its required fields", () => {
    const next = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      gateway: {
        channels: [{ id: "deepseek", model: "deepseek-reasoner" }],
      },
    });

    expect(next.gateway.channels[0]).toEqual({
      id: "deepseek",
      name: "DeepSeek",
      baseUrl: "https://api.deepseek.com/v1",
      model: "deepseek-reasoner",
      enabled: true,
    });
  });

  it("preserves all default channels when patching one channel", () => {
    const next = applyServerSettingsPatch(
      {
        ...DEFAULT_SERVER_SETTINGS,
        gateway: {
          ...DEFAULT_SERVER_SETTINGS.gateway,
          channels: [DEFAULT_SERVER_SETTINGS.gateway.channels[0]!],
        },
      },
      {
        gateway: {
          channels: [{ id: "kimi", model: "kimi-k2.5" }],
        },
      },
    );

    expect(next.gateway.channels.map((channel) => channel.id)).toEqual([
      "deepseek",
      "siliconflow",
      "volcano",
      "tongyi",
      "kimi",
      "minimax",
    ]);
    expect(next.gateway.channels.find((channel) => channel.id === "kimi")?.model).toBe("kimi-k2.5");
  });
});
