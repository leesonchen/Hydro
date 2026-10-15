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
NPM_VIEW_TIMEOUT_SECONDS="${NPM_VIEW_TIMEOUT_SECONDS:-180}"
RELEASES_DIR="$HYDRO_HOME/dev-releases"
BACKUPS_DIR="$HYDRO_HOME/dev-backups"
ACTIVE_RELEASE_FILE="$RELEASES_DIR/active"
HYDRO_BIN_LINK="/usr/local/bin/hydrooj"
HYDRO_MAINTENANCE_BIN_LINK="/usr/local/bin/hydro-maintenance"
OPERATION_LOCK_DIR="${HYDRO_OPERATION_LOCK_DIR:-${HYDRO_MAINTENANCE_LOCK:-$HYDRO_HOME/maintenance.lock}}"
MAINTENANCE_DIR="${HYDRO_MAINTENANCE_DIR:-$HYDRO_HOME/maintenance}"
MAINTENANCE_STATE_FILE="$MAINTENANCE_DIR/maintenance.json"
MAINTENANCE_ACTIVE_FILE="$MAINTENANCE_DIR/active"
MAINTENANCE_ACTIVE=0
RELEASE_INCREMENTAL_INSTALL=0
SKIP_RESTART="${SKIP_RESTART:-0}"
PACKAGE_KEYS=("common" "framework" "hydrooj" "ui-default" "hydrojudge" "fps-importer" "a11y" "import-hoj")
SELECTED_PACKAGE_KEYS=()
declare -A CURRENT_PACKAGE_VERSIONS=()
declare -A REMOTE_PACKAGE_VERSIONS=()
declare -A SELECTED_PACKAGE_VERSIONS=()

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd /tmp

for path_entry in "$HOME/.nix-profile/bin" /nix/var/nix/profiles/default/bin /usr/local/bin; do
    if [ -d "$path_entry" ] && [[ ":$PATH:" != *":$path_entry:"* ]]; then
        PATH="$PATH:$path_entry"
    fi
done
export PATH

acquire_operation_lock() {
    mkdir -p "$(dirname "$OPERATION_LOCK_DIR")"
    if ! mkdir "$OPERATION_LOCK_DIR" 2>/dev/null; then
        echo -e "${RED}错误: 已有维护或升级操作锁；确认没有操作运行后再手工清理: ${OPERATION_LOCK_DIR}${NC}"
        return 1
    fi
    if ! (umask 077; printf '%s\n' "$$" > "$OPERATION_LOCK_DIR/owner"); then
        rm -f "$OPERATION_LOCK_DIR/owner"
        rmdir "$OPERATION_LOCK_DIR" 2>/dev/null || true
        echo -e "${RED}错误: 无法初始化操作锁: ${OPERATION_LOCK_DIR}${NC}"
        return 1
    fi
    trap release_operation_lock EXIT
}

release_operation_lock() {
    if [ -d "$OPERATION_LOCK_DIR" ]; then
        rm -f "$OPERATION_LOCK_DIR/owner"
        rmdir "$OPERATION_LOCK_DIR" 2>/dev/null || true
    fi
}

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
  ./install-dev-from-private-npm.sh [install] [--no-restart] [--packages all|common,framework,hydrooj,ui-default,hydrojudge,fps-importer,a11y,import-hoj]
  ./install-dev-from-private-npm.sh update [--no-restart] [--packages all|common,framework,hydrooj,ui-default,hydrojudge,fps-importer,a11y,import-hoj]
  ./install-dev-from-private-npm.sh update hydrojudge [--no-restart]
  ./install-dev-from-private-npm.sh check-updates
  ./install-dev-from-private-npm.sh upgrade-interactive [--no-restart]
  ./install-dev-from-private-npm.sh rollback [backup-id] [--no-restart]
  ./install-dev-from-private-npm.sh list-backups

说明:
  install            默认安装/更新所有 dev 包。
  update             默认只更新远端 dev 版本变化的包，未变化的包固定为当前 release 版本。
  --packages         指定更新模块，未指定的模块固定为当前 release 版本。
  --no-restart       更新/回退完成后不自动重启服务，亦不进行在线检查（别名: --skip-restart）。
  upgrade-interactive 先选择可更新模块，再为每个模块选择要安装的 dev 版本。

