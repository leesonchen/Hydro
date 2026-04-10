#!/bin/bash
# Hydro 开发版本从私有 npm 仓库安装/更新的一键脚本

set -e

# 颜色定义
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd /tmp  # 切换到非 workspace 目录

echo -e "${GREEN}=== Hydro 开发版本安装/更新脚本 ===${NC}"
echo ""

# 检查必要工具
check_tools() {
    echo -e "${YELLOW}1. 检查必要工具...${NC}"
    local missing_tools=()

    if ! command -v yarn &> /dev/null; then
        missing_tools+=("yarn")
    fi

    if ! command -v npm &> /dev/null; then
        missing_tools+=("npm")
    fi

    if ! command -v pm2 &> /dev/null; then
        echo -e "${YELLOW}⚠ PM2 未安装，服务管理功能将不可用${NC}"
    fi

    if [ ${#missing_tools[@]} -gt 0 ]; then
        echo -e "${RED}错误: 缺少必要工具: ${missing_tools[*]}${NC}"
        exit 1
    fi

    echo -e "${GREEN}✓ 所有必要工具已安装${NC}"
    echo ""
}

# 检查 Node.js 版本
check_node_version() {
    echo -e "${YELLOW}2. 检查 Node.js 版本...${NC}"
    NODE_VERSION=$(node --version 2>/dev/null || echo "v0.0.0")
    if [[ "$NODE_VERSION" =~ v([0-9]+) ]]; then
        NODE_MAJOR_VER=${BASH_REMATCH[1]}
        if (( NODE_MAJOR_VER < 22 )); then
            echo -e "${RED}错误: 需要 Node.js v22 或更高版本${NC}"
            echo -e "当前版本: $NODE_VERSION"
            exit 1
        fi
        echo -e "${GREEN}✓ Node.js 版本 $NODE_VERSION 通过验证${NC}"
    else
        echo -e "${RED}错误: Node.js 未安装${NC}"
        exit 1
    fi
    echo ""
}

# 配置 npm registry
setup_registry() {
    echo -e "${YELLOW}3. 配置 npm 仓库地址...${NC}"
    npm config set registry https://npm.leeson.top/
    yarn config set registry https://npm.leeson.top/

    # 清除可能的 yarnrc，避免冲突
    rm -f ~/.yarnrc 2>/dev/null || true

    echo -e "${GREEN}✓ npm 仓库配置完成${NC}"
    echo ""
}

# 停止服务
stop_services() {
    if command -v pm2 &> /dev/null; then
        echo -e "${YELLOW}4. 停止现有服务...${NC}"
        pm2 stop hydrooj 2>/dev/null || true
        pm2 stop hydro-sandbox 2>/dev/null || true
        pm2 stop hydrojudge 2>/dev/null || true
        echo -e "${GREEN}✓ 服务已停止${NC}"
        echo ""
    fi
}

# 清除旧版本
clear_old_versions() {
    echo -e "${YELLOW}5. 清除旧版本和缓存...${NC}"

    # 移除全局包
    if command -v yarn &> /dev/null; then
        yarn global remove hydrooj @hydrooj/ui-default @hydrooj/hydrojudge @hydrooj/fps-importer 2>/dev/null || true
    fi
    if command -v npm &> /dev/null; then
        npm uninstall -g hydrooj @hydrooj/ui-default @hydrooj/hydrojudge @hydrooj/fps-importer 2>/dev/null || true
    fi

    # 清除缓存
    if command -v yarn &> /dev/null; then
        yarn cache clean --force 2>/dev/null || true
    fi
    if command -v npm &> /dev/null; then
        npm cache clean --force 2>/dev/null || true
    fi

    # 删除可能的旧 symlink
    rm -f /usr/local/bin/hydrooj 2>/dev/null || true

    echo -e "${GREEN}✓ 旧版本和缓存已清除${NC}"
    echo ""
}

# 安装包
install_packages() {
    echo -e "${YELLOW}6. 从私有 npm 仓库安装开发版本...${NC}"

    # 使用 npm 安装（避免 yarn 的 localhost:4873 问题）
    echo -e "正在安装 hydrooj@dev..."
    npm install -g hydrooj@dev 2>&1 | grep -E "added|removed|changed|up to date" || true

    echo -e ""
    echo -e "正在安装 @hydrooj/ui-default@dev..."
    npm install -g @hydrooj/ui-default@dev 2>&1 | grep -E "added|removed|changed|up to date" || true

    echo -e ""
    echo -e "正在安装 @hydrooj/hydrojudge@dev..."
    npm install -g @hydrooj/hydrojudge@dev 2>&1 | grep -E "added|removed|changed|up to date" || true

    echo -e ""
    echo -e "${GREEN}✓ 所有包安装完成${NC}"
    echo ""
}

# 验证安装
verify_install() {
    echo -e "${YELLOW}7. 验证安装...${NC}"

    # 查找 npm global bin 目录中的 hydrooj
    local npm_bin_dir=$(npm config get prefix 2>/dev/null)/bin
    local hydrooj_bin=""

    # 检查 npm global bin 中是否有 hydrooj
    if [ -f "$npm_bin_dir/hydrooj" ]; then
        hydrooj_bin="$npm_bin_dir/hydrooj"
        echo -e "${GREEN}✓ 找到 hydrooj: $hydrooj_bin${NC}"
    else
        # 尝试在 nix store 中查找
        hydrooj_bin=$(find /nix/store -name "hydrooj" -path "*/bin/hydrooj" -type l 2>/dev/null | head -1)
        if [ -n "$hydrooj_bin" ]; then
            echo -e "${GREEN}✓ 找到 hydrooj: $hydrooj_bin${NC}"
        fi
    fi

    # 创建 /usr/local/bin/hydrooj symlink（PM2 需要）
    if [ -n "$hydrooj_bin" ]; then
        echo -e "  创建 symlink: /usr/local/bin/hydrooj -> $hydrooj_bin"
        ln -sf "$hydrooj_bin" /usr/local/bin/hydrooj

        if [ -f /usr/local/bin/hydrooj ]; then
            echo -e "${GREEN}✓ symlink 创建成功${NC}"
        else
            echo -e "${RED}✗ symlink 创建失败${NC}"
        fi
    else
        echo -e "${RED}✗ 无法找到 hydrooj 可执行文件${NC}"
    fi

    # 验证命令可用性
    if command -v hydrooj &> /dev/null; then
        echo -e "${GREEN}✓ hydrooj 命令可用${NC}"
    else
        echo -e "${YELLOW}⚠ hydrooj 命令不在 PATH 中，但 PM2 可以通过 /usr/local/bin/hydrooj 访问${NC}"
    fi

    echo ""
}

# 同步 ui-default dev 版本静态资源名，避免模板引用 dev 文件而静态目录仅有基础版本
sync_ui_static_aliases() {
    echo -e "${YELLOW}8. 同步 UI 静态资源版本...${NC}"

    local ui_version=""
    local base_version=""
    ui_version=$(npm view @hydrooj/ui-default@dev version --registry https://npm.leeson.top/ 2>/dev/null | tr -d '[:space:]')
    base_version=$(echo "$ui_version" | sed -E 's/-dev\.[0-9]+$//')

    if [ -z "$ui_version" ]; then
        echo -e "${YELLOW}⚠ 无法获取 ui-default@dev 版本，跳过同步${NC}"
        echo ""
        return 0
    fi

    if [ "$ui_version" = "$base_version" ]; then
        echo -e "${GREEN}✓ 当前不是 dev 版本，无需同步${NC}"
        echo ""
        return 0
    fi

    local static_dir="/root/.hydro/static"
    local source_theme="$static_dir/theme-${base_version}.css"
    local source_hydro="$static_dir/hydro-${base_version}.js"
    local target_theme="$static_dir/theme-${ui_version}.css"
    local target_hydro="$static_dir/hydro-${ui_version}.js"

    if [ -f "$source_theme" ] && [ ! -f "$target_theme" ]; then
        cp -f "$source_theme" "$target_theme"
    fi
    if [ -f "$source_hydro" ] && [ ! -f "$target_hydro" ]; then
        cp -f "$source_hydro" "$target_hydro"
    fi

    if [ -f "$target_theme" ] && [ -f "$target_hydro" ]; then
        echo -e "${GREEN}✓ UI 静态资源已同步到 dev 版本名 (${ui_version})${NC}"
    else
        echo -e "${YELLOW}⚠ 部分静态资源未生成，建议重启后再次执行同步${NC}"
    fi
    echo ""
}

# 启动服务
start_services() {
    if command -v pm2 &> /dev/null; then
        echo -e "${YELLOW}9. 启动服务...${NC}"

        echo -e "启动 hydrooj..."
        pm2 start hydrooj 2>&1 || echo -e "${YELLOW}启动失败，尝试恢复...${NC}"

        echo -e "启动 hydro-sandbox..."
        pm2 start hydro-sandbox 2>/dev/null || true

        echo -e "启动 hydrojudge..."
        pm2 start hydrojudge 2>/dev/null || true

        echo -e "保存 PM2 配置..."
        pm2 save 2>/dev/null || true

        echo -e ""
        echo -e "${GREEN}✓ 服务状态:${NC}"
        pm2 status 2>/dev/null || echo -e "${RED}无法获取服务状态${NC}"
        echo ""
    fi
}

# 显示完成信息
show_complete() {
    echo -e "${GREEN}=== 安装/更新完成 ===${NC}"
    echo ""
    echo -e "下一步验证:"
    echo -e "  1. ${YELLOW}pm2 status${NC} - 检查服务状态"
    echo -e "  2. ${YELLOW}pm2 logs hydrooj --lines 50${NC} - 查看日志"
    echo -e "  3. ${YELLOW}curl -I http://localhost${NC} - 测试本地访问"
    echo -e "  4. 浏览器访问: http://服务器IP"
    echo ""
    echo -e "如果遇到问题:"
    echo -e "  - 检查 Verdaccio 配置: ${YELLOW}url_prefix: https://npm.leeson.top/${NC}"
    echo -e "  - 确保能访问: ${YELLOW}https://npm.leeson.top/${NC}"
    echo -e "  - 查看详细日志: ${YELLOW}pm2 logs hydrooj${NC}"
    echo ""
}

# 主流程
main() {
    check_tools
    check_node_version
    setup_registry
    stop_services
    clear_old_versions
    install_packages
    verify_install
    start_services
    sync_ui_static_aliases
    show_complete
}

# 运行主流程
main "$@"
