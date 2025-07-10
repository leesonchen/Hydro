# 🚀 Hydro 域复制功能快速部署

## 一键部署（推荐）
```bash
cd /mnt/d/work/Hydro/install/docker-v3
./deploy-domain-copy.sh
```

## 分步部署
```bash
# 1. 构建（如果依赖冲突，会自动使用简化构建）
./build-hydro.sh
# 或直接使用简化构建
./build-simple.sh

# 2. 更新
./update-hydro.sh

# 3. 验证
./verify-domain-copy.sh
```

## 访问地址
- 系统主页: http://localhost:8082/
- 管理面板: http://localhost:8082/manage
- 域复制: http://localhost:8082/domain/copy

## 使用步骤
1. 管理员登录
2. 管理面板 → Domain → Copy Domain
3. 选择源域和目标域
4. 配置复制选项
5. 开始复制

## 故障排除
```bash
# 检查容器
docker ps | grep hydro

# 检查服务
docker exec hydro pm2 list

# 查看日志
docker logs hydro
```

## 文件说明
- `deploy-domain-copy.sh` - 一键部署脚本
- `build-hydro.sh` - 构建脚本
- `update-hydro.sh` - 更新脚本
- `verify-domain-copy.sh` - 验证脚本
- `README-DOMAIN-COPY.md` - 详细文档

---
需要帮助？查看 `README-DOMAIN-COPY.md` 获取详细说明。