环境变量:
  NPM_REGISTRY   npm 仓库地址，默认 ${NPM_REGISTRY}
  HYDRO_HOME     Hydro 数据目录，默认 ${HYDRO_HOME}
  HYDRO_MAINTENANCE_DIR 维护状态目录，默认 ${MAINTENANCE_DIR}
  SKIP_RESTART   是否跳过服务重启 (1 或 true 为跳过)，默认 0
  LOGIN_VERIFY_TIMEOUT_SECONDS   登录页最多等待秒数，默认 ${LOGIN_VERIFY_TIMEOUT_SECONDS}
  LOGIN_VERIFY_INTERVAL_SECONDS  登录页重试间隔秒数，默认 ${LOGIN_VERIFY_INTERVAL_SECONDS}
  NPM_VIEW_TIMEOUT_SECONDS       npm view 查询超时秒数，默认 ${NPM_VIEW_TIMEOUT_SECONDS}
  HYDRO_OPERATION_LOCK_DIR       与 hydro-maintenance 共用的操作锁目录，默认 ${OPERATION_LOCK_DIR}
USAGE
}

is_skip_restart() {
    [ "$SKIP_RESTART" = "1" ] || [ "$SKIP_RESTART" = "true" ]
}

maintenance_state() {
    if [ ! -f "$MAINTENANCE_STATE_FILE" ]; then
        echo "inactive"
        return 0
    fi
    node -e '
const fs = require("fs");
try {
  const state = JSON.parse(fs.readFileSync(process.argv[1], "utf8")).state;
  if (!["inactive", "scheduled", "active"].includes(state)) process.exit(2);
  process.stdout.write(state);
} catch {
  process.exit(1);
}
' "$MAINTENANCE_STATE_FILE"
}

check_maintenance_state() {
    local state
    state=$(maintenance_state) || {
        echo -e "${RED}错误: 无法安全读取维护状态，请先检查 ${MAINTENANCE_STATE_FILE}${NC}"
        return 1
    }

    if [ "$state" = "scheduled" ]; then
        echo -e "${RED}错误: 系统已安排维护，暂不执行安装/升级；请先执行 hydro-maintenance off 取消预告${NC}"
        return 1
    fi

    if [ "$state" = "active" ] || [ -f "$MAINTENANCE_ACTIVE_FILE" ]; then
        MAINTENANCE_ACTIVE=1
        if [ "$state" != "active" ]; then
            log_warn "发现维护 active 标记但状态文件不是 active，升级将继续保持服务停止"
        fi
        log_warn "当前处于维护模式：安装后不会重启 Hydro、判定服务在线或检查登录页"
    else
        MAINTENANCE_ACTIVE=0
    fi
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

package_name_for_key() {
    case "$1" in
        common)
            echo "@hydrooj/common"
            ;;
        framework)
            echo "@hydrooj/framework"
            ;;
        hydrooj)
            echo "hydrooj"
            ;;
        ui-default)
            echo "@hydrooj/ui-default"
            ;;
        hydrojudge)
            echo "@hydrooj/hydrojudge"
            ;;
        fps-importer)
            echo "@hydrooj/fps-importer"
            ;;
        a11y)
            echo "@hydrooj/a11y"
            ;;
        import-hoj)
            echo "@hydrooj/import-hoj"
            ;;
        *)
            return 1
            ;;
    esac
}

normalize_package_key() {
    case "$1" in
        all)
            echo "all"
            ;;
        common|framework|hydrooj|ui-default|hydrojudge|fps-importer|a11y|import-hoj)
            echo "$1"
            ;;
        @hydrooj/common)
            echo "common"
            ;;
        @hydrooj/framework)
            echo "framework"
            ;;
        @hydrooj/ui-default)
            echo "ui-default"
            ;;
        @hydrooj/hydrojudge)
            echo "hydrojudge"
            ;;
        @hydrooj/fps-importer)
            echo "fps-importer"
            ;;
        @hydrooj/a11y)
            echo "a11y"
            ;;
        @hydrooj/import-hoj)
            echo "import-hoj"
            ;;
        *)
            return 1
            ;;
    esac
}

