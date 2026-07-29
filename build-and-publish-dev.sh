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
NPM_REGISTRY="${NPM_REGISTRY:-https://npm.leeson.top/}"
YARN_APPROVED_GIT_REPOSITORIES="${YARN_APPROVED_GIT_REPOSITORIES:-https://github.com/Mango/emitter.git}"
DEFAULT_PACKAGES=("common" "hydrooj" "ui-default" "hydrojudge" "fps-importer" "a11y" "import-hoj")
SELECTED_PACKAGES=()
TS_PREPARE_DONE=0
BUILT_TS_CONFIGS=()
declare -A PUBLISHED_VERSIONS

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Docker/Nix 环境中非 login shell 可能没有加载 npm/yarn 所在目录。
for path_entry in "$HOME/.nix-profile/bin" /nix/var/nix/profiles/default/bin /usr/local/bin; do
    if [ -d "$path_entry" ] && [[ ":$PATH:" != *":$path_entry:"* ]]; then
        PATH="$path_entry:$PATH"
    fi
done
export PATH
export YARN_APPROVED_GIT_REPOSITORIES

echo -e "${GREEN}=== Hydro 开发版本打包发布脚本 ===${NC}"
echo ""

# 显示用法
print_usage() {
    echo "用法:"
    echo "  ./build-and-publish-dev.sh [--packages pkg1,pkg2]"
    echo ""
    echo "可选包名: common, hydrooj, ui-default, hydrojudge, fps-importer, a11y, import-hoj"
    echo "示例:"
    echo "  ./build-and-publish-dev.sh --packages hydrooj,ui-default,fps-importer"
    echo ""
}

