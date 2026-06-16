/**
 * 本地大模型客户端 - 通过 Ollama API 调用本地模型
 * 无需联网，完全免费
 */

const OLLAMA_BASE_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'qwen2.5:7b';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatOptions {
  temperature?: number;
  stream?: boolean;
}

/**
 * 非流式对话 - 一次性返回完整回复
 */
export async function chat(messages: ChatMessage[], options: ChatOptions = {}): Promise<string> {
  const res = await fetch(`${OLLAMA_BASE_URL}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: OLLAMA_MODEL,
      messages,
      stream: false,
      options: {
        temperature: options.temperature ?? 0.8,
        num_predict: -1,       // -1 = 不限制输出长度
        num_ctx: 8192,         // 上下文窗口 8K
        top_p: 0.9,
        top_k: 40,
        repeat_penalty: 1.1,
      },
    }),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Ollama API error ${res.status}: ${errText}`);
  }

  const data = await res.json() as { message?: { content?: string } };
  return data.message?.content || '';
}

/**
 * 流式对话 - 逐字返回
 */
export async function* chatStream(messages: ChatMessage[], options: ChatOptions = {}): AsyncGenerator<string, void, unknown> {
  const res = await fetch(`${OLLAMA_BASE_URL}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: OLLAMA_MODEL,
      messages,
      stream: true,
      options: {
        temperature: options.temperature ?? 0.8,
        num_predict: -1,       // -1 = 不限制输出长度
        num_ctx: 8192,         // 上下文窗口 8K
        top_p: 0.9,
        top_k: 40,
        repeat_penalty: 1.1,
      },
    }),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Ollama API error ${res.status}: ${errText}`);
  }

  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const chunk = JSON.parse(line);
        if (chunk.message?.content) {
          yield chunk.message.content;
        }
      } catch {
        // 忽略解析失败的行
      }
    }
  }
}

/**
 * 检查 Ollama 服务是否可用
 */
export async function checkOllama(): Promise<{ ok: boolean; model?: string; error?: string }> {
  try {
    const res = await fetch(`${OLLAMA_BASE_URL}/api/tags`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };

    const data = await res.json() as { models?: any[] };
    const models = data.models || [];
    const hasModel = models.some((m: any) => m.name === OLLAMA_MODEL || m.model === OLLAMA_MODEL);

    if (!hasModel) {
      return { ok: false, error: `模型 ${OLLAMA_MODEL} 未安装。请运行: ollama pull ${OLLAMA_MODEL}` };
    }

    return { ok: true, model: OLLAMA_MODEL };
  } catch (err: any) {
    return { ok: false, error: err.message || 'Ollama 服务未启动' };
  }
}
