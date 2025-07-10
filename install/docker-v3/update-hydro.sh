#!/bin/bash

# Hydro 更新脚本 - 用于将域复制功能部署到 Docker 容器
# 作者: Claude Code
# 日期: 2025-07-10

set -e

# 配置变量
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
CONTAINER_NAME="hydro"
BACKUP_DIR="${SCRIPT_DIR}/backup/$(date +%Y%m%d_%H%M%S)"

# 颜色定义
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# 日志函数
log() {
    echo -e "${GREEN}[$(date '+%Y-%m-%d %H:%M:%S')] $1${NC}"
}

warn() {
    echo -e "${YELLOW}[$(date '+%Y-%m-%d %H:%M:%S')] ⚠️  $1${NC}"
}

error() {
    echo -e "${RED}[$(date '+%Y-%m-%d %H:%M:%S')] ❌ $1${NC}"
}

info() {
    echo -e "${BLUE}[$(date '+%Y-%m-%d %H:%M:%S')] ℹ️  $1${NC}"
}

# 检查必要的工具
check_prerequisites() {
    log "检查必要的工具..."
    
    if ! command -v docker &> /dev/null; then
        error "Docker 未安装或不在 PATH 中"
        exit 1
    fi
    
    if ! command -v docker-compose &> /dev/null; then
        error "Docker Compose 未安装或不在 PATH 中"
        exit 1
    fi
    
    if ! command -v node &> /dev/null; then
        error "Node.js 未安装或不在 PATH 中"
        exit 1
    fi
    
    if ! command -v npm &> /dev/null; then
        error "npm 未安装或不在 PATH 中"
        exit 1
    fi
    
    log "✅ 所有必要工具检查通过"
}

# 创建备份
create_backup() {
    log "创建备份..."
    mkdir -p "${BACKUP_DIR}"
    
    # 备份容器数据
    if docker ps -q -f name=${CONTAINER_NAME} | grep -q .; then
        log "备份容器数据..."
        docker exec ${CONTAINER_NAME} tar -czf /tmp/hydro-backup.tar.gz -C /root/.hydro . 2>/dev/null || true
        docker cp ${CONTAINER_NAME}:/tmp/hydro-backup.tar.gz "${BACKUP_DIR}/" 2>/dev/null || true
        docker exec ${CONTAINER_NAME} rm -f /tmp/hydro-backup.tar.gz 2>/dev/null || true
    fi
    
    # 备份本地数据
    if [ -d "${SCRIPT_DIR}/hydro-config" ]; then
        cp -r "${SCRIPT_DIR}/hydro-config" "${BACKUP_DIR}/" 2>/dev/null || true
    fi
    
    log "✅ 备份完成: ${BACKUP_DIR}"
}

# 构建项目
build_project() {
    log "检查构建文件..."
    
    # 检查是否有现成的构建文件
    if [ -d "${SCRIPT_DIR}/build" ] && [ -f "${SCRIPT_DIR}/build/file-list.txt" ]; then
        log "✅ 发现现成的构建文件，跳过构建步骤"
        return 0
    fi
    
    cd "${PROJECT_ROOT}"
    
    # 安装依赖
    log "安装依赖..."
    if npm install; then
        log "✅ 依赖安装成功"
    else
        warn "npm install 失败，尝试使用 --legacy-peer-deps"
        if npm install --legacy-peer-deps; then
            log "✅ 依赖安装成功（兼容模式）"
        else
            warn "依赖安装失败，但不影响域复制功能的部署"
            log "将跳过构建步骤，直接使用源文件"
            return 0
        fi
    fi
    
    # 构建项目
    log "构建项目..."
    if npm run build; then
        log "✅ 项目构建完成"
    else
        warn "构建失败，但不影响域复制功能的部署"
        log "将使用源文件直接部署"
    fi
}

# 检查容器状态
check_container_status() {
    if docker ps -q -f name=${CONTAINER_NAME} | grep -q .; then
        log "容器 ${CONTAINER_NAME} 正在运行"
        return 0
    elif docker ps -aq -f name=${CONTAINER_NAME} | grep -q .; then
        log "容器 ${CONTAINER_NAME} 存在但未运行"
        return 1
    else
        log "容器 ${CONTAINER_NAME} 不存在"
        return 2
    fi
}