is_key_selected() {
    local target="$1" key
    for key in "${SELECTED_PACKAGE_KEYS[@]}"; do
        if [ "$key" = "$target" ]; then
            return 0
        fi
    done
    return 1
}

select_all_packages() {
    SELECTED_PACKAGE_KEYS=("${PACKAGE_KEYS[@]}")
}

add_selected_package_key() {
    local key="$1" selected
    if [ "$key" = "all" ]; then
        select_all_packages
        return 0
    fi
    for selected in "${SELECTED_PACKAGE_KEYS[@]}"; do
        [ "$selected" = "$key" ] && return 0
    done
    SELECTED_PACKAGE_KEYS+=("$key")
}

parse_package_selector() {
    local selector="$1" raw key
    local raw_keys=()
    IFS=',' read -r -a raw_keys <<< "$selector"
    for raw in "${raw_keys[@]}"; do
        key=$(normalize_package_key "$raw" || true)
        if [ -z "$key" ]; then
            echo -e "${RED}错误: 未知模块 ${raw}${NC}"
            usage
            exit 1
        fi
        add_selected_package_key "$key"
    done
}

parse_update_args() {
    while [ "$#" -gt 0 ]; do
        case "$1" in
            --no-restart|--skip-restart)
                SKIP_RESTART=1
                ;;
            --packages)
                shift
                if [ -z "${1:-}" ]; then
                    echo -e "${RED}错误: --packages 需要参数${NC}"
                    usage
                    exit 1
                fi
                parse_package_selector "$1"
                ;;
            --packages=*)
                parse_package_selector "${1#--packages=}"
                ;;
            all|common|framework|hydrooj|ui-default|hydrojudge|fps-importer|a11y|import-hoj|@hydrooj/common|@hydrooj/framework|@hydrooj/ui-default|@hydrooj/hydrojudge|@hydrooj/fps-importer|@hydrooj/a11y|@hydrooj/import-hoj)
                parse_package_selector "$1"
                ;;
            *)
                echo -e "${RED}错误: 未知参数 $1${NC}"
                usage
                exit 1
                ;;
        esac
        shift
    done
}

current_package_version() {
    local package_name="$1"
    local active_release executable resolved package_dir package_root candidate_dir global_root yarn_global_dir version
    active_release=$(read_active_release || true)
    if [ -n "$active_release" ] && [ -d "$active_release/node_modules" ]; then
        version=$(package_version_from_dir "$active_release" "$package_name" 2>/dev/null || true)
        if [ -n "$version" ]; then
            echo "$version"
            return 0
        fi
    fi

    # 兼容尚未通过本脚本创建 release 的全局安装，以及 active 记录缺失的情况。
    for executable in "$HYDRO_BIN_LINK" "$(command -v hydrooj || true)"; do
        [ -n "$executable" ] && [ -e "$executable" ] || continue
        resolved=$(readlink -f "$executable" 2>/dev/null || true)
        [ -n "$resolved" ] || continue
        package_dir=$(dirname "$(dirname "$resolved")")
        if [ "$(basename "$package_dir")" != "hydrooj" ] \
            || [ "$(basename "$(dirname "$package_dir")")" != "node_modules" ]; then
            continue
        fi
        package_root=$(dirname "$package_dir")
        for candidate_dir in "$(dirname "$package_root")" "$package_dir"; do
            if [ -f "$candidate_dir/node_modules/$package_name/package.json" ]; then
                package_version_from_dir "$candidate_dir" "$package_name"
                return 0
            fi
        done
    done

    global_root=$(npm root -g 2>/dev/null || true)
    if [ -n "$global_root" ] && [ -f "$global_root/$package_name/package.json" ]; then
        node -e 'process.stdout.write(require(process.argv[1]).version)' "$global_root/$package_name/package.json"
        return 0
    fi

    if command -v yarn >/dev/null 2>&1; then
        yarn_global_dir=$(yarn global dir 2>/dev/null || true)
        if [ -n "$yarn_global_dir" ] && [ -f "$yarn_global_dir/node_modules/$package_name/package.json" ]; then
            package_version_from_dir "$yarn_global_dir" "$package_name"
        fi
    fi
}

