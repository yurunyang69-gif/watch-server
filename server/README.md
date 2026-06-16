# 雨润Claw — 腕上AI助手

> 专为华为 Watch 4 智能手表打造的 AI 助手应用

## 项目简介

**雨润Claw** 是一个为华为 Watch 4 智能手表量身定制的 AI 助手应用。应用名称中的 "雨润" 是主人的名字（杨雨润），AI 人格也以 "雨润" 的身份与主人交流。

## 技术架构

### 模式一：本地大模型（默认，无需联网）

```
手表(Expo Web) → Express后端 → Ollama本地大模型
                     ↓
                Supabase数据库（多设备同步 + 知识库）
```

### 模式二：小艺Claw对接（需联网）

```
手表(Expo Web) → Express后端 → Supabase数据库 ←→ 小艺Claw服务
```

| 层级 | 技术栈 |
|------|--------|
| 前端 | Expo 54 + React Native + Tailwind CSS |
| 后端 | Express.js + TypeScript |
| 数据库 | Supabase (PostgreSQL) |
| AI模型 | Ollama + Qwen2.5-7B（本地运行，完全免费） |
| AI对接 | 小艺Claw 直接读写 Supabase（可选） |

## 核心功能

### 1. AI 智能对话（本地大模型）
- **本地运行，无需联网** —— 通过 Ollama 调用本地 Qwen2.5-7B 模型
- 流式输出，逐字显示 AI 回复
- 对话记忆（保留最近 50 条消息上下文）
- **取消字数限制** —— AI 根据问题复杂度自然回复，不再强制精简
- AI 人格：雨润（温暖、聪明、贴心）

### 2. 语音输入
- 语音录制转文字
- 文字可手动编辑后发送
- 录音质量已优化为低质量以减少耗时

### 3. 多设备消息同步
- 基于 Supabase 数据库存储所有聊天记录
- 使用 device_id 标识设备
- 轮询刷新，确保手表与手机端实时同步

### 4. 三种对话模式
| 模式 | 功能描述 |
|------|----------|
| **普通模式** | 直接与小艺Claw对话 |
| **搜索模式** | AI 自动搜索实时网页/公众号资料 |
| **文档模式** | AI 以结构化 Markdown 文档形式输出 |

### 5. 文档上传与知识库
- 支持上传 PDF、DOCX、TXT、CSV、XLSX
- 文档自动分块存储
- 关键词搜索匹配
- AI 对话时自动检索相关文档内容注入上下文

### 6. 语音唤醒
- 支持通过华为手表小艺语音助手唤醒
- 语音指令："小艺小艺，帮我打开 Adam Claw"

## 项目结构

```
├── client/                     # Expo 前端
│   ├── app/                    # Expo Router 路由
│   │   ├── _layout.tsx
│   │   ├── index.tsx
│   │   └── knowledge-base.tsx
│   ├── screens/
│   │   ├── chat/index.tsx      # 核心聊天页面
│   │   └── knowledge-base/index.tsx  # 知识库管理
│   ├── components/
│   │   └── Screen.tsx          # 页面容器
│   ├── global.css              # 深色主题样式
│   └── app.config.ts           # 应用配置（含语音唤醒）
│
├── src/                        # Express 后端
│   ├── index.ts                # 主入口 + API路由
│   ├── claw-client.ts          # 小艺Claw客户端
│   └── storage/
│       └── database/
│           ├── supabase-client.ts
│           └── shared/
│               ├── schema.ts
│               └── relations.ts
│
├── Dockerfile                  # Docker 镜像构建
├── docker-compose.yml          # 一键编排启动
├── DEPLOY.md                   # 部署指南
└── .env.example                # 环境变量模板
```

## 数据库表结构

### chat_messages（消息表）

| 列名 | 类型 | 说明 |
|------|------|------|
| id | uuid | 主键 |
| device_id | varchar(64) | 设备标识 |
| type | varchar(32) | user / assistant |
| text | text | 消息内容 |
| created_at | timestamptz | 创建时间 |

### knowledge_documents（知识库表）

| 列名 | 类型 | 说明 |
|------|------|------|
| id | uuid | 主键 |
| device_id | varchar(64) | 设备标识 |
| title | varchar(255) | 文档标题 |
| content | text | 文档内容 |
| content_hash | varchar(64) | SHA256哈希 |
| doc_id | varchar(64) | 分块关联ID |
| created_at | timestamptz | 创建时间 |

