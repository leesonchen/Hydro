#!/bin/bash
# 验证 Verdaccio 修复是否成功
# 在开发服务器（当前服务器）上执行

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo -e "${GREEN}=== 验证 Verdaccio 修复 ===${NC}"
echo ""

# 1. 检查 tarball URL
echo -e "${YELLOW}1. 检查包的 tarball URL...${NC}"
TARBALL_URL=$(npm view hydrooj@dev dist.tarball --registry https://npm.leeson.top/ 2>&1 | grep -v warn)

echo "   当前 URL: $TARBALL_URL"
echo ""

if [[ "$TARBALL_URL" == https://npm.leeson.top/* ]]; then
    echo -e "${GREEN}✓ URL 正确！Verdaccio 配置已修复${NC}"
    echo ""

    echo -e "${YELLOW}2. 准备重新发布所有包...${NC}"
    echo "   这将使用正确的 URL 重新发布所有包"
    echo ""
    read -p "   是否继续？(y/n) " -n 1 -r
    echo ""

    if [[ $REPLY =~ ^[Yy]$ ]]; then
        echo -e "${GREEN}开始重新发布...${NC}"
        cd /home/ubuntu/Hydro
        ./build-and-publish-dev.sh

        echo ""
        echo -e "${YELLOW}3. 验证新发布的包...${NC}"
        sleep 2

        NEW_TARBALL=$(npm view hydrooj@dev dist.tarball --registry https://npm.leeson.top/ 2>&1 | grep -v warn)
        echo "   新包 URL: $NEW_TARBALL"

        if [[ "$NEW_TARBALL" == https://npm.leeson.top/* ]]; then
            echo -e "${GREEN}✓ 验证成功！${NC}"
            echo ""
            echo -e "${YELLOW}4. 现在可以测试安装...${NC}"
            echo "   执行: ./packages/hydrooj/bin/install-dev-from-private-npm.sh"
        else
            echo -e "${RED}✗ 验证失败，URL 仍然不正确${NC}"
        fi
    else
        echo "已取消"
    fi

elif [[ "$TARBALL_URL" == http://localhost:4873/* ]]; then
    echo -e "${RED}✗ URL 仍然错误！${NC}"
    echo ""
    echo "Verdaccio 配置可能未正确修复，请检查："
    echo "1. 是否在 config.yaml 中添加了 url_prefix: https://npm.leeson.top/"
    echo "2. 是否重启了 Verdaccio 服务"
    echo "3. 查看 Verdaccio 日志: pm2 logs verdaccio"
    echo ""
    exit 1
else
    echo -e "${YELLOW}⚠ 无法获取 tarball URL${NC}"
    echo "请检查网络连接和 npm registry 配置"
    exit 1
fi
