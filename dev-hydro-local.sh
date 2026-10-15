#!/usr/bin/env bash

# Hydro 三种开发/验证流程：本地前端、容器内发布前构建、发布后 dev 安装。
#
# dev/container 会先把容器里的全局 Hydro 包完整备份到 .cache，再只覆盖源码
# 目录，最后通过 pm2 restart hydrooj 让容器重新加载源码。release 会明确调用
# build-and-publish-dev.sh，然后调用容器 active release 中的安装器。

set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

CONTAINER="${HYDRO_CONTAINER:-}"
BACKEND_URL="${HYDRO_BACKEND_URL:-}"
NODE_MODULES="${HYDRO_CONTAINER_NODE_MODULES:-/usr/local/share/.config/yarn/global/node_modules}"
BACKUP_ROOT="${HYDRO_DEV_BACKUP_DIR:-$SCRIPT_DIR/.cache/hydro-container-backups}"
PACKAGES_CSV="${HYDRO_DEV_PACKAGES:-hydrooj,framework,utils,common,ui-backend}"
DO_BUILD=1
DO_RESTART=1
DO_UI_BUILD=0
BUILD_WAS_DISABLED=0
RESTORE_ID=""
PUBLISH_PACKAGES_CSV=""
INSTALL_PACKAGES_CSV=""
PACKAGES_WAS_SET=0

