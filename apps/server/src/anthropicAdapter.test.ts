import { describe, expect, it } from "vitest";

import {
  anthropicToOpenAIChat,
  openAIChatToAnthropicMessages,
  openAIChatStreamToAnthropicStream,
} from "./anthropicAdapter";

// ------------------------------------------------------------------
// anthropicToOpenAIChat (request direction)
// ------------------------------------------------------------------

describe("anthropicToOpenAIChat", () => {
  it("maps a top-level system prompt to a system message", () => {
    const chat = anthropicToOpenAIChat({
      model: "claude-sonnet-4-5",
      system: "You are helpful.",
      messages: [{ role: "user", content: "hi" }],
    });
    expect((chat.messages as unknown[])[0]).toEqual({ role: "system", content: "You are helpful." });
  });

  it("joins a system content-block array into one system message", () => {
    const chat = anthropicToOpenAIChat({
      model: "m",
      system: [{ type: "text", text: "rule one" }, { type: "text", text: "rule two" }],
      messages: [{ role: "user", content: "hi" }],
    });
    expect((chat.messages as unknown[])[0]).toEqual({
      role: "system",
      content: "rule one\nrule two",
    });
  });

  it("converts string content user messages verbatim", () => {
    const chat = anthropicToOpenAIChat({
      model: "m",
      messages: [{ role: "user", content: "hello world" }],
    });
    expect(chat.messages).toEqual([{ role: "user", content: "hello world" }]);
  });

  it("converts assistant tool_use blocks into OpenAI tool_calls", () => {
    const chat = anthropicToOpenAIChat({
      model: "m",
      messages: [
        {
          role: "assistant",
          content: [
            { type: "text", text: "calling tool" },
            {
              type: "tool_use",
              id: "toolu_1",
              name: "read_file",
              input: { path: "README.md" },
            },
          ],
        },
      ],
    });
    const assistant = (chat.messages as unknown[])[0] as {
      role: string;
      content: string | null;
      tool_calls: Array<{ id: string; type: string; function: { name: string; arguments: string } }>;
    };
    expect(assistant.role).toBe("assistant");
    expect(assistant.content).toBe("calling tool");
    expect(assistant.tool_calls).toEqual([
      {
        id: "toolu_1",
        type: "function",
        function: { name: "read_file", arguments: JSON.stringify({ path: "README.md" }) },
      },
    ]);
  });

  it("converts user tool_result blocks into OpenAI tool messages", () => {
    const chat = anthropicToOpenAIChat({
      model: "m",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_1",
              content: [{ type: "text", text: "file contents" }],
            },
          ],
        },
      ],
    });
    expect(chat.messages).toEqual([
      { role: "tool", tool_call_id: "toolu_1", content: "file contents" },
    ]);
  });

  it("maps Anthropic tools (input_schema) to OpenAI function tools", () => {
    const chat = anthropicToOpenAIChat({
      model: "m",
      messages: [{ role: "user", content: "hi" }],
      tools: [
        {
          name: "read_file",
          description: "Reads a file",
          input_schema: { type: "object", properties: { path: { type: "string" } } },
        },
      ],
    });
    expect(chat.tools).toEqual([
      {
        type: "function",
        function: {
          name: "read_file",
          description: "Reads a file",
          parameters: { type: "object", properties: { path: { type: "string" } } },
        },
      },
    ]);
  });

  it("preserves max_tokens, temperature, top_p, stream", () => {
    const chat = anthropicToOpenAIChat({
      model: "m",
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 1024,
      temperature: 0.5,
      top_p: 0.9,
      stream: true,
    });
    expect(chat).toMatchObject({ max_tokens: 1024, temperature: 0.5, top_p: 0.9, stream: true });
  });
});

// ------------------------------------------------------------------
// openAIChatToAnthropicMessages (non-streaming response)
// ------------------------------------------------------------------

