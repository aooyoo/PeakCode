import { randomUUID } from "node:crypto";

import type { GatewayChannelConfig, GatewayChannelId, GatewayConfig } from "@peakcode/contracts";

export const GATEWAY_ROUTE_PREFIX = "/gateway/openai/v1";

export function gatewaySecretName(channelId: GatewayChannelId): string {
  return `gateway.channel.${channelId}.apiKey`;
}

export function resolveGatewayChannel(
  config: GatewayConfig,
  requestedModel: string | null,
): { channel: GatewayChannelConfig | null; model: string | null } {
  const slashIndex = requestedModel?.indexOf("/") ?? -1;
  const requestedChannelId = slashIndex > 0 ? requestedModel?.slice(0, slashIndex) : null;
  const channelId = config.channels.some((channel) => channel.id === requestedChannelId)
    ? requestedChannelId
    : config.activeChannelId;
  const channel = config.channels.find((candidate) => candidate.id === channelId) ?? null;
  const model =
    requestedModel && requestedChannelId === channelId
      ? requestedModel.slice(slashIndex + 1)
      : requestedModel || channel?.model || null;
  return { channel, model };
}

export function makeGatewayModelsPayload(config: GatewayConfig) {
  return {
    object: "list",
    data: config.channels.flatMap((channel) =>
      channel.enabled && channel.baseUrl && channel.model
        ? [
            {
              id: `${channel.id}/${channel.model}`,
              object: "model",
              created: 0,
              owned_by: channel.id,
            },
          ]
        : [],
    ),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function joinUrl(baseUrl: string, suffix: string): string {
  return `${baseUrl.replace(/\/+$/u, "")}/${suffix.replace(/^\/+/u, "")}`;
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((part) => {
      if (!isRecord(part)) return [];
      const text = part.text;
      return typeof text === "string" ? [text] : [];
    })
    .join("\n");
}

function responsesInputToMessages(payload: Record<string, unknown>): Record<string, unknown>[] {
  const messages: Record<string, unknown>[] = [];
  if (typeof payload.instructions === "string" && payload.instructions.trim()) {
    messages.push({ role: "system", content: payload.instructions });
  }
  const input = Array.isArray(payload.input) ? payload.input : [payload.input];
  for (const item of input) {
    if (typeof item === "string") {
      messages.push({ role: "user", content: item });
      continue;
    }
    if (!isRecord(item)) continue;
    if (item.type === "function_call_output") {
      messages.push({
        role: "tool",
        tool_call_id: item.call_id,
        content: typeof item.output === "string" ? item.output : JSON.stringify(item.output ?? ""),
      });
      continue;
    }
    if (item.type === "function_call") {
      messages.push({
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: item.call_id ?? item.id ?? `call_${randomUUID()}`,
            type: "function",
            function: {
              name: item.name,
              arguments:
                typeof item.arguments === "string"
                  ? item.arguments
                  : JSON.stringify(item.arguments ?? {}),
            },
          },
        ],
      });
      continue;
    }
    const role = item.role === "developer" ? "system" : (item.role ?? "user");
    messages.push({ role, content: item.content ?? item.text ?? "" });
  }
  return messages;
}

function responsesToolsToChatTools(tools: unknown): unknown {
  if (!Array.isArray(tools)) return undefined;
  const converted = tools.flatMap((tool) => {
    if (!isRecord(tool) || tool.type !== "function" || typeof tool.name !== "string") return [];
    return [
      {
        type: "function",
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
          strict: tool.strict,
        },
      },
    ];
  });
  return converted.length > 0 ? converted : undefined;
}

export function responsesPayloadToChatPayload(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {
    model: payload.model,
    messages: responsesInputToMessages(payload),
    stream: payload.stream === true,
  };
  const tools = responsesToolsToChatTools(payload.tools);
  if (tools) result.tools = tools;
  if (payload.tool_choice !== undefined) result.tool_choice = payload.tool_choice;
  if (payload.temperature !== undefined) result.temperature = payload.temperature;
  if (payload.top_p !== undefined) result.top_p = payload.top_p;
  if (payload.max_output_tokens !== undefined) result.max_tokens = payload.max_output_tokens;
  return result;
}

