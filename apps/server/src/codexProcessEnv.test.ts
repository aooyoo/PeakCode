import assert from "node:assert/strict";

import { describe, it } from "vitest";

import type { GatewayConfig } from "@peakcode/contracts";

import { buildGatewayBaseUrl, injectGatewayProviderIntoCodexConfig } from "./codexProcessEnv.ts";

const enabledGateway: GatewayConfig = {
  enabled: true,
  activeChannelId: "deepseek",
  channels: [
    {
      id: "deepseek",
      name: "DeepSeek",
      baseUrl: "https://api.deepseek.com/v1",
      model: "deepseek-chat",
      enabled: true,
    },
  ],
};

const disabledGateway: GatewayConfig = { ...enabledGateway, enabled: false };

describe("buildGatewayBaseUrl", () => {
  it("builds a loopback url with the given port", () => {
    assert.equal(buildGatewayBaseUrl(3773), "http://127.0.0.1:3773/gateway/openai/v1");
    assert.equal(buildGatewayBaseUrl(0), "http://127.0.0.1:0/gateway/openai/v1");
  });
});

describe("injectGatewayProviderIntoCodexConfig", () => {
  describe("when enabling", () => {
    it("injects model_provider and the provider section into an empty config", () => {
      const result = injectGatewayProviderIntoCodexConfig("", {
        gateway: enabledGateway,
        port: 3773,
      });
      assert.ok(result.includes('model_provider = "peakcode-gateway"'));
      assert.ok(result.includes("[model_providers.peakcode-gateway]"));
      assert.ok(result.includes('base_url = "http://127.0.0.1:3773/gateway/openai/v1"'));
      assert.ok(result.includes('wire_api = "responses"'));
      assert.ok(result.includes('env_key = "PEAKCODE_GATEWAY_API_KEY"'));
    });

    it("stashes the user's original model_provider and replaces it", () => {
      const original = 'model_provider = "openai"\n';
      const result = injectGatewayProviderIntoCodexConfig(original, {
        gateway: enabledGateway,
        port: 3773,
      });
      // The active provider is now peakcode-gateway.
      assert.match(result, /^model_provider = "peakcode-gateway"$/m);
      // The original is preserved as a comment marker.
      assert.match(result, /^# peakcode-gateway-original-model-provider = "openai"$/m);
      // The literal openai line must not remain as an active top-level key.
      assert.doesNotMatch(result, /^model_provider = "openai"$/m);
    });

    it("keeps user model_provider section bodies intact", () => {
      const original = [
        'model_provider = "openai"',
        "",
        "[model_providers.openai]",
        'name = "OpenAI"',
        'base_url = "https://api.openai.com/v1"',
      ].join("\n");
      const result = injectGatewayProviderIntoCodexConfig(original, {
        gateway: enabledGateway,
        port: 3773,
      });
      // The user's openai provider section survives untouched.
      assert.ok(result.includes("[model_providers.openai]"));
      assert.ok(result.includes('name = "OpenAI"'));
      // And our gateway section is appended.
      assert.ok(result.includes("[model_providers.peakcode-gateway]"));
    });
  });

  describe("idempotency", () => {
    it("applying twice yields the same result as applying once", () => {
      const original = 'model_provider = "openai"\n';
      const once = injectGatewayProviderIntoCodexConfig(original, {
        gateway: enabledGateway,
        port: 3773,
      });
      const twice = injectGatewayProviderIntoCodexConfig(once, {
        gateway: enabledGateway,
        port: 3773,
      });
      assert.equal(twice, once);
    });

    it("is stable when there is no pre-existing provider", () => {
      const once = injectGatewayProviderIntoCodexConfig("", {
        gateway: enabledGateway,
        port: 3773,
      });
      const twice = injectGatewayProviderIntoCodexConfig(once, {
        gateway: enabledGateway,
        port: 3773,
      });
      assert.equal(twice, once);
    });
  });

  describe("when disabling", () => {
    it("removes the gateway section and injected model_provider from an empty-origin config", () => {
      // Start from an enabled overlay that had no original provider.
      const enabled = injectGatewayProviderIntoCodexConfig("", {
        gateway: enabledGateway,
        port: 3773,
      });
      const disabled = injectGatewayProviderIntoCodexConfig(enabled, {
        gateway: disabledGateway,
        port: 3773,
      });
      assert.ok(!disabled.includes("peakcode-gateway"));
      assert.ok(!disabled.includes("model_provider"));
    });

    it("restores the user's original model_provider when disabling", () => {
      const original = 'model_provider = "openai"\n';
      const enabled = injectGatewayProviderIntoCodexConfig(original, {
        gateway: enabledGateway,
        port: 3773,
      });
      const disabled = injectGatewayProviderIntoCodexConfig(enabled, {
        gateway: disabledGateway,
        port: 3773,
      });
      // The original openai provider is restored.
      assert.match(disabled, /^model_provider = "openai"$/m);
      // No gateway remnants.
      assert.ok(!disabled.includes("peakcode-gateway"));
      assert.ok(!disabled.includes("# peakcode-gateway-original"));
    });

    it("disable is the inverse of enable for a config with an existing provider", () => {
      const original = [
        'model_provider = "openai"',
        "",
        "[model_providers.openai]",
        'name = "OpenAI"',
      ].join("\n");
      const enabled = injectGatewayProviderIntoCodexConfig(original, {
        gateway: enabledGateway,
        port: 3773,
      });
      const disabled = injectGatewayProviderIntoCodexConfig(enabled, {
        gateway: disabledGateway,
        port: 3773,
      });
      // After enable -> disable, the openai provider section is preserved and
      // the active model_provider points back at openai.
      assert.ok(disabled.includes("[model_providers.openai]"));
      assert.match(disabled, /^model_provider = "openai"$/m);
    });
  });

  describe("port changes", () => {
    it("updates the base_url when the port changes on re-injection", () => {
      const first = injectGatewayProviderIntoCodexConfig("", {
        gateway: enabledGateway,
        port: 3773,
      });
      const updated = injectGatewayProviderIntoCodexConfig(first, {
        gateway: enabledGateway,
        port: 48080,
      });
      assert.ok(updated.includes("http://127.0.0.1:48080/gateway/openai/v1"));
      assert.ok(!updated.includes("http://127.0.0.1:3773/gateway/openai/v1"));
    });
  });
});