print_usage() {
    cat <<'HELP'
用法:
  ./dev-hydro-local.sh dev [选项]
  ./dev-hydro-local.sh container [选项]
  ./dev-hydro-local.sh release [选项]
  ./dev-hydro-local.sh run [选项]
  ./dev-hydro-local.sh frontend [--backend-url URL]
  ./dev-hydro-local.sh build
  ./dev-hydro-local.sh sync [选项]
  ./dev-hydro-local.sh restore [备份编号] [选项]
  ./dev-hydro-local.sh list-backups
  ./dev-hydro-local.sh status [--container hydro|hydro2]

dev       场景 1：编译后端、备份并同步源码，然后启动本地前端开发服务器。
container 场景 2：编译前后端、备份并同步到容器，前后端都由容器提供。
release   场景 3：调用 build-and-publish-dev.sh 发布，再在容器内安装 dev 版本。
run       dev 的兼容别名。
frontend  只启动本地前端开发服务器，默认监听 http://localhost:8000。
build     只执行 yarn build，不连接容器。
sync      编译并同步后端源码，默认重启容器内的 hydrooj。
restore   恢复一个 sync 产生的备份，并重启容器内的 hydrooj。

选项:
  --container NAME       目标容器；省略时默认 hydro，可选 hydro 或 hydro2。
  --backend-url URL      前端代理的后端地址；dev 默认读取容器映射端口，
                         frontend 单独启动时默认 http://127.0.0.1:8888。
  --packages LIST        包列表，逗号分隔：
                         hydrooj,framework,utils,common,ui,ui-backend,ui-frontend,hydrojudge
                         release 也接受 all、ui-default 和 @hydrooj/* 包名。
  --no-build             dev/container/sync 时跳过 yarn build。
  --no-restart           同步或恢复后不重启 PM2 进程。
  --backup-dir DIR       备份目录，默认 .cache/hydro-container-backups。
  -h, --help             显示帮助。

示例:
  ./dev-hydro-local.sh dev --container hydro --backend-url http://127.0.0.1:8082
  ./dev-hydro-local.sh container --container hydro --packages hydrooj,ui
  ./dev-hydro-local.sh release --container hydro --packages hydrooj,ui-default
  ./dev-hydro-local.sh sync --container hydro2 --packages hydrooj,framework
  ./dev-hydro-local.sh restore 20261015-120000-12345 --container hydro

说明:
  - 脚本要求目标容器正在运行，并且容器中存在 /usr/local/bin/pm2。
  - 默认全局包目录是 /usr/local/share/.config/yarn/global/node_modules，
    可通过 HYDRO_CONTAINER_NODE_MODULES 修改。
  - ui-backend 只同步 UI 的后端入口、模板和 backendlib。
  - ui-frontend 只构建并同步 UI 的 public；ui 同时处理前后端。
  - release 会产生真实发布和容器升级，必须在用户明确批准该次发布后执行。
HELP
}

die() {
    echo "错误: $*" >&2
    exit 1
}

warn() {
    echo "警告: $*" >&2
}

command_exists() {
    command -v "$1" >/dev/null 2>&1
}

require_docker() {
    command_exists docker || die "找不到 docker 命令。"
}

container_exists() {
    docker inspect "$1" >/dev/null 2>&1
}

resolve_container() {
    require_docker

    if [[ -n "$CONTAINER" ]]; then
        container_exists "$CONTAINER" || die "容器不存在: $CONTAINER"
    else
        CONTAINER="hydro"
        container_exists "$CONTAINER" || die "默认容器 hydro 不存在；如需使用其他容器，请通过 --container 指定。"
    fi

    local running
    running="$(docker inspect --format '{{.State.Running}}' "$CONTAINER" 2>/dev/null || true)"
    [[ "$running" == "true" ]] || die "容器未运行: $CONTAINER"
}

resolve_backend_url() {
    [[ -n "$BACKEND_URL" ]] && return 0
    local port
    port="$(docker port "$CONTAINER" 80/tcp 2>/dev/null | head -1 | awk -F: '{print $NF}' || true)"
    if [[ "$port" =~ ^[0-9]+$ ]]; then
        BACKEND_URL="http://127.0.0.1:$port"
        echo "==> 使用容器映射端口作为前端后端地址: $BACKEND_URL"
    else
        BACKEND_URL="http://127.0.0.1:8888"
        warn "无法读取容器 80 端口映射，前端回退到 $BACKEND_URL"
    fi
}

container_exec() {
    docker exec "$CONTAINER" "$@"
}

container_sh() {
    docker exec "$CONTAINER" sh -lc "$1"
}

resolve_node_modules() {
    local candidate yarn_global hydro_bin release_modules
    if container_exec test -d "$NODE_MODULES/hydrooj"; then
        return 0
    fi

    hydro_bin="$(container_exec sh -lc 'readlink -f "$(command -v hydrooj)" 2>/dev/null || true' 2>/dev/null || true)"
    if [[ -n "$hydro_bin" ]]; then
        release_modules="$(dirname "$(dirname "$(dirname "$hydro_bin")")")"
        if container_exec test -d "$release_modules/hydrooj"; then
            NODE_MODULES="$release_modules"
            echo "==> 使用 hydrooj 当前 release 包目录: $NODE_MODULES"
            return 0
        fi
    fi

    yarn_global="$(container_exec sh -lc 'yarn global dir 2>/dev/null || true' 2>/dev/null || true)"
    for candidate in \
        "${yarn_global:+$yarn_global/node_modules}" \
        "$(container_exec npm root -g 2>/dev/null || true)"; do
        [[ -n "$candidate" ]] || continue
        if container_exec test -d "$candidate/hydrooj"; then
            NODE_MODULES="$candidate"
            echo "==> 使用容器全局包目录: $NODE_MODULES"
            return 0
        fi
    done

    die "无法定位容器全局包目录: $NODE_MODULES。请设置 HYDRO_CONTAINER_NODE_MODULES。"
}

package_label() {
    case "$1" in
        hydrooj) echo hydrooj ;;
        framework) echo framework ;;
        utils) echo utils ;;
        common) echo common ;;
        ui) echo ui-default ;;
        ui-backend) echo ui-default-backend ;;
        ui-frontend) echo ui-default-frontend ;;
        hydrojudge) echo hydrojudge ;;
        *) die "不支持的包: $1" ;;
    esac
}

package_dest() {
    case "$1" in
        hydrooj) echo "$NODE_MODULES/hydrooj" ;;
        framework) echo "$NODE_MODULES/@hydrooj/framework" ;;
        utils) echo "$NODE_MODULES/@hydrooj/utils" ;;
        common) echo "$NODE_MODULES/@hydrooj/common" ;;
        ui|ui-backend|ui-frontend) echo "$NODE_MODULES/@hydrooj/ui-default" ;;
        hydrojudge) echo "$NODE_MODULES/@hydrooj/hydrojudge" ;;
        *) die "不支持的包: $1" ;;
    esac
}

normalize_packages() {
    local raw
    local -a requested
    local -a normalized=()
    IFS=',' read -r -a requested <<< "$PACKAGES_CSV"
    for raw in "${requested[@]}"; do
        [[ -n "$raw" ]] || continue
        case "$raw" in
            ui|ui-default) raw=ui ;;
        esac
        if [[ "$raw" == framework ]]; then
            [[ " ${normalized[*]} " =~ " framework " ]] || normalized+=(framework)
            [[ " ${normalized[*]} " =~ " utils " ]] || normalized+=(utils)
            continue
        fi
        case "$raw" in
            hydrooj|framework|utils|common|ui|ui-backend|ui-frontend|hydrojudge) ;;
            *) die "--packages 包含不支持的值: $raw" ;;
        esac
        if [[ ! " ${normalized[*]} " =~ " $raw " ]]; then
            normalized+=("$raw")
        fi
    done
    # ui 覆盖同一个安装目录的后端和前端；选中完整 UI 时去掉两个子选择，
    # 避免重复备份和重复替换。
    if [[ " ${normalized[*]} " =~ " ui " ]]; then
        local -a without_ui_parts=()
        for raw in "${normalized[@]}"; do
            [[ "$raw" == ui-backend || "$raw" == ui-frontend ]] || without_ui_parts+=("$raw")
        done
        normalized=("${without_ui_parts[@]}" ui)
    fi
    ((${#normalized[@]} > 0)) || die "至少需要同步一个包。"
    SELECTED_PACKAGES=("${normalized[@]}")
}

source_path_for() {
    case "$1" in
        hydrooj) echo "$SCRIPT_DIR/packages/hydrooj/src" ;;
        framework) echo "$SCRIPT_DIR/framework/framework" ;;
        utils) echo "$SCRIPT_DIR/framework/utils/lib" ;;
        common) echo "$SCRIPT_DIR/packages/common" ;;
        ui|ui-backend|ui-frontend) echo "$SCRIPT_DIR/packages/ui-default" ;;
        hydrojudge) echo "$SCRIPT_DIR/packages/hydrojudge/src" ;;
        *) die "不支持的包: $1" ;;
    esac
}

validate_sources() {
    local package source
    for package in "${SELECTED_PACKAGES[@]}"; do
        source="$(source_path_for "$package")"
        [[ -d "$source" ]] || die "本地源码目录不存在: $source"
        case "$package" in
            framework)
                [[ -f "$source/package.json" ]] || die "framework 源码目录不完整: $source" ;;
            utils)
                [[ -f "$source/utils.ts" ]] || die "utils 源码目录不完整: $source" ;;
            common)
                [[ -f "$source/index.ts" ]] || die "common 源码目录不完整: $source" ;;
            ui)
                [[ -f "$source/index.ts" && -d "$source/backendlib" ]] \
                    || die "ui-default 后端源码目录不完整: $source"
                if ! ((DO_UI_BUILD)) && [[ ! -d "$source/public" ]]; then
                    die "ui-default 前端构建目录不存在: $source/public；先执行 yarn build:ui"
                fi
                ;;
            ui-backend)
                [[ -f "$source/index.ts" && -d "$source/backendlib" ]] \
                    || die "ui-default 后端源码目录不完整: $source" ;;
            ui-frontend)
                if ((DO_UI_BUILD == 0)) && [[ ! -d "$source/public" ]]; then
                    die "ui-default 前端构建目录不存在: $source/public；先执行 yarn build:ui"
                fi
                ;;
        esac
    done
}

check_remote_packages() {
    local package dest
    for package in "${SELECTED_PACKAGES[@]}"; do
        dest="$(package_dest "$package")"
        container_exec test -d "$dest" \
            || die "容器内找不到 $package: $dest。可通过 HYDRO_CONTAINER_NODE_MODULES 指定全局包目录。"
    done
}

run_build() {
    echo "==> 编译本地后端源码"
    yarn build
}

run_ui_build() {
    echo "==> 构建本地前端生产资源"
    yarn build:ui
}

has_selected_package() {
    local selected
    for selected in "${SELECTED_PACKAGES[@]}"; do
        [[ "$selected" == "$1" ]] && return 0
    done
    return 1
}

backup_packages() {
    local package label dest
    local stamp backup_dir temp_dir
    declare -A seen_dest=()
    mkdir -p "$BACKUP_ROOT"
    stamp="$(date +%Y%m%d-%H%M%S)-$$"
    backup_dir="$BACKUP_ROOT/$stamp"
    temp_dir="$BACKUP_ROOT/.$stamp.tmp"
    mkdir -p "$temp_dir"
    printf 'container=%s\nnode_modules=%s\ncreated_at=%s\n' \
        "$CONTAINER" "$NODE_MODULES" "$(date -Iseconds)" > "$temp_dir/metadata"
    : > "$temp_dir/manifest.tsv"

    echo "==> 备份容器内源码"
    for package in "${SELECTED_PACKAGES[@]}"; do
        label="$(package_label "$package")"
        dest="$(package_dest "$package")"
        if [[ -n "${seen_dest[$dest]:-}" ]]; then
            continue
        fi
        seen_dest["$dest"]=1
        echo "    $package <- $dest"
        docker cp "$CONTAINER:$dest" "$temp_dir/$label"
        printf '%s\t%s\t%s\n' "$package" "$label" "$dest" >> "$temp_dir/manifest.tsv"
    done
    mv "$temp_dir" "$backup_dir"
    LAST_BACKUP_DIR="$backup_dir"
    echo "    备份位置: $backup_dir"
}

sync_directory_replace() {
    local source="$1"
    local dest="$2"
    local temp_dest="${dest}.hydro-dev-tmp-$$"
    container_exec rm -rf "$temp_dest"
    container_exec mkdir -p "$temp_dest"
    tar -C "$source" -cf - . \
        | docker exec -i "$CONTAINER" tar -C "$temp_dest" -xf -
    container_exec rm -rf "$dest"
    container_exec mv "$temp_dest" "$dest"
}

sync_package_root_code() {
    local source="$1"
    local dest="$2"
    [[ -f "$source/package.json" ]] || die "源码包缺少 package.json: $source"
    container_sh "find '$dest' -mindepth 1 -maxdepth 1 ! -name package.json ! -name tsconfig.json ! -name node_modules -exec rm -rf {} +"
    tar -C "$source" --exclude=package.json --exclude=tsconfig.json --exclude=node_modules --exclude=tests --exclude='*.tgz' -cf - . \
        | docker exec -i "$CONTAINER" tar -C "$dest" -xf -
}

sync_package() {
    local package="$1"
    local source dest
    source="$(source_path_for "$package")"
    dest="$(package_dest "$package")"
    echo "==> 同步 $package"

    case "$package" in
        hydrooj)
            container_exec rm -rf "$dest/src"
            docker cp "$source" "$CONTAINER:$dest/"
            ;;
        framework|common)
            sync_package_root_code "$source" "$dest"
            ;;
        utils)
            container_exec rm -rf "$dest/lib"
            docker cp "$source" "$CONTAINER:$dest/"
            ;;
        ui|ui-backend)
            container_exec rm -rf "$dest/backendlib" "$dest/templates" "$dest/locales" "$dest/api.ts" "$dest/setting.yaml"
            docker cp "$source/backendlib" "$CONTAINER:$dest/"
            docker cp "$source/templates" "$CONTAINER:$dest/"
            docker cp "$source/index.ts" "$CONTAINER:$dest/"
            [[ -f "$source/api.ts" ]] && docker cp "$source/api.ts" "$CONTAINER:$dest/"
            [[ -f "$source/setting.yaml" ]] && docker cp "$source/setting.yaml" "$CONTAINER:$dest/"
            if [[ -d "$source/locales" ]]; then
                container_exec rm -rf "$dest/locales"
                docker cp "$source/locales" "$CONTAINER:$dest/"
            fi
            if [[ "$package" == ui ]]; then
                echo "    同步 UI public"
                sync_directory_replace "$source/public" "$dest/public"
            fi
            ;;
        ui-frontend)
            echo "    同步 UI public"
            sync_directory_replace "$source/public" "$dest/public"
            ;;
        hydrojudge)
            container_exec rm -rf "$dest/src"
            docker cp "$source" "$CONTAINER:$dest/"
            ;;
    esac
}

pm2_has_app() {
    local app="$1"
    container_sh "command -v pm2 >/dev/null 2>&1 && pm2 describe '$app' >/dev/null 2>&1"
}

restart_services() {
    if ! pm2_has_app hydrooj; then
        die "容器内没有找到 PM2 应用 hydrooj；如果进程名称不同，请使用 --no-restart 后手动重启。"
    fi
    echo "==> 重启容器内 hydrooj"
    container_sh "pm2 restart hydrooj --update-env"

    local package
    local restart_judge=0
    for package in "${SELECTED_PACKAGES[@]}"; do
        case "$package" in
            framework|utils|common|hydrojudge) restart_judge=1 ;;
        esac
    done
    if ((restart_judge)) && pm2_has_app hydrojudge; then
        echo "==> 重启容器内 hydrojudge"
        container_sh "pm2 restart hydrojudge --update-env"
    fi
}

perform_sync() {
    resolve_container
    resolve_backend_url
    resolve_node_modules
    normalize_packages
    validate_sources
    check_remote_packages
    if ((DO_BUILD)); then run_build; fi
    if ((DO_UI_BUILD)) && (has_selected_package ui || has_selected_package ui-frontend); then
        run_ui_build
    fi
    backup_packages
    local package
    for package in "${SELECTED_PACKAGES[@]}"; do
        sync_package "$package"
    done
    if ((DO_RESTART)); then
        restart_services
    else
        warn "已跳过 PM2 重启；需要手动执行: docker exec $CONTAINER sh -lc 'pm2 restart hydrooj --update-env'"
    fi
    echo "完成。旧版本备份位于: $LAST_BACKUP_DIR"
}

run_frontend() {
    [[ -n "$BACKEND_URL" ]] || BACKEND_URL="http://127.0.0.1:8888"
    echo "==> 启动本地前端，代理到 $BACKEND_URL"
    HYDRO_UI_DEV_BACKEND="$BACKEND_URL" exec yarn build:ui:dev
}

normalize_publish_packages() {
    local input raw key
    local -a requested normalized=()
    if ((PACKAGES_WAS_SET)); then
        input="$PACKAGES_CSV"
    else
        input="common,framework,hydrooj,ui-default,hydrojudge"
    fi
    if [[ ",$input," == *,all,* ]]; then
        input="common,framework,hydrooj,ui-default,hydrojudge,fps-importer,a11y,import-hoj"
    fi
    IFS=',' read -r -a requested <<< "$input"
    for raw in "${requested[@]}"; do
        [[ -n "$raw" ]] || continue
        key="${raw#@hydrooj/}"
        case "$key" in
            ui|ui-default|ui-backend|ui-frontend) key=ui-default ;;
            common|framework|hydrooj|hydrojudge|fps-importer|a11y|import-hoj) ;;
            utils)
                die "release 不支持单独发布 utils；请发布 framework，或使用 dev/container 直接同步 utils。" ;;
            *) die "release --packages 包含不支持的值: $raw" ;;
        esac
        if [[ ! " ${normalized[*]} " =~ " $key " ]]; then
            normalized+=("$key")
        fi
    done
    ((${#normalized[@]} > 0)) || die "release 至少需要发布一个包。"
    # common 被 hydrooj、ui-default 和 hydrojudge 直接依赖。发布 common 时
    # 必须同步发布这些消费者，否则它们固定的依赖版本仍会指向旧 common。
    local has_common=0
    for key in "${normalized[@]}"; do
        [[ "$key" == common ]] && has_common=1
    done
    if ((has_common)); then
        for key in hydrooj ui-default hydrojudge; do
            if [[ ! " ${normalized[*]} " =~ " $key " ]]; then
                normalized+=("$key")
            fi
        done
    fi
    PUBLISH_PACKAGES_CSV="$(IFS=,; echo "${normalized[*]}")"
    local -a install_packages=("${normalized[@]}")
    INSTALL_PACKAGES_CSV="$(IFS=,; echo "${install_packages[*]}")"
}

run_release() {
    resolve_container
    normalize_publish_packages
    resolve_node_modules
    local installer="$NODE_MODULES/hydrooj/bin/install-dev-from-private-npm.sh"
    container_exec test -x "$installer" \
        || die "容器 active release 中找不到安装器: $installer"
    [[ -x "$SCRIPT_DIR/build-and-publish-dev.sh" ]] \
        || die "找不到可执行发布脚本: $SCRIPT_DIR/build-and-publish-dev.sh"
    echo "==> 将发布 dev 包: $PUBLISH_PACKAGES_CSV"
    echo "==> 容器安装包: $INSTALL_PACKAGES_CSV"
    echo "==> 目标容器: $CONTAINER"
    echo "==> 该命令会访问私有 registry 并改变容器 active release。"
    NPM_REGISTRY="${NPM_REGISTRY:-https://npm.leeson.top/}" \
        "$SCRIPT_DIR/build-and-publish-dev.sh" --packages "$PUBLISH_PACKAGES_CSV"

    local -a install_args=(update --packages "$INSTALL_PACKAGES_CSV")
    if ((DO_RESTART == 0)); then
        install_args+=(--no-restart)
    fi
    echo "==> 在容器内安装已发布 dev 版本"
    docker exec -e "NPM_REGISTRY=${NPM_REGISTRY:-https://npm.leeson.top/}" \
        "$CONTAINER" "$installer" "${install_args[@]}"
    if ((DO_RESTART)); then
        echo "==> 重启容器内 hydrooj"
        container_sh "pm2 restart hydrooj --update-env"
    fi
    echo "==> 发布后服务状态"
    container_sh "readlink -f /usr/local/bin/hydrooj; pm2 jlist"
}

list_backups() {
    if [[ ! -d "$BACKUP_ROOT" ]]; then
        echo "没有备份: $BACKUP_ROOT"
        return 0
    fi
    find "$BACKUP_ROOT" -mindepth 1 -maxdepth 1 -type f -name manifest.tsv -printf '%h\n' \
        | sed "s#^$BACKUP_ROOT/##" | sort
}

validate_backup_manifest() {
    local backup_dir="$1"
    local package label dest expected_label expected_dest
    while IFS=$'\t' read -r package label dest; do
        [[ -n "$package" ]] || continue
        expected_label="$(package_label "$package")"
        expected_dest="$(package_dest "$package")"
        [[ "$label" == "$expected_label" ]] \
            || die "备份包标签不匹配: $package"
        [[ "$dest" == "$expected_dest" ]] \
            || die "备份目标路径不匹配: $package"
        [[ -d "$backup_dir/$label" ]] \
            || die "备份包目录不存在: $backup_dir/$label"
    done < "$backup_dir/manifest.tsv"
}

restore_backup() {
    resolve_container
    resolve_node_modules
    [[ -n "$RESTORE_ID" ]] || die "restore 需要备份编号；先执行 list-backups 查看。"
    [[ "$RESTORE_ID" != */* ]] || die "restore 只接受 list-backups 输出的备份编号。"
    local backup_dir="$BACKUP_ROOT/$RESTORE_ID"
    [[ -f "$backup_dir/manifest.tsv" ]] || die "备份不存在或缺少 manifest.tsv: $backup_dir"
    validate_backup_manifest "$backup_dir"

    SELECTED_PACKAGES=()
    local package label dest parent
    while IFS=$'\t' read -r package label dest; do
        [[ -n "$package" ]] || continue
        SELECTED_PACKAGES+=("$package")
    done < "$backup_dir/manifest.tsv"
    ((${#SELECTED_PACKAGES[@]} > 0)) || die "备份为空: $backup_dir"
    check_remote_packages

    echo "==> 先备份当前容器文件，再恢复 $backup_dir"
    backup_packages
    while IFS=$'\t' read -r package label dest; do
        [[ -n "$package" ]] || continue
        parent="${dest%/*}"
        echo "    恢复 $package <- $dest"
        container_exec rm -rf "$dest"
        container_exec mkdir -p "$parent"
        docker cp "$backup_dir/$label" "$CONTAINER:$parent/"
    done < "$backup_dir/manifest.tsv"

    if ((DO_RESTART)); then
        restart_services
    else
        warn "已跳过 PM2 重启；需要手动执行: docker exec $CONTAINER sh -lc 'pm2 restart hydrooj --update-env'"
    fi
    echo "恢复完成。恢复前的当前文件备份位于: $LAST_BACKUP_DIR"
}

COMMAND="${1:-help}"
if (($# > 0)); then shift; fi

while (($# > 0)); do
    case "$1" in
        --container)
            (($# >= 2)) || die "--container 缺少参数"
            CONTAINER="$2"
            shift 2
            ;;
        --backend-url)
            (($# >= 2)) || die "--backend-url 缺少参数"
            BACKEND_URL="$2"
            shift 2
            ;;
        --packages)
            (($# >= 2)) || die "--packages 缺少参数"
            PACKAGES_CSV="$2"
            PACKAGES_WAS_SET=1
            shift 2
            ;;
        --backup-dir)
            (($# >= 2)) || die "--backup-dir 缺少参数"
            BACKUP_ROOT="$2"
            shift 2
            ;;
        --no-build)
            DO_BUILD=0
            DO_UI_BUILD=0
            BUILD_WAS_DISABLED=1
            shift
            ;;
        --no-restart)
            DO_RESTART=0
            shift
            ;;
        -h|--help)
            print_usage
            exit 0
            ;;
        --*)
            die "未知选项: $1"
            ;;
        *)
            if [[ "$COMMAND" == restore && -z "$RESTORE_ID" ]]; then
                RESTORE_ID="$1"
                shift
            else
                die "多余参数: $1"
            fi
            ;;
    esac
done

case "$COMMAND" in
    dev|run)
        perform_sync
        run_frontend
        ;;
    container)
        if ((PACKAGES_WAS_SET == 0)); then
            PACKAGES_CSV="hydrooj,framework,utils,common,ui"
        fi
        if ((BUILD_WAS_DISABLED == 0)); then
            DO_UI_BUILD=1
        fi
        perform_sync
        ;;
    release)
        run_release
        ;;
    frontend)
        run_frontend
        ;;
    build)
        run_build
        ;;
    sync)
        perform_sync
        ;;
    restore)
        restore_backup
        ;;
    list-backups)
        list_backups
        ;;
    status)
        resolve_container
        resolve_node_modules
        echo "container=$CONTAINER"
        echo "node_modules=$NODE_MODULES"
        container_sh "pm2 jlist"
        ;;
    help|-h|--help)
        print_usage
        ;;
    *)
        die "未知命令: $COMMAND；使用 --help 查看用法。"
        ;;
esac
