// Volcengine Ark (方舟) chat completions. Used for conversation, speech recognition
// (the multimodal model accepts input_audio) and reading pictures (image_url).

import { request } from './client.js';

export const ARK_ORIGIN = 'https://ark.cn-beijing.volces.com';
const ARK_URL = `${ARK_ORIGIN}/api/v3/chat/completions`;

// json: ask for a JSON object back (the answer's content is then that JSON, as text).
export async function arkChat({ apiKey, model, messages, tools, maxTokens = 300, timeoutMs = 25000, json = false }) {
  if (!apiKey) throw new Error('ARK_API_KEY is not set');
  const body = { model, messages, max_tokens: maxTokens, thinking: { type: 'disabled' } };
  if (tools?.length) body.tools = tools;
  if (json) body.response_format = { type: 'json_object' };
  const res = await request(ARK_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    timeoutMs,
  });
  let data = {};
  try {
    data = JSON.parse(res.body.toString('utf8'));
  } catch {
    /* not JSON */
  }
  if (res.status >= 400 || data.error) {
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
