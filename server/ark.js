// Volcengine Ark (方舟) chat completions. Used for both conversation and
// speech recognition (the multimodal model accepts input_audio).

const ARK_URL = 'https://ark.cn-beijing.volces.com/api/v3/chat/completions';

export async function arkChat({ apiKey, model, messages, tools, maxTokens = 300, timeoutMs = 25000 }) {
  if (!apiKey) throw new Error('ARK_API_KEY is not set');
  const body = { model, messages, max_tokens: maxTokens, thinking: { type: 'disabled' } };
  if (tools?.length) body.tools = tools;
  const res = await fetch(ARK_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) {
    const msg = data.error?.message || `HTTP ${res.status}`;
    throw new Error(`Ark ${model}: ${msg}`);
  }
  const choice = data.choices?.[0]?.message || {};
  return {
    content: (choice.content || '').trim(),
    toolCalls: (choice.tool_calls || []).map((c) => ({
      id: c.id,
      name: c.function?.name,
      args: safeJson(c.function?.arguments),
    })),
    tokens: data.usage?.total_tokens || 0,
  };
}

function safeJson(s) {
  try {
    return JSON.parse(s || '{}');
  } catch {
    return {};
  }
}