describe("openAIChatToAnthropicMessages", () => {
  it("converts text content into a text block with end_turn stop_reason", async () => {
    const openai = Response.json({
      id: "chatcmpl_1",
      choices: [
        { message: { content: "Hello!" }, finish_reason: "stop" },
      ],
      usage: { prompt_tokens: 3, completion_tokens: 2 },
    });
    const res = await openAIChatToAnthropicMessages(openai, "claude-sonnet-4-5");
    const body = (await res.json()) as {
      type: string;
      role: string;
      content: Array<{ type: string; text: string }>;
      stop_reason: string;
      usage: { input_tokens: number; output_tokens: number };
    };
    expect(body.type).toBe("message");
    expect(body.role).toBe("assistant");
    expect(body.content).toEqual([{ type: "text", text: "Hello!" }]);
    expect(body.stop_reason).toBe("end_turn");
    expect(body.usage).toEqual({ input_tokens: 3, output_tokens: 2 });
  });

  it("converts tool_calls into tool_use blocks with parsed input", async () => {
    const openai = Response.json({
      id: "chatcmpl_2",
      choices: [
        {
          message: {
            content: null,
            tool_calls: [
              {
                id: "call_1",
                function: { name: "read_file", arguments: '{"path":"README.md"}' },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
    });
    const res = await openAIChatToAnthropicMessages(openai, "m");
    const body = (await res.json()) as {
      content: Array<{ type: string; id: string; name: string; input: unknown }>;
      stop_reason: string;
    };
    expect(body.content[0]).toMatchObject({
      type: "tool_use",
      id: "call_1",
      name: "read_file",
      input: { path: "README.md" },
    });
    expect(body.stop_reason).toBe("tool_use");
  });

  it("maps length finish_reason to max_tokens", async () => {
    const openai = Response.json({
      choices: [{ message: { content: "..." }, finish_reason: "length" }],
    });
    const res = await openAIChatToAnthropicMessages(openai, "m");
    const body = (await res.json()) as { stop_reason: string };
    expect(body.stop_reason).toBe("max_tokens");
  });

  it("passes through non-2xx status unchanged", async () => {
    const openai = Response.json({ error: "rate limited" }, { status: 429 });
    const res = await openAIChatToAnthropicMessages(openai, "m");
    expect(res.status).toBe(429);
  });
});

// ------------------------------------------------------------------
// openAIChatStreamToAnthropicStream
// ------------------------------------------------------------------

describe("openAIChatStreamToAnthropicStream", () => {
  function openaiSseResponse(events: ReadonlyArray<string>): Response {
    return new Response(events.join(""), { headers: { "Content-Type": "text/event-stream" } });
  }

  type ParsedEvent = { event: string; data: Record<string, unknown> };

  function parseSse(text: string): ParsedEvent[] {
    const events: ParsedEvent[] = [];
    for (const block of text.split(/\n\n/)) {
      const lines = block.split(/\n/);
      const eventLine = lines.find((l) => l.startsWith("event:"));
      const dataLines = lines.filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim());
      if (!eventLine || dataLines.length === 0) continue;
      const eventType = eventLine.slice(6).trim();
      try {
        events.push({ event: eventType, data: JSON.parse(dataLines.join("\n")) as Record<string, unknown> });
      } catch {
        // skip
      }
    }
    return events;
  }

  it("emits the full Anthropic event sequence for a text stream", async () => {
    const upstream = openaiSseResponse([
      'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":" world"}}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
      "data: [DONE]\n\n",
    ]);
    const text = await openAIChatStreamToAnthropicStream(upstream, "claude-sonnet-4-5").text();
    const events = parseSse(text);
    const types = events.map((e) => e.event);

    expect(types[0]).toBe("message_start");
    expect(types).toContain("content_block_start");
    expect(types).toContain("content_block_delta");
    expect(types).toContain("content_block_stop");
    expect(types).toContain("message_delta");
    expect(types.at(-1)).toBe("message_stop");
  });

  it("streams text deltas as text_delta events", async () => {
    const upstream = openaiSseResponse([
      'data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
      "data: [DONE]\n\n",
    ]);
    const text = await openAIChatStreamToAnthropicStream(upstream, "m").text();
    const events = parseSse(text);
    const deltas = events.filter((e) => e.event === "content_block_delta");
    expect(deltas[0]?.data.delta).toEqual({ type: "text_delta", text: "Hi" });
  });

  it("carries the stop_reason in message_delta", async () => {
    const upstream = openaiSseResponse([
      'data: {"choices":[{"delta":{"content":"x"},"finish_reason":"stop"}]}\n\n',
      "data: [DONE]\n\n",
    ]);
    const text = await openAIChatStreamToAnthropicStream(upstream, "m").text();
    const events = parseSse(text);
    const msgDelta = events.find((e) => e.event === "message_delta");
    expect(msgDelta?.data.delta).toMatchObject({ stop_reason: "end_turn" });
  });

  it("emits tool_use blocks when the upstream stream has tool_calls", async () => {
    // Use a single complete tool_call chunk (id + name + full arguments) to
    // avoid cross-chunk argument reassembly flakiness in the assertion.
    const upstream = openaiSseResponse([
      `data: ${JSON.stringify({
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call_1",
                  function: { name: "read", arguments: JSON.stringify({ a: 1 }) },
                },
              ],
            },
          },
        ],
      })}\n\n`,
      `data: ${JSON.stringify({
        choices: [{ delta: {}, finish_reason: "tool_calls" }],
      })}\n\n`,
      "data: [DONE]\n\n",
    ]);
    const text = await openAIChatStreamToAnthropicStream(upstream, "m").text();
    expect(text).toContain('"type":"tool_use"');
    expect(text).toContain('"id":"call_1"');
    expect(text).toContain('"name":"read"');
    expect(text).toContain('"input":{"a":1}');
    expect(text).toContain('"stop_reason":"tool_use"');
  });
});
