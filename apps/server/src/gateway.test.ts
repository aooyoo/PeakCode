import { describe, expect, it } from "vitest";

import { DEFAULT_OPENAI_CHANNEL_SECRETS, type GatewayChannelConfig } from "@peakcode/contracts";

import {
  chatResponseToResponsesResponse,
  chatStreamToResponsesStream,
  dispatchGatewayChat,
  makeGatewayModelsPayload,
  resolveGatewayChannel,
  responsesPayloadToChatPayload,
} from "./gateway";

const deepseekChannel: GatewayChannelConfig = {
  id: "deepseek",
  name: "DeepSeek",
  baseUrl: "https://api.deepseek.com/v1",
  model: "deepseek-chat",
  enabled: true,
  kind: "openai",
  secrets: [...DEFAULT_OPENAI_CHANNEL_SECRETS],
  models: [],
  agentMappings: {},
};

const config = {
  enabled: true,
  activeChannelId: "deepseek" as const,
  channels: [deepseekChannel],
};

describe("gateway protocol conversion", () => {
  it("routes prefixed models to the matching channel", () => {
    const multiChannelConfig = {
      ...config,
      channels: [
        deepseekChannel,
        {
          id: "kimi" as const,
          name: "Kimi",
          baseUrl: "https://api.moonshot.cn/v1",
          model: "kimi-k2.5",
          enabled: true,
          kind: "openai" as const,
          secrets: [...DEFAULT_OPENAI_CHANNEL_SECRETS],
          models: [],
          agentMappings: {},
        },
      ],
    };

    expect(resolveGatewayChannel(multiChannelConfig, "kimi/kimi-k2.5")).toEqual({
      channel: multiChannelConfig.channels[1],
      model: "kimi-k2.5",
    });
    expect(resolveGatewayChannel(multiChannelConfig, "deepseek/deepseek-reasoner")).toEqual({
      channel: multiChannelConfig.channels[0],
      model: "deepseek-reasoner",
    });
  });

  it("lists every configured enabled channel and skips incomplete channels", () => {
    expect(
      makeGatewayModelsPayload({
        ...config,
        channels: [
          deepseekChannel,
          {
            id: "kimi",
            name: "Kimi",
            baseUrl: "https://api.moonshot.cn/v1",
            model: "kimi-k2.5",
            enabled: true,
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
            enabled: true,
            kind: "openai",
            secrets: [...DEFAULT_OPENAI_CHANNEL_SECRETS],
            models: [],
            agentMappings: {},
          },
        ],
      }),
    ).toMatchObject({
      data: [{ id: "deepseek/deepseek-chat" }, { id: "kimi/kimi-k2.5" }],
    });
  });

  it("lists every model declared by an enabled channel", () => {
    expect(
      makeGatewayModelsPayload({
        ...config,
        channels: [
          {
            ...deepseekChannel,
            models: [
              { id: "deepseek-chat", label: "DeepSeek Chat" },
              { id: "deepseek-reasoner", label: "DeepSeek Reasoner" },
            ],
          },
        ],
      }),
    ).toMatchObject({
      data: [{ id: "deepseek/deepseek-chat" }, { id: "deepseek/deepseek-reasoner" }],
    });
  });

  it("preserves function calls and tool outputs from Responses input", () => {
    const payload = responsesPayloadToChatPayload({
      model: "deepseek/deepseek-chat",
      input: [
        {
          type: "function_call",
          call_id: "call_1",
          name: "read_file",
          arguments: '{"path":"README.md"}',
        },
        { type: "function_call_output", call_id: "call_1", output: "hello" },
      ],
    });

    expect(payload.messages).toEqual([
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "read_file", arguments: '{"path":"README.md"}' },
          },
        ],
      },
      { role: "tool", tool_call_id: "call_1", content: "hello" },
    ]);
  });

  it("replays stored Responses context for previous_response_id", async () => {
    const first = await chatResponseToResponsesResponse(
      Response.json({
        id: "resp_prev",
        created: 1,
        choices: [{ message: { content: "earlier answer" } }],
      }),
      "deepseek/deepseek-chat",
      [{ role: "user", content: [{ type: "input_text", text: "earlier question" }] }],
    );
    expect(first.status).toBe(200);

    const payload = responsesPayloadToChatPayload({
      model: "deepseek/deepseek-chat",
      previous_response_id: "resp_prev",
      input: [{ role: "user", content: [{ type: "input_text", text: "next question" }] }],
    });

    expect(payload.messages).toEqual([
      { role: "user", content: "earlier question" },
      { role: "assistant", content: "earlier answer" },
      { role: "user", content: "next question" },
    ]);
  });

  it("converts non-streaming chat tool calls to Responses output", async () => {
    const response = await chatResponseToResponsesResponse(
      Response.json({
        id: "chat_1",
        choices: [
          {
            message: {
              content: "",
              tool_calls: [
                {
                  id: "call_1",
                  function: { name: "read_file", arguments: '{"path":"README.md"}' },
                },
              ],
            },
          },
        ],
      }),
      "deepseek/deepseek-chat",
    );
    const payload = (await response.json()) as { output: Array<Record<string, unknown>> };
    expect(payload.output[0]).toMatchObject({
      type: "function_call",
      call_id: "call_1",
      name: "read_file",
      arguments: '{"path":"README.md"}',
    });
  });

  it("keeps parallel streaming tool call indexes separate", async () => {
    const upstream = new Response(
      [
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_a","function":{"name":"a","arguments":"{\\"x\\":"}},{"index":1,"id":"call_b","function":{"name":"b","arguments":"{\\"y\\":"}}]}}]}\n\n',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"1}"}},{"index":1,"function":{"arguments":"2}"}}]}}]}\n\n',
        "data: [DONE]\n\n",
      ].join(""),
      { headers: { "Content-Type": "text/event-stream" } },
    );

    const body = await chatStreamToResponsesStream(upstream, "deepseek/deepseek-chat").text();
    expect(body).toContain('"call_id":"call_a"');
    expect(body).toContain('"arguments":"{\\"x\\":1}"');
    expect(body).toContain('"call_id":"call_b"');
    expect(body).toContain('"arguments":"{\\"y\\":2}"');
  });
});

