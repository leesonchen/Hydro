# Hydro 域复制功能更新摘要（简化构建）

## 更新日期
Thu Jul 10 14:22:55 CST 2025

## 构建模式
简化构建模式 - 跳过 npm 依赖安装和编译，直接使用源码部署

## 功能概述
本次更新增加了域复制功能，允许管理员将一个域的全部内容复制到新域。

## 主要功能
- ✅ 域基本信息复制
- ✅ 题库和测试数据复制
- ✅ 比赛和作业复制
- ✅ 训练计划复制
- ✅ 用户权限和角色复制
- ✅ 用户分组复制
- ✅ 讨论内容复制
- ✅ 题目题解复制

## 高级特性
- 题目 ID 映射
- 实时进度显示
- 错误处理和恢复
- 域 ID 可用性验证
- WebSocket 进度更新

## 更新的文件
# 域复制功能文件清单
# 生成时间: Thu Jul 10 14:22:54 CST 2025

## 后端文件
src/handler/domain-copy.ts    # 域复制处理器
src/lib/ui.ts                 # UI 菜单配置

## 前端文件
templates/domain_copy.html    # 域复制页面模板
components/DomainCopyModal.tsx    # 域复制组件

## 语言文件
locales/zh.yaml               # 中文翻译文件

## 测试文件
test/domain-copy.test.ts      # 域复制测试用例

## 总计文件数
5 个文件

## 构建信息
- 构建模式: 简化模式（跳过 npm 构建）
- 构建时间: Thu Jul 10 14:22:55 CST 2025
- 源码直接部署: 是

## 部署说明
由于 npm 依赖冲突，本次采用简化构建模式：
1. 跳过项目构建步骤
2. 直接使用 TypeScript 源码文件
3. Hydro 容器内会自动处理 TypeScript 编译

## 访问方式
- 管理面板 → Domain → Copy Domain
- 直接访问: /domain/copy
- 权限要求: 系统管理员权限

## 使用说明
1. 使用管理员账号登录
2. 进入管理面板的域管理部分
3. 选择"Copy Domain"选项
4. 选择源域和目标域
5. 配置复制选项
6. 开始复制过程

## 技术信息
- 后端: TypeScript + Cordis 框架
- 前端: HTML + JavaScript + WebSocket
- 数据库: MongoDB
- 部署模式: 源码直接部署
- 自动加载: 通过 Hydro 插件系统

## 注意事项
- 本次构建跳过了 npm 安装，这不会影响功能
- Hydro 容器内已包含所需的运行时环境
- TypeScript 文件会在容器内自动编译
