import express, { type Request, type Response } from "express";
import cors from "cors";
import multer from "multer";
import crypto from "crypto";

// 加载 .env 文件（确保 AI_SOURCE 等自定义环境变量生效）
import dotenv from 'dotenv';
dotenv.config();
// coze-coding-dev-sdk 是内部包，本机可能不存在。
// 只在使用 LLM/ASR 功能时动态加载；claw 模式不需要。
let ASRClient: any, LLMClient: any, Config: any, HeaderUtils: any, SearchClient: any;
async function loadSdk() {
  if (!Config) {
    try {
      const sdk = await import('coze-coding-dev-sdk');
      ASRClient = sdk.ASRClient;
      LLMClient = sdk.LLMClient;
      Config = sdk.Config;
      HeaderUtils = sdk.HeaderUtils;
      SearchClient = sdk.SearchClient;
    } catch {
      throw new Error('coze-coding-dev-sdk 未安装，请安装后再使用 LLM/ASR 功能');
    }
  }
}
import { getSupabaseClient } from "./storage/database/supabase-client.js";
import { sendAndWait } from "./claw-client.js";
import { chat as localChat, checkOllama } from "./local-llm.js"; // 本地大模型调用（Ollama）
import { chatStream } from "./local-llm.js"; // 本地大模型流式调用（Ollama）
import type { ChatMessage } from "./local-llm.js"; // 本地大模型消息类型定义
import { Readable } from "stream"; // 流式输出辅助工具
import type { Response as ExpressResponse } from "express"; // Express 响应类型别名
import type { Request as ExpressRequest } from "express"; // Express 请求类型别名
import type { NextFunction } from "express"; // Express 中间件类型别名

// 本地大模型健康状态缓存（每30秒刷新一次）
let ollamaStatusCache: { ok: boolean; checkedAt: number; model?: string; error?: string } | null = null;
async function getOllamaStatus(): Promise<{ ok: boolean; model?: string; error?: string }> {
  if (ollamaStatusCache && Date.now() - ollamaStatusCache.checkedAt < 30000) {
    return { ok: ollamaStatusCache.ok, model: ollamaStatusCache.model, error: ollamaStatusCache.error };
  }
  const status = await checkOllama();
  ollamaStatusCache = { ...status, checkedAt: Date.now() };
  return status;
}

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
  status: 'pending' | 'streaming' | 'done' | 'error';
  reply?: string;
  error?: string;
  createdAt: number;
  deviceId?: string;
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
 * 文档上传与解析
 * POST /api/v1/upload-doc
 * Body: FormData，字段名 doc（文档文件）
 */
