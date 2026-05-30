/**
 * claw-client.ts
 * 当 AI_SOURCE=claw 时，将聊天请求转发到 Cloudflare Worker
 * 由 Worker 作为中间邮箱，等待 claw 服务处理完回写结果
 */

const WORKER_URL = process.env.WORKER_URL || '';
const AI_BACKEND_TOKEN = process.env.AI_BACKEND_TOKEN || '';

interface ChatMessage {
  role: string;
  content: string;
}

interface ChatPayload {
  device_id: string;
  message: string;
  mode: string;
  history: ChatMessage[];
}

/**
 * 投递消息到 Worker 邮箱
 */
export async function postToWorker(
  ticketId: string,
  payload: ChatPayload,
): Promise<{ ok: boolean; ticketId: string }> {
  if (!WORKER_URL) {
    throw new Error('WORKER_URL not configured');
  }

  const res = await fetch(`${WORKER_URL}/api/inbox`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${AI_BACKEND_TOKEN}`,
    },
    body: JSON.stringify({
      ticketId,
      deviceId: payload.device_id,
      message: payload.message,
      mode: payload.mode,
      history: payload.history,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Worker inbox error: ${res.status} ${err}`);
  }

  return res.json() as Promise<{ ok: boolean; ticketId: string }>;
}

/**
 * 轮询 Worker 等待 claw 服务回写结果
 */
export async function pollWorkerResult(
  ticketId: string,
  onChunk: (text: string) => void,
  onDone: () => void,
  onError: (err: string) => void,
  timeoutMs = 120000,
  intervalMs = 1500,
): Promise<void> {
  if (!WORKER_URL) {
    onError('WORKER_URL not configured');
    return;
  }

  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(
        `${WORKER_URL}/api/result?ticketId=${ticketId}`,
        {
          headers: {
            Authorization: `Bearer ${AI_BACKEND_TOKEN}`,
          },
        },
      );

      if (!res.ok) {
        await sleep(intervalMs);
        continue;
      }

      const data = (await res.json()) as {
        status: string;
        answer?: string;
        error?: string;
      };

      if (data.status === 'done' && data.answer) {
        // 模拟流式输出：把 answer 拆成小段逐字推送
        const chunks = splitIntoChunks(data.answer, 8);
        for (const chunk of chunks) {
          onChunk(chunk);
          await sleep(80);
        }
        onDone();
        return;
      }

      if (data.status === 'error') {
        onError(data.error || 'Unknown error from claw service');
        return;
      }
    } catch (e) {
      // 网络错误继续轮询
    }

    await sleep(intervalMs);
  }

  onError('等待 claw 服务回复超时（120秒）');
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function splitIntoChunks(text: string, chunkSize: number): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += chunkSize) {
    chunks.push(text.slice(i, i + chunkSize));
  }
  return chunks;
}
