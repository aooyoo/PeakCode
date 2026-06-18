import { describe, expect, it } from "vitest";

import {
  mimoBuildQuery,
  mimoBuildRequestBody,
  mimoMissingSecrets,
  mimoResponseToChatResponse,
  mimoStreamToChatStream,
  parseThinkTags,
} from "./mimoAdapter";

describe("mimoBuildQuery", () => {
  it("flattens messages as 'role: content' joined by newlines", () => {
    const query = mimoBuildQuery([
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi there" },
    ]);
    expect(query).toBe("user: hello\nassistant: hi there");
  });

  it("keeps only the last 10 messages", () => {
    const messages = Array.from({ length: 15 }, (_, i) => ({
      role: "user" as const,
      content: `m${i}`,
    }));
    const query = mimoBuildQuery(messages);
    const lines = query.split("\n");
    expect(lines).toHaveLength(10);
    expect(lines[0]).toBe("user: m5");
    expect(lines.at(-1)).toBe("user: m14");
  });

  it("truncates content longer than 4000 chars and appends ellipsis", () => {
    const long = "a".repeat(4001);
    const query = mimoBuildQuery([{ role: "user", content: long }]);
    // "user: " (6) + 4000 truncated body + "..." (3)
    expect(query.length).toBe(6 + 4000 + 3);
    expect(query.endsWith("...")).toBe(true);
  });

  it("extracts text from array content parts", () => {
    const query = mimoBuildQuery([
      { role: "user", content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] },
    ]);
    expect(query).toBe("user: a\nb");
  });

  it("returns empty string for non-array input", () => {
    expect(mimoBuildQuery(null)).toBe("");
    expect(mimoBuildQuery("not an array")).toBe("");
  });
});

describe("mimoBuildRequestBody", () => {
  it("sets enableThinking true when reasoning_effort is a non-empty string", () => {
    const body = mimoBuildRequestBody({ reasoning_effort: "medium", messages: [] });
    expect(body.modelConfig).toMatchObject({ enableThinking: true, model: "mimo-v2-flash-studio" });
  });

  it("sets enableThinking false when reasoning_effort is absent or empty", () => {
    expect(mimoBuildRequestBody({ messages: [] }).modelConfig).toMatchObject({
      enableThinking: false,
    });
    expect(mimoBuildRequestBody({ reasoning_effort: "", messages: [] }).modelConfig).toMatchObject({
      enableThinking: false,
    });
  });

  it("drops tools/function fields (unsupported upstream)", () => {
    const body = mimoBuildRequestBody({
      messages: [],
      tools: [{ type: "function", function: { name: "x" } }],
      tool_choice: "auto",
    });
    expect(body).not.toHaveProperty("tools");
    expect(body).not.toHaveProperty("tool_choice");
  });

  it("generates fresh 32-hex msgId and conversationId per call", () => {
    const a = mimoBuildRequestBody({ messages: [] });
    const b = mimoBuildRequestBody({ messages: [] });
    expect(typeof a.msgId).toBe("string");
    expect(a.msgId).toHaveLength(32);
    expect(a.conversationId).toHaveLength(32);
    expect(a.msgId).not.toBe(b.msgId);
    expect(a.conversationId).not.toBe(b.conversationId);
  });
});

describe("mimoMissingSecrets", () => {
  it("returns all three ids when nothing is provided", () => {
    expect(mimoMissingSecrets({})).toEqual([
      "serviceToken",
      "userId",
      "xiaomichatbot_ph",
    ]);
  });

  it("returns only the blank ones", () => {
    expect(
      mimoMissingSecrets({ serviceToken: "tok", userId: "   ", xiaomichatbot_ph: "ph" }),
    ).toEqual(["userId"]);
  });

  it("returns empty when all three are present", () => {
    expect(
      mimoMissingSecrets({ serviceToken: "tok", userId: "1", xiaomichatbot_ph: "ph" }),
    ).toEqual([]);
  });
});

describe("parseThinkTags", () => {
  it("returns content unchanged and empty think when no tag present", () => {
    expect(parseThinkTags("just text")).toEqual({ content: "just text", think: "" });
  });

  it("splits a complete think block", () => {
    const { content, think } = parseThinkTags("before<think>reasoning</think>after");
    expect(think).toBe("reasoning");
    expect(content).toBe("beforeafter");
  });

  it("treats an unterminated think block as all reasoning", () => {
    const { content, think } = parseThinkTags("text<think>ongoing");
    expect(content).toBe("text");
    expect(think).toBe("ongoing");
  });
});