## 环境变量

复制 `.env.example` 为 `.env`，填写以下配置：

```env
# Supabase 数据库（多设备同步 + 知识库，必须）
COZE_SUPABASE_URL=https://你的项目.supabase.co
COZE_SUPABASE_ANON_KEY=你的anon_key
COZE_SUPABASE_SERVICE_ROLE_KEY=你的service_role_key

# Ollama 本地大模型配置（默认模式）
OLLAMA_URL=http://localhost:11434
OLLAMA_MODEL=qwen2.5:7b

# Claw 模式配置（可选，如需对接小艺Claw则开启）
# AI_SOURCE=claw
# WORKER_URL=https://snowy-smoke-edf2.yurunyang69.workers.dev
# AI_BACKEND_TOKEN=@yyrAdam~

# 服务端口号
PORT=9091
```

## 本地大模型安装指南

### 1. 安装 Ollama

```bash
# macOS / Linux
curl -fsSL https://ollama.com/install.sh | sh

# Windows: 下载安装包 https://ollama.com/download/windows
```

### 2. 下载模型（推荐 Qwen2.5-7B）

```bash
# 下载模型（约4.5GB，中文能力顶级）
ollama pull qwen2.5:7b

# 验证安装
ollama run qwen2.5:7b
```

### 3. 启动 Ollama 服务

```bash
# 默认端口 11434
ollama serve
```

> 可选：更换其他模型
> - `ollama pull llama3.2` — Meta Llama 3.2（3B，更轻量）
> - `ollama pull deepseek-r1:7b` — DeepSeek R1（推理能力强）
> - `ollama pull gemma2:9b` — Google Gemma 2

## 启动方式

### 本地开发

```bash
# 1. 先启动 Ollama（确保本地模型服务在跑）
ollama serve

# 2. 启动后端
cd server/
pnpm install
pnpm run dev

# 3. 启动前端（另开终端）
cd client/
npx expo start --web
```

### Docker 部署

```bash
# 注意：Docker 内无法直接访问宿主机的 Ollama
# 方案1：在容器内安装 Ollama（需大内存，不推荐）
# 方案2：使用 host 网络模式，让容器访问宿主机的 Ollama
docker compose up -d --build
```

## API 接口

| 接口 | 方法 | 路径 | 功能 |
|------|------|------|------|
| 健康检查 | GET | `/api/v1/health` | 服务状态 |
| **本地模型状态** | GET | `/api/v1/llm-status` | 检查 Ollama 服务是否就绪 |
| **流式对话** | POST | `/api/v1/chat` | SSE 流式 AI 对话（本地模型） |
| 发送消息 | POST | `/api/v1/send` | 发送用户消息（轮询模式） |
| 轮询消息 | GET | `/api/v1/poll` | 获取 AI 回复 |
| 历史消息 | GET | `/api/v1/history` | 查询聊天记录 |
| 语音转文字 | POST | `/api/v1/transcribe` | 上传音频转文字 |
| 文档解析 | POST | `/api/v1/upload-doc` | 上传并解析文档 |
| 知识库列表 | GET | `/api/v1/knowledge/list` | 获取知识库文档 |
| 知识库上传 | POST | `/api/v1/knowledge/upload` | 上传文档到知识库 |
| 知识库搜索 | GET | `/api/v1/knowledge/search` | 关键词搜索知识库 |
| 知识库删除 | DELETE | `/api/v1/knowledge/delete` | 删除知识库文档 |

## 数据流

### 本地大模型模式（默认）

```
手表 → Express后端(/api/v1/chat 或 /api/v1/send)
         ↓
    调用本地 Ollama 大模型生成回复
         ↓
    回复写入 Supabase（多设备同步）
         ↓
    手表 SSE 流式显示 / 轮询获取回复
```

### 小艺Claw模式（可选，需设置 AI_SOURCE=claw）

```
手表 → Express后端(/api/v1/send)
         ↓
    写入 Supabase chat_messages(type='user')
         ↓
    小艺Claw轮询 Supabase → 发现新 user 消息
         ↓
    小艺Claw处理完 → 写入 Supabase(type='assistant')
         ↓
    手表轮询(/api/v1/poll) → 获取 assistant 回复
```

## 作者

- **主人**：杨雨润 (Adam)
- **AI 人格**：雨润
- **平台**：华为 Watch 4
