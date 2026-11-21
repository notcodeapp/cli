'use strict';
// Minimal OpenAI-compatible chat-completions client with SSE streaming and
// tool-call accumulation. Zero dependencies: Node 18+ global fetch.

function sseError(status, body) {
  let detail = body.slice(0, 400);
  try { detail = JSON.parse(body).error?.message || detail; } catch { /* keep raw */ }
  const err = new Error(`Провайдер вернул HTTP ${status}: ${detail}`);
  err.status = status;
  return err;
}

/// Streams one chat completion. Returns the assembled assistant message:
/// { role: 'assistant', content: string, tool_calls?: [{id, type, function: {name, arguments}}] }
async function streamChat({ baseUrl, key, model, messages, tools, signal, fetchImpl = fetch, onDelta = () => {} }) {
  const response = await fetchImpl(`${baseUrl}/chat/completions`, {
    method: 'POST',
    signal,
    headers: {
      // Некоторым шлюзам (например, локальному Ollama) ключ не нужен вовсе.
      ...(key ? { 'Authorization': `Bearer ${key}` } : {}),
      'Content-Type': 'application/json',
      'Accept': 'text/event-stream',
    },
    body: JSON.stringify({
      model,
      messages,
      ...(tools && tools.length ? { tools, tool_choice: 'auto' } : {}),
      // Не все провайдеры отдают usage в потоке: неизвестное поле игнорируется.
      stream_options: { include_usage: true },
      stream: true,
    }),
  });
  if (!response.ok) {
    throw sseError(response.status, await response.text().catch(() => ''));
  }
  if (!response.body) throw new Error('Провайдер не вернул поток ответа');

  const message = { role: 'assistant', content: '' };
  const usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, estimated: false };
  const toolCalls = new Map(); // index → {id, type, function: {name, arguments}}
  const decoder = new TextDecoder();
  let buffer = '';

  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let newline;
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newline).replace(/\r$/, '');
      buffer = buffer.slice(newline + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      let parsed;
      try { parsed = JSON.parse(payload); } catch { continue; } // keep-alive comments etc.
      if (parsed.usage && typeof parsed.usage === 'object') {
        usage.total_tokens = Number(parsed.usage.total_tokens) || usage.total_tokens;
        usage.prompt_tokens = Number(parsed.usage.prompt_tokens) || usage.prompt_tokens;
        usage.completion_tokens = Number(parsed.usage.completion_tokens) || usage.completion_tokens;
      }
      const delta = parsed.choices?.[0]?.delta;
      if (!delta) continue;
      if (typeof delta.content === 'string' && delta.content) {
        message.content += delta.content;
        onDelta(delta.content);
      }
      if (Array.isArray(delta.tool_calls)) {
        for (const call of delta.tool_calls) {
          const slot = toolCalls.get(call.index) ?? { id: '', type: 'function', function: { name: '', arguments: '' } };
          if (call.id) slot.id = call.id;
          if (call.function?.name) slot.function.name += call.function.name;
          if (call.function?.arguments) slot.function.arguments += call.function.arguments;
          toolCalls.set(call.index, slot);
        }
      }
    }
  }
  if (toolCalls.size) {
    message.tool_calls = [...toolCalls.entries()].sort((a, b) => a[0] - b[0]).map(([, call]) => call);
  }
  // Провайдер не отдал usage — грубая оценка: ~4 символа на токен.
  if (!usage.total_tokens) {
    const promptChars = messages.reduce((sum, m) => sum + String(m.content ?? '').length + 4, 0);
    const completionChars = message.content.length + (message.tool_calls ?? []).reduce((sum, c) => sum + c.function.arguments.length, 0);
    usage.prompt_tokens = Math.ceil(promptChars / 4);
    usage.completion_tokens = Math.ceil(completionChars / 4);
    usage.total_tokens = usage.prompt_tokens + usage.completion_tokens;
    usage.estimated = true;
  }
  message.usage = usage;
  return message;
}

module.exports = { streamChat };