app.post('/api/v1/upload-doc', upload.single('doc'), async (req: Request, res: Response) => {
  try {
    if (!req.file) {
      res.status(400).json({ error: 'No document uploaded' });
      return;
    }

    const { originalname, mimetype, buffer } = req.file;
    const ext = originalname.split('.').pop()?.toLowerCase() || '';
    let text = '';

    if (ext === 'txt' || ext === 'md' || ext === 'json' || ext === 'js' || ext === 'ts' || ext === 'jsx' || ext === 'tsx' || ext === 'py' || ext === 'css' || ext === 'html') {
      text = buffer.toString('utf-8');
    } else if (ext === 'docx') {
      const mammoth = await import('mammoth');
      const result = await mammoth.extractRawText({ buffer });
      text = result.value;
    } else if (ext === 'pdf') {
      try {
        const { PDFParse } = await import('pdf-parse');
        const parser = new PDFParse({ data: buffer });
        const textResult = await (parser as any).getText();
        text = textResult.pages.map((p: any) => p.text).join('\n');
      } catch (pdfErr) {
        console.error('PDF parse error:', pdfErr);
        res.status(500).json({ error: 'PDF parsing failed. Please convert to TXT or DOCX.' });
        return;
      }
    } else if (ext === 'csv') {
      try {
        const csvText = buffer.toString('utf-8');
        const lines = csvText.split('\n').map(line => line.replace(/\r/g, '')).filter(line => line.trim());
        text = lines.map(line => line.split(',').join('\t')).join('\n');
      } catch (csvErr) {
        console.error('CSV parse error:', csvErr);
        res.status(500).json({ error: 'CSV parsing failed' });
        return;
      }
    } else if (ext === 'xlsx' || ext === 'xls') {
      try {
        const xlsx = await import('xlsx');
        const workbook = xlsx.read(buffer, { type: 'buffer' });
        const sheetNames = workbook.SheetNames;
        const lines: string[] = [];
        for (const sheetName of sheetNames) {
          const worksheet = workbook.Sheets[sheetName];
          const json = xlsx.utils.sheet_to_json(worksheet, { header: 1 });
          lines.push(`--- Sheet: ${sheetName} ---`);
          for (const row of json as unknown[][]) {
            lines.push((row as unknown[]).join('\t'));
          }
        }
        text = lines.join('\n');
      } catch (xlsxErr) {
        console.error('Excel parse error:', xlsxErr);
        res.status(500).json({ error: 'Excel parsing failed. Please convert to TXT.' });
        return;
      }
    } else {
      res.status(400).json({ error: `Unsupported file type: ${ext}. Supported: txt, md, docx, pdf, xlsx, csv, json, code files` });
      return;
    }

    // 截断过长的文本（保留前15000字符，约5000汉字）
    const maxLen = 15000;
    const truncated = text.length > maxLen ? text.slice(0, maxLen) + '\n\n[文档内容过长，已截断]' : text;

    res.json({ text: truncated, title: originalname });
  } catch (err) {
    console.error('Upload doc error:', err);
    res.status(500).json({ error: 'Failed to parse document' });
  }
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
      deviceId: device_id || 'unknown',
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

    // 是否启用文档模式
    const docMode = req.body.doc_mode === true;

    // ========== AI_SOURCE=claw 模式：只写 user 消息到 Supabase，等待 claw 服务写回 assistant 回复 ==========
    if (process.env.AI_SOURCE === 'claw') {
      // claw 服务直接轮询 Supabase，处理完自己写 assistant 消息
      // 后端这里什么都不做，只返回 ok
      res.json({ ok: true, id });
      return;
    }

    // 后台异步调用LLM生成回复
    const generateReply = async () => {
      try {

        // 查询历史消息作为上下文（最多50条，增强记忆）
        const { data: historyData, error: historyError } = await client
          .from('chat_messages')
          .select('type, text')
          .eq('device_id', device_id || 'unknown')
          .order('created_at', { ascending: true })
          .limit(50);

        if (historyError) {
          console.error('History fetch error:', historyError);
        }

        const historyMessages = (historyData || []).map((h: any) => ({
          role: h.type === 'user' ? 'user' as const : 'assistant' as const,
          content: h.text,
        }));

        // ========== 知识库检索（关键词匹配）==========
        let knowledgeContext = '';
        try {
          const maxResults = 3;
          // 使用 Supabase RPC 函数或直接查询进行关键词匹配
          const queryText = text.toLowerCase();
          const queryWords = queryText.split(/\s+/).filter((w: string) => w.length > 1);

          const { data: kbData } = await client
            .from('knowledge_documents')
            .select('id, title, content')
            .eq('device_id', device_id || 'unknown')
            .limit(20);

          if (kbData && kbData.length > 0) {
            const scoredDocs = (kbData as any[])
              .map((doc: any) => {
                const contentLower = doc.content.toLowerCase();
                const score = queryWords.filter((w: string) => contentLower.includes(w)).length;
                return { ...doc, score };
              })
              .filter((d: any) => d.score > 0)
              .sort((a: any, b: any) => b.score - a.score)
              .slice(0, maxResults);

            if (scoredDocs.length > 0) {
              knowledgeContext = scoredDocs
                .map((doc: any, i: number) => `[知识库文档${i + 1}: ${doc.title}]\n${doc.content.slice(0, 1500)}`)
                .join('\n\n');
            }
          }
        } catch (kbErr) {
          console.warn('Knowledge base search failed:', kbErr);
        }

        // ========== 网页资料搜索（可选，需要联网）==========
        let searchContext = '';
        try {
          await loadSdk();
          const customHeaders = HeaderUtils.extractForwardHeaders(req.headers as Record<string, string>);
          const config = new Config();
          const searchClient = new SearchClient(config, customHeaders);
          const searchRes = await searchClient.webSearch(text, 5, true);
          if (searchRes.web_items && searchRes.web_items.length > 0) {
            const items = searchRes.web_items.slice(0, 3).map((item: any, i: number) => {
              return `${i + 1}. ${item.title}\n来源：${item.site_name || '未知'}\n摘要：${item.snippet || ''}`;
            }).join('\n\n');
            searchContext = `\n\n【网络搜索参考资料】\n${items}\n\n`;
          }
        } catch (searchErr) {
          // 搜索失败不影响本地模型回复（无网络时静默跳过）
          console.warn('Search unavailable (offline?):', searchErr);
        }

        // 构建system prompt —— 取消字数限制
        let systemPrompt = '你是雨润Claw，一位贴心的腕上AI助手。你的主人叫杨雨润（英文名Adam）。请结合之前的对话上下文回答用户，保持记忆连贯性。你可以称呼主人为"雨润"或"Adam"。';
        if (docMode) {
          systemPrompt += '\n\n【文档模式】用户要求以结构化文档形式输出。请使用Markdown格式，包含：\n- 清晰的标题层级（# ## ###）\n- 分点论述\n- 适当的加粗强调\n- 结构化、条理清晰的排版\n请尽可能详细、完整地输出内容，不要精简。';
        } else {
          systemPrompt += '\n\n请用自然、流畅的中文回复用户，保持友好亲切的语气。回复长度根据问题复杂度决定，不要刻意精简，完整表达你的观点即可。';
        }
        if (searchContext) {
          systemPrompt += '\n\n【搜索增强】以下是从互联网搜索到的最新参考资料，请优先结合这些资料回答用户问题：' + searchContext;
        }
        if (knowledgeContext) {
          systemPrompt += '\n\n【个人知识库】以下是从你的个人知识库中检索到的相关资料，请优先结合这些资料回答用户：\n' + knowledgeContext + '\n\n请结合上述知识库内容，给出专业、准确的回答。如果知识库内容不相关，请忽略。';
        }

        const messages: ChatMessage[] = [
          { role: 'system', content: systemPrompt },
          ...historyMessages,
        ];

        // 调用本地大模型（Ollama）
        const reply = await localChat(messages, { temperature: 0.8 }) || '抱歉，我没听懂，请再说一遍。';

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

    // claw 模式：去 Supabase 查询 claw 服务写回的 assistant 回复
    if (process.env.AI_SOURCE === 'claw' && record.status === 'pending' && record.deviceId) {
      const client = getSupabaseClient();
      // 查询该设备在 send 时间之后最新的非 user 消息（即 ai/assistant 回复）
      const { data: replyData, error: replyError } = await client
        .from('chat_messages')
        .select('type, text, created_at')
        .eq('device_id', record.deviceId)
        .neq('type', 'user')
        .gt('created_at', new Date(record.createdAt).toISOString())
        .order('created_at', { ascending: false })
        .limit(1);

      if (!replyError && replyData && replyData.length > 0) {
        const reply = replyData[0].text;
        chatStore.set(id, { ...record, status: 'done', reply });
        res.json({ reply, status: 'done' });
        return;
      }

      // 还没收到回复，继续等待
      res.json({ error: 'nf' });
      return;
    }

    if (record.status === 'done' && record.reply != null) {
      res.json({ reply: record.reply, status: 'done' });
      return;
    }

    if (record.status === 'error') {
      res.json({ error: record.error || 'generation failed', status: 'error' });
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

    await loadSdk();
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

// ============== 知识库管理 ==============

/**
 * 将长文本按段落分块
 */
function splitIntoChunks(text: string, maxChars: number): string[] {
  // 按换行分割成段落
  const paragraphs = text.split(/\n+/).filter(p => p.trim().length > 0);
  const chunks: string[] = [];
  let current = '';

  for (const para of paragraphs) {
    if ((current + '\n' + para).length <= maxChars) {
      current = current ? current + '\n' + para : para;
    } else {
      if (current) chunks.push(current);
      // 如果单个段落就超过限制，按句子继续拆分
      if (para.length > maxChars) {
        const sentences = para.split(/(?<=[。！？.!?])/);
        current = '';
        for (const sent of sentences) {
          if ((current + sent).length <= maxChars) {
            current += sent;
          } else {
            if (current) chunks.push(current);
            current = sent.length <= maxChars ? sent : sent.slice(0, maxChars);
          }
        }
      } else {
        current = para;
      }
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

/**
 * 上传文档到知识库
 * POST /api/v1/knowledge/upload
 * Body: FormData, 字段名 doc（文档文件）
 *        { name: string } - 文档名称
 *        { device_id: string } - 设备ID
 */
app.post('/api/v1/knowledge/upload', upload.single('doc'), async (req: Request, res: Response) => {
  try {
    if (!req.file) {
      res.status(400).json({ error: 'No document uploaded' });
      return;
    }

    const { originalname, mimetype, buffer } = req.file;
    const docName = req.body.name || originalname;
    const deviceId = req.body.device_id || 'unknown';
    const ext = originalname.split('.').pop()?.toLowerCase() || '';
    let text = '';

    // 复用upload-doc的解析逻辑
    if (ext === 'txt' || ext === 'md' || ext === 'json' || ext === 'js' || ext === 'ts' || ext === 'jsx' || ext === 'tsx' || ext === 'py' || ext === 'css' || ext === 'html') {
      text = buffer.toString('utf-8');
    } else if (ext === 'docx') {
      const mammoth = await import('mammoth');
      const result = await mammoth.extractRawText({ buffer });
      text = result.value;
    } else if (ext === 'pdf') {
      try {
        const { PDFParse } = await import('pdf-parse');
        const parser = new PDFParse({ data: buffer });
        const textResult = await (parser as any).getText();
        text = textResult.pages.map((p: any) => p.text).join('\n');
      } catch (pdfErr) {
        console.error('PDF parse error:', pdfErr);
        res.status(500).json({ error: 'PDF parsing failed' });
        return;
      }
    } else if (ext === 'csv') {
      const csvText = buffer.toString('utf-8');
      const lines = csvText.split('\n').map(line => line.replace(/\r/g, '')).filter(line => line.trim());
      text = lines.map(line => line.split(',').join('\t')).join('\n');
    } else if (ext === 'xlsx' || ext === 'xls') {
      try {
        const xlsx = await import('xlsx');
        const workbook = xlsx.read(buffer, { type: 'buffer' });
        const sheetNames = workbook.SheetNames;
        const lines: string[] = [];
        for (const sheetName of sheetNames) {
          const worksheet = workbook.Sheets[sheetName];
          const json = xlsx.utils.sheet_to_json(worksheet, { header: 1 });
          lines.push(`--- Sheet: ${sheetName} ---`);
          for (const row of json as unknown[][]) {
            lines.push((row as unknown[]).join('\t'));
          }
        }
        text = lines.join('\n');
      } catch (xlsxErr) {
        console.error('Excel parse error:', xlsxErr);
        res.status(500).json({ error: 'Excel parsing failed' });
        return;
      }
    } else {
      res.status(400).json({ error: `Unsupported file type: ${ext}` });
      return;
    }

    // 清理文本
    text = text.replace(/\s+/g, ' ').trim();
    if (text.length < 10) {
      res.status(400).json({ error: 'Document content too short' });
      return;
    }

    // 生成文档ID（用于关联所有分块）
    const docId = crypto.randomUUID();

    // 存储元数据行
    const client = getSupabaseClient();
    const { error: metaError } = await client.from('knowledge_documents').insert({
      id: docId,
      device_id: deviceId,
      title: docName,
      content: text.slice(0, 50000), // 限制内容长度
    });

    if (metaError) {
      console.error('Knowledge metadata insert error:', metaError);
      res.status(500).json({ error: 'Failed to save document metadata' });
      return;
    }

    // 将文本分块（按段落或句子分割，每块约500字符）
    const chunks = splitIntoChunks(text, 500);
    console.log(`Split document into ${chunks.length} chunks`);

    // 批量生成向量并插入分块（每批最多10个）
    for (let i = 0; i < chunks.length; i += 10) {
      const batch = chunks.slice(i, i + 10);
      const records = [];

      for (const chunk of batch) {
        records.push({
          id: crypto.randomUUID(),
          device_id: deviceId,
          title: docName,
          content: chunk,
          doc_id: docId,
        });
      }

      const { error: chunkError } = await client.from('knowledge_documents').insert(records);
      if (chunkError) {
        console.error('Knowledge chunks insert error:', chunkError);
      }
    }

    res.json({ id: docId, name: docName, charCount: text.length, chunkCount: chunks.length });
  } catch (err) {
    console.error('Knowledge upload error:', err);
    res.status(500).json({ error: 'Failed to upload document' });
  }
});

/**
 * 获取知识库文档列表
 * GET /api/v1/knowledge/list
 * Query: { device_id: string }
 */
app.get('/api/v1/knowledge/list', async (req: Request, res: Response) => {
  try {
    const { device_id } = req.query;
    if (!device_id || typeof device_id !== 'string') {
      res.status(400).json({ error: 'device_id is required' });
      return;
    }

    const client = getSupabaseClient();
    // 只查询元数据行（doc_id为null），按创建时间倒序
    const { data, error } = await client
      .from('knowledge_documents')
      .select('id, title, content, content_hash, doc_id, created_at')
      .eq('device_id', device_id)
      .is('doc_id', null)
      .order('created_at', { ascending: false });

    if (error) {
      console.error('Knowledge list error:', error);
      res.status(500).json({ error: 'Failed to load knowledge base' });
      return;
    }

    const documents = (data || []).map((doc: any) => ({
      id: doc.id,
      title: doc.title,
      char_count: doc.content?.length || 0,
      doc_type: "txt",
      created_at: doc.created_at,
    }));
    res.json({ documents });
  } catch (err) {
    console.error('Knowledge list error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * 删除知识库文档
 * DELETE /api/v1/knowledge/delete
 * Query: { id: string, device_id: string }
 */
app.delete('/api/v1/knowledge/delete', async (req: Request, res: Response) => {
  try {
    const { id, device_id } = req.query;
    if (!id || !device_id || typeof id !== 'string' || typeof device_id !== 'string') {
      res.status(400).json({ error: 'id and device_id are required' });
      return;
    }

    const client = getSupabaseClient();
    // 删除元数据行和所有分块
    await client.from('knowledge_documents').delete().eq('id', id).eq('device_id', device_id);
    await client.from('knowledge_documents').delete().eq('doc_id', id).eq('device_id', device_id);

    res.json({ ok: true });
  } catch (err) {
    console.error('Knowledge delete error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * 搜索知识库
 * GET /api/v1/knowledge/search
 * Query: { q: string, device_id: string, limit?: number }
 */
app.get('/api/v1/knowledge/search', async (req: Request, res: Response) => {
  try {
    const { q, device_id, limit } = req.query;
    if (!q || !device_id || typeof q !== 'string' || typeof device_id !== 'string') {
      res.status(400).json({ error: 'q and device_id are required' });
      return;
    }

    const client = getSupabaseClient();
    const maxResults = Math.min(parseInt(limit as string) || 3, 5);

    // 关键词匹配搜索
    const { data: docs, error } = await client
      .from('knowledge_documents')
      .select('id, title, content')
      .eq('device_id', device_id)
      .limit(20);

    if (error) {
      console.error('Knowledge search error:', error);
      res.status(500).json({ error: 'Search failed' });
      return;
    }

    // 简单关键词匹配
    const queryLower = q.toLowerCase();
    const queryWords = queryLower.split(/\s+/).filter(w => w.length > 1);
    const results = (docs || [])
      .map((doc: any) => {
        const contentLower = doc.content.toLowerCase();
        const matches = queryWords.filter(w => contentLower.includes(w)).length;
        return { ...doc, matchCount: matches };
      })
      .filter((doc: any) => doc.matchCount > 0)
      .sort((a: any, b: any) => b.matchCount - a.matchCount)
      .slice(0, maxResults)
      .map((doc: any) => ({
        id: doc.id,
        name: doc.title,
        content: doc.content.slice(0, 2000),
        similarity: doc.matchCount / queryWords.length,
      }));

    res.json({ results });
  } catch (err) {
    console.error('Knowledge search error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * SSE 流式AI对话（本地大模型 Ollama）
 * POST /api/v1/chat
 * Body: { text: string, device_id: string, doc_mode?: boolean }
 */
app.post('/api/v1/chat', async (req: Request, res: Response) => {
  try {
    const { text, device_id, doc_mode } = req.body;
    if (!text || typeof text !== 'string') {
      res.status(400).json({ error: 'text is required' });
      return;
    }

    // 设置SSE响应头
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-store, no-transform, must-revalidate');
    res.setHeader('Connection', 'keep-alive');

    const client = getSupabaseClient();

    // 保存用户消息到数据库
    await client.from('chat_messages').insert({
      device_id: device_id || 'unknown',
      type: 'user',
      text,
    });

    // 查询历史消息作为上下文
    const { data: historyData } = await client
      .from('chat_messages')
      .select('type, text')
      .eq('device_id', device_id || 'unknown')
      .order('created_at', { ascending: true })
      .limit(50);

    const historyMessages = (historyData || []).map((h: any) => ({
      role: h.type === 'user' ? 'user' as const : 'assistant' as const,
      content: h.text,
    }));

    // 知识库检索
    let knowledgeContext = '';
    try {
      const { data: kbData } = await client
        .from('knowledge_documents')
        .select('id, title, content')
        .eq('device_id', device_id || 'unknown')
        .limit(20);

      if (kbData && kbData.length > 0) {
        const queryText = text.toLowerCase();
        const queryWords = queryText.split(/\s+/).filter((w: string) => w.length > 1);
        const scoredDocs = (kbData as any[])
          .map((doc: any) => {
            const score = queryWords.filter((w: string) => doc.content.toLowerCase().includes(w)).length;
            return { ...doc, score };
          })
          .filter((d: any) => d.score > 0)
          .sort((a: any, b: any) => b.score - a.score)
          .slice(0, 3);

        if (scoredDocs.length > 0) {
          knowledgeContext = scoredDocs
            .map((doc: any, i: number) => `[知识库文档${i + 1}: ${doc.title}]\n${doc.content.slice(0, 1500)}`)
            .join('\n\n');
        }
      }
    } catch (kbErr) {
      console.warn('Knowledge base search failed:', kbErr);
    }

    // 构建system prompt —— 取消字数限制
    let systemPrompt = '你是雨润Claw，一位贴心的腕上AI助手。你的主人叫杨雨润（英文名Adam）。请结合之前的对话上下文回答用户，保持记忆连贯性。你可以称呼主人为"雨润"或"Adam"。';
    if (doc_mode === true) {
      systemPrompt += '\n\n【文档模式】用户要求以结构化文档形式输出。请使用Markdown格式，包含：\n- 清晰的标题层级（# ## ###）\n- 分点论述\n- 适当的加粗强调\n- 结构化、条理清晰的排版\n请尽可能详细、完整地输出内容，不要精简。';
    } else {
      systemPrompt += '\n\n请用自然、流畅的中文回复用户，保持友好亲切的语气。回复长度根据问题复杂度决定，不要刻意精简，完整表达你的观点即可。';
    }
    if (knowledgeContext) {
      systemPrompt += '\n\n【个人知识库】以下是从你的个人知识库中检索到的相关资料，请优先结合这些资料回答用户：\n' + knowledgeContext + '\n\n请结合上述知识库内容，给出专业、准确的回答。如果知识库内容不相关，请忽略。';
    }

    const messages: ChatMessage[] = [
      { role: 'system', content: systemPrompt },
      ...historyMessages,
    ];

    // 流式调用本地大模型
    let fullReply = '';
    try {
      for await (const chunk of chatStream(messages, { temperature: 0.8 })) {
        res.write(`data: ${JSON.stringify({ content: chunk })}\n\n`);
        fullReply += chunk;
      }
      res.write(`data: [DONE]\n\n`);
    } catch (streamErr) {
      console.error('Stream error:', streamErr);
      res.write(`data: ${JSON.stringify({ error: '生成中断' })}\n\n`);
    } finally {
      res.end();
    }

    // 保存AI回复到数据库
    if (fullReply) {
      await client.from('chat_messages').insert({
        device_id: device_id || 'unknown',
        type: 'ai',
        text: fullReply,
      });
    }
  } catch (err) {
    console.error('Chat SSE error:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Internal server error' });
    } else {
      res.write(`data: ${JSON.stringify({ error: 'Internal server error' })}\n\n`);
      res.end();
    }
  }
});

/**
 * 本地大模型状态检查
 * GET /api/v1/llm-status
 */
app.get('/api/v1/llm-status', async (req: Request, res: Response) => {
  const status = await getOllamaStatus();
  res.json(status);
});

app.listen(port, () => {
  console.log(`Server listening at http://localhost:${port}/`);
  if (process.env.AI_SOURCE === 'claw') {
    console.log('AI模式: 小艺Claw 对接');
  } else {
    console.log(`AI模式: 本地大模型 (Ollama: ${process.env.OLLAMA_MODEL || 'qwen2.5:7b'})`);
  }
});
