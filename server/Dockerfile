# 雨润Claw 后端 Docker 镜像
FROM node:20-alpine

WORKDIR /app

# 安装 pnpm
RUN npm install -g pnpm

# 复制依赖配置
COPY package.json pnpm-lock.yaml* ./
RUN pnpm install --frozen-lockfile || pnpm install

# 复制源码
COPY . .

# 构建
RUN pnpm run build

# 暴露端口
EXPOSE 9091

# 启动
CMD ["node", "dist/index.js"]
