# 雨润Claw 后端部署指南

## 方式一：腾讯云轻量应用服务器（推荐）

### 前提条件
1. 购买一台腾讯云轻量应用服务器（2核2G 够跑）
2. 服务器系统选择 Ubuntu 22.04
3. 开放防火墙端口 9091

### 部署步骤

```bash
# 1. SSH 登录服务器
ssh ubuntu@你的服务器IP

# 2. 安装 Docker
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER
newgrp docker

# 3. 安装 Docker Compose
sudo apt update
sudo apt install -y docker-compose-plugin

# 4. 创建项目目录
mkdir -p ~/rainclaw-server && cd ~/rainclaw-server

# 5. 复制以下文件到服务器（用 scp 或手动创建）
# - Dockerfile
# - docker-compose.yml
# - package.json
# - tsconfig.json
# - build.js
# - src/ 目录下的所有 .ts 文件

# 6. 创建 .env 文件
cat > .env << 'EOF'
COZE_SUPABASE_URL=https://你的项目.supabase.co
COZE_SUPABASE_ANON_KEY=你的anon_key
COZE_SUPABASE_SERVICE_ROLE_KEY=你的service_role_key
EOF

# 7. 构建并启动
docker compose up -d --build

# 8. 查看日志
docker logs -f rainclaw-server

# 9. 测试
curl http://localhost:9091/api/v1/health
```

### 配置腾讯云安全组
1. 进入腾讯云控制台 → 轻量应用服务器 → 防火墙
2. 添加规则：
   - 协议：TCP
   - 端口：9091
   - 策略：允许

### 获取公网访问地址
```
http://你的服务器IP:9091
```

---

## 方式二：Railway（免费，最简单）

1. 访问 https://railway.app
2. 用 GitHub 账号登录
3. 新建项目 → Deploy from GitHub repo
4. 把后端代码 push 到一个 GitHub 仓库
5. Railway 自动识别 Dockerfile 并部署
6. 在 Variables 里添加环境变量
7. 自动生成公网域名

---

## 方式三：Render（免费）

1. 访问 https://render.com
2. 新建 Web Service
3. 连接 GitHub 仓库
4. 选择 Docker 运行时
5. 添加环境变量
6. 自动部署并分配域名

---

## 环境变量说明

| 变量名 | 说明 | 示例 |
|--------|------|------|
| `COZE_SUPABASE_URL` | Supabase 项目 URL | `https://xxx.supabase.co` |
| `COZE_SUPABASE_ANON_KEY` | Supabase Anon Key | `eyJ...` |
| `AI_SOURCE` | AI 模式 | `claw` 或留空（直连LLM） |
| `WORKER_URL` | Cloudflare Worker 地址 | `https://snowy-smoke-edf2.yurunyang69.workers.dev` |
| `AI_BACKEND_TOKEN` | Worker 鉴权 Token | `@yyrAdam~` |
| `PORT` | 服务端口号 | `9091` |

---

## 前端配置

部署完成后，把前端的环境变量指向你的公网地址：

```bash
# 如果是腾讯云
EXPO_PUBLIC_BACKEND_BASE_URL=http://你的服务器IP:9091

# 如果用了 HTTPS（配了域名+证书）
EXPO_PUBLIC_BACKEND_BASE_URL=https://你的域名
```

然后重新构建前端即可。
