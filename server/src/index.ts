import express, { type Request, type Response } from "express";
import cors from "cors";
import multer from "multer";
import { ASRClient, LLMClient, Config, HeaderUtils } from "coze-coding-dev-sdk";
import { getSupabaseClient } from "./storage/database/supabase-client.js";

const app = express();
const port = process.env.PORT || 9091;

// Multer 内存存储（不写入磁盘）
const upload = multer({ storage: multer.memoryStorage() });

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// 内存存储：对话生成状态（临时状态，不持久化）
interface ChatRecord {
  id: string;
  status: 'pending' | 'done' | 'error';
  reply?: string;
  error?: string;
  createdAt: number;
}

const chatStore = new Map<string, ChatRecord>();

// 清理过期记录（1小时）
setInterval(() => {
  const now = Date.now();
  for (const [id, record] of chatStore.entries()) {
    if (now - record.createdAt > 60 * 60 * 1000) {
      chatStore.delete(id);
    }
  }
}, 5 * 60 * 1000);

// Health check
app.get('/api/v1/health', (req, res) => {
  console.log('Health check success');
  res.status(200).json({ status: 'ok' });
});

/**
 * 查询历史消息
 * GET /api/v1/history
 * Query: { device_id: string }
 */
app.get('/api/v1/history', async (req: Request, res: Response) => {
  try {
    const { device_id } = req.query;
    if (!device_id || typeof device_id !== 'string') {
      res.status(400).json({ error: 'device_id is required' });
      return;
    }

    const client = getSupabaseClient();
    const { data, error } = await client
      .from('chat_messages')
      .select('id, type, text, created_at')
      .eq('device_id', device_id)
      .order('created_at', { ascending: true })
      .limit(200);

    if (error) {
      console.error('History query error:', error);
      res.status(500).json({ error: 'Failed to load history' });
      return;
    }

    res.json({ messages: data || [] });
  } catch (err) {
    console.error('History error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * 发送消息到AI服务
 * POST /api/v1/send
 * Body: { text: string, device_id: string }
 */
app.post('/api/v1/send', async (req: Request, res: Response) => {
  try {
    const { text, device_id } = req.body;
    if (!text || typeof text !== 'string') {
      res.status(400).json({ error: 'text is required' });
      return;
    }

    const id = Date.now().toString();
    chatStore.set(id, {
      id,
      status: 'pending',
      createdAt: Date.now(),
    });

    // 保存用户消息到数据库
    const client = getSupabaseClient();
    const { error: insertError } = await client.from('chat_messages').insert({
      device_id: device_id || 'unknown',
      type: 'user',
      text,
    });
    if (insertError) {
      console.error('Insert user message error:', insertError);
    }

    // 后台异步调用LLM生成回复
    const generateReply = async () => {
      try {
        // 查询历史消息作为上下文
        const { data: historyData, error: historyError } = await client
          .from('chat_messages')
          .select('type, text')
          .eq('device_id', device_id || 'unknown')
          .order('created_at', { ascending: true })
          .limit(20);

        if (historyError) {
          console.error('History fetch error:', historyError);
        }

        const historyMessages = (historyData || []).map((h: any) => ({
          role: h.type === 'user' ? 'user' as const : 'assistant' as const,
          content: h.text,
        }));

        const customHeaders = HeaderUtils.extractForwardHeaders(req.headers as Record<string, string>);
        const config = new Config();
        const llmClient = new LLMClient(config, customHeaders);

        const messages = [
          {
            role: 'system' as const,
            content: '你是小艺Claw，一位贴心的腕上AI助手。请用简洁、友好、口语化的中文回复用户，适合在手表小屏幕上阅读。回复控制在100字以内。',
          },
          ...historyMessages,
        ];

        const response = await llmClient.invoke(messages, {
          model: 'doubao-seed-2-0-lite-260215',
          temperature: 0.8,
        });

        const reply = response.content || '抱歉，我没听懂，请再说一遍。';

        // 保存AI回复到数据库
        const { error: aiInsertError } = await client.from('chat_messages').insert({
          device_id: device_id || 'unknown',
          type: 'ai',
          text: reply,
        });
        if (aiInsertError) {
          console.error('Insert AI message error:', aiInsertError);
        }

        chatStore.set(id, {
          id,
          status: 'done',
          reply,
          createdAt: Date.now(),
        });
      } catch (err) {
        console.error('LLM generation error:', err);
        chatStore.set(id, {
          id,
          status: 'error',
          error: 'AI回复生成失败',
          createdAt: Date.now(),
        });
      }
    };

    // 启动异步生成（不阻塞响应）
    generateReply();

    res.json({ ok: true, id });
  } catch (err) {
    console.error('Send error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * 轮询获取AI回复
 * GET /api/v1/poll
 * Query: { id: string }
 */
app.get('/api/v1/poll', async (req: Request, res: Response) => {
  try {
    const { id } = req.query;
    if (!id || typeof id !== 'string') {
      res.status(400).json({ error: 'id is required' });
      return;
    }

    const record = chatStore.get(id);
    if (!record) {
      res.status(404).json({ error: 'not found' });
      return;
    }

    if (record.status === 'done' && record.reply != null) {
      res.json({ reply: record.reply });
      return;
    }

    if (record.status === 'error') {
      res.json({ error: record.error || 'generation failed' });
      return;
    }

    // 仍在生成中
    res.json({ error: 'nf' });
  } catch (err) {
    console.error('Poll error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * 语音转文字（ASR）
 * POST /api/v1/transcribe
 * Body: FormData, 字段名 audio（音频文件）
 */
app.post('/api/v1/transcribe', upload.single('audio'), async (req: Request, res: Response) => {
  try {
    if (!req.file) {
      res.status(400).json({ error: 'audio file is required' });
      return;
    }

    const audioBase64 = req.file.buffer.toString('base64');

    const customHeaders = HeaderUtils.extractForwardHeaders(req.headers as Record<string, string>);
    const config = new Config();
    const asrClient = new ASRClient(config, customHeaders);

    const result = await asrClient.recognize({
      uid: 'watch-user',
      base64Data: audioBase64,
    });

    res.json({ text: result.text });
  } catch (err) {
    console.error('ASR error:', err);
    res.status(500).json({ error: 'Speech recognition failed' });
  }
});

app.listen(port, () => {
  console.log(`Server listening at http://localhost:${port}/`);
});
