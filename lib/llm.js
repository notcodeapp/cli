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
      stream: true,
    }),
  });
  if (!response.ok) {
    throw sseError(response.status, await response.text().catch(() => ''));
  }
  if (!response.body) throw new Error('Провайдер не вернул поток ответа');

  const message = { role: 'assistant', content: '' };
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
  return message;
}

module.exports = { streamChat };
