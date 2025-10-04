sudo cp /etc/apt/sources.list /etc/apt/sources.list.bak
sudo echo "deb http://mirrors.aliyun.com/ubuntu/ jammy main restricted universe multiverse" > /etc/apt/sources.list
sudo echo "deb http://mirrors.aliyun.com/ubuntu/ jammy-security main restricted universe multiverse" >> /etc/apt/sources.list
sudo echo "deb http://mirrors.aliyun.com/ubuntu/ jammy-updates main restricted universe multiverse" >> /etc/apt/sources.list
sudo echo "deb http://mirrors.aliyun.com/ubuntu/ jammy-backports main restricted universe multiverse" >> /etc/apt/sources.list


#ubuntu 24
sudo cp /etc/apt/sources.list.d/ubuntu.sources /etc/apt/sources.list.d/ubuntu.sources.bak
sudo nano /etc/apt/sources.list.d/ubuntu.sources
Types: deb
URIs: https://mirrors.aliyun.com/ubuntu/
Suites: noble noble-security noble-updates noble-proposed noble-backports
Components: main restricted universe multiverse
Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg

Types: deb-src
URIs: https://mirrors.aliyun.com/ubuntu/
Suites: noble noble-security noble-updates noble-proposed noble-backports
Components: main restricted universe multiverse
Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg

sudo apt-get update
sudo apt-get install -y \
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
jq 

#安装node
sudo rm -rf /var/lib/apt/lists/*
curl -sL https://deb.nodesource.com/setup_lts.x | sudo -E bash -
sudo apt-get install nodejs -y


#安装docker(ubuntu22)
sudo apt install apt-transport-https ca-certificates curl software-properties-common
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /usr/share/keyrings/docker-archive-keyring.gpg
echo \
  "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/docker-archive-keyring.gpg] https://download.docker.com/linux/ubuntu \
  jammy stable" | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
  
#安装docker （ubuntu24）  
sudo apt install -y ca-certificates curl gnupg
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
sudo chmod a+r /etc/apt/keyrings/docker.gpg
echo \
  "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu \
  $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | \
  sudo tee /etc/apt/sources.list.d/docker.list > /dev/null

sudo apt update
sudo apt install docker-ce docker-ce-cli containerd.io
sudo systemctl start docker
sudo systemctl enable docker

sudo usermod -aG docker $USER
newgrp docker  # 立即生效（或重新登录）

#安装claude
echo "export http_proxy=http://192.168.52.1:7890" >> ~/.bashrc
echo "export https_proxy=http://192.168.52.1:7890" >> ~/.bashrc
npm i -g @anthropic-ai/claude-code

#安装JAVA 17环境
sudo apt install -y openjdk-17-jdk maven

#安装mcp
sudo npm install -g @upstash/context7-mcp
sudo -S PUPPETEER_SKIP_DOWNLOAD=true npm install -g @kirkdeam/puppeteer-mcp-server
sudo -S apt install -y chromium-browser
claude mcp add context7 "npx" "@upstash/context7-mcp"
claude mcp add puppeteer "npx" "@kirkdeam/puppeteer-mcp-server"