# 交互选择包（支持空格分隔多选）
interactive_select_packages() {
    local options=("common" "hydrooj" "ui-default" "hydrojudge" "fps-importer" "a11y" "import-hoj")
    local idx
    local input

    echo -e "${YELLOW}请选择要构建/发布的包:${NC}"
    echo "  0) all"
    for idx in "${!options[@]}"; do
        echo "  $((idx + 1))) ${options[$idx]}"
    done
    echo "  示例: 0 或 2 3"
    read -r -p "输入序号后回车: " input

    if [ -z "$input" ]; then
        SELECTED_PACKAGES=("${DEFAULT_PACKAGES[@]}")
        return 0
    fi

    local picked=()
    local token
    for token in $input; do
        case "$token" in
            0)
                SELECTED_PACKAGES=("${DEFAULT_PACKAGES[@]}")
                return 0
                ;;
            1)
                picked+=("common")
                ;;
            2)
                picked+=("hydrooj")
                ;;
            3)
                picked+=("ui-default")
                ;;
            4)
                picked+=("hydrojudge")
                ;;
            5)
                picked+=("fps-importer")
                ;;
            6)
                picked+=("a11y")
                ;;
            7)
                picked+=("import-hoj")
                ;;
            *)
                echo -e "${YELLOW}忽略无效序号: ${token}${NC}"
                ;;
        esac
    done

    if [ ${#picked[@]} -eq 0 ]; then
        SELECTED_PACKAGES=("${DEFAULT_PACKAGES[@]}")
    else
        # 去重并保持顺序
        local p
        local unique=()
        for p in "${picked[@]}"; do
            local exists=0
            local u
            for u in "${unique[@]}"; do
                if [ "$u" = "$p" ]; then
                    exists=1
                    break
                fi
            done
            if [ "$exists" -eq 0 ]; then
                unique+=("$p")
            fi
        done
        SELECTED_PACKAGES=("${unique[@]}")
    fi
}

# 解析参数
parse_args() {
    while [ "$#" -gt 0 ]; do
        case "$1" in
            --packages)
                shift
                if [ -z "${1:-}" ]; then
                    echo -e "${RED}错误: --packages 需要参数${NC}"
                    print_usage
                    exit 1
                fi
                IFS=',' read -r -a SELECTED_PACKAGES <<< "$1"
                ;;
            -h|--help)
                print_usage
                exit 0
                ;;
            *)
                echo -e "${RED}错误: 未知参数 $1${NC}"
                print_usage
                exit 1
                ;;
        esac
        shift
    done

    if [ ${#SELECTED_PACKAGES[@]} -eq 0 ]; then
        if [ -t 0 ]; then
            interactive_select_packages
        else
            SELECTED_PACKAGES=("${DEFAULT_PACKAGES[@]}")
        fi
    fi
}

# 判断包是否被选中
is_selected() {
    local target="$1"
    local p
    for p in "${SELECTED_PACKAGES[@]}"; do
        if [ "$p" = "$target" ]; then
            return 0
        fi
    done
    return 1
}

# 构建单个 TypeScript 包。不要构建根 tsconfig，否则未选中的插件类型错误会阻塞发布。
build_ts_package() {
    local package_name="$1"
    local package_path="$2"
    local tsconfig="$package_path/tsconfig.json"

    if [ ! -f "$tsconfig" ]; then
        echo -e "  ${YELLOW}未找到 tsconfig，跳过 TS 构建: ${package_name}${NC}"
        return 0
    fi

    local built
    for built in "${BUILT_TS_CONFIGS[@]}"; do
        if [ "$built" = "$tsconfig" ]; then
            echo -e "  ${YELLOW}已完成 TS 构建，跳过重复构建: ${package_name}${NC}"
            return 0
        fi
    done

    cd "$SCRIPT_DIR"
    if [ "$TS_PREPARE_DONE" -eq 0 ]; then
        node build/prepare.js
        TS_PREPARE_DONE=1
    fi

    echo -e "  正在构建: ${package_name} (tsc -b ${tsconfig#$SCRIPT_DIR/})"
    ./node_modules/.bin/tsc -b --verbose "$tsconfig"
    BUILT_TS_CONFIGS+=("$tsconfig")
}

# 构建单个包
build_package() {
    local package_name="$1"
    local package_path="$2"

    if [ ! -d "$package_path" ]; then
        echo -e "${RED}错误: 包目录不存在: $package_path${NC}"
        return 1
    fi

    if [ "$package_name" = "@hydrooj/ui-default" ]; then
        echo -e "  正在构建: ${package_name} (npm run build:ui)"
        cd "$SCRIPT_DIR"
        npm run build:ui
        if ! ls "$SCRIPT_DIR/packages/ui-default/public"/theme-*.css >/dev/null 2>&1; then
            echo -e "${RED}错误: ui-default 构建后未找到 theme-*.css${NC}"
            return 1
        fi
        if ! ls "$SCRIPT_DIR/packages/ui-default/public"/hydro-*.js >/dev/null 2>&1; then
            echo -e "${RED}错误: ui-default 构建后未找到 hydro-*.js${NC}"
            return 1
        fi
        return 0
    fi

    build_ts_package "$package_name" "$package_path"
}

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

# 检查发布仓库和登录状态
check_publish_registry() {
    echo -e "${YELLOW}3. 检查发布仓库和登录状态...${NC}"

    if ! npm ping --registry "$NPM_REGISTRY"; then
        echo -e "${RED}错误: 无法连接到 npm 仓库: $NPM_REGISTRY${NC}"
        exit 1
    fi

    if ! npm whoami --registry "$NPM_REGISTRY"; then
        echo -e "${RED}错误: 当前未登录私有 npm 仓库: $NPM_REGISTRY${NC}"
        echo -e "${YELLOW}请先执行: npm login --registry $NPM_REGISTRY${NC}"
        exit 1
    fi

    echo -e "${GREEN}✓ npm 仓库可访问，且已登录发布账号${NC}"
    echo ""
}

# 安装依赖
install_deps() {
    echo -e "${YELLOW}2. 安装依赖...${NC}"
    cd "$SCRIPT_DIR"
    if [ ! -d "node_modules" ]; then
        yarn install --mode=skip-build
    else
        echo -e "  node_modules 已存在，跳过安装（如需重装请手动删除 node_modules 后重跑）"
    fi
    echo -e "${GREEN}✓ 依赖安装完成${NC}"
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

# 基于本地版本和远端 dev dist-tag 计算下一个 dev 版本，避免本地版本落后时把 dev tag 回退。
next_dev_version() {
    local package_name="$1"
    local current_version="$2"
    local candidate
    candidate=$(increment_version "$current_version")

    local base="${current_version}"
    local current_num=0
    if [[ "$current_version" =~ ^(.+)-dev\.([0-9]+)$ ]]; then
        base="${BASH_REMATCH[1]}"
        current_num="${BASH_REMATCH[2]}"
    fi

    local remote_version=""
    remote_version=$(npm view "${package_name}@dev" version --registry "$NPM_REGISTRY" 2>/dev/null | tr -d '[:space:]' || true)
    if [[ "$remote_version" =~ ^(.+)-dev\.([0-9]+)$ ]] && [ "${BASH_REMATCH[1]}" = "$base" ]; then
        local remote_num="${BASH_REMATCH[2]}"
        local next_num=$((current_num > remote_num ? current_num + 1 : remote_num + 1))
        candidate="${base}-dev.${next_num}"
    fi

    echo "$candidate"
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

    if [ ! -f "$source_theme" ]; then
        source_theme=$(find "$public_dir" -maxdepth 1 -type f -name "theme-${base_version}-dev.*.css" | sort -V | tail -1)
    fi
    if [ ! -f "$source_hydro" ]; then
        source_hydro=$(find "$public_dir" -maxdepth 1 -type f -name "hydro-${base_version}-dev.*.js" | sort -V | tail -1)
    fi

    local source_theme_name=""
    local source_hydro_name=""
    if [ -n "$source_theme" ]; then
        source_theme_name=$(basename "$source_theme")
    fi
    if [ -n "$source_hydro" ]; then
        source_hydro_name=$(basename "$source_hydro")
    fi

    # 先清理同基础版本的历史 dev 别名，避免包体逐次膨胀
    find "$public_dir" -maxdepth 1 -type f -name "theme-${base_version}-dev.*.css" ! -name "theme-${full_version}.css" ! -name "$source_theme_name" -delete 2>/dev/null || true
    find "$public_dir" -maxdepth 1 -type f -name "hydro-${base_version}-dev.*.js" ! -name "hydro-${full_version}.js" ! -name "$source_hydro_name" -delete 2>/dev/null || true

    UI_ALIAS_THEME_CREATED=0
    UI_ALIAS_HYDRO_CREATED=0
    UI_ALIAS_THEME_PATH="$target_theme"
    UI_ALIAS_HYDRO_PATH="$target_hydro"

    if [ -n "$source_theme" ] && [ -f "$source_theme" ] && [ ! -f "$target_theme" ]; then
        cp -f "$source_theme" "$target_theme"
        UI_ALIAS_THEME_CREATED=1
    fi
    if [ -n "$source_hydro" ] && [ -f "$source_hydro" ] && [ ! -f "$target_hydro" ]; then
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

# 使用 npm 打包，兼容 Yarn Berry/Classic 环境
pack_package() {
    local package_path="$1"
    local tgz_filename="$2"
    local packed_file=""

    packed_file=$(npm pack --silent --pack-destination "$package_path" | tail -n 1 | tr -d '[:space:]')
    if [ -z "$packed_file" ] || [ ! -f "$package_path/$packed_file" ]; then
        return 1
    fi

    if [ "$packed_file" != "$tgz_filename" ]; then
        rm -f "$package_path/$tgz_filename"
        mv -f "$package_path/$packed_file" "$package_path/$tgz_filename"
    fi

    return 0
}

# 获取工作区依赖的本地版本号
get_workspace_version() {
    case "$1" in
        @hydrooj/common)
            get_current_version "$SCRIPT_DIR/packages/common"
            ;;
        @hydrooj/framework)
            get_current_version "$SCRIPT_DIR/framework/framework"
            ;;
        @hydrooj/utils)
            get_current_version "$SCRIPT_DIR/framework/utils"
            ;;
        @hydrooj/register)
            get_current_version "$SCRIPT_DIR/framework/register"
            ;;
        *)
            echo ""
            ;;
    esac
}