describe("mimoResponseToChatResponse", () => {
  function mimoSseResponse(events: ReadonlyArray<string>): Response {
    return new Response(events.join(""), { headers: { "Content-Type": "text/event-stream" } });
  }

  it("accumulates text events into a single chat.completion object", async () => {
    const upstream = mimoSseResponse([
      'data: {"type":"text","content":"Hello"}\n',
      'data: {"type":"text","content":", world"}\n',
      'data: {"promptTokens":5,"completionTokens":2}\n',
    ]);
    const response = await mimoResponseToChatResponse(upstream, "mimo/mimo-v2-flash-studio");
    const body = (await response.json()) as {
      object: string;
      choices: Array<{ message: { content: string }; finish_reason: string }>;
      usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
    };
    expect(body.object).toBe("chat.completion");
    expect(body.choices[0]?.message.content).toBe("Hello, world");
    expect(body.choices[0]?.finish_reason).toBe("stop");
    expect(body.usage).toEqual({ prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 });
  });

  it("inlines reasoning as <think>...</think> prefix in non-streaming mode", async () => {
    const upstream = mimoSseResponse([
      'data: {"type":"text","content":"<think>why</think>answer"}\n',
    ]);
    const response = await mimoResponseToChatResponse(upstream, "mimo/mimo-v2-flash-studio");
    const body = (await response.json()) as {
      choices: Array<{ message: { content: string } }>;
    };
    expect(body.choices[0]?.message.content).toBe("<think>why</think>\nanswer");
  });

  it("skips malformed data lines without throwing", async () => {
    const upstream = mimoSseResponse([
      "data: not json\n",
      'data: {"type":"text","content":"ok"}\n',
    ]);
    const response = await mimoResponseToChatResponse(upstream, "mimo/mimo-v2-flash-studio");
    const body = (await response.json()) as {
      choices: Array<{ message: { content: string } }>;
    };
    expect(body.choices[0]?.message.content).toBe("ok");
  });
});

describe("mimoStreamToChatStream", () => {
  type CollectedChunk = {
    delta: { content?: string; reasoning?: string; role?: string };
    finish_reason: string | null;
  };

  function mimoSseResponse(chunks: ReadonlyArray<string>): Response {
    return new Response(chunks.join(""), { headers: { "Content-Type": "text/event-stream" } });
  }

  async function collectChunks(response: Response): Promise<CollectedChunk[]> {
    const text = await response.text();
    const parsed: CollectedChunk[] = [];
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const data = trimmed.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      const chunk = JSON.parse(data) as {
        choices: Array<{
          delta: { content?: string; reasoning?: string; role?: string };
          finish_reason?: string | null;
        }>;
      };
      const choice = chunk.choices[0];
      if (choice) {
        parsed.push({ delta: choice.delta, finish_reason: choice.finish_reason ?? null });
      }
    }
    return parsed;
  }

  it("emits role then content deltas then a stop finish_reason", async () => {
    const upstream = mimoSseResponse([
      'data: {"type":"text","content":"Hi"}\n',
      'data: {"type":"text","content":" there"}\n',
    ]);
    const chunks = await collectChunks(mimoStreamToChatStream(upstream, "mimo/mimo-v2-flash-studio"));
    // First chunk is always the role delta.
    expect(chunks[0]?.delta).toEqual({ role: "assistant" });
    // The tag-state machine holds back a few trailing chars to avoid splitting
    // a potential `<think>` marker, so individual chunk boundaries don't line
    // up with SSE events — but the concatenated content must be complete.
    const content = chunks
      .filter((c) => c.delta.content)
      .map((c) => c.delta.content)
      .join("");
    expect(content).toBe("Hi there");
    expect(chunks.at(-1)?.finish_reason).toBe("stop");
  });

  it("routes think-enclosed text to delta.reasoning and the rest to delta.content", async () => {
    const upstream = mimoSseResponse([
      'data: {"type":"text","content":"<think>reasoning</think>answer"}\n',
    ]);
    const chunks = await collectChunks(mimoStreamToChatStream(upstream, "mimo/mimo-v2-flash-studio"));
    const reasoning = chunks.filter((c) => c.delta.reasoning).map((c) => c.delta.reasoning).join("");
    const content = chunks.filter((c) => c.delta.content).map((c) => c.delta.content).join("");
    expect(reasoning).toBe("reasoning");
    expect(content).toBe("answer");
  });

  it("does not split a <think> tag across chunk boundaries", async () => {
    // The opening "<think>" arrives split across two SSE events: "<thi" then
    // "nk>reasoning</think>out". The holdback must keep "<thi" buffered until
    // the rest arrives, so no partial "<thi" leaks as content.
    const upstream = mimoSseResponse([
      'data: {"type":"text","content":"<thi"}\n',
      'data: {"type":"text","content":"nk>reasoning</think>out"}\n',
    ]);
    const chunks = await collectChunks(mimoStreamToChatStream(upstream, "mimo/mimo-v2-flash-studio"));
    const allContent = chunks.filter((c) => c.delta.content).map((c) => c.delta.content).join("");
    const allReasoning = chunks.filter((c) => c.delta.reasoning).map((c) => c.delta.reasoning).join("");
    // Nothing should have leaked as content before the tag resolved.
    expect(allContent).toBe("out");
    expect(allReasoning).toBe("reasoning");
  });

  it("flushes a buffered partial tag at EOF when no marker follows", async () => {
    // "<thi" arrives then the stream ends; with no closing marker, the buffered
    // partial must be emitted as content (it was never a real tag).
    const upstream = mimoSseResponse(['data: {"type":"text","content":"ab<thi"}\n']);
    const chunks = await collectChunks(mimoStreamToChatStream(upstream, "mimo/mimo-v2-flash-studio"));
    const content = chunks.filter((c) => c.delta.content).map((c) => c.delta.content).join("");
    expect(content).toBe("ab<thi");
  });
});
