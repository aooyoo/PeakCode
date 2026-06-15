import { describe, expect, it } from "vitest";

import {
  chatResponseToResponsesResponse,
  chatStreamToResponsesStream,
  makeGatewayModelsPayload,
  resolveGatewayChannel,
  responsesPayloadToChatPayload,
} from "./gateway";

const config = {
  enabled: true,
  activeChannelId: "deepseek" as const,
  channels: [
    {
      id: "deepseek" as const,
      name: "DeepSeek",
      baseUrl: "https://api.deepseek.com/v1",
      model: "deepseek-chat",
      enabled: true,
    },
  ],
};

describe("gateway protocol conversion", () => {
  const deepseek = config.channels[0]!;

  it("routes prefixed models to the matching channel", () => {
    const multiChannelConfig = {
      ...config,
      channels: [
        deepseek,
        {
          id: "kimi" as const,
          name: "Kimi",
          baseUrl: "https://api.moonshot.cn/v1",
          model: "kimi-k2.5",
          enabled: true,
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
          deepseek,
          {
            id: "kimi",
            name: "Kimi",
            baseUrl: "https://api.moonshot.cn/v1",
            model: "kimi-k2.5",
            enabled: true,
          },
          {
            id: "volcano",
            name: "火山方舟",
            baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
            model: "",
            enabled: true,
          },
        ],
      }),
    ).toMatchObject({
      data: [{ id: "deepseek/deepseek-chat" }, { id: "kimi/kimi-k2.5" }],
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
