# Hydro 手动安装调试环境

## 📋 目录结构
```
docker-v2/
├── Dockerfile.ubuntu-base     # 基础Ubuntu镜像（仅调试用）
├── Dockerfile.hydro-auto     # 自动安装Hydro的镜像（修复版）
├── docker-compose.yml        # 基础调试容器配置
├── docker-compose.auto.yml   # 自动安装Hydro配置
├── start-debug.sh           # 快速启动调试脚本
├── start-hydro-fixed.sh     # 修复版Hydro安装脚本
└── README.md               # 本说明文档
```

## 🐛 **问题修复说明**

### **发现的关键问题：`nix-channel: command not found`**

**根本原因：** Docker容器中缺少 `HOME` 和 `USER` 环境变量，导致 Nix 的 `nix.sh` 脚本条件检查失败，PATH 没有被正确设置。

**解决方案：** 
1. 在 Dockerfile 中明确设置 `ENV HOME=/root` 和 `ENV USER=root`
2. 在启动脚本中确保这些变量被正确导出
3. 手动 source nix.sh 确保环境变量生效

### **新增功能：外部访问和目录映射**

#### **MongoDB 外部访问修复**
- **问题**：MongoDB 默认监听 `127.0.0.1:27017`，容器外无法访问
- **解决**：自动修改 MongoDB 配置为监听 `0.0.0.0:27017`
- **方法**：多种配置文件路径检查，PM2 进程重启，后台监控修复

#### **本地目录映射**
- **功能**：添加 bind mount 映射，方便容器外访问数据
- **映射关系**：
  ```
  ./hydro-data/     -> /data-host          (数据文件)
  ./hydro-config/   -> /root/.hydro-host   (配置文件)
  ./hydro-logs/     -> /var/log/hydro      (日志文件)
  ./hydro-problems/ -> /data/file          (题目文件)
  ./hydro-db/       -> /var/lib/mongodb    (数据库文件)
  ```

## 🚀 快速开始

### **选项1：自动安装Hydro（推荐）**
```bash
# 1. 准备本地目录
./prepare-host-dirs.sh

# 2. 构建并启动
docker-compose -f docker-compose.auto.yml up -d --build

# 3. 查看日志
docker logs hydro-auto -f

# 4. 测试全部功能
./test-fix.sh
```

### **选项2：手动调试安装**
```bash
# 方式1: 使用启动脚本
chmod +x start-debug.sh
./start-debug.sh

# 方式2: 手动启动
docker-compose up -d --build
```

### 2. 进入容器
```bash
docker exec -it hydro-debug bash
```

### 3. 手动安装 Hydro
在容器内执行以下命令进行调试：

```bash
# 基础环境检查
echo "=== 检查基础环境 ==="
which curl wget git
cat /etc/os-release

# 下载安装脚本
echo "=== 下载 Hydro 安装脚本 ==="
curl -fsSL https://hydro.ac/setup.sh -o /tmp/hydro-setup.sh
chmod +x /tmp/hydro-setup.sh

# 设置环境变量
export IGNORE_BT=1
export IGNORE_CENTOS=1
export REGION=CN
export HOME=/root

# 执行安装（可以分步调试）
echo "=== 开始安装 Hydro ==="
LANG=zh bash /tmp/hydro-setup.sh
```

## 🔍 调试技巧

### 监控安装过程
```bash
# 在另一个终端窗口中实时查看日志
docker logs hydro-debug --follow

# 检查网络连接
docker exec hydro-debug curl -I https://hydro.ac/
docker exec hydro-debug curl -I https://mirror.nju.edu.cn/

# 检查系统状态
docker exec hydro-debug htop
docker exec hydro-debug df -h
docker exec hydro-debug free -h
```

### 常见问题排查

#### 1. Nix 安装失败
```bash
# 检查符号链接问题
ls -la ~/.nix-profile
rm -rf ~/.nix-profile
mkdir -p ~/.nix-profile/bin

# 手动安装 Nix
curl -L https://nixos.org/nix/install | sh
source ~/.nix-profile/etc/profile.d/nix.sh
```

#### 2. 网络连接问题
```bash
# 测试各个镜像源
curl -I https://mirror.nju.edu.cn/
curl -I https://mirrors.tuna.tsinghua.edu.cn/
curl -I https://mirrors.aliyun.com/

# 配置 DNS
echo "nameserver 8.8.8.8" >> /etc/resolv.conf
```

#### 3. 权限问题
```bash
# 检查当前用户
whoami
id

# 检查目录权限
ls -la /nix /root/.hydro /data
```

## 📝 记录调试过程

### 成功安装后的步骤
1. 记录所有执行的命令
2. 检查安装后的目录结构：
   ```bash
   tree /root/.hydro
   pm2 list
   which hydrooj hydrojudge
   ```
3. 测试服务状态：
   ```bash
   curl -I http://localhost:80/
   curl -I http://localhost:8888/
   ```

### 创建最终的 Dockerfile
基于成功的手动安装过程，更新 Dockerfile 来自动化安装。

## 🛠️ 管理命令

```bash
# 查看容器状态
docker-compose ps

# 重启容器
docker-compose restart

# 停止并删除容器
docker-compose down

# 查看资源使用
docker stats hydro-debug

# 清理所有数据（谨慎使用）
docker-compose down -v
docker system prune -f
```

## 🔗 相关链接
- [Hydro 官方文档](https://hydro.ac/)
- [Hydro 安装脚本](https://hydro.ac/setup.sh)
- [Docker 官方文档](https://docs.docker.com/) 