# 更新 package.json 中的 workspace 依赖
fix_workspace_deps() {
    local package_path="$1"
    local package_json="$package_path/package.json"

    if [ -f "$package_json" ]; then
        local dep
        for dep in "@hydrooj/common" "@hydrooj/framework" "@hydrooj/utils" "@hydrooj/register"; do
            local version
            version=$(get_workspace_version "$dep")
            if [ -n "$version" ]; then
                sed -E -i.bak "s#\"${dep//\//\\/}\": \"workspace:[^\"]*\"#\"${dep//\//\\/}\": \"$version\"#g" "$package_json"
                rm -f "$package_json.bak"
            fi
        done
    fi
}

# 打包并发布单个包
publish_package() {
    local package_name="$1"
    local package_path="$2"
    local tgz_filename="$3"
    local package_json="$package_path/package.json"
    local package_json_backup

    echo -e "${YELLOW}处理包: ${package_name}${NC}"

    if [ ! -d "$package_path" ]; then
        echo -e "${RED}错误: 包目录不存在: $package_path${NC}"
        return 1
    fi

    cd "$package_path"
    package_json_backup=$(mktemp "/tmp/$(basename "$package_path")-package.json.XXXXXX")
    cp "$package_json" "$package_json_backup"

    # 修复 workspace 依赖
    fix_workspace_deps "$package_path"

    # 获取当前版本并递增
    local current_version=$(get_current_version "$package_path")
    local new_version=$(next_dev_version "$package_name" "$current_version")

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
    if ! pack_package "$package_path" "$tgz_filename"; then
        echo -e "${RED}错误: 打包失败${NC}"
        mv -f "$package_json_backup" "$package_json"
        if [ "$package_name" = "@hydrooj/ui-default" ]; then
            cleanup_ui_asset_aliases
        fi
        cd "$SCRIPT_DIR"
        return 1
    fi

    if [ ! -f "$tgz_filename" ]; then
        echo -e "${RED}错误: 打包失败${NC}"
        mv -f "$package_json_backup" "$package_json"
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
            timeout "$PUBLISH_TIMEOUT_SECONDS" npm publish --registry "$NPM_REGISTRY" --tag dev 2>&1 | tee "$log_file"
            local status=${PIPESTATUS[0]}
        else
            npm publish --registry "$NPM_REGISTRY" --tag dev 2>&1 | tee "$log_file"
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
        PUBLISHED_VERSIONS["$package_name"]="$new_version"
    else
        echo -e "${YELLOW}⚠ ${package_name} 发布失败，详情日志: ${log_file}${NC}"
        if [ "$package_name" = "@hydrooj/ui-default" ]; then
            cleanup_ui_asset_aliases
        fi
        mv -f "$package_json_backup" "$package_json"
        cd "$SCRIPT_DIR"
        rm -rf /tmp/publish-temp
        return 1
    fi

    if [ "$package_name" = "@hydrooj/ui-default" ]; then
        cleanup_ui_asset_aliases
    fi

    mv -f "$package_json_backup" "$package_json"
    cd "$SCRIPT_DIR"
    rm -rf /tmp/publish-temp

    echo ""
}