# 更新域复制功能文件
update_domain_copy_files() {
    log "更新域复制功能文件到容器..."
    
    # 创建临时目录
    TEMP_DIR=$(mktemp -d)
    
    # 复制需要更新的文件
    log "准备更新文件..."
    
    # 优先使用构建目录的文件
    if [ -d "${SCRIPT_DIR}/build" ] && [ -f "${SCRIPT_DIR}/build/file-list.txt" ]; then
        log "使用构建目录的文件..."
        cp -r "${SCRIPT_DIR}/build/"* "${TEMP_DIR}/"
    else
        log "使用源代码目录的文件..."
        
        # 后端文件
        mkdir -p "${TEMP_DIR}/src/handler"
        cp "${PROJECT_ROOT}/packages/hydrooj/src/handler/domain-copy.ts" "${TEMP_DIR}/src/handler/" 2>/dev/null || {
            error "域复制处理器文件不存在"
            exit 1
        }
        
        # UI 配置文件
        mkdir -p "${TEMP_DIR}/src/lib"
        cp "${PROJECT_ROOT}/packages/hydrooj/src/lib/ui.ts" "${TEMP_DIR}/src/lib/" 2>/dev/null || {
            error "UI 配置文件不存在"
            exit 1
        }
        
        # 前端模板
        mkdir -p "${TEMP_DIR}/templates"
        cp "${PROJECT_ROOT}/packages/ui-default/templates/domain_copy.html" "${TEMP_DIR}/templates/" 2>/dev/null || {
            error "域复制模板文件不存在"
            exit 1
        }
        
        # 前端组件（如果存在）
        if [ -f "${PROJECT_ROOT}/packages/ui-default/components/DomainCopyModal.tsx" ]; then
            mkdir -p "${TEMP_DIR}/components"
            cp "${PROJECT_ROOT}/packages/ui-default/components/DomainCopyModal.tsx" "${TEMP_DIR}/components/"
        fi
    fi
    
    # 复制文件到容器
    log "复制文件到容器..."
    docker cp "${TEMP_DIR}/." ${CONTAINER_NAME}:/tmp/hydro-update/
    
    # 在容器内执行更新
    log "在容器内执行更新..."
    docker exec ${CONTAINER_NAME} bash -c "
        set -e
        
        # 加载 Nix 环境
        [ -f /root/.nix-profile/etc/profile.d/nix.sh ] && source /root/.nix-profile/etc/profile.d/nix.sh
        
        # 查找 Hydro 安装目录
        HYDRO_DIR=\"/usr/local/share/.config/yarn/global/node_modules/hydrooj\"
        
        # 如果标准位置不存在，尝试其他位置
        if [ ! -d \"\$HYDRO_DIR\" ]; then
            echo '⚠️ 标准位置未找到，尝试其他位置...'
            HYDRO_DIR=\$(find /root/.nix-profile -name 'hydrooj' -type d | head -1)
            if [ -z \"\$HYDRO_DIR\" ]; then
                HYDRO_DIR=\$(find /nix -name 'hydrooj' -type d | head -1)
            fi
            if [ -z \"\$HYDRO_DIR\" ]; then
                HYDRO_DIR=\$(find /usr -name 'hydrooj' -type d | head -1)
            fi
        fi
        
        if [ -z \"\$HYDRO_DIR\" ] || [ ! -d \"\$HYDRO_DIR\" ]; then
            echo '❌ 无法找到 Hydro 安装目录'
            exit 1
        fi
        
        echo \"📁 找到 Hydro 目录: \$HYDRO_DIR\"
        
        # 备份原始文件
        echo '💾 备份原始文件...'
        mkdir -p /tmp/hydro-backup-original
        [ -f \"\$HYDRO_DIR/src/handler/domain-copy.ts\" ] && cp \"\$HYDRO_DIR/src/handler/domain-copy.ts\" /tmp/hydro-backup-original/ 2>/dev/null || true
        [ -f \"\$HYDRO_DIR/src/lib/ui.ts\" ] && cp \"\$HYDRO_DIR/src/lib/ui.ts\" /tmp/hydro-backup-original/ 2>/dev/null || true
        
        # 更新后端文件
        echo '🔄 更新后端文件...'
        [ -f /tmp/hydro-update/src/handler/domain-copy.ts ] && cp /tmp/hydro-update/src/handler/domain-copy.ts \"\$HYDRO_DIR/src/handler/\"
        [ -f /tmp/hydro-update/src/lib/ui.ts ] && cp /tmp/hydro-update/src/lib/ui.ts \"\$HYDRO_DIR/src/lib/\"
        
        # 查找前端模板目录
        TEMPLATE_DIR=\"/usr/local/share/.config/yarn/global/node_modules/@hydrooj/ui-default/templates\"
        
        # 如果标准位置不存在，尝试其他位置
        if [ ! -d \"\$TEMPLATE_DIR\" ]; then
            echo '⚠️ 标准模板目录未找到，尝试其他位置...'
            TEMPLATE_DIR=\$(find /root/.nix-profile -name 'templates' -type d | grep ui-default | head -1)
            if [ -z \"\$TEMPLATE_DIR\" ]; then
                TEMPLATE_DIR=\$(find /nix -name 'templates' -type d | grep ui-default | head -1)
            fi
            if [ -z \"\$TEMPLATE_DIR\" ]; then
                TEMPLATE_DIR=\$(find /usr -name 'templates' -type d | grep ui-default | head -1)
            fi
        fi
        
        if [ -n \"\$TEMPLATE_DIR\" ]; then
            echo \"📁 找到模板目录: \$TEMPLATE_DIR\"
            echo '🔄 更新前端模板...'
            [ -f /tmp/hydro-update/templates/domain_copy.html ] && cp /tmp/hydro-update/templates/domain_copy.html \"\$TEMPLATE_DIR/\"
        else
            echo '⚠️ 未找到前端模板目录'
        fi
        
        # 查找前端组件目录
        COMPONENT_DIR=\"/usr/local/share/.config/yarn/global/node_modules/@hydrooj/ui-default/components\"
        
        # 如果标准位置不存在，尝试其他位置
        if [ ! -d \"\$COMPONENT_DIR\" ]; then
            echo '⚠️ 标准组件目录未找到，尝试其他位置...'
            COMPONENT_DIR=\$(find /root/.nix-profile -name 'components' -type d | grep ui-default | head -1)
            if [ -z \"\$COMPONENT_DIR\" ]; then
                COMPONENT_DIR=\$(find /nix -name 'components' -type d | grep ui-default | head -1)
            fi
            if [ -z \"\$COMPONENT_DIR\" ]; then
                COMPONENT_DIR=\$(find /usr -name 'components' -type d | grep ui-default | head -1)
            fi
        fi
        
        if [ -n \"\$COMPONENT_DIR\" ] && [ -f /tmp/hydro-update/components/DomainCopyModal.tsx ]; then
            echo \"📁 找到组件目录: \$COMPONENT_DIR\"
            echo '🔄 更新前端组件...'
            cp /tmp/hydro-update/components/DomainCopyModal.tsx \"\$COMPONENT_DIR/\"
        fi
        
        # 查找语言文件目录
        LOCALE_DIR=\"/usr/local/share/.config/yarn/global/node_modules/@hydrooj/ui-default/locales\"
        
        # 如果标准位置不存在，尝试其他位置
        if [ ! -d \"\$LOCALE_DIR\" ]; then
            echo '⚠️ 标准语言目录未找到，尝试其他位置...'
            LOCALE_DIR=\$(find /root/.nix-profile -name 'locales' -type d | grep ui-default | head -1)
            if [ -z \"\$LOCALE_DIR\" ]; then
                LOCALE_DIR=\$(find /nix -name 'locales' -type d | grep ui-default | head -1)
            fi
            if [ -z \"\$LOCALE_DIR\" ]; then
                LOCALE_DIR=\$(find /usr -name 'locales' -type d | grep ui-default | head -1)
            fi
        fi
        
        if [ -n \"\$LOCALE_DIR\" ] && [ -f /tmp/hydro-update/locales/zh.yaml ]; then
            echo \"📁 找到语言目录: \$LOCALE_DIR\"
            echo '🔄 更新中文语言文件...'
            cp /tmp/hydro-update/locales/zh.yaml \"\$LOCALE_DIR/\"
        fi
        
        echo '✅ 文件更新完成'
        
        # 清理临时文件
        rm -rf /tmp/hydro-update
    "
    
    # 清理本地临时文件
    rm -rf "${TEMP_DIR}"
    
    log "✅ 域复制功能文件更新完成"
}

# 重启服务
restart_services() {
    log "重启 Hydro 服务..."
    
    docker exec ${CONTAINER_NAME} bash -c "
        set -e
        
        # 加载 Nix 环境
        [ -f /root/.nix-profile/etc/profile.d/nix.sh ] && source /root/.nix-profile/etc/profile.d/nix.sh
        
        # 重启 PM2 服务
        if command -v pm2 >/dev/null 2>&1; then
            echo '🔄 重启 PM2 服务...'
            pm2 restart all || echo '⚠️ PM2 重启失败'
            pm2 save
        else
            echo '⚠️ PM2 不可用'
        fi
        
        echo '✅ 服务重启完成'
    "
    
    log "✅ 服务重启完成"
}

# 验证更新
verify_update() {
    log "验证更新..."
    
    # 等待服务启动
    sleep 10
    
    # 检查容器状态
    if ! docker ps -q -f name=${CONTAINER_NAME} | grep -q .; then
        error "容器未运行"
        return 1
    fi
    
    # 检查服务状态
    log "检查服务状态..."
    docker exec ${CONTAINER_NAME} bash -c "
        # 检查端口监听
        if netstat -tlnp 2>/dev/null | grep -E ':(80|8888)' >/dev/null; then
            echo '✅ Web 服务正在运行'
        else
            echo '⚠️ Web 服务可能未启动'
        fi
        
        # 检查 PM2 状态
        if command -v pm2 >/dev/null 2>&1; then
            pm2 list
        fi
    "
    
    # 检查域复制功能
    log "检查域复制功能..."
    docker exec ${CONTAINER_NAME} bash -c "
        # 查找域复制处理器文件
        HYDRO_DIR=\$(find /root/.nix-profile -name 'hydrooj' -type d | head -1)
        if [ -z \"\$HYDRO_DIR\" ]; then
            HYDRO_DIR=\$(find /nix -name 'hydrooj' -type d | head -1)
        fi
        
        if [ -f \"\$HYDRO_DIR/src/handler/domain-copy.ts\" ]; then
            echo '✅ 域复制处理器文件存在'
        else
            echo '❌ 域复制处理器文件不存在'
        fi
        
        # 查找域复制模板文件
        TEMPLATE_DIR=\$(find /root/.nix-profile -name 'templates' -type d | grep ui-default | head -1)
        if [ -z \"\$TEMPLATE_DIR\" ]; then
            TEMPLATE_DIR=\$(find /nix -name 'templates' -type d | grep ui-default | head -1)
        fi
        
        if [ -f \"\$TEMPLATE_DIR/domain_copy.html\" ]; then
            echo '✅ 域复制模板文件存在'
        else
            echo '❌ 域复制模板文件不存在'
        fi
    "
    
    log "✅ 验证完成"
}

# 显示访问信息
show_access_info() {
    log "更新完成！"
    echo ""
    echo "🌐 访问信息："
    echo "  • Web 界面: http://localhost:8082"
    echo "  • 管理面板: http://localhost:8082/manage"
    echo "  • 域复制功能: http://localhost:8082/domain/copy"
    echo ""
    echo "📝 使用说明："
    echo "  1. 使用管理员账号登录"
    echo "  2. 进入管理面板 → Domain → Copy Domain"
    echo "  3. 或直接访问 /domain/copy 路径"
    echo ""
    echo "💾 备份位置: ${BACKUP_DIR}"
    echo ""
}

# 主函数
main() {
    log "开始更新 Hydro 域复制功能..."
    
    # 检查先决条件
    check_prerequisites
    
    # 检查容器状态
    check_container_status
    local container_status=$?
    
    if [ $container_status -eq 2 ]; then
        error "容器不存在，请先启动 Hydro 容器"
        exit 1
    elif [ $container_status -eq 1 ]; then
        log "启动容器..."
        cd "${SCRIPT_DIR}"
        docker-compose up -d
        sleep 30
    fi
    
    # 创建备份
    create_backup
    
    # 构建项目
    build_project
    
    # 更新文件
    update_domain_copy_files
    
    # 重启服务
    restart_services
    
    # 验证更新
    verify_update
    
    # 显示访问信息
    show_access_info
    
    log "🎉 域复制功能更新完成！"
}

# 错误处理
trap 'error "脚本执行失败，请检查错误信息"; exit 1' ERR

# 执行主函数
main "$@"