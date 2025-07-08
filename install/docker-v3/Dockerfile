FROM ubuntu:22.04

# 设置环境变量 - 修复Nix安装的关键问题
ENV DEBIAN_FRONTEND=noninteractive
ENV LANG=zh_CN.UTF-8
ENV LC_ALL=zh_CN.UTF-8
ENV TZ=Asia/Shanghai
ENV HOME=/root
ENV USER=root

# 配置国内镜像源
RUN cp /etc/apt/sources.list /etc/apt/sources.list.bak && \
    echo "deb http://mirrors.aliyun.com/ubuntu/ jammy main restricted universe multiverse" > /etc/apt/sources.list && \
    echo "deb http://mirrors.aliyun.com/ubuntu/ jammy-security main restricted universe multiverse" >> /etc/apt/sources.list && \
    echo "deb http://mirrors.aliyun.com/ubuntu/ jammy-updates main restricted universe multiverse" >> /etc/apt/sources.list && \
    echo "deb http://mirrors.aliyun.com/ubuntu/ jammy-backports main restricted universe multiverse" >> /etc/apt/sources.list

# 安装基础工具
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

# 设置中文locale
RUN sed -i '/zh_CN.UTF-8/s/^# //g' /etc/locale.gen && \
    locale-gen

# 创建必要目录
RUN mkdir -p /data/db /data/file /tmp /root/.hydro \
    /data-host /root/.hydro-host /var/log/hydro /var/lib/mongodb

# 复制启动脚本
COPY start-hydro.sh /start.sh
RUN chmod +x /start.sh

# 暴露端口
EXPOSE 80 8888 27017

# 设置工作目录
WORKDIR /root

# 启动脚本
CMD ["/start.sh"] 