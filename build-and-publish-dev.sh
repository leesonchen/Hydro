#!/bin/bash
# Hydro 开发版本打包并发布到私有 npm 仓库的一键脚本

set -e

# 颜色定义
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color
PUBLISH_TIMEOUT_SECONDS=300
PUBLISH_RETRY_COUNT=3

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo -e "${GREEN}=== Hydro 开发版本打包发布脚本 ===${NC}"
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

    if [ ${#missing_tools[@]} -gt 0 ]; then
        echo -e "${RED}错误: 缺少必要工具: ${missing_tools[*]}${NC}"
        exit 1
    fi

    echo -e "${GREEN}✓ 所有必要工具已安装${NC}"
    echo ""
}

# 配置 npm registry
setup_registry() {
    echo -e "${YELLOW}2. 配置 npm 仓库地址...${NC}"
    npm config set registry https://npm.leeson.top/
    yarn config set registry https://npm.leeson.top/

    # 增加超时时间
    npm config set fetch-timeout 600000
    npm config set fetch-retry-maxtimeout 300000

    echo -e "${GREEN}✓ npm 仓库配置完成${NC}"
    echo ""
}

# 获取当前版本号
get_current_version() {
    local package_path="$1"
    if [ -f "$package_path/package.json" ]; then
        grep '"version"' "$package_path/package.json" | head -1 | cut -d'"' -f4
    else
        echo ""
    fi
}

# 增加版本号
increment_version() {
    local version="$1"
    # 检查是否是 dev 版本
    if [[ "$version" =~ ^(.+)-dev\.([0-9]+)$ ]]; then
        local base="${BASH_REMATCH[1]}"
        local num="${BASH_REMATCH[2]}"
        echo "$base-dev.$((num + 1))"
    else
        # 如果不是 dev 版本，添加 -dev.1
        echo "$version-dev.1"
    fi
}

# 为 ui-default 生成与完整版本号一致的静态资源别名（并控制别名数量）
prepare_ui_asset_aliases() {
    local package_path="$1"
    local full_version="$2"
    local public_dir="$package_path/public"
    local base_version
    base_version=$(echo "$full_version" | sed -E 's/-dev\.[0-9]+$//')

    if [ ! -d "$public_dir" ] || [ "$base_version" = "$full_version" ]; then
        return 0
    fi

    local source_theme="$public_dir/theme-${base_version}.css"
    local source_hydro="$public_dir/hydro-${base_version}.js"
    local target_theme="$public_dir/theme-${full_version}.css"
    local target_hydro="$public_dir/hydro-${full_version}.js"

    # 先清理同基础版本的历史 dev 别名，避免包体逐次膨胀
    find "$public_dir" -maxdepth 1 -type f -name "theme-${base_version}-dev.*.css" ! -name "theme-${full_version}.css" -delete 2>/dev/null || true
    find "$public_dir" -maxdepth 1 -type f -name "hydro-${base_version}-dev.*.js" ! -name "hydro-${full_version}.js" -delete 2>/dev/null || true

    UI_ALIAS_THEME_CREATED=0
    UI_ALIAS_HYDRO_CREATED=0
    UI_ALIAS_THEME_PATH="$target_theme"
    UI_ALIAS_HYDRO_PATH="$target_hydro"

    if [ -f "$source_theme" ] && [ ! -f "$target_theme" ]; then
        cp -f "$source_theme" "$target_theme"
        UI_ALIAS_THEME_CREATED=1
    fi
    if [ -f "$source_hydro" ] && [ ! -f "$target_hydro" ]; then
        cp -f "$source_hydro" "$target_hydro"
        UI_ALIAS_HYDRO_CREATED=1
    fi
}

cleanup_ui_asset_aliases() {
    if [ "${UI_ALIAS_THEME_CREATED:-0}" -eq 1 ] && [ -f "${UI_ALIAS_THEME_PATH:-}" ]; then
        rm -f "$UI_ALIAS_THEME_PATH"
    fi
    if [ "${UI_ALIAS_HYDRO_CREATED:-0}" -eq 1 ] && [ -f "${UI_ALIAS_HYDRO_PATH:-}" ]; then
        rm -f "$UI_ALIAS_HYDRO_PATH"
    fi
}

# 更新 package.json 中的 workspace 依赖
fix_workspace_deps() {
    local package_path="$1"
    local package_json="$package_path/package.json"

    if [ -f "$package_json" ]; then
        # 替换 workspace:^ 为实际版本号
        # @hydrooj/common -> 0.0.7
        # @hydrooj/framework -> 0.2.7
        # @hydrooj/utils -> 1.5.4
        sed -i.bak 's/"@hydrooj\/common": "workspace:\^"/"@hydrooj\/common": "0.0.7"/g' "$package_json"
        sed -i.bak 's/"@hydrooj\/framework": "workspace:\^"/"@hydrooj\/framework": "0.2.7"/g' "$package_json"
        sed -i.bak 's/"@hydrooj\/utils": "workspace:\^"/"@hydrooj\/utils": "1.5.4"/g' "$package_json"

        # 删除备份文件
        rm -f "$package_json.bak"
    fi
}

# 打包并发布单个包
publish_package() {
    local package_name="$1"
    local package_path="$2"
    local tgz_filename="$3"

    echo -e "${YELLOW}处理包: ${package_name}${NC}"

    if [ ! -d "$package_path" ]; then
        echo -e "${RED}错误: 包目录不存在: $package_path${NC}"
        return 1
    fi

    cd "$package_path"

    # 修复 workspace 依赖
    fix_workspace_deps "$package_path"

    # 获取当前版本并递增
    local current_version=$(get_current_version "$package_path")
    local new_version=$(increment_version "$current_version")

    echo -e "  版本: $current_version -> $new_version"

    # 更新 package.json 版本号
    sed -i.bak "s/\"version\": \"$current_version\"/\"version\": \"$new_version\"/" package.json
    rm -f package.json.bak

    # 对 ui-default 追加静态资源别名，确保与 dev 版本号一致
    if [ "$package_name" = "@hydrooj/ui-default" ]; then
        prepare_ui_asset_aliases "$package_path" "$new_version"
    fi

    # 清理旧的打包文件
    rm -f "$tgz_filename"

    # 打包
    echo -e "  正在打包..."
    yarn pack --filename "$tgz_filename" > /dev/null 2>&1

    if [ ! -f "$tgz_filename" ]; then
        echo -e "${RED}错误: 打包失败${NC}"
        cd "$SCRIPT_DIR"
        return 1
    fi

    # 发布
    echo -e "  正在发布到私有 npm 仓库..."
    cd /tmp
    rm -rf publish-temp
    mkdir -p publish-temp
    cd publish-temp
    tar -xzf "$package_path/$tgz_filename"
    cd package

    local safe_package_name
    safe_package_name=$(echo "$package_name" | tr '/@' '__')
    local log_file="/tmp/npm-publish-${safe_package_name}-${new_version}.log"
    local publish_success=0
    local attempt
    for attempt in $(seq 1 "$PUBLISH_RETRY_COUNT"); do
        echo -e "  发布尝试 ${attempt}/${PUBLISH_RETRY_COUNT}..."
        rm -f "$log_file"
        if command -v timeout > /dev/null 2>&1; then
            timeout "$PUBLISH_TIMEOUT_SECONDS" npm publish --registry https://npm.leeson.top/ --tag dev 2>&1 | tee "$log_file"
            local status=${PIPESTATUS[0]}
        else
            npm publish --registry https://npm.leeson.top/ --tag dev 2>&1 | tee "$log_file"
            local status=${PIPESTATUS[0]}
        fi

        if [ "$status" -eq 0 ]; then
            publish_success=1
            break
        fi

        # 已存在视为可接受，避免阻塞后续流程
        if grep -qiE "cannot publish over existing version|previously published|forbidden.*version" "$log_file"; then
            echo -e "  ${YELLOW}版本可能已存在，按成功处理${NC}"
            publish_success=1
            break
        fi

        if [ "$attempt" -lt "$PUBLISH_RETRY_COUNT" ]; then
            echo -e "  ${YELLOW}发布失败，5秒后重试...${NC}"
            sleep 5
        fi
    done

    if [ "$publish_success" -eq 1 ]; then
        echo -e "${GREEN}✓ ${package_name}@${new_version} 发布成功${NC}"
    else
        echo -e "${YELLOW}⚠ ${package_name} 发布失败，详情日志: ${log_file}${NC}"
    fi

    if [ "$package_name" = "@hydrooj/ui-default" ]; then
        cleanup_ui_asset_aliases
    fi

    cd "$SCRIPT_DIR"
    rm -rf /tmp/publish-temp

    echo ""
}

# 主流程
main() {
    check_tools
    setup_registry

    echo -e "${YELLOW}3. 开始打包和发布...${NC}"
    echo ""

    # 先发布依赖包（不递增版本，使用固定版本）
    echo -e "${YELLOW}发布依赖包...${NC}"

    if [ -d "$SCRIPT_DIR/packages/common" ]; then
        echo -e "发布 @hydrooj/common..."
        cd "$SCRIPT_DIR/packages/common"
        rm -f common.tgz
        yarn pack --filename common.tgz > /dev/null 2>&1
        cd /tmp && rm -rf publish-temp && mkdir -p publish-temp && cd publish-temp
        tar -xzf "$SCRIPT_DIR/packages/common/common.tgz"
        cd package
        npm publish --registry https://npm.leeson.top/ > /dev/null 2>&1 || echo -e "${YELLOW}  (可能已存在)${NC}"
        cd "$SCRIPT_DIR"
        rm -rf /tmp/publish-temp
    fi

    echo ""

    # 发布 hydrooj
    publish_package "hydrooj" "$SCRIPT_DIR/packages/hydrooj" "hydrooj-dev.tgz"

    # 发布 ui-default
    publish_package "@hydrooj/ui-default" "$SCRIPT_DIR/packages/ui-default" "ui-default-dev.tgz"

    # 发布 hydrojudge
    publish_package "@hydrooj/hydrojudge" "$SCRIPT_DIR/packages/hydrojudge" "hydrojudge-dev.tgz"

    echo -e "${GREEN}=== 所有包发布完成 ===${NC}"
    echo ""
    echo -e "已发布的版本:"
    echo -e "  - @hydrooj/common@$(get_current_version "$SCRIPT_DIR/packages/common")"
    echo -e "  - hydrooj@$(get_current_version "$SCRIPT_DIR/packages/hydrooj")"
    echo -e "  - @hydrooj/ui-default@$(get_current_version "$SCRIPT_DIR/packages/ui-default")"
    echo -e "  - @hydrooj/hydrojudge@$(get_current_version "$SCRIPT_DIR/packages/hydrojudge")"
    echo ""
    echo -e "安装命令:"
    echo -e "  ${YELLOW}./install-dev-from-private-npm.sh${NC}"
    echo ""
}

# 运行主流程
main "$@"
