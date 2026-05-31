/**
 * claw-client.ts — 雨润Claw 手表AI助手 -> 小艺Claw 接入层
 *
 * 通信架构：
 *   手表 → Express后端(/api/v1/send)
 *        → sendAndWait() → Cloudflare Worker → 小艺Claw轮询 → 处理 → 回复
 *        → 结果存入 chatStore → 前端 poll 获取
 */

import axios from 'axios';

// ============================================================
// 配置（优先从环境变量读取，fallback 用默认值）
// ============================================================
const CONFIG = {
  WORKER_URL: process.env.WORKER_URL || 'https://snowy-smoke-edf2.yurunyang69.workers.dev',
  BACKEND_TOKEN: process.env.AI_BACKEND_TOKEN || '@yyrAdam~',
  POLL_TIMEOUT: parseInt(process.env.POLL_TIMEOUT || '30000', 10),
  POLL_INTERVAL: parseInt(process.env.POLL_INTERVAL || '2000', 10),
};

// ============================================================
// 类型定义
// ============================================================
export interface ClawRequest {
  text: string;
  mode?: 'normal' | 'search' | 'doc';
  deviceId?: string;
  history?: Array<{ role: string; content: string }>;
}

export interface ClawResponse {
  ticketId: string;
  response: string;
  status: 'completed' | 'pending' | 'timeout';
}

// ============================================================
// 核心：发送消息 + 轮询结果
// 返回完整回复文本
// ============================================================
export async function sendAndWait(request: ClawRequest): Promise<string> {
  const url = CONFIG.WORKER_URL;

  // 1. 发送消息 → 获取 ticketId
  const askRes = await axios.post(
    `${url}/api/ask`,
    {
      text: formatMessage(request),
      mode: request.mode || 'normal',
      deviceId: request.deviceId || 'watch',
      history: request.history || [],
    },
    {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${CONFIG.BACKEND_TOKEN}`,
      },
      timeout: 10000,
    }
  );

  const { ticketId } = askRes.data;
  if (!ticketId) {
    throw new Error('Worker 未返回 ticketId');
  }

  // 2. 长轮询结果
  const startTime = Date.now();
  while (Date.now() - startTime < CONFIG.POLL_TIMEOUT) {
    try {
      const resultRes = await axios.get(`${url}/api/result`, {
        params: { ticketId },
        headers: { Authorization: `Bearer ${CONFIG.BACKEND_TOKEN}` },
        timeout: CONFIG.POLL_INTERVAL + 3000,
      });

      const data = resultRes.data;
      if (data.status === 'completed') {
        return data.response;
      }
      if (data.status === 'timeout') {
        throw new Error('AI 处理超时，请重试');
      }
    } catch (e: any) {
      // 网络波动时重试
      if (Date.now() - startTime >= CONFIG.POLL_TIMEOUT) throw e;
    }

    // 等轮询间隔
    await sleep(CONFIG.POLL_INTERVAL);
  }

  throw new Error('等待 AI 回复超时');
}

// ============================================================
// 格式化消息
// ============================================================
function formatMessage(req: ClawRequest): string {
  let msg = req.text;

  // 如果带了对话历史，标明
  if (req.history && req.history.length > 0) {
    const recentHistory = req.history.slice(-6); // 最近6轮对话
    const contextStr = recentHistory
      .map((h) => `${h.role === 'user' ? '用户' : '助手'}: ${h.content}`)
      .join('\n');

    msg = `[上下文]\n${contextStr}\n\n[当前问题]\n${req.text}`;
  }

  // 模式标记
  if (req.mode === 'search') msg = `[需要搜索] ${msg}`;
  if (req.mode === 'doc') msg = `[以文档形式输出] ${msg}`;

  return msg;
}

// ============================================================
// Express SSE 辅助：把结果逐字推送到客户端
// 注：当前架构使用 chatStore + poll，此函数预留供未来 SSE 直推使用
// ============================================================
export function pushToWatchSSE(res: any, responseText: string) {
  const chars = responseText.split('');
  let index = 0;

  const interval = setInterval(() => {
    if (index >= chars.length) {
      res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
      res.end();
      clearInterval(interval);
      return;
    }

    const chunkSize = Math.min(1 + Math.floor(Math.random() * 2), chars.length - index);
    const chunk = chars.slice(index, index + chunkSize).join('');

    res.write(
      `data: ${JSON.stringify({
        type: 'text',
        content: chunk,
      })}\n\n`
    );

    index += chunkSize;
  }, 30 + Math.random() * 40);
}

// ============================================================
// 主入口（SSE 模式）：API 路由直接调用这个
// 注：当前架构使用 chatStore + poll，此函数预留供未来 SSE 直推使用
// ============================================================
export async function handleClawChat(
  userMessage: string,
  options: {
    mode?: 'normal' | 'search' | 'doc';
    deviceId?: string;
    history?: Array<{ role: string; content: string }>;
    res: any; // Express Response 对象（用于 SSE 输出）
  }
) {
  const { mode, deviceId, history, res } = options;

  // 设置 SSE 头
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });

  try {
    const response = await sendAndWait({
      text: userMessage,
      mode,
      deviceId,
      history,
    });

    pushToWatchSSE(res, response);
  } catch (e: any) {
    const errorMsg = e.message || 'AI 回复失败，请稍后重试';
    res.write(`data: ${JSON.stringify({ type: 'error', content: errorMsg })}\n\n`);
    res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
    res.end();
  }
}

// ============================================================
// 工具
// ============================================================
function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
