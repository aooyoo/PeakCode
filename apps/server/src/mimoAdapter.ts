// FILE: mimoAdapter.ts
// Purpose: Adapts Xiaomi MiMo's private chat protocol
//          (https://aistudio.xiaomimimo.com/open-apis/bot/chat) into an
//          OpenAI-compatible chat/completions surface, so the gateway can
//          treat it uniformly with OpenAI-compatible channels.
// Layer: Server gateway adapter
//
// Reference: https://github.com/Water008/MiMo2API (Python reference impl).
// MiMo upstream is stateless from this client's perspective: msgId and
// conversationId are regenerated per request, multi-turn context is carried
// only by the flattened `query` string built from the message list.

import { randomUUID } from "node:crypto";

// ------------------------------------------------------------------
// Constants mirroring the upstream MiMo contract
// ------------------------------------------------------------------

const MIMO_CHAT_PATH = "/open-apis/bot/chat";
const MIMO_UPSTREAM_MODEL = "mimo-v2-flash-studio";
const MIMO_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36";

/** Messages kept when flattening into the upstream `query`. */
const MIMO_MAX_MESSAGES = 10;
/** Per-message character cap before truncation. */
const MIMO_MAX_CONTENT_LEN = 4000;
/** Holdback sizes so a `<think>`/`</think>` tag split across SSE chunks is not emitted broken. */
const THINK_OPEN = "<think>";
const THINK_CLOSE = "</think>";
const THINK_OPEN_HOLDBACK = THINK_OPEN.length;
const THINK_CLOSE_HOLDBACK = THINK_CLOSE.length;

// ------------------------------------------------------------------
// Types
// ------------------------------------------------------------------

export interface MimoSecrets {
  readonly serviceToken: string;
  readonly userId: string;
  readonly xiaomichatbot_ph: string;
}

export interface MimoAdapterInput {
  /** Channel base URL, e.g. https://aistudio.xiaomimimo.com (no trailing slash). */
  readonly baseUrl: string;
  /** OpenAI chat/completions payload (model already resolved). */
  readonly chatPayload: Record<string, unknown>;
  /** Resolved cookie values keyed by secret id. */
  readonly secrets: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal | null;
}

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function joinUrl(baseUrl: string, suffix: string): string {
  return `${baseUrl.replace(/\/+$/u, "")}/${suffix.replace(/^\/+/u, "")}`;
}

/** 32-char hex id, matching MiMo's msgId/conversationId format. */
function mimoId(): string {
  return randomUUID().replace(/-/gu, "").slice(0, 32);
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((part) => {
      if (!isRecord(part)) return [];
      return typeof part.text === "string" ? [part.text] : [];
    })
    .join("\n");
}

/**
 * Flattens the OpenAI message list into the single `query` string MiMo
 * expects. Mirrors MiMo2API: take the last MIMO_MAX_MESSAGES, truncate each
 * content to MIMO_MAX_CONTENT_LEN, join as `"{role}: {content}\n"`.
 */
export function mimoBuildQuery(messages: unknown): string {
  if (!Array.isArray(messages)) return "";
  const tail = messages.slice(-MIMO_MAX_MESSAGES);
  return tail
    .map((message) => {
      if (!isRecord(message)) return "";
      const role = typeof message.role === "string" ? message.role : "user";
      const rawContent = textFromContent(message.content);
      const content =
        rawContent.length > MIMO_MAX_CONTENT_LEN
          ? `${rawContent.slice(0, MIMO_MAX_CONTENT_LEN)}...`
          : rawContent;
      return `${role}: ${content}`;
    })
    .filter((line) => line.length > 0)
    .join("\n");
}

/**
 * Builds the upstream MiMo request body from an OpenAI chat payload.
 *
 * Tool/function-calling is not supported by the upstream, so `tools` and
 * related fields are intentionally dropped.
 */
export function mimoBuildRequestBody(chatPayload: Record<string, unknown>): Record<string, unknown> {
  const reasoningEffort = chatPayload.reasoning_effort;
  const enableThinking =
    typeof reasoningEffort === "string" ? reasoningEffort.trim().length > 0 : Boolean(reasoningEffort);
  return {
    msgId: mimoId(),
    conversationId: mimoId(),
    query: mimoBuildQuery(chatPayload.messages),
    modelConfig: {
      enableThinking,
      temperature: 0.8,
      topP: 0.95,
      webSearchStatus: "disabled",
      model: MIMO_UPSTREAM_MODEL,
    },
    multiMedias: [],
  };
}

function resolveMimoSecrets(secrets: Readonly<Record<string, string>>): MimoSecrets {
  const serviceToken = (secrets.serviceToken ?? "").trim();
  const userId = (secrets.userId ?? "").trim();
  const xiaomichatbot_ph = (secrets.xiaomichatbot_ph ?? "").trim();
  return { serviceToken, userId, xiaomichatbot_ph };
}

