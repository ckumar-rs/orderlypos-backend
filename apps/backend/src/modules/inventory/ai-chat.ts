export async function completeChatJson(opts: {
  baseUrl: string;
  token: string;
  model: string;
  system: string;
  user: string;
}): Promise<string> {
  const url = chatCompletionsUrl(opts.baseUrl);
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${opts.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: opts.model,
      messages: [
        { role: 'system', content: opts.system },
        { role: 'user', content: opts.user },
      ],
      temperature: 0.2,
      max_tokens: 2000,
    }),
    signal: AbortSignal.timeout(45_000),
  });
  const body = (await response.json().catch(() => null)) as {
    error?: { message?: string } | string;
    choices?: { message?: { content?: string } }[];
  } | null;
  if (!response.ok) {
    const message =
      typeof body?.error === 'string'
        ? body.error
        : body?.error?.message ?? `Model HTTP ${response.status}`;
    throw new Error(message);
  }
  const text = body?.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error('Model returned an empty reply');
  return text;
}

export function chatCompletionsUrl(baseUrl: string) {
  const trimmed = baseUrl.trim().replace(/\/+$/, '');
  if (trimmed.endsWith('/chat/completions')) return trimmed;
  return `${trimmed}/chat/completions`;
}

export async function fetchWeatherText(
  url: string,
  apiKey?: string | null,
): Promise<string> {
  const headers: Record<string, string> = {};
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const response = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    throw new Error(`Weather HTTP ${response.status}`);
  }
  const text = await response.text();
  return text.slice(0, 4000);
}
