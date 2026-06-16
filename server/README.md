# 雨润Claw — 腕上AI助手

> 专为华为 Watch 4 智能手表打造的 AI 助手应用

## 项目简介

**雨润Claw** 是一个为华为 Watch 4 智能手表量身定制的 AI 助手应用。应用名称中的 "雨润" 是主人的名字（杨雨润），AI 人格也以 "雨润" 的身份与主人交流。

## 技术架构

### 模式一：小艺Claw 对接（推荐，默认）

```
手表(Expo Web) → Express后端 → Supabase数据库 ←→ 小艺Claw服务
```

**特点：**
- 回复速度快（云端 GPU 推理）
- 无需本地安装大模型
- 小艺Claw 直接轮询 Supabase 处理消息

### 模式二：本地大模型（备选，无需联网）

```
手表(Expo Web) → Express后端 → Ollama本地大模型
                     ↓
                Supabase数据库（多设备同步 + 知识库）
```

**特点：**
- 完全离线，保护隐私
- 需要本地安装 Ollama + 模型（约 4.5GB）
- 纯 CPU 推理，速度较慢（20-60秒/回复）

| 层级 | 技术栈 |
|------|--------|
| 前端 | Expo 54 + React Native + Tailwind CSS |
| 后端 | Express.js + TypeScript |
| 数据库 | Supabase (PostgreSQL) |
| AI 对接 | 小艺Claw 直接读写 Supabase（默认） |
| 本地模型 | Ollama + Qwen2.5-7B（可选） |

## 核心功能

### 1. AI 智能对话
- **小艺Claw 对接（默认）** —— 云端 GPU 推理，秒级回复
- **本地大模型（可选）** —— Ollama + Qwen2.5-7B，完全离线
- 流式输出，逐字显示 AI 回复
- 对话记忆（保留最近 50 条消息上下文）
- **取消字数限制** —— AI 根据问题复杂度自然回复
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
# --- Supabase 数据库（必须）---
COZE_SUPABASE_URL=https://你的项目.supabase.co
COZE_SUPABASE_ANON_KEY=你的anon_key
COZE_SUPABASE_SERVICE_ROLE_KEY=你的service_role_key

# --- AI 模式选择（二选一）---

# 模式A：小艺Claw 对接（推荐，速度快）
AI_SOURCE=claw

# 模式B：本地大模型（无需联网，但速度慢）
# 去掉下面两行前面的 # 即可切换
# OLLAMA_URL=http://localhost:11434
# OLLAMA_MODEL=qwen2.5:7b

# 服务端口号
PORT=9091
```

## 启动方式

### 小艺Claw 模式（推荐，默认）

```bash
# 1. 配置 .env
cp server/.env.example server/.env
# 编辑 .env，确保 AI_SOURCE=claw

# 2. 启动后端
cd server/
pnpm install
pnpm run dev

# 3. 启动前端（另开终端）
cd client/
npx expo start --web
```

### 本地大模型模式（备选，完全离线）

```bash
# 1. 安装 Ollama
curl -fsSL https://ollama.com/install.sh | sh

# 2. 下载模型（约4.5GB）
ollama pull qwen2.5:7b
ollama serve

# 3. 配置 .env（切换到本地模型）
cp server/.env.example server/.env
# 编辑 .env，注释掉 AI_SOURCE=claw，启用 OLLAMA_MODEL

# 4. 启动前后端（同上）
```

### Docker 部署

```bash
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

### 小艺Claw 模式（默认）

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

### 本地大模型模式（可选）

```
手表 → Express后端(/api/v1/chat 或 /api/v1/send)
         ↓
    调用本地 Ollama 大模型生成回复
         ↓
    回复写入 Supabase（多设备同步）
         ↓
    手表 SSE 流式显示 / 轮询获取回复
```

## 作者

- **主人**：杨雨润 (Adam)
- **AI 人格**：雨润
- **平台**：华为 Watch 4