/** Returns the ids of required MiMo cookies that are missing/blank. */
export function mimoMissingSecrets(secrets: Readonly<Record<string, string>>): string[] {
  const { serviceToken, userId, xiaomichatbot_ph } = resolveMimoSecrets(secrets);
  const missing: string[] = [];
  if (!serviceToken) missing.push("serviceToken");
  if (!userId) missing.push("userId");
  if (!xiaomichatbot_ph) missing.push("xiaomichatbot_ph");
  return missing;
}

function mimoCookieHeader(secrets: MimoSecrets): string {
  return `serviceToken=${secrets.serviceToken}; userId=${secrets.userId}; xiaomichatbot_ph=${secrets.xiaomichatbot_ph}`;
}

function mimoHeaders(secrets: MimoSecrets): Record<string, string> {
  return {
    Accept: "*/*",
    "Content-Type": "application/json",
    Cookie: mimoCookieHeader(secrets),
    Origin: "https://aistudio.xiaomimimo.com",
    Referer: "https://aistudio.xiaomimimo.com/",
    "User-Agent": MIMO_USER_AGENT,
    "x-timezone": "Asia/Shanghai",
  };
}

/**
 * Performs the upstream MiMo chat call. The upstream always responds with SSE,
 * even for non-streaming requests; callers decide how to consume the body.
 */
export async function mimoFetch(input: MimoAdapterInput): Promise<Response> {
  const resolved = resolveMimoSecrets(input.secrets);
  const url = `${joinUrl(input.baseUrl, MIMO_CHAT_PATH)}?xiaomichatbot_ph=${encodeURIComponent(
    resolved.xiaomichatbot_ph,
  )}`;
  const body = mimoBuildRequestBody(input.chatPayload);
  return fetch(url, {
    method: "POST",
    headers: mimoHeaders(resolved),
    body: JSON.stringify(body),
    signal: input.signal ?? null,
  });
}

// ------------------------------------------------------------------
// Response conversion: MiMo SSE -> OpenAI chat
// ------------------------------------------------------------------

function chatCompletionId(): string {
  return `chatcmpl-${randomUUID().replace(/-/gu, "").slice(0, 24)}`;
}

function sseDataLine(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

interface ParsedMimoEvents {
  readonly text: string;
  readonly promptTokens: number;
  readonly completionTokens: number;
}

/**
 * Reads the whole upstream MiMo SSE body and accumulates text + usage.
 *
 * Each `data:` line carries either `{type:"text",content:"..."}` (append) or
 * a usage object with top-level `promptTokens`/`completionTokens`. JSON
 * decode errors on any line are silently skipped, matching MiMo2API.
 */
async function consumeMimoSse(response: Response): Promise<ParsedMimoEvents> {
  const reader = response.body?.getReader();
  if (!reader) return { text: "", promptTokens: 0, completionTokens: 0 };
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  let promptTokens = 0;
  let completionTokens = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/u);
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const dataStr = trimmed.slice(5).trim();
      if (!dataStr || dataStr === "[DONE]") continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(dataStr);
      } catch {
        continue;
      }
      if (!isRecord(parsed)) continue;
      if (parsed.type === "text" && typeof parsed.content === "string") {
        // MiMo occasionally emits NUL bytes inside content; strip them.
        text += parsed.content.replace(/\x00/gu, "");
        continue;
      }
      if (typeof parsed.promptTokens === "number") promptTokens = parsed.promptTokens;
      if (typeof parsed.completionTokens === "number") completionTokens = parsed.completionTokens;
    }
  }
  return { text, promptTokens, completionTokens };
}

/** Splits `<think>...</think>` from surrounding text. */
export function parseThinkTags(input: string): { content: string; think: string } {
  const openIndex = input.indexOf(THINK_OPEN);
  if (openIndex === -1) return { content: input, think: "" };
  const afterOpen = input.slice(openIndex + THINK_OPEN.length);
  const closeIndex = afterOpen.indexOf(THINK_CLOSE);
  if (closeIndex === -1) {
    // Unterminated think block: treat the rest as reasoning.
    return { content: input.slice(0, openIndex), think: afterOpen };
  }
  const think = afterOpen.slice(0, closeIndex);
  const remaining = afterOpen.slice(closeIndex + THINK_CLOSE.length);
  const before = input.slice(0, openIndex);
  return { content: `${before}${remaining}`, think };
}

/**
 * Non-streaming conversion: collect the full MiMo response, then emit a single
 * OpenAI `chat.completion` JSON object.
 *
 * Following MiMo2API, reasoning is inlined into `message.content` as
 * `<think>...</think>\n<answer>` (no separate `reasoning_content` field in
 * non-streaming mode).
 */
