#!/bin/bash
# 版本管理脚本
# 用法: bash version.sh [create|list|checkout|push|help]

set -e

# 颜色定义
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# 获取最新版本号
get_latest_version() {
  git tag -l "v*" --sort=-v:refname | head -n 1
}

# 创建新版本
create_version() {
  local version=$1
  local message=$2

  if [ -z "$version" ]; then
    # 自动递增版本号
    local latest=$(get_latest_version)
    if [ -z "$latest" ]; then
      version="v1.0.0"
    else
      # 解析 v1.2.3 → 增加 patch 版本
      local major=$(echo "$latest" | cut -d. -f1)
      local minor=$(echo "$latest" | cut -d. -f2)
      local patch=$(echo "$latest" | cut -d. -f3)
      patch=$((patch + 1))
      version="${major}.${minor}.${patch}"
    fi
  fi

  if [ -z "$message" ]; then
    message="$version - 新版本发布"
  fi

  # 检查是否有未提交的更改
  if [ -n "$(git status --porcelain)" ]; then
    echo -e "${YELLOW}⚠️  有未提交的更改，先提交...${NC}"
    git add -A
    git commit -m "release: $version"
  fi

  local commit=$(git rev-parse --short HEAD)

  echo -e "${BLUE}正在创建版本标签...${NC}"
  echo -e "  版本号: ${GREEN}$version${NC}"
  echo -e "  提交:   $commit"
  echo -e "  描述:   $message"

  git tag -a "$version" -m "$message"

  echo -e "${GREEN}✅ 版本 $version 已创建${NC}"
  echo -e "${BLUE}推送命令: git push origin $version${NC}"
}

# 列出所有版本
list_versions() {
  echo -e "${BLUE}📋 版本列表:${NC}"
  echo ""
  git tag -l "v*" --sort=-v:refname --format='%(refname:short) | %(subject) | %(taggerdate:short)' | while read -r line; do
    echo -e "  ${GREEN}$line${NC}"
  done
}

# 切换到指定版本
checkout_version() {
  local version=$1
  if [ -z "$version" ]; then
    echo -e "${RED}❌ 错误: 请指定版本号${NC}"
    echo -e "${BLUE}示例: bash version.sh checkout v1.2.0${NC}"
    exit 1
  fi

  if ! git tag -l "$version" | grep -q "$version"; then
    echo -e "${RED}❌ 错误: 版本 $version 不存在${NC}"
    echo -e "${BLUE}可用版本:${NC}"
    git tag -l "v*" --sort=-v:refname
    exit 1
  fi

  echo -e "${BLUE}切换到版本 $version...${NC}"
  git checkout "$version"
  echo -e "${GREEN}✅ 已切换到 $version${NC}"
  echo -e "${YELLOW}提示: 当前处于'分离头指针'状态，修改不会保存到分支${NC}"
  echo -e "${YELLOW}      完成后用 'git checkout main' 返回主分支${NC}"
}

# 推送所有标签
push_versions() {
  echo -e "${BLUE}正在推送所有版本标签到 GitHub...${NC}"
  git push origin --tags
  echo -e "${GREEN}✅ 所有标签已推送${NC}"
}

# 显示帮助
show_help() {
  echo -e "${BLUE}📦 雨润Claw 版本管理脚本${NC}"
  echo ""
  echo "用法: bash version.sh [命令] [参数]"
  echo ""
  echo -e "${GREEN}命令列表:${NC}"
  echo "  create [版本号] [描述]  创建新版本标签（不传版本号则自动递增）"
  echo "  list                    列出所有版本"
  echo "  checkout <版本号>       切换到指定版本"
  echo "  push                    推送所有标签到GitHub"
  echo "  help                    显示此帮助"
  echo ""
  echo -e "${YELLOW}示例:${NC}"
  echo "  bash version.sh create                    # 自动创建 v1.4.0"
  echo "  bash version.sh create v2.0.0             # 创建指定版本"
  echo "  bash version.sh create v1.4.0 '新增功能X' # 创建带描述的版本"
  echo "  bash version.sh list                      # 查看所有版本"
  echo "  bash version.sh checkout v1.2.0           # 回退到本地模型版本"
  echo "  bash version.sh push                      # 推送所有标签"
}

# 主逻辑
case "${1:-help}" in
  create)
    create_version "$2" "$3"
    ;;
  list)
    list_versions
    ;;
  checkout)
    checkout_version "$2"
    ;;
  push)
    push_versions
    ;;
  help|--help|-h)
    show_help
    ;;
  *)
    echo -e "${RED}❌ 未知命令: $1${NC}"
    show_help
    exit 1
    ;;
esac