remote_package_version() {
    local package_name="$1"
    local registry_url="${NPM_REGISTRY%/}"
    local version=""
    local fetch_timeout_ms=$((NPM_VIEW_TIMEOUT_SECONDS * 1000))

    # 1. 优先尝试轻量的 dist-tags 接口 (Verdaccio / npm registry 原生支持，仅几十字节)
    version=$(curl -fsSL --max-time 15 "${registry_url}/-/package/${package_name}/dist-tags" 2>/dev/null | node -e '
let body = "";
process.stdin.on("data", c => body += c);
process.stdin.on("end", () => {
  try {
    const data = JSON.parse(body || "{}");
    process.stdout.write(data.dev || "");
  } catch {}
});
' 2>/dev/null || true)

    if [ -n "$version" ]; then
        echo "$version"
        return 0
    fi

    # 2. 回退到查询完整 package 元数据
    local package_path="$package_name"
    if [[ "$package_path" == @*/* ]]; then
        package_path="${package_path/\//%2f}"
    fi

    version=$(curl -fsSL --max-time 30 "${registry_url}/${package_path}" 2>/dev/null | node -e '
const chunks = [];
process.stdin.on("data", (chunk) => chunks.push(chunk));
process.stdin.on("end", () => {
  try {
    const data = JSON.parse(Buffer.concat(chunks).toString() || "{}");
    process.stdout.write((data["dist-tags"] && data["dist-tags"].dev) || "");
  } catch {
    process.exit(1);
  }
});
' 2>/dev/null || true)
    if [ -n "$version" ]; then
        echo "$version"
        return 0
    fi

    if command -v timeout >/dev/null 2>&1; then
        timeout 30 npm view "${package_name}@dev" version --registry "$NPM_REGISTRY" --fetch-retries=1 --fetch-timeout=30000 2>/dev/null | tr -d '[:space:]' || true
    else
        npm view "${package_name}@dev" version --registry "$NPM_REGISTRY" --fetch-retries=1 --fetch-timeout=30000 2>/dev/null | tr -d '[:space:]' || true
    fi
}

newer_dev_versions() {
    local package_name="$1" current="$2"
    local fetch_timeout_ms=$((NPM_VIEW_TIMEOUT_SECONDS * 1000))
    npm view "$package_name" versions --json --registry "$NPM_REGISTRY" \
        --prefer-online --fetch-retries=1 --fetch-timeout="$fetch_timeout_ms" | node -e '
const current = process.argv[1];
const parse = (version) => {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-dev\.(\d+))?$/.exec(version);
  return match && match.slice(1).map((part) => part === undefined ? Infinity : Number(part));
};
const compare = (a, b) => {
  for (let i = 0; i < 4; i++) {
    if (a[i] !== b[i]) return a[i] > b[i] ? 1 : -1;
  }
  return 0;
};
const installed = current ? parse(current) : null;
if (current && !installed) {
  process.stderr.write(`无法比较当前版本: ${current}\n`);
  process.exit(1);
}
let body = "";
process.stdin.on("data", (chunk) => body += chunk);
process.stdin.on("end", () => {
  try {
    const versions = JSON.parse(body);
    const available = Array.isArray(versions) ? versions : [versions];
    const newer = [...new Set(available)]
      .filter((version) => typeof version === "string" && /-dev\.\d+$/.test(version))
      .map((version) => ({ version, parts: parse(version) }))
      .filter(({ parts }) => parts && (!installed || compare(parts, installed) > 0))
      .sort((a, b) => compare(b.parts, a.parts));
    process.stdout.write(newer.map(({ version }) => version).join("\n"));
  } catch (error) {
    process.stderr.write(`无法解析仓库版本列表: ${error.message}\n`);
    process.exitCode = 1;
  }
});
' "$current"
}

load_package_versions() {
    local key package_name
    CURRENT_PACKAGE_VERSIONS=()
    REMOTE_PACKAGE_VERSIONS=()
    for key in "${PACKAGE_KEYS[@]}"; do
        package_name=$(package_name_for_key "$key")
        CURRENT_PACKAGE_VERSIONS["$key"]="$(current_package_version "$package_name")"
        REMOTE_PACKAGE_VERSIONS["$key"]="$(remote_package_version "$package_name")"
    done
}

load_current_package_versions() {
    local key package_name
    CURRENT_PACKAGE_VERSIONS=()
    for key in "${PACKAGE_KEYS[@]}"; do
        package_name=$(package_name_for_key "$key")
        CURRENT_PACKAGE_VERSIONS["$key"]="$(current_package_version "$package_name")"
    done
}

print_update_table() {
    local key package_name current remote status
    printf '%-12s %-26s %-22s %-22s %s\n' "模块" "包名" "当前版本" "dev 版本" "状态"
    for key in "${PACKAGE_KEYS[@]}"; do
        package_name=$(package_name_for_key "$key")
        current="${CURRENT_PACKAGE_VERSIONS[$key]:-}"
        remote="${REMOTE_PACKAGE_VERSIONS[$key]:-}"
        if [ -z "$remote" ]; then
            status="无法查询"
        elif [ -z "$current" ]; then
            status="未安装"
        elif [ "$current" != "$remote" ]; then
            status="可更新"
        else
            status="已最新"
        fi
        printf '%-12s %-26s %-22s %-22s %s\n' "$key" "$package_name" "${current:-none}" "${remote:-unknown}" "$status"
    done
}

has_unknown_remote_versions() {
    local key
    for key in "${PACKAGE_KEYS[@]}"; do
        if [ -z "${REMOTE_PACKAGE_VERSIONS[$key]:-}" ]; then
            return 0
        fi
    done
    return 1
}

select_outdated_packages() {
    local key current remote
    SELECTED_PACKAGE_KEYS=()
    load_package_versions
    for key in "${PACKAGE_KEYS[@]}"; do
        current="${CURRENT_PACKAGE_VERSIONS[$key]:-}"
        remote="${REMOTE_PACKAGE_VERSIONS[$key]:-}"
        if [ -n "$remote" ] && [ "$current" != "$remote" ]; then
            add_selected_package_key "$key"
        fi
    done
}

interactive_select_updates() {
    local outdated=() key idx input token token_index selected
    load_package_versions
    log_title "4. 检查 dev 版本更新..."
    print_update_table
    echo ""

    for key in "${PACKAGE_KEYS[@]}"; do
        if [ -n "${REMOTE_PACKAGE_VERSIONS[$key]:-}" ] && [ "${CURRENT_PACKAGE_VERSIONS[$key]:-}" != "${REMOTE_PACKAGE_VERSIONS[$key]:-}" ]; then
            outdated+=("$key")
        fi
    done

    if [ ${#outdated[@]} -eq 0 ]; then
        if has_unknown_remote_versions; then
            log_warn "未发现可更新模块，但部分模块 dev 版本查询失败，请查看状态表"
        else
            log_ok "所有模块都已是最新 dev 版本"
        fi
        return 1
    fi

    echo -e "${YELLOW}请选择要更新的模块:${NC}"
    echo "  0) all outdated"
    for idx in "${!outdated[@]}"; do
        key="${outdated[$idx]}"
        echo "  $((idx + 1))) $key (${CURRENT_PACKAGE_VERSIONS[$key]:-none} -> ${REMOTE_PACKAGE_VERSIONS[$key]})"
    done
    echo "  示例: 0 或 1 3"
    read -r -p "输入序号后回车: " input

    SELECTED_PACKAGE_KEYS=()
    if [ -z "$input" ] || [ "$input" = "0" ]; then
        SELECTED_PACKAGE_KEYS=("${outdated[@]}")
    else
        for token in $input; do
            if ! [[ "$token" =~ ^[0-9]+$ ]]; then
                log_warn "忽略无效序号: ${token}"
                continue
            fi
            token_index=$((10#$token))
            if (( token_index < 1 || token_index > ${#outdated[@]} )); then
                log_warn "忽略无效序号: ${token}"
                continue
            fi
            selected="${outdated[$((token_index - 1))]}"
            add_selected_package_key "$selected"
        done
    fi

    if [ ${#SELECTED_PACKAGE_KEYS[@]} -eq 0 ]; then
        log_warn "未选择任何模块，取消更新"
        return 1
    fi

    interactive_select_versions
}

interactive_select_versions() {
    local key package_name versions input input_index idx
    local available=()
    SELECTED_PACKAGE_VERSIONS=()
    for key in "${SELECTED_PACKAGE_KEYS[@]}"; do
        package_name=$(package_name_for_key "$key")
        if ! versions=$(newer_dev_versions "$package_name" "${CURRENT_PACKAGE_VERSIONS[$key]:-}"); then
            log_error "无法查询 ${package_name} 的可用 dev 版本，取消更新"
            return 1
        fi
        if [ -z "$versions" ]; then
            log_error "${package_name} 没有比当前版本更新的 dev 版本，取消更新"
            return 1
        fi
        mapfile -t available <<< "$versions"
        if [ ${#available[@]} -eq 1 ]; then
            SELECTED_PACKAGE_VERSIONS["$key"]="${available[0]}"
            echo "${package_name}: ${CURRENT_PACKAGE_VERSIONS[$key]:-none} -> ${available[0]}"
            continue
        fi

        echo ""
        echo -e "${YELLOW}请选择 ${package_name} 的目标版本（当前: ${CURRENT_PACKAGE_VERSIONS[$key]:-none}）:${NC}"
        for idx in "${!available[@]}"; do
            echo "  $((idx + 1))) ${available[$idx]}"
        done
        echo "  0) 取消更新"
        while :; do
            read -r -p "输入序号后回车（默认 1，最新版本）: " input
            input="${input:-1}"
            if [[ "$input" =~ ^[0-9]+$ ]] && (( 10#$input <= ${#available[@]} )); then
                break
            fi
            log_warn "无效序号: ${input}"
        done
        input_index=$((10#$input))
        if [ "$input_index" -eq 0 ]; then
            log_warn "已取消更新"
            return 1
        fi
        SELECTED_PACKAGE_VERSIONS["$key"]="${available[$((input_index - 1))]}"
    done
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
    local release_id release_dir log_file key package_name current spec active_release
    local package_specs=()
    local incremental_install=0
    RELEASE_INCREMENTAL_INSTALL=0
    release_id=$(now_id)
    release_dir="$RELEASES_DIR/$release_id"
    log_file="/tmp/hydro-dev-install-${release_id}.log"

    load_current_package_versions
    active_release=$(read_active_release || true)
    mkdir -p "$release_dir"

    if [ -n "$active_release" ] && [ -d "$active_release/node_modules" ] \
        && [ ${#SELECTED_PACKAGE_KEYS[@]} -gt 0 ] && [ ${#SELECTED_PACKAGE_KEYS[@]} -lt ${#PACKAGE_KEYS[@]} ]; then
        incremental_install=1
        RELEASE_INCREMENTAL_INSTALL=1
        log_title "4. 基于当前 release 增量安装选中模块..."
        cp -a "$active_release"/. "$release_dir"/
        echo "  复用当前 release: ${active_release}"
    else
        log_title "4. 下载并安装包到独立 release 目录..."
        cat > "$release_dir/package.json" <<JSON
{"private":true,"name":"hydro-dev-release-${release_id}","version":"0.0.0"}
JSON
    fi

    echo "  本次更新模块: ${SELECTED_PACKAGE_KEYS[*]}"
    for key in "${PACKAGE_KEYS[@]}"; do
        package_name=$(package_name_for_key "$key")
        current="${CURRENT_PACKAGE_VERSIONS[$key]:-}"
        if [ "$incremental_install" -eq 1 ] && ! is_key_selected "$key"; then
            echo "  - ${package_name}@${current} (复用当前 release)"
            continue
        fi
        if [ -n "${SELECTED_PACKAGE_VERSIONS[$key]:-}" ]; then
            spec="${package_name}@${SELECTED_PACKAGE_VERSIONS[$key]}"
        elif is_key_selected "$key" || [ -z "$current" ]; then
            if [ -n "${REMOTE_PACKAGE_VERSIONS[$key]:-}" ]; then
                spec="${package_name}@${REMOTE_PACKAGE_VERSIONS[$key]}"
            else
                spec="${package_name}@dev"
            fi
        else
            spec="${package_name}@${current}"
        fi
        package_specs+=("$spec")
        echo "  - ${spec}"
    done

    if npm install --prefix "$release_dir" --omit=dev --registry "$NPM_REGISTRY" "${package_specs[@]}" 2>&1 | tee "$log_file"; then
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
    local maintenance_bin="$release_dir/node_modules/.bin/hydro-maintenance"
    if [ ! -x "$maintenance_bin" ] && { [ "$RELEASE_INCREMENTAL_INSTALL" -eq 0 ] || is_key_selected hydrooj; }; then
        log_error "未找到维护命令: ${maintenance_bin}"
        return 1
    elif [ ! -x "$maintenance_bin" ]; then
        log_warn "局部更新未包含 hydrooj，跳过维护命令校验"
    fi

    local key package_name package_version expected_version
    for key in "${PACKAGE_KEYS[@]}"; do
        package_name=$(package_name_for_key "$key")
        package_version=$(package_version_from_dir "$release_dir" "$package_name")
        if is_key_selected "$key"; then
            expected_version="${SELECTED_PACKAGE_VERSIONS[$key]:-${REMOTE_PACKAGE_VERSIONS[$key]:-}}"
            if [ -n "$expected_version" ] && [ "$package_version" != "$expected_version" ]; then
                log_error "实际安装版本不匹配: ${package_name} 期望 ${expected_version}，获得 ${package_version}"
                return 1
            fi
        fi
        log_ok "${package_name}@${package_version}"
    done
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
        ui_version=$(remote_package_version "@hydrooj/ui-default")
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
    local maintenance_bin="$release_dir/node_modules/.bin/hydro-maintenance"

    if [ ! -x "$hydro_bin" ]; then
        log_error "${hydro_bin} 不可执行"
        return 1
    fi
    if [ ! -x "$maintenance_bin" ] && { [ "$RELEASE_INCREMENTAL_INSTALL" -eq 0 ] || is_key_selected hydrooj; }; then
        log_error "未找到维护命令: ${maintenance_bin}"
        return 1
    fi

    mkdir -p "$(dirname "$HYDRO_BIN_LINK")"
    ln -sfn "$hydro_bin" "$HYDRO_BIN_LINK"
    echo "$release_dir" > "$ACTIVE_RELEASE_FILE"

    if [ -x "$maintenance_bin" ]; then
        ln -sfn "$maintenance_bin" "$HYDRO_MAINTENANCE_BIN_LINK"
        log_ok "${HYDRO_MAINTENANCE_BIN_LINK} -> ${maintenance_bin}"
    else
        log_warn "局部更新未提供 hydro-maintenance，保留现有命令链接（如有）"
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
    if [ "$MAINTENANCE_ACTIVE" -eq 1 ]; then
        log_warn "当前处于维护模式，跳过服务重启；请完成升级后执行 hydro-maintenance off"
        return 0
    fi
    if is_skip_restart; then
        log_warn "已指定跳过服务重启"
        return 0
    fi
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
    if [ "$MAINTENANCE_ACTIVE" -eq 1 ]; then
        log_warn "当前处于维护模式，跳过服务在线验证"
        return 0
    fi
    if is_skip_restart; then
        log_warn "已跳过服务重启，跳过服务在线验证"
        return 0
    fi
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
    if [ "$MAINTENANCE_ACTIVE" -eq 1 ]; then
        log_warn "当前处于维护模式，跳过登录页验证"
        return 0
    fi
    if is_skip_restart; then
        log_warn "已跳过服务重启，跳过登录页验证"
        return 0
    fi
    log_title "10. 验证登录页响应..."

    local body version deadline
    deadline=$((SECONDS + LOGIN_VERIFY_TIMEOUT_SECONDS))
    while :; do
        body=$(curl -fsSL --max-time 10 http://127.0.0.1:8888/login?redirect=%2F 2>/dev/null || true)
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
    if is_skip_restart; then
        echo -e "${YELLOW}提示: 已跳过自动重启服务。如需生效回退版本，请手动执行: pm2 restart hydrooj${NC}"
    fi
}

prepare_selected_packages() {
    local mode="$1" key package_name remote
    if [ "$mode" = "install" ]; then
        if [ ${#SELECTED_PACKAGE_KEYS[@]} -eq 0 ]; then select_all_packages; fi
        return 0
    fi

    log_title "4. 检查 dev 版本更新..."
    if [ ${#SELECTED_PACKAGE_KEYS[@]} -gt 0 ]; then
        # Explicit --packages requests also require verified remote metadata.
        for key in "${SELECTED_PACKAGE_KEYS[@]}"; do
            package_name=$(package_name_for_key "$key")
            remote=$(remote_package_version "$package_name")
            if [ -z "$remote" ]; then
                log_error "无法确认 ${package_name} 的远端 dev 版本，更新已取消"
                return 2
            fi
            REMOTE_PACKAGE_VERSIONS["$key"]="$remote"
        done
        return 0
    fi

    select_outdated_packages
    print_update_table
    echo ""
    if has_unknown_remote_versions; then
        log_error "部分模块远端 dev 版本查询失败，不能确认已是最新，更新已取消"
        return 2
    fi
    if [ ${#SELECTED_PACKAGE_KEYS[@]} -eq 0 ]; then
        log_ok "所有模块都已是最新 dev 版本，无需更新"
        return 1
    fi
}
run_selected_install() {
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
    if command -v hydrooj >/dev/null 2>&1; then
        echo "回退命令: hydrooj upgrade --rollback $(basename "$backup_dir")"
    else
        echo "回退命令: $SCRIPT_DIR/$(basename "$0") rollback $(basename "$backup_dir")"
    fi
    if [ "$MAINTENANCE_ACTIVE" -eq 1 ]; then
        echo -e "${YELLOW}当前仍处于维护模式，请确认升级无误后执行: hydro-maintenance off${NC}"
    elif is_skip_restart; then
        echo -e "${YELLOW}提示: 已跳过自动重启服务。如需生效新版本，请手动执行: pm2 restart hydrooj${NC}"
    fi
}

install_flow() {
    local mode="${1:-install}"
    check_maintenance_state
    check_tools
    check_node_version
    setup_registry

    if prepare_selected_packages "$mode"; then
        run_selected_install
    else
        local status=$?
        # A verified no-op returns 1; a registry/metadata failure must remain fatal.
        if [ "$status" -ne 1 ]; then return "$status"; fi
    fi
}

check_updates_flow() {
    check_tools
    check_node_version
    setup_registry
    log_title "4. 检查 dev 版本更新..."
    load_package_versions
    print_update_table
}

upgrade_interactive_flow() {
    check_maintenance_state
    check_tools
    check_node_version
    setup_registry

    if interactive_select_updates; then
        run_selected_install
    fi
}

rollback_flow() {
    check_maintenance_state
    check_tools
    check_node_version
    rollback_release "${1:-}"
}

main() {
    local mode=""
    local args=()

    while [ "$#" -gt 0 ]; do
        case "$1" in
            --no-restart|--skip-restart)
                SKIP_RESTART=1
                ;;
            install|update|check-updates|upgrade-interactive|rollback|list-backups|-h|--help|help)
                if [ -z "$mode" ]; then
                    mode="$1"
                else
                    args+=("$1")
                fi
                ;;
            *)
                args+=("$1")
                ;;
        esac
        shift
    done

    mode="${mode:-install}"

    case "$mode" in
        install|update)
            parse_update_args "${args[@]}"
            (
                acquire_operation_lock
                echo -e "${GREEN}=== Hydro 开发版本安装/更新脚本 ===${NC}"
                echo ""
                install_flow "$mode"
            )
            ;;
        check-updates)
            (
                acquire_operation_lock
                echo -e "${GREEN}=== Hydro dev 版本检查脚本 ===${NC}"
                echo ""
                check_updates_flow
            )
            ;;
        upgrade-interactive)
            (
                acquire_operation_lock
                echo -e "${GREEN}=== Hydro dev 交互升级脚本 ===${NC}"
                echo ""
                upgrade_interactive_flow
            )
            ;;
        rollback)
            (
                acquire_operation_lock
                echo -e "${GREEN}=== Hydro 开发版本回退脚本 ===${NC}"
                echo ""
                rollback_flow "${args[0]:-}"
            )
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
