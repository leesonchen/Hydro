#!/bin/bash
# Hydro 开发版本从私有 npm 仓库安装/更新的一键脚本

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

NPM_REGISTRY="${NPM_REGISTRY:-https://npm.leeson.top/}"
HYDRO_HOME="${HYDRO_HOME:-$HOME/.hydro}"
SERVICE_VERIFY_DELAY_SECONDS="${SERVICE_VERIFY_DELAY_SECONDS:-15}"
LOGIN_VERIFY_TIMEOUT_SECONDS="${LOGIN_VERIFY_TIMEOUT_SECONDS:-180}"
LOGIN_VERIFY_INTERVAL_SECONDS="${LOGIN_VERIFY_INTERVAL_SECONDS:-10}"
LOCK_FILE="${LOCK_FILE:-/tmp/hydro-dev-install.lock}"
RELEASES_DIR="$HYDRO_HOME/dev-releases"
BACKUPS_DIR="$HYDRO_HOME/dev-backups"
ACTIVE_RELEASE_FILE="$RELEASES_DIR/active"
HYDRO_BIN_LINK="/usr/local/bin/hydrooj"
PACKAGES=("hydrooj@dev" "@hydrooj/ui-default@dev" "@hydrooj/hydrojudge@dev")

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd /tmp

for path_entry in "$HOME/.nix-profile/bin" /nix/var/nix/profiles/default/bin /usr/local/bin; do
    if [ -d "$path_entry" ] && [[ ":$PATH:" != *":$path_entry:"* ]]; then
        PATH="$path_entry:$PATH"
    fi
done
export PATH

log_title() {
    echo -e "${YELLOW}$1${NC}"
}

log_ok() {
    echo -e "${GREEN}✓ $1${NC}"
}

log_warn() {
    echo -e "${YELLOW}⚠ $1${NC}"
}

log_error() {
    echo -e "${RED}✗ $1${NC}"
}

usage() {
    cat <<USAGE
用法:
  ./install-dev-from-private-npm.sh [install]
  ./install-dev-from-private-npm.sh rollback [backup-id]
  ./install-dev-from-private-npm.sh list-backups

环境变量:
  NPM_REGISTRY   npm 仓库地址，默认 ${NPM_REGISTRY}
  HYDRO_HOME     Hydro 数据目录，默认 ${HYDRO_HOME}
  LOGIN_VERIFY_TIMEOUT_SECONDS   登录页最多等待秒数，默认 ${LOGIN_VERIFY_TIMEOUT_SECONDS}
  LOGIN_VERIFY_INTERVAL_SECONDS  登录页重试间隔秒数，默认 ${LOGIN_VERIFY_INTERVAL_SECONDS}
USAGE
}