export async function mimoResponseToChatResponse(
  response: Response,
  requestedModel: string,
): Promise<Response> {
  const { text, promptTokens, completionTokens } = await consumeMimoSse(response);
  const { content, think } = parseThinkTags(text);
  const messageContent = think ? `${THINK_OPEN}${think}${THINK_CLOSE}\n${content}` : content;
  const totalTokens = promptTokens + completionTokens;
  return Response.json(
    {
      id: chatCompletionId(),
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: requestedModel,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: messageContent },
          finish_reason: "stop",
        },
      ],
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: totalTokens,
      },
    },
    { status: response.status },
  );
}

/**
 * Streaming conversion: transform MiMo's SSE into OpenAI `chat.completion.chunk`
 * SSE, with a tag-aware state machine so a `<think>`/`</think>` marker split
 * across chunks is never emitted broken.
 *
 * - Normal text -> `delta.content`.
 * - Text inside `<think>` -> `delta.reasoning` (non-standard but used by
 *   reasoning-capable OpenAI-compatible clients).
 *
 * Holds back the trailing `len("<think>")` (or `len("</think>")`) chars until
 * more data arrives, so we can tell a partial tag from content.
 */
export function mimoStreamToChatStream(response: Response, requestedModel: string): Response {
  if (!response.body) {
    return Response.json(
      { error: { type: "peakcode_gateway_error", message: "MiMo upstream returned an empty stream." } },
      { status: 502 },
    );
  }
  const completionId = chatCompletionId();
  const created = Math.floor(Date.now() / 1000);
  const upstream = response.body;
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  const baseChunk = (delta: Record<string, unknown>, finishReason: string | null) => ({
    id: completionId,
    object: "chat.completion.chunk",
    created,
    model: requestedModel,
    choices: [{ index: 0, delta, ...(finishReason ? { finish_reason: finishReason } : {}) }],
  });

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const enqueue = (payload: unknown) => controller.enqueue(encoder.encode(sseDataLine(payload)));
      // Opening role delta.
      enqueue(baseChunk({ role: "assistant" }, null));

      const reader = upstream.getReader();
      let buffer = "";
      let pending = ""; // text not yet classified (may contain a partial tag)
      let inThink = false;

      const emitText = (chunk: string) => {
        if (!chunk) return;
        enqueue(baseChunk(inThink ? { reasoning: chunk } : { content: chunk }, null));
      };

      /**
       * Drains `pending` as far as safely possible, keeping back the trailing
       * holdback so a tag split across reads stays buffered.
       */
      const drainPending = (eof: boolean) => {
        let work = pending;
        while (work.length > 0) {
          const target = inThink ? THINK_CLOSE : THINK_OPEN;
          const holdback = inThink ? THINK_CLOSE_HOLDBACK : THINK_OPEN_HOLDBACK;
          const foundIndex = work.indexOf(target);
          if (foundIndex !== -1) {
            // Emit everything before the marker, flip state, skip the marker.
            emitText(work.slice(0, foundIndex));
            inThink = !inThink;
            work = work.slice(foundIndex + target.length);
            continue;
          }
          if (eof) {
            // No marker found and stream is done: flush everything.
            emitText(work);
            work = "";
            break;
          }
          // Keep the holdback tail in case it's the prefix of the marker.
          if (work.length > holdback) {
            emitText(work.slice(0, work.length - holdback));
            work = work.slice(work.length - holdback);
          }
          break;
        }
        pending = work;
      };

      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split(/\r?\n/u);
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith("data:")) continue;
            const dataStr = trimmed.slice(5).trim();
            if (!dataStr || dataStr === "[DONE]") continue;
            let parsed: unknown;
            try {
              parsed = JSON.parse(dataStr);
            } catch {
              continue;
            }
            if (!isRecord(parsed)) continue;
            if (parsed.type === "text" && typeof parsed.content === "string") {
              pending += parsed.content.replace(/\x00/gu, "");
              drainPending(false);
            }
          }
        }
        drainPending(true);
        enqueue(baseChunk({}, "stop"));
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

/**
 * Entry point for the gateway dispatcher. Performs the upstream call and
 * returns an OpenAI-compatible Response (streaming or non-streaming depending
 * on the request's `stream` flag). The upstream is always SSE; this function
 * only re-wraps it.
 */
export async function sendMimoChat(input: MimoAdapterInput): Promise<Response> {
  const wantsStream = input.chatPayload.stream === true;
  const upstream = await mimoFetch(input);
  if (!upstream.ok) {
    // Pass non-2xx upstream responses through unchanged so the client sees
    // the real error status/body.
    return upstream;
  }
  const requestedModel =
    typeof input.chatPayload.model === "string" ? input.chatPayload.model : MIMO_UPSTREAM_MODEL;
  return wantsStream
    ? mimoStreamToChatStream(upstream, requestedModel)
    : mimoResponseToChatResponse(upstream, requestedModel);
}
