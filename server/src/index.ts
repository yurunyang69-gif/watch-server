import express, { type Request, type Response } from "express";
import cors from "cors";
import multer from "multer";
import { ASRClient, Config, HeaderUtils } from "coze-coding-dev-sdk";

const app = express();
const port = process.env.PORT || 9091;

// 外部AI服务地址
const EXTERNAL_AI_BASE = "https://d0a2710d54693b41-139-9-149-221.serveousercontent.com";

// Multer 内存存储（不写入磁盘）
const upload = multer({ storage: multer.memoryStorage() });

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// Health check
app.get('/api/v1/health', (req, res) => {
  console.log('Health check success');
  res.status(200).json({ status: 'ok' });
});

/**
 * 发送消息到AI服务
 * POST /api/v1/send
 * Body: { text: string }
 */
app.post('/api/v1/send', async (req: Request, res: Response) => {
  try {
    const { text } = req.body;
    if (!text || typeof text !== 'string') {
      res.status(400).json({ error: 'text is required' });
      return;
    }

    const response = await fetch(`${EXTERNAL_AI_BASE}/api/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });

    const data = await response.json();
    res.status(response.status).json(data);
  } catch (err) {
    console.error('Send proxy error:', err);
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

    const response = await fetch(`${EXTERNAL_AI_BASE}/api/poll?id=${encodeURIComponent(id)}`);
    const data = await response.json();
    res.status(response.status).json(data);
  } catch (err) {
    console.error('Poll proxy error:', err);
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