# 主流程
main() {
    parse_args "$@"
    check_tools
    install_deps
    check_publish_registry

    echo -e "${YELLOW}4. 开始构建...${NC}"
    echo ""

    if is_selected "common"; then
        echo -e "${YELLOW}构建依赖包...${NC}"
        build_package "@hydrooj/common" "$SCRIPT_DIR/packages/common"
        echo ""
    fi

    if is_selected "hydrooj"; then
        build_package "hydrooj" "$SCRIPT_DIR/packages/hydrooj"
    fi
    if is_selected "ui-default"; then
        build_package "@hydrooj/ui-default" "$SCRIPT_DIR/packages/ui-default"
    fi
    if is_selected "hydrojudge"; then
        build_package "@hydrooj/hydrojudge" "$SCRIPT_DIR/packages/hydrojudge"
    fi
    if is_selected "fps-importer"; then
        build_package "@hydrooj/fps-importer" "$SCRIPT_DIR/packages/fps-importer"
    fi
    if is_selected "a11y"; then
        build_package "@hydrooj/a11y" "$SCRIPT_DIR/packages/a11y"
    fi
    if is_selected "import-hoj"; then
        build_package "@hydrooj/import-hoj" "$SCRIPT_DIR/packages/import-hoj"
    fi

    echo ""
    echo -e "${YELLOW}5. 开始打包和发布...${NC}"
    echo ""

    # 发布 common
    if is_selected "common"; then
        publish_package "@hydrooj/common" "$SCRIPT_DIR/packages/common" "common-dev.tgz"
    fi

    # 发布 hydrooj
    if is_selected "hydrooj"; then
        publish_package "hydrooj" "$SCRIPT_DIR/packages/hydrooj" "hydrooj-dev.tgz"
    fi

    # 发布 ui-default
    if is_selected "ui-default"; then
        publish_package "@hydrooj/ui-default" "$SCRIPT_DIR/packages/ui-default" "ui-default-dev.tgz"
    fi

    # 发布 hydrojudge
    if is_selected "hydrojudge"; then
        publish_package "@hydrooj/hydrojudge" "$SCRIPT_DIR/packages/hydrojudge" "hydrojudge-dev.tgz"
    fi
    if is_selected "fps-importer"; then
        publish_package "@hydrooj/fps-importer" "$SCRIPT_DIR/packages/fps-importer" "fps-importer-dev.tgz"
    fi
    if is_selected "a11y"; then
        publish_package "@hydrooj/a11y" "$SCRIPT_DIR/packages/a11y" "a11y-dev.tgz"
    fi
    if is_selected "import-hoj"; then
        publish_package "@hydrooj/import-hoj" "$SCRIPT_DIR/packages/import-hoj" "import-hoj-dev.tgz"
    fi

    echo -e "${GREEN}=== 所有包发布完成 ===${NC}"
    echo ""
    echo -e "已发布的版本:"
    if is_selected "common"; then
        echo -e "  - @hydrooj/common@${PUBLISHED_VERSIONS["@hydrooj/common"]}"
    fi
    if is_selected "hydrooj"; then
        echo -e "  - hydrooj@${PUBLISHED_VERSIONS["hydrooj"]}"
    fi
    if is_selected "ui-default"; then
        echo -e "  - @hydrooj/ui-default@${PUBLISHED_VERSIONS["@hydrooj/ui-default"]}"
    fi
    if is_selected "hydrojudge"; then
        echo -e "  - @hydrooj/hydrojudge@${PUBLISHED_VERSIONS["@hydrooj/hydrojudge"]}"
    fi
    if is_selected "fps-importer"; then
        echo -e "  - @hydrooj/fps-importer@${PUBLISHED_VERSIONS["@hydrooj/fps-importer"]}"
    fi
    if is_selected "a11y"; then
        echo -e "  - @hydrooj/a11y@${PUBLISHED_VERSIONS["@hydrooj/a11y"]}"
    fi
    if is_selected "import-hoj"; then
        echo -e "  - @hydrooj/import-hoj@${PUBLISHED_VERSIONS["@hydrooj/import-hoj"]}"
    fi
    echo ""
    echo -e "安装命令:"
    echo -e "  ${YELLOW}./install-dev-from-private-npm.sh${NC}"
    echo ""
}

# 运行主流程
main "$@"