export async function proxyGatewayChat(input: {
  config: GatewayConfig;
  payload: Record<string, unknown>;
  apiKey: string;
  signal?: AbortSignal | null;
}): Promise<Response> {
  const requestedModel =
    typeof input.payload.model === "string" ? input.payload.model.trim() : null;
  const { channel, model } = resolveGatewayChannel(input.config, requestedModel);
  if (!channel || !channel.enabled || !channel.baseUrl || !model) {
    return Response.json(
      { error: { type: "peakcode_gateway_error", message: "Gateway channel is not configured." } },
      { status: 400 },
    );
  }
  return fetch(joinUrl(channel.baseUrl, "chat/completions"), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${input.apiKey}`,
      "Content-Type": "application/json",
      Accept: input.payload.stream === true ? "text/event-stream" : "application/json",
    },
    body: JSON.stringify({ ...input.payload, model }),
    signal: input.signal ?? null,
  });
}

function chatToolCallsToResponseItems(toolCalls: unknown): unknown[] {
  if (!Array.isArray(toolCalls)) return [];
  return toolCalls.flatMap((toolCall) => {
    if (!isRecord(toolCall) || !isRecord(toolCall.function)) return [];
    const callId =
      typeof toolCall.id === "string" && toolCall.id ? toolCall.id : `call_${randomUUID()}`;
    return [
      {
        id: `fc_${randomUUID()}`,
        type: "function_call",
        status: "completed",
        call_id: callId,
        name: toolCall.function.name,
        arguments: toolCall.function.arguments ?? "{}",
      },
    ];
  });
}

export async function chatResponseToResponsesResponse(
  response: Response,
  requestedModel: unknown,
): Promise<Response> {
  const payload = (await response.json()) as unknown;
  if (!response.ok || !isRecord(payload))
    return Response.json(payload, { status: response.status });
  const firstChoice =
    Array.isArray(payload.choices) && isRecord(payload.choices[0]) ? payload.choices[0] : null;
  const message = firstChoice && isRecord(firstChoice.message) ? firstChoice.message : null;
  const output: unknown[] = [];
  const text = message ? textFromContent(message.content) : "";
  if (text) {
    output.push({
      id: `msg_${randomUUID()}`,
      type: "message",
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", text, annotations: [] }],
    });
  }
  if (message) output.push(...chatToolCallsToResponseItems(message.tool_calls));
  return Response.json(
    {
      id: typeof payload.id === "string" ? payload.id : `resp_${randomUUID()}`,
      object: "response",
      created_at:
        typeof payload.created === "number" ? payload.created : Math.floor(Date.now() / 1000),
      status: "completed",
      model: requestedModel ?? payload.model,
      output,
      usage: payload.usage,
    },
    { status: response.status },
  );
}

function sse(event: Record<string, unknown>): string {
  return `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`;
}

export function chatStreamToResponsesStream(response: Response, requestedModel: unknown): Response {
  if (!response.body) {
    return Response.json(
      { error: { type: "peakcode_gateway_error", message: "Upstream returned an empty stream." } },
      { status: 502 },
    );
  }
  const responseId = `resp_${randomUUID()}`;
  const messageId = `msg_${randomUUID()}`;
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const body = response.body;
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: Record<string, unknown>) =>
        controller.enqueue(encoder.encode(sse(event)));
      send({
        type: "response.created",
        response: {
          id: responseId,
          object: "response",
          status: "in_progress",
          model: requestedModel,
          output: [],
        },
      });
      send({
        type: "response.in_progress",
        response: {
          id: responseId,
          object: "response",
          status: "in_progress",
          model: requestedModel,
          output: [],
        },
      });
      let buffer = "";
      let text = "";
      let messageStarted = false;
      const toolCalls = new Map<
        number,
        { id: string; callId: string; name: string; arguments: string; outputIndex: number }
      >();
      const reader = body.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const blocks = buffer.split(/\r?\n\r?\n/u);
          buffer = blocks.pop() ?? "";
          for (const block of blocks) {
            const data = block
              .split(/\r?\n/u)
              .filter((line) => line.startsWith("data:"))
              .map((line) => line.slice(5).trim())
              .join("\n");
            if (!data || data === "[DONE]") continue;
            const chunk = JSON.parse(data) as unknown;
            if (!isRecord(chunk) || !Array.isArray(chunk.choices)) continue;
            for (const choice of chunk.choices) {
              if (!isRecord(choice) || !isRecord(choice.delta)) continue;
              const delta = choice.delta;
              if (typeof delta.content === "string" && delta.content) {
                if (!messageStarted) {
                  messageStarted = true;
                  send({
                    type: "response.output_item.added",
                    output_index: 0,
                    item: {
                      id: messageId,
                      type: "message",
                      status: "in_progress",
                      role: "assistant",
                      content: [],
                    },
                  });
                  send({
                    type: "response.content_part.added",
                    item_id: messageId,
                    output_index: 0,
                    content_index: 0,
                    part: { type: "output_text", text: "", annotations: [] },
                  });
                }
                text += delta.content;
                send({
                  type: "response.output_text.delta",
                  item_id: messageId,
                  output_index: 0,
                  content_index: 0,
                  delta: delta.content,
                });
              }
              if (!Array.isArray(delta.tool_calls)) continue;
              for (const rawToolCall of delta.tool_calls) {
                if (!isRecord(rawToolCall)) continue;
                const index = typeof rawToolCall.index === "number" ? rawToolCall.index : 0;
                const fn = isRecord(rawToolCall.function) ? rawToolCall.function : {};
                let toolCall = toolCalls.get(index);
                if (!toolCall) {
                  const callId =
                    typeof rawToolCall.id === "string" && rawToolCall.id
                      ? rawToolCall.id
                      : `call_${randomUUID()}`;
                  toolCall = {
                    id: `fc_${randomUUID()}`,
                    callId,
                    name: typeof fn.name === "string" ? fn.name : "",
                    arguments: "",
                    outputIndex: (messageStarted ? 1 : 0) + toolCalls.size,
                  };
                  toolCalls.set(index, toolCall);
                  send({
                    type: "response.output_item.added",
                    output_index: toolCall.outputIndex,
                    item: {
                      id: toolCall.id,
                      type: "function_call",
                      status: "in_progress",
                      call_id: callId,
                      name: toolCall.name,
                      arguments: "",
                    },
                  });
                }
                if (typeof fn.name === "string" && fn.name) toolCall.name = fn.name;
                if (typeof fn.arguments === "string" && fn.arguments) {
                  toolCall.arguments += fn.arguments;
                  send({
                    type: "response.function_call_arguments.delta",
                    item_id: toolCall.id,
                    output_index: toolCall.outputIndex,
                    delta: fn.arguments,
                  });
                }
              }
            }
          }
        }
        if (messageStarted) {
          send({
            type: "response.output_text.done",
            item_id: messageId,
            output_index: 0,
            content_index: 0,
            text,
          });
          send({
            type: "response.content_part.done",
            item_id: messageId,
            output_index: 0,
            content_index: 0,
            part: { type: "output_text", text, annotations: [] },
          });
          send({
            type: "response.output_item.done",
            output_index: 0,
            item: {
              id: messageId,
              type: "message",
              status: "completed",
              role: "assistant",
              content: [{ type: "output_text", text, annotations: [] }],
            },
          });
        }
        for (const toolCall of toolCalls.values()) {
          send({
            type: "response.function_call_arguments.done",
            item_id: toolCall.id,
            output_index: toolCall.outputIndex,
            arguments: toolCall.arguments,
          });
          send({
            type: "response.output_item.done",
            output_index: toolCall.outputIndex,
            item: {
              id: toolCall.id,
              type: "function_call",
              status: "completed",
              call_id: toolCall.callId,
              name: toolCall.name,
              arguments: toolCall.arguments,
            },
          });
        }
        send({
          type: "response.completed",
          response: {
            id: responseId,
            object: "response",
            status: "completed",
            model: requestedModel,
            output: [
              ...(messageStarted
                ? [
                    {
                      id: messageId,
                      type: "message",
                      status: "completed",
                      role: "assistant",
                      content: [{ type: "output_text", text, annotations: [] }],
                    },
                  ]
                : []),
              ...Array.from(toolCalls.values()).map((toolCall) => ({
                id: toolCall.id,
                type: "function_call",
                status: "completed",
                call_id: toolCall.callId,
                name: toolCall.name,
                arguments: toolCall.arguments,
              })),
            ],
          },
        });
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      } catch (cause) {
        controller.error(cause);
      } finally {
        reader.releaseLock();
      }
    },
  });
  return new Response(stream, {
    status: response.status,
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