check_tools() {
    log_title "1. 检查必要工具..."
    local missing_tools=()

    command -v npm >/dev/null 2>&1 || missing_tools+=("npm")
    command -v node >/dev/null 2>&1 || missing_tools+=("node")
    command -v curl >/dev/null 2>&1 || missing_tools+=("curl")

    if ! command -v pm2 >/dev/null 2>&1; then
        log_warn "PM2 未安装，服务管理功能将不可用"
    fi

    if [ ${#missing_tools[@]} -gt 0 ]; then
        echo -e "${RED}错误: 缺少必要工具: ${missing_tools[*]}${NC}"
        exit 1
    fi

    log_ok "所有必要工具已安装"
    echo ""
}

check_node_version() {
    log_title "2. 检查 Node.js 版本..."
    local node_version node_major
    node_version=$(node --version 2>/dev/null || echo "v0.0.0")
    if [[ "$node_version" =~ v([0-9]+) ]]; then
        node_major="${BASH_REMATCH[1]}"
        if (( node_major < 22 )); then
            echo -e "${RED}错误: 需要 Node.js v22 或更高版本，当前版本: ${node_version}${NC}"
            exit 1
        fi
        log_ok "Node.js 版本 ${node_version} 通过验证"
    else
        echo -e "${RED}错误: Node.js 未安装${NC}"
        exit 1
    fi
    echo ""
}

setup_registry() {
    log_title "3. 配置 npm 仓库地址..."
    npm config set registry "$NPM_REGISTRY" >/dev/null
    if command -v yarn >/dev/null 2>&1; then
        yarn config set registry "$NPM_REGISTRY" >/dev/null 2>&1 || true
        rm -f ~/.yarnrc 2>/dev/null || true
    fi
    log_ok "npm 仓库配置完成: ${NPM_REGISTRY}"
    echo ""
}

now_id() {
    date +%Y%m%d%H%M%S
}

read_active_release() {
    if [ -f "$ACTIVE_RELEASE_FILE" ]; then
        cat "$ACTIVE_RELEASE_FILE"
    fi
}

package_version_from_dir() {
    local release_dir="$1"
    local package_name="$2"
    node -e "console.log(require(process.argv[1] + '/node_modules/' + process.argv[2] + '/package.json').version)" "$release_dir" "$package_name"
}

link_target() {
    if [ -L "$HYDRO_BIN_LINK" ]; then
        readlink "$HYDRO_BIN_LINK"
    elif [ -e "$HYDRO_BIN_LINK" ]; then
        echo "$HYDRO_BIN_LINK"
    fi
}

resolved_link_target() {
    if [ -e "$HYDRO_BIN_LINK" ] || [ -L "$HYDRO_BIN_LINK" ]; then
        readlink -f "$HYDRO_BIN_LINK" 2>/dev/null || true
    fi
}

get_hydro_version_from_link() {
    local resolved package_dir
    resolved=$(resolved_link_target)
    if [ -z "$resolved" ]; then
        return 0
    fi
    package_dir=$(cd "$(dirname "$resolved")/.." 2>/dev/null && pwd || true)
    if [ -n "$package_dir" ] && [ -f "$package_dir/package.json" ]; then
        node -e "console.log(require(process.argv[1]).version)" "$package_dir/package.json" 2>/dev/null || true
    fi
}

backup_current_state() {
    mkdir -p "$BACKUPS_DIR" "$RELEASES_DIR"
    local backup_id backup_dir prev_link prev_resolved prev_active prev_version
    backup_id=$(now_id)
    backup_dir="$BACKUPS_DIR/$backup_id"
    mkdir -p "$backup_dir"

    prev_link=$(link_target || true)
    prev_resolved=$(resolved_link_target || true)
    prev_active=$(read_active_release || true)
    prev_version=$(get_hydro_version_from_link || true)

    {
        printf 'BACKUP_ID=%q\n' "$backup_id"
        printf 'CREATED_AT=%q\n' "$(date -Iseconds)"
        printf 'PREVIOUS_HYDROOJ_LINK=%q\n' "$prev_link"
        printf 'PREVIOUS_HYDROOJ_RESOLVED=%q\n' "$prev_resolved"
        printf 'PREVIOUS_ACTIVE_RELEASE=%q\n' "$prev_active"
        printf 'PREVIOUS_HYDROOJ_VERSION=%q\n' "$prev_version"
    } > "$backup_dir/manifest.env"

    if command -v pm2 >/dev/null 2>&1; then
        pm2 jlist > "$backup_dir/pm2-jlist.json" 2>/dev/null || true
        pm2 save >/dev/null 2>&1 || true
    fi

    if [ -d "$HYDRO_HOME/static" ]; then
        tar -C "$HYDRO_HOME" -czf "$backup_dir/static.tgz" static 2>/dev/null || true
    fi

    echo "$backup_dir"
}

install_release() {
    mkdir -p "$RELEASES_DIR"
    local release_id release_dir log_file
    release_id=$(now_id)
    release_dir="$RELEASES_DIR/$release_id"
    log_file="/tmp/hydro-dev-install-${release_id}.log"

    log_title "4. 下载并安装 dev 包到独立 release 目录..."
    mkdir -p "$release_dir"
    cat > "$release_dir/package.json" <<JSON
{"private":true,"name":"hydro-dev-release-${release_id}","version":"0.0.0"}
JSON

    if npm install --prefix "$release_dir" --omit=dev --registry "$NPM_REGISTRY" "${PACKAGES[@]}" 2>&1 | tee "$log_file"; then
        log_ok "release 安装完成: ${release_dir}"
    else
        log_error "release 安装失败，详情日志: ${log_file}"
        return 1
    fi
    INSTALL_RELEASE_DIR="$release_dir"
    echo ""
}

verify_release() {
    local release_dir="$1"
    log_title "5. 验证 release 内容..."

    local hydro_bin="$release_dir/node_modules/.bin/hydrooj"
    if [ ! -x "$hydro_bin" ]; then
        log_error "未找到可执行文件: ${hydro_bin}"
        return 1
    fi

    local hydro_version ui_version judge_version
    hydro_version=$(package_version_from_dir "$release_dir" "hydrooj")
    ui_version=$(package_version_from_dir "$release_dir" "@hydrooj/ui-default")
    judge_version=$(package_version_from_dir "$release_dir" "@hydrooj/hydrojudge")

    log_ok "hydrooj@${hydro_version}"
    log_ok "@hydrooj/ui-default@${ui_version}"
    log_ok "@hydrooj/hydrojudge@${judge_version}"
    echo ""
}

sync_ui_static_aliases() {
    local release_dir="${1:-}"
    log_title "6. 同步 UI 静态资源版本..."

    local package_public_dir ui_version base_version
    if [ -n "$release_dir" ]; then
        package_public_dir="$release_dir/node_modules/@hydrooj/ui-default/public"
        ui_version=$(package_version_from_dir "$release_dir" "@hydrooj/ui-default" 2>/dev/null || true)
    else
        package_public_dir="$(npm root -g 2>/dev/null)/@hydrooj/ui-default/public"
        ui_version=$(npm view @hydrooj/ui-default@dev version --registry "$NPM_REGISTRY" 2>/dev/null | tr -d '[:space:]' || true)
    fi

    if [ -z "$ui_version" ] || [ ! -d "$package_public_dir" ]; then
        log_warn "无法定位 ui-default public 目录，跳过同步"
        echo ""
        return 0
    fi

    base_version=$(echo "$ui_version" | sed -E 's/-dev\.[0-9]+$//')
    if [ "$ui_version" = "$base_version" ]; then
        log_ok "当前不是 dev 版本，无需同步"
        echo ""
        return 0
    fi

    local static_dir="$HYDRO_HOME/static"
    local source_theme="$package_public_dir/theme-${ui_version}.css"
    local source_hydro="$package_public_dir/hydro-${ui_version}.js"
    local target_theme="$static_dir/theme-${ui_version}.css"
    local target_hydro="$static_dir/hydro-${ui_version}.js"

    if [ ! -f "$source_theme" ]; then
        source_theme="$static_dir/theme-${base_version}.css"
    fi
    if [ ! -f "$source_theme" ]; then
        source_theme=$(find "$static_dir" "$package_public_dir" -maxdepth 1 -type f -name "theme-${base_version}-dev.*.css" 2>/dev/null | sort -V | tail -1 || true)
    fi
    if [ ! -f "$source_hydro" ]; then
        source_hydro="$static_dir/hydro-${base_version}.js"
    fi
    if [ ! -f "$source_hydro" ]; then
        source_hydro=$(find "$static_dir" "$package_public_dir" -maxdepth 1 -type f -name "hydro-${base_version}-dev.*.js" 2>/dev/null | sort -V | tail -1 || true)
    fi

    mkdir -p "$static_dir"
    if [ -n "$source_theme" ] && [ -f "$source_theme" ]; then
        cp -f "$source_theme" "$target_theme"
    fi
    if [ -n "$source_hydro" ] && [ -f "$source_hydro" ]; then
        cp -f "$source_hydro" "$target_hydro"
    fi

    if [ -f "$target_theme" ] && [ -f "$target_hydro" ]; then
        log_ok "UI 静态资源已同步到 dev 版本名 (${ui_version})"
    else
        log_warn "部分静态资源未生成，建议检查 ${package_public_dir}"
    fi
    echo ""
}

switch_hydrooj_link() {
    local release_dir="$1"
    log_title "7. 切换 hydrooj 可执行文件..."
    local hydro_bin="$release_dir/node_modules/.bin/hydrooj"

    mkdir -p "$(dirname "$HYDRO_BIN_LINK")"
    ln -sfn "$hydro_bin" "$HYDRO_BIN_LINK"
    echo "$release_dir" > "$ACTIVE_RELEASE_FILE"

    if [ ! -x "$HYDRO_BIN_LINK" ]; then
        log_error "${HYDRO_BIN_LINK} 不可执行"
        return 1
    fi

    log_ok "${HYDRO_BIN_LINK} -> ${hydro_bin}"
    echo ""
}

pm2_app_exists() {
    local app_name="$1"
    command -v pm2 >/dev/null 2>&1 || return 1
    pm2 jlist 2>/dev/null | node -e '
const name = process.argv[1];
const chunks = [];
process.stdin.on("data", (chunk) => chunks.push(chunk));
process.stdin.on("end", () => {
  const list = JSON.parse(Buffer.concat(chunks).toString() || "[]");
  process.exit(list.some((item) => item.name === name) ? 0 : 1);
});
' "$app_name"
}

restart_services() {
    if ! command -v pm2 >/dev/null 2>&1; then
        return 0
    fi

    log_title "8. 重启服务..."
    if pm2_app_exists hydrooj; then
        pm2 restart hydrooj --update-env
    else
        pm2 start "$HYDRO_BIN_LINK" --name hydrooj
    fi

    if pm2_app_exists hydrojudge; then
        pm2 restart hydrojudge --update-env || true
    fi

    pm2 save >/dev/null 2>&1 || true
    log_ok "服务重启完成"
    echo ""
}

verify_services() {
    if ! command -v pm2 >/dev/null 2>&1; then
        return 0
    fi

    log_title "9. 验证服务运行状态..."
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
        log_ok "hydrooj 服务保持在线"
    else
        log_error "hydrooj 服务未保持在线，请查看最近日志:"
        pm2 logs hydrooj --lines 80 --nostream 2>/dev/null || true
        return 1
    fi
    echo ""
}

verify_login_page() {
    log_title "10. 验证登录页响应..."

    local body version deadline
    deadline=$((SECONDS + LOGIN_VERIFY_TIMEOUT_SECONDS))
    while :; do
        body=$(curl -fsSL --max-time 10 http://127.0.0.1/login?redirect=%2F 2>/dev/null || true)
        if [ "$body" != "{}" ] && grep -qiE "<html|<form|login|signin|登录" <<<"$body"; then
            break
        fi
        if (( SECONDS >= deadline )); then
            log_error "登录页响应异常，请查看最近日志:"
            printf '%s\n' "${body:0:500}"
            pm2 logs hydrooj --lines 80 --nostream 2>/dev/null || true
            return 1
        fi
        sleep "$LOGIN_VERIFY_INTERVAL_SECONDS"
    done

    version=$(grep -oE 'Hydro v[^< ]+' <<<"$body" | head -1 || true)
    if [ -n "$version" ]; then
        log_ok "登录页响应正常: ${version}"
    else
        log_ok "登录页响应正常"
    fi
    echo ""
}

list_backups() {
    mkdir -p "$BACKUPS_DIR"
    local found=0 dir
    for dir in $(ls -1dt "$BACKUPS_DIR"/* 2>/dev/null || true); do
        [ -d "$dir" ] || continue
        found=1
        if [ -f "$dir/manifest.env" ]; then
            # shellcheck disable=SC1090
            source "$dir/manifest.env"
            printf '%s  previous=%s  active=%s\n' "${BACKUP_ID:-$(basename "$dir")}" "${PREVIOUS_HYDROOJ_VERSION:-unknown}" "${PREVIOUS_ACTIVE_RELEASE:-global}"
        else
            basename "$dir"
        fi
    done
    if [ "$found" -eq 0 ]; then
        log_warn "暂无备份"
    fi
}

latest_backup_dir() {
    ls -1dt "$BACKUPS_DIR"/* 2>/dev/null | head -1 || true
}

resolve_backup_dir() {
    local backup_id="${1:-}"
    if [ -z "$backup_id" ]; then
        latest_backup_dir
    elif [ -d "$backup_id" ]; then
        echo "$backup_id"
    else
        echo "$BACKUPS_DIR/$backup_id"
    fi
}

restore_static_backup() {
    local backup_dir="$1"
    if [ -f "$backup_dir/static.tgz" ]; then
        tar -C "$HYDRO_HOME" -xzf "$backup_dir/static.tgz" 2>/dev/null || true
        log_ok "已恢复静态资源备份"
    else
        log_warn "备份中没有静态资源快照，跳过恢复"
    fi
}

rollback_release() {
    local backup_dir backup_id target=""
    backup_dir=$(resolve_backup_dir "${1:-}")
    if [ -z "$backup_dir" ] || [ ! -d "$backup_dir" ] || [ ! -f "$backup_dir/manifest.env" ]; then
        echo -e "${RED}错误: 找不到可用备份${NC}"
        return 1
    fi

    # shellcheck disable=SC1090
    source "$backup_dir/manifest.env"
    backup_id="${BACKUP_ID:-$(basename "$backup_dir")}" 

    log_title "4. 回退到备份 ${backup_id}..."
    if [ -n "${PREVIOUS_HYDROOJ_LINK:-}" ] && [ -e "${PREVIOUS_HYDROOJ_LINK}" ]; then
        target="$PREVIOUS_HYDROOJ_LINK"
    elif [ -n "${PREVIOUS_HYDROOJ_RESOLVED:-}" ] && [ -e "${PREVIOUS_HYDROOJ_RESOLVED}" ]; then
        target="$PREVIOUS_HYDROOJ_RESOLVED"
    fi

    if [ -z "$target" ]; then
        echo -e "${RED}错误: 备份记录的旧 hydrooj 可执行文件已不存在${NC}"
        echo "  PREVIOUS_HYDROOJ_LINK=${PREVIOUS_HYDROOJ_LINK:-}"
        echo "  PREVIOUS_HYDROOJ_RESOLVED=${PREVIOUS_HYDROOJ_RESOLVED:-}"
        return 1
    fi

    ln -sfn "$target" "$HYDRO_BIN_LINK"
    if [ -n "${PREVIOUS_ACTIVE_RELEASE:-}" ] && [ -d "${PREVIOUS_ACTIVE_RELEASE}" ]; then
        mkdir -p "$RELEASES_DIR"
        echo "$PREVIOUS_ACTIVE_RELEASE" > "$ACTIVE_RELEASE_FILE"
    else
        rm -f "$ACTIVE_RELEASE_FILE"
    fi

    restore_static_backup "$backup_dir"
    log_ok "${HYDRO_BIN_LINK} -> ${target}"
    if [ -n "${PREVIOUS_HYDROOJ_VERSION:-}" ]; then
        log_ok "目标版本: hydrooj@${PREVIOUS_HYDROOJ_VERSION}"
    fi
    echo ""

    restart_services
    verify_services
    verify_login_page
    echo -e "${GREEN}=== 回退完成 ===${NC}"
}

install_flow() {
    check_tools
    check_node_version
    setup_registry

    local backup_dir release_dir
    backup_dir=$(backup_current_state)
    log_ok "已创建回退备份: ${backup_dir}"
    echo ""

    install_release
    release_dir="$INSTALL_RELEASE_DIR"

    verify_release "$release_dir"
    sync_ui_static_aliases "$release_dir"
    switch_hydrooj_link "$release_dir"
    restart_services
    verify_services
    verify_login_page

    echo -e "${GREEN}=== 安装/更新完成 ===${NC}"
    echo "当前 release: ${release_dir}"
    echo "回退命令: $SCRIPT_DIR/$(basename "$0") rollback $(basename "$backup_dir")"
}

rollback_flow() {
    check_tools
    check_node_version
    rollback_release "${1:-}"
}

main() {
    local mode="${1:-install}"
    if [ "$mode" != "install" ] && [ "$#" -gt 0 ]; then
        shift
    elif [ "$mode" = "install" ] && [ "$#" -gt 0 ]; then
        shift
    fi

    case "$mode" in
        install|update)
            (
                flock -n 9 || { echo -e "${RED}错误: 已有安装/回退流程正在运行${NC}"; exit 1; }
                echo -e "${GREEN}=== Hydro 开发版本安装/更新脚本 ===${NC}"
                echo ""
                install_flow
            ) 9>"$LOCK_FILE"
            ;;
        rollback)
            (
                flock -n 9 || { echo -e "${RED}错误: 已有安装/回退流程正在运行${NC}"; exit 1; }
                echo -e "${GREEN}=== Hydro 开发版本回退脚本 ===${NC}"
                echo ""
                rollback_flow "${1:-}"
            ) 9>"$LOCK_FILE"
            ;;
        list-backups)
            list_backups
            ;;
        -h|--help|help)
            usage
            ;;
        *)
            echo -e "${RED}错误: 未知命令 ${mode}${NC}"
            usage
            exit 1
            ;;
    esac
}

main "$@"
