#!/bin/bash

# Hydro 域复制功能一键部署脚本
# 整合构建、更新、验证流程
# 作者: Claude Code
# 日期: 2025-07-10

set -e

# 配置变量
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
CONTAINER_NAME="hydro"

# 颜色定义
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
PURPLE='\033[0;35m'
CYAN='\033[0;36m'
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

success() {
    echo -e "${GREEN}[$(date '+%Y-%m-%d %H:%M:%S')] ✅ $1${NC}"
}

header() {
    echo -e "${PURPLE}════════════════════════════════════════════════════════════════${NC}"
    echo -e "${PURPLE}$1${NC}"
    echo -e "${PURPLE}════════════════════════════════════════════════════════════════${NC}"
}

# 显示欢迎信息
show_welcome() {
    clear
    header "🚀 Hydro 域复制功能一键部署脚本"
    echo ""
    echo -e "${CYAN}📋 本脚本将自动完成以下步骤:${NC}"
    echo -e "${CYAN}  1. 检查环境和依赖${NC}"
    echo -e "${CYAN}  2. 构建项目文件${NC}"
    echo -e "${CYAN}  3. 更新 Docker 容器${NC}"
    echo -e "${CYAN}  4. 验证功能正常${NC}"
    echo -e "${CYAN}  5. 生成部署报告${NC}"
    echo ""
    echo -e "${CYAN}📁 项目目录: ${PROJECT_ROOT}${NC}"
    echo -e "${CYAN}🐳 容器名称: ${CONTAINER_NAME}${NC}"
    echo ""
    
    read -p "是否继续部署? (y/N): " -n 1 -r
    echo ""
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        echo "取消部署"
        exit 0
    fi
}

# 检查环境
check_environment() {
    header "🔍 检查环境和依赖"
    
    # 检查脚本存在
    local scripts=("build-hydro.sh" "build-simple.sh" "update-hydro.sh" "verify-domain-copy.sh")
    for script in "${scripts[@]}"; do
        if [ ! -f "${SCRIPT_DIR}/${script}" ]; then
            error "脚本 ${script} 不存在"
            exit 1
        fi
        # 设置执行权限
        chmod +x "${SCRIPT_DIR}/${script}"
    done
    
    success "所有部署脚本检查通过"
}

# 执行构建
run_build() {
    header "🔨 构建项目文件"
    
    log "尝试标准构建..."
    if "${SCRIPT_DIR}/build-hydro.sh"; then
        success "标准构建完成"
    else
        warn "标准构建失败，尝试简化构建..."
        if "${SCRIPT_DIR}/build-simple.sh"; then
            success "简化构建完成"
        else
            error "所有构建方式都失败"
            exit 1
        fi
    fi
}

# 执行更新
run_update() {
    header "🔄 更新 Docker 容器"
    
    log "执行更新脚本..."
    if "${SCRIPT_DIR}/update-hydro.sh"; then
        success "更新完成"
    else
        error "更新失败"
        exit 1
    fi
}

# 执行验证
run_verification() {
    header "✅ 验证功能正常"
    
    log "执行验证脚本..."
    if "${SCRIPT_DIR}/verify-domain-copy.sh"; then
        success "验证完成"
    else
        error "验证失败"
        exit 1
    fi
}

