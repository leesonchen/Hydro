# Hydro 源码部署完整指南

## 当前状态

✅ **已完成（ubuntu 账号）**：
- 1. 一键安装脚本执行完成
- 2. 源码编译环境准备完成
- 3. TypeScript 后端代码编译完成（虽然有类型警告，但不影响运行）
- 4. UI 构建正在进行中（预计 5-10 分钟）

⏳ **待完成（需要 root 账号）**：
- 5. 替换全局包为本地源码
- 6. 重启服务并验证

---

## 部署步骤（root 账号执行）

### 步骤 1: 等待 UI 构建完成

在 ubuntu 账号下检查 UI 构建状态：

```bash
# 检查构建进程
ps aux | grep "build:ui:dev" | grep -v grep

# 如果没有输出，说明构建已完成
# 也可以查看构建输出
ls -lh packages/ui-default/public/
```

### 步骤 2: 切换到 root 账号

```bash
sudo su
cd /home/ubuntu/Hydro
```

### 步骤 3: 执行替换脚本

```bash
# 执行源码替换脚本
./deploy-replace.sh
```

**脚本会自动完成**：
- 备份原有的全局 Hydro 包
- 创建 symlink 指向本地源码
- 运行 yarn install 处理依赖
- 重启所有 Hydro 服务
- 显示服务状态

### 步骤 4: 验证部署

```bash
# 运行验证脚本
./verify-deployment.sh
```

### 步骤 5: 功能测试

浏览器访问 `http://服务器IP`，测试：
- [ ] 用户注册/登录
- [ ] 创建题目
- [ ] 提交代码
- [ ] 评测运行
- [ ] 比赛创建

---

## 脚本说明

### 1. deploy-replace.sh（部署脚本）

**功能**：将 Yarn 全局安装的 Hydro 包替换为本地源码

**执行内容**：
- 备份 hydrooj, @hydrooj/ui-default, @hydrooj/hydrojudge
- 创建 symlink 到 /home/ubuntu/Hydro/packages/*
- 运行 yarn install 处理 workspace 依赖
- 重启 PM2 服务

**使用方法**：
```bash
sudo su
./deploy-replace.sh
```

### 2. rollback.sh（回滚脚本）

**功能**：如果部署失败，恢复到替换前的状态

**执行内容**：
- 停止 Hydro 服务
- 删除 symlink
- 恢复备份的原有包
- 重启服务

**使用方法**：
```bash
sudo su
./rollback.sh
```

### 3. verify-deployment.sh（验证脚本）

**功能**：检查部署是否成功

**检查项目**：
- PM2 服务状态
- 模块路径（应该指向本地源码）
- 配置文件完整性
- Web 访问测试
- 日志检查

**使用方法**：
```bash
./verify-deployment.sh
```

---

## 常见问题排查

### 问题 1: UI 构建失败

**症状**：UI 构建进程一直运行或报错

**解决方案**：
```bash
# 清理���存重新构建
rm -rf packages/ui-default/.cache
rm -rf node_modules/.cache

# 重新构建
yarn build:ui:dev
```

### 问题 2: 模块加载失败

**症状**：PM2 日志显示 "Cannot find module"

**解决方案**：
```bash
# 确认 yarn install 已执行
cd /home/ubuntu/Hydro
yarn install

# 重启服务
pm2 restart hydrooj
```

### 问题 3: 权限问题

**症状**：无法访问 /home/ubuntu/Hydro 目录

**解决方案**：
```bash
# 方案 1: 修改目录所有者为 root
sudo chown -R root:root /home/ubuntu/Hydro

# 方案 2: 给其他用户添加读取权限
sudo chmod -R o+rX /home/ubuntu/Hydro
```

### 问题 4: 服务无法启动

**症状**：PM2 显示服务 errored 或 stopped

**解决方案**：
```bash
# 查看详细错误日志
pm2 logs hydrooj --err --lines 100

# 检查数据库连接
cat ~/.hydro/config.json

# 测试数据库连接
mongosh "mongodb://hydro:<密码>@127.0.0.1:27017/hydro"
```

---

## 开发工作流程

部署成功后，修改代码的流程：

```bash
# 1. 修改源码
cd /home/ubuntu/Hydro
# ... 编辑文件 ...

# 2. 如果修改了 TypeScript，重新编译
yarn build

# 3. 如果修改了 UI，重新构建
yarn build:ui:dev

# 4. 重启服务
pm2 restart hydrooj

# 5. 查看日志
pm2 logs hydrooj
```

---

## 关键路径

**源码目录**：
- `/home/ubuntu/Hydro/` - 项目根目录
- `/home/ubuntu/Hydro/packages/hydrooj/` - 核心包
- `/home/ubuntu/Hydro/packages/ui-default/` - UI 包
- `/home/ubuntu/Hydro/packages/hydrojudge/` - 评测机包

**全局目录（root）**：
- `/root/.config/yarn/global/node_modules/` - Yarn 全局包
- 或 `/usr/local/share/.config/yarn/global/node_modules/`

**配置和数据**：
- `~/.hydro/config.json` - 数据库连接
- `~/.hydro/addon.json` - 插件列表
- `~/.hydro/judge.yaml` - 评测机配置
- `/data/db` - MongoDB 数据
- `/data/file` - 文件存储

---

## 成功标志

部署成功的标志：

1. ✅ PM2 显示所有服务 online
   ```bash
   pm2 status
   ```

2. ✅ 模块路径指向本地源码
   ```bash
   ls -la $(which hydrooj)
   # 应该显示: /usr/local/bin/hydrooj -> /home/ubuntu/Hydro/packages/hydrooj/bin/hydrooj.js
   ```

3. ✅ 可以通过浏览器访问系统
   ```
   http://服务器IP
   ```

4. ✅ 日志中没有模块加载错误
   ```bash
   pm2 logs hydrooj --lines 50
   ```

5. ✅ 功能正常：用户登录、创建题目、提交代码

---

## 时间估算

- UI 构建：5-10 分钟
- 执行替换脚本：2 分钟
- 验证和测试：5 分钟
- **总计：约 15-20 分钟**

---

## 下一步

1. 等待 UI 构建完成（检查进程）
2. 切���到 root 账号
3. 执行 `./deploy-replace.sh`
4. 执行 `./verify-deployment.sh`
5. 浏览器功能测试

如有问题，请查看日志或执行回滚脚本。