# 版本变更日志

> 本项目使用 Git 标签管理版本，每个关键节点都有独立的版本号。
> 通过 `git checkout v1.x.x` 可一键回退到任意版本。

---

## v1.3.0 (当前默认分支) — 小艺Claw对接优化版

**提交**: `07c680d`
**标签**: `v1.3.0`
**日期**: 2025-07-16

### 变更
- 默认模式切换回小艺Claw对接（`AI_SOURCE=claw`）
- 修复 `/api/v1/poll` 路由在Claw模式下无法获取回复的Bug
  - 之前poll只查内存chatStore，Claw服务直接写Supabase导致永远收不到回复
  - 现在poll在Claw模式下会去Supabase查询最新的assistant消息
- 添加 `.env` 文件 + dotenv 强制加载逻辑
  - 之前dotenv只在supabase-client.ts中按需加载，条件判断阻止了执行
- 保留本地大模型代码作为备选（`local-llm.ts` + SSE流式路由）

### 适用场景
- 需要**秒级AI回复**，不想忍受本地模型CPU推理的缓慢
- 已和小艺Claw建立对接链路

### 回退命令
```bash
git checkout v1.3.0
```

---

## v1.2.0 — 本地大模型版本

**提交**: `7b97849`
**标签**: `v1.2.0`
**日期**: 2025-07-16

### 变更
- 后端接入本地大模型：Ollama + Qwen2.5-7B
- 新增 `server/src/local-llm.ts` 封装Ollama API调用
- 新增 `POST /api/v1/chat` SSE流式对话路由（实时逐字推送）
- 新增 `GET /api/v1/llm-status` Ollama服务健康检查
- 取消所有字数限制（`num_predict: -1`）
- 搜索功能改为可选（无网络时静默跳过）

### 适用场景
- 需要**完全离线运行**，不依赖任何外部AI服务
- 有NVIDIA GPU或愿意接受CPU推理的延迟

### 模型推荐
| 模型 | 大小 | 特点 |
|------|------|------|
| qwen2.5:7b | ~4.5GB | 中文能力顶级，默认推荐 |
| qwen2.5:3b | ~2GB | 速度更快，质量稍降 |
| deepseek-r1:7b | ~4GB | 推理能力强 |
| llama3.2 | ~2GB | 英文为主，轻量 |

### 回退命令
```bash
git checkout v1.2.0
```

---

## v1.1.0 — 纯Supabase模式

**提交**: `b18a64a`
**标签**: `v1.1.0`
**日期**: 2025-07-16

### 变更
- 后端Claw模式从"Cloudflare Worker中转"改为"纯Supabase模式"
- 去掉Cloudflare Worker依赖（沙箱无法访问*.workers.dev）
- 后端只写user消息到Supabase，Claw服务直接轮Supabase处理
- 删除 `claw-client.ts` 中的Worker调用逻辑

### 适用场景
- 需要和小艺Claw对接，但Worker部署失败
- 国内网络环境，Supabase直连稳定

### 回退命令
```bash
git checkout v1.1.0
```

---

## v1.0.0 — 初始完整版本

**提交**: `9834427`
**标签**: `v1.0.0`
**日期**: 2025-07-16

### 功能清单
- **前端（Expo 54 + React Native）**
  - 深色主题聊天界面（#0D0D0D背景）
  - 语音输入（expo-av，可编辑）
  - 文档上传（PDF/DOCX/TXT）
  - 模式切换：普通对话 / 搜索模式 / 文档模式
  - FlatList反转消息列表，每5秒轮询刷新
  - useFocusEffect页面返回自动刷新

- **后端（Express.js + TypeScript）**
  - AI对话（LLMClient → 豆包 doubao-lite-260215）
  - 多设备消息同步（Supabase chat_messages表）
  - 对话记忆（最近50条消息）
  - 实时网页搜索（SearchClient）
  - Markdown文档输出（react-native-markdown-display）
  - 知识库（Supabase存储 + 关键词匹配）
  - 文档解析（pdf-parse + mammoth）

- **部署**
  - Dockerfile + docker-compose
  - Docker Hub镜像

### 回退命令
```bash
git checkout v1.0.0
```

---

## 版本管理规范

### 如何切换版本

```bash
# 查看所有版本标签
git tag -l

# 切换到指定版本（只读，不影响当前分支）
git checkout v1.2.0

# 切换回最新版本
git checkout main
```

### 如何创建新版本

每次重大修改后，执行以下命令：

```bash
# 1. 确保代码已提交
git add -A
git commit -m "feat: 你的修改描述"

# 2. 获取最新提交哈希
COMMIT=$(git rev-parse --short HEAD)

# 3. 打标签（语义化版本号）
git tag -a v1.4.0 $COMMIT -m "v1.4.0 - 版本描述"

# 4. 推送标签到GitHub
git push origin v1.4.0
```

### 语义化版本号规则

| 版本号变化 | 含义 | 示例 |
|-----------|------|------|
| v1.0.0 → v1.1.0 | 新增功能，向后兼容 | 新增本地大模型支持 |
| v1.1.0 → v1.2.0 | 新增功能，向后兼容 | 新增SSE流式对话 |
| v1.2.0 → v1.3.0 | 新增功能，向后兼容 | 修复poll路由Bug |
| v2.0.0 | 破坏性变更，不兼容旧版 | 重构数据库Schema |

---

## 版本时间线

```
v1.0.0 (9834427) ──→ v1.1.0 (b18a64a) ──→ v1.2.0 (7b97849) ──→ v1.3.0 (07c680d)
初始完整版本         纯Supabase模式         本地大模型版本         默认Claw对接优化版
```

---

*最后更新: 2025-07-16*