describe("dispatchGatewayChat", () => {
  it("rejects a MiMo channel when required cookies are missing", async () => {
    const response = await dispatchGatewayChat({
      channel: {
        id: "mimo",
        name: "小米 MiMo",
        baseUrl: "https://aistudio.xiaomimimo.com",
        model: "mimo-v2-flash-studio",
        enabled: true,
        kind: "mimo",
        secrets: [
          { id: "serviceToken", label: "Service Token", sensitive: true },
          { id: "userId", label: "User ID", sensitive: false },
          { id: "xiaomichatbot_ph", label: "PH Token", sensitive: true },
        ],
        models: [],
        agentMappings: {},
      },
      chatPayload: { model: "mimo/mimo-v2-flash-studio", messages: [], stream: false },
      secrets: { serviceToken: "tok" }, // userId + xiaomichatbot_ph missing
    });

    expect(response.status).toBe(401);
    const body = (await response.json()) as { error: { message: string } };
    expect(body.error.message).toContain("userId");
    expect(body.error.message).toContain("xiaomichatbot_ph");
  });

  it("throws on an unknown channel kind", () => {
    const bogusChannel = {
      id: "custom",
      name: "Bogus",
      baseUrl: "",
      model: "",
      enabled: true,
      // Deliberately invalid kind to exercise the default branch; cast because
      // the closed literal would otherwise reject it at compile time.
      kind: "bogus" as unknown as GatewayChannelConfig["kind"],
      secrets: [...DEFAULT_OPENAI_CHANNEL_SECRETS],
      models: [],
      agentMappings: {},
    } satisfies GatewayChannelConfig;
    expect(() =>
      dispatchGatewayChat({
        channel: bogusChannel,
        chatPayload: { messages: [] },
        secrets: {},
      }),
    ).toThrow(/Unsupported gateway channel kind/);
  });
});