# 生成部署报告
generate_deployment_report() {
    header "📊 生成部署报告"
    
    local report_file="${SCRIPT_DIR}/deployment-report.md"
    
    cat > "$report_file" << EOF
# Hydro 域复制功能部署报告

## 部署信息
- 部署时间: $(date)
- 部署脚本: $(basename "$0")
- 项目目录: ${PROJECT_ROOT}
- 容器名称: ${CONTAINER_NAME}

## 部署步骤
1. ✅ 环境检查
2. ✅ 项目构建
3. ✅ 容器更新
4. ✅ 功能验证
5. ✅ 报告生成

## 功能特性
- ✅ 域基本信息复制
- ✅ 题库和测试数据复制
- ✅ 比赛和作业复制
- ✅ 训练计划复制
- ✅ 用户权限和角色复制
- ✅ 用户分组复制
- ✅ 讨论内容复制
- ✅ 题目题解复制

## 高级特性
- ✅ 题目 ID 映射
- ✅ 实时进度显示
- ✅ 错误处理和恢复
- ✅ 域 ID 可用性验证
- ✅ WebSocket 进度更新

## 访问信息
- 系统主页: http://localhost:8082/
- 管理面板: http://localhost:8082/manage
- 域复制页面: http://localhost:8082/domain/copy
- API 验证: http://localhost:8082/domain/copy/validate

## 使用说明
1. 使用管理员账号登录系统
2. 进入管理面板，找到 "Domain" 分类
3. 点击 "Copy Domain" 选项
4. 选择源域和目标域
5. 配置复制选项
6. 开始复制过程

## 权限要求
- 需要系统管理员权限 (PRIV_EDIT_SYSTEM)
- 功能位于: 管理面板 → Domain → Copy Domain

## 文件结构
\`\`\`
${SCRIPT_DIR}/
├── build-hydro.sh           # 构建脚本
├── update-hydro.sh          # 更新脚本
├── verify-domain-copy.sh    # 验证脚本
├── deploy-domain-copy.sh    # 部署脚本（本脚本）
├── build/                   # 构建输出目录
├── backup/                  # 备份目录
└── deployment-report.md     # 部署报告（本文件）
\`\`\`

## 技术信息
- 后端框架: TypeScript + Cordis
- 前端技术: HTML + JavaScript + WebSocket
- 数据库: MongoDB
- 容器技术: Docker
- 进程管理: PM2

## 故障排除
如果遇到问题，请检查：
1. 容器是否正在运行: \`docker ps | grep ${CONTAINER_NAME}\`
2. 服务是否启动: \`docker exec ${CONTAINER_NAME} pm2 list\`
3. 端口是否监听: \`docker exec ${CONTAINER_NAME} netstat -tlnp | grep 80\`
4. 日志文件: \`docker logs ${CONTAINER_NAME}\`

## 测试建议
1. 创建测试域进行功能验证
2. 测试各种复制选项组合
3. 验证大数据量场景
4. 检查错误处理机制
5. 监控性能表现

## 联系支持
如有问题，请参考：
- 项目文档: https://hydro.js.org/
- 问题反馈: https://github.com/hydro-dev/Hydro/issues

---
报告生成时间: $(date)
部署状态: 成功 ✅
EOF
    
    success "部署报告已生成: $report_file"
}

# 显示完成信息
show_completion() {
    header "🎉 部署完成！"
    
    echo ""
    echo -e "${GREEN}✅ 域复制功能已成功部署到 Docker 容器！${NC}"
    echo ""
    echo -e "${CYAN}📋 快速访问链接:${NC}"
    echo -e "${CYAN}  • 系统主页: http://localhost:8082/${NC}"
    echo -e "${CYAN}  • 管理面板: http://localhost:8082/manage${NC}"
    echo -e "${CYAN}  • 域复制页面: http://localhost:8082/domain/copy${NC}"
    echo ""
    echo -e "${CYAN}🔐 使用说明:${NC}"
    echo -e "${CYAN}  1. 使用管理员账号登录${NC}"
    echo -e "${CYAN}  2. 进入管理面板 → Domain → Copy Domain${NC}"
    echo -e "${CYAN}  3. 选择源域和目标域${NC}"
    echo -e "${CYAN}  4. 配置复制选项${NC}"
    echo -e "${CYAN}  5. 开始复制过程${NC}"
    echo ""
    echo -e "${CYAN}📊 相关文件:${NC}"
    echo -e "${CYAN}  • 部署报告: ${SCRIPT_DIR}/deployment-report.md${NC}"
    echo -e "${CYAN}  • 测试报告: ${SCRIPT_DIR}/domain-copy-test-report.md${NC}"
    echo -e "${CYAN}  • 构建目录: ${SCRIPT_DIR}/build/${NC}"
    echo -e "${CYAN}  • 备份目录: ${SCRIPT_DIR}/backup/${NC}"
    echo ""
    echo -e "${GREEN}🎊 感谢使用 Hydro 域复制功能！${NC}"
    echo ""
}

# 主函数
main() {
    # 显示欢迎信息
    show_welcome
    
    # 检查环境
    check_environment
    
    # 执行构建
    run_build
    
    # 执行更新
    run_update
    
    # 执行验证
    run_verification
    
    # 生成部署报告
    generate_deployment_report
    
    # 显示完成信息
    show_completion
}

# 错误处理
trap 'error "部署失败，请检查错误信息"; exit 1' ERR

# 执行主函数
main "$@"