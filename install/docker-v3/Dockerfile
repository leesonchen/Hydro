FROM ubuntu:22.04

# 设置环境变量 - 修复Nix安装的关键问题
ENV DEBIAN_FRONTEND=noninteractive
ENV LANG=zh_CN.UTF-8
ENV LC_ALL=zh_CN.UTF-8
ENV TZ=Asia/Shanghai
ENV HOME=/root
ENV USER=root

# # 配置国内镜像源
RUN cp /etc/apt/sources.list /etc/apt/sources.list.bak && \
    echo "deb http://mirrors.aliyun.com/ubuntu/ jammy main restricted universe multiverse" > /etc/apt/sources.list && \
    echo "deb http://mirrors.aliyun.com/ubuntu/ jammy-security main restricted universe multiverse" >> /etc/apt/sources.list && \
    echo "deb http://mirrors.aliyun.com/ubuntu/ jammy-updates main restricted universe multiverse" >> /etc/apt/sources.list && \
    echo "deb http://mirrors.aliyun.com/ubuntu/ jammy-backports main restricted universe multiverse" >> /etc/apt/sources.list

# # 安装基础工具
RUN apt-get update && apt-get install -y \
    curl \
    wget \
    ca-certificates \
    locales \
    tzdata \
    sudo \
    systemd \
    init \
    procps \
    git \
    vim \
    net-tools \
    htop \
    tree \
    build-essential \
    jq \
    && rm -rf /var/lib/apt/lists/*

# # 设置中文locale
RUN sed -i '/zh_CN.UTF-8/s/^# //g' /etc/locale.gen && \
    locale-gen

# 创建必要目录
RUN mkdir -p /data/db /data/file /tmp /root/.hydro \
    /data-host /root/.hydro-host /var/log/hydro /var/lib/mongodb


# 安装 Nix (下载、执行安装脚本，然后安装Nix包)
RUN echo "⬇️ 下载并运行 Nix 安装脚本..." && \
    curl -fsSL https://hydro.ac/nix.sh -o /tmp/nix.sh && \
    chmod +x /tmp/nix.sh && \
    /tmp/nix.sh --no-daemon && \
    echo "🔧 安装 Nix 环境包 (nodejs, coreutils, qrencode)..." && \
    # 确保在同一层中source Nix环境，以便nix-env命令可用
    . /root/.nix-profile/etc/profile.d/nix.sh && \
    nix-env -iA nixpkgs.nodejs nixpkgs.coreutils nixpkgs.qrencode

# 设置 PATH 环境变量，确保 Nix 工具在后续 RUN 命令和容器运行时可用
ENV PATH="/root/.nix-profile/bin:$PATH"

# 下载并运行 Hydro 安装脚本来安装 Hydro (这会创建 /root/.hydro 内容并安装 pm2)
RUN echo "⬇️ 下载并运行 Hydro 安装脚本..." && \
    curl -fsSL https://hydro.ac/setup.sh -o /tmp/hydro-setup.sh && \
    chmod +x /tmp/hydro-setup.sh && \
    echo "🔧 开始安装 Hydro..." && \
    LANG=zh bash /tmp/hydro-setup.sh

# 保存 PM2 进程列表到镜像中，以便在容器启动时可以恢复
RUN if command -v pm2 >/dev/null 2>&1; then \
    echo "✅ 保存 PM2 进程列表到镜像..."; \
    pm2 save; \
    else \
    echo "⚠️ PM2 未找到，跳过保存进程列表."; \
    fi

# 复制启动脚本
COPY start-hydro.sh /start.sh
RUN chmod +x /start.sh

# 暴露端口
EXPOSE 80 8888 27017

# 设置工作目录
WORKDIR /root

# 启动脚本
CMD ["/start.sh"]