#!/bin/bash
# Hydro 开发版本从私有 npm 仓库安装/更新的一键脚本

set -e

# 颜色定义
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color
NPM_REGISTRY="${NPM_REGISTRY:-https://npm.leeson.top/}"
HYDRO_HOME="${HYDRO_HOME:-$HOME/.hydro}"
SERVICE_VERIFY_DELAY_SECONDS="${SERVICE_VERIFY_DELAY_SECONDS:-5}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd /tmp  # 切换到非 workspace 目录

# Docker/Nix 环境中非 login shell 可能没有加载 npm/yarn/pm2 所在目录。
for path_entry in "$HOME/.nix-profile/bin" /nix/var/nix/profiles/default/bin /usr/local/bin; do
    if [ -d "$path_entry" ] && [[ ":$PATH:" != *":$path_entry:"* ]]; then
        PATH="$path_entry:$PATH"
    fi
done
export PATH

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
    npm config set registry "$NPM_REGISTRY"
    yarn config set registry "$NPM_REGISTRY"

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
install_global_package() {
    local package_spec="$1"
    local safe_package_spec
    safe_package_spec=$(echo "$package_spec" | tr '/@:' '___')
    local log_file="/tmp/install-${safe_package_spec}.log"

    echo -e "正在安装 ${package_spec}..."
    rm -f "$log_file"
    npm install -g "$package_spec" --registry "$NPM_REGISTRY" 2>&1 | tee "$log_file"
    local status=${PIPESTATUS[0]}
    if [ "$status" -eq 0 ]; then
        grep -E "added|removed|changed|up to date" "$log_file" || true
    else
        echo -e "${RED}错误: ${package_spec} 安装失败，详情日志: ${log_file}${NC}"
        return 1
    fi
}

install_packages() {
    echo -e "${YELLOW}6. 从私有 npm 仓库安装开发版本...${NC}"

    # 使用 npm 安装（避免 yarn 的 localhost:4873 问题），并显式指定 registry。
    install_global_package "hydrooj@dev"
    echo -e ""
    install_global_package "@hydrooj/ui-default@dev"
    echo -e ""
    install_global_package "@hydrooj/hydrojudge@dev"

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
        return 1
    fi

    # 验证命令可用性
    if command -v hydrooj &> /dev/null; then
        echo -e "${GREEN}✓ hydrooj 命令可用${NC}"
    else
        echo -e "${YELLOW}⚠ hydrooj 命令不在 PATH 中，但 PM2 可以通过 /usr/local/bin/hydrooj 访问${NC}"
        if [ ! -x /usr/local/bin/hydrooj ]; then
            echo -e "${RED}✗ /usr/local/bin/hydrooj 不可执行${NC}"
            return 1
        fi
    fi

    echo ""
}

# 同步 ui-default dev 版本静态资源名，避免模板引用 dev 文件而静态目录仅有基础版本
sync_ui_static_aliases() {
    echo -e "${YELLOW}10. 同步 UI 静态资源版本...${NC}"

    local ui_version=""
    local base_version=""
    ui_version=$(npm view @hydrooj/ui-default@dev version --registry "$NPM_REGISTRY" 2>/dev/null | tr -d '[:space:]')
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

    local static_dir="$HYDRO_HOME/static"
    local package_public_dir
    package_public_dir="$(npm root -g 2>/dev/null)/@hydrooj/ui-default/public"
    local source_theme="$package_public_dir/theme-${ui_version}.css"
    local source_hydro="$package_public_dir/hydro-${ui_version}.js"
    local target_theme="$static_dir/theme-${ui_version}.css"
    local target_hydro="$static_dir/hydro-${ui_version}.js"

    if [ ! -f "$source_theme" ]; then
        source_theme="$static_dir/theme-${base_version}.css"
    fi
    if [ ! -f "$source_theme" ]; then
        source_theme=$(find "$static_dir" "$package_public_dir" -maxdepth 1 -type f -name "theme-${base_version}-dev.*.css" 2>/dev/null | sort -V | tail -1)
    fi
    if [ ! -f "$source_hydro" ]; then
        source_hydro="$static_dir/hydro-${base_version}.js"
    fi
    if [ ! -f "$source_hydro" ]; then
        source_hydro=$(find "$static_dir" "$package_public_dir" -maxdepth 1 -type f -name "hydro-${base_version}-dev.*.js" 2>/dev/null | sort -V | tail -1)
    fi

    mkdir -p "$static_dir"
    if [ -n "$source_theme" ] && [ -f "$source_theme" ] && [ ! -f "$target_theme" ]; then
        cp -f "$source_theme" "$target_theme"
    fi
    if [ -n "$source_hydro" ] && [ -f "$source_hydro" ] && [ ! -f "$target_hydro" ]; then
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

# PM2 启动命令可能先成功、随后进程崩溃；短暂等待后再确认 hydrooj 仍在线。
verify_services() {
    if ! command -v pm2 &> /dev/null; then
        return 0
    fi

    echo -e "${YELLOW}11. 验证服务运行状态...${NC}"
    sleep "$SERVICE_VERIFY_DELAY_SECONDS"

    if pm2 jlist 2>/dev/null | node -e '
const chunks = [];
process.stdin.on("data", (chunk) => chunks.push(chunk));
process.stdin.on("end", () => {
  const list = JSON.parse(Buffer.concat(chunks).toString() || "[]");
  const app = list.find((item) => item.name === "hydrooj");
  process.exit(app && app.pm2_env && app.pm2_env.status === "online" ? 0 : 1);
});
'; then
        echo -e "${GREEN}✓ hydrooj 服务保持在线${NC}"
    else
        echo -e "${RED}✗ hydrooj 服务未保持在线，请查看最近日志:${NC}"
        pm2 logs hydrooj --lines 50 --nostream 2>/dev/null || true
        return 1
    fi
    echo ""
}

verify_login_page() {
    echo -e "${YELLOW}12. 验证登录页响应...${NC}"

    local body
    body=$(curl -fsSL --max-time 10 http://127.0.0.1/login?redirect=%2F 2>/dev/null || true)
    if [ "$body" = "{}" ] || ! echo "$body" | grep -qiE "<html|<form|login|signin|登录"; then
        echo -e "${RED}✗ 登录页响应异常，请查看最近日志:${NC}"
        echo "$body" | head -c 500
        echo ""
        pm2 logs hydrooj --lines 80 --nostream 2>/dev/null || true
        return 1
    fi

    echo -e "${GREEN}✓ 登录页响应正常${NC}"
    echo ""
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
    echo -e "  - 检查 Verdaccio 配置: ${YELLOW}url_prefix: ${NPM_REGISTRY}${NC}"
    echo -e "  - 确保能访问: ${YELLOW}${NPM_REGISTRY}${NC}"
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
    verify_services
    verify_login_page
    show_complete
}

# 运行主流程
main "$@"
