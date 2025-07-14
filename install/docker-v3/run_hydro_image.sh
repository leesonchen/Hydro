docker run -d --name hydro2  -p 27017:27017 -p 8082:80 -v ./hydro-data:/data-host -v ./hydro-logs:/var/log/hydro -v /dev/shm:/dev/shm hydro-leeson:v1.0

docker run -d `
  --name hydro `
  --hostname hydro `
  --privileged `
  -p "8082:80" `
  -p "27017:27017" `
  -e "LANG=zh_CN.UTF-8" `
  -e "LC_ALL=zh_CN.UTF-8" `
  -e "TZ=Asia/Shanghai" `
  -e "HOME=/root" `
  -e "USER=root" `
  -e "IGNORE_BT=1" `
  -e "IGNORE_CENTOS=1" `
  -e "REGION=CN" `
  --restart unless-stopped `
  --health-cmd "curl -f http://localhost:80/" `
  --health-interval 60s `
  --health-timeout 30s `
  --health-retries 5 `
  --health-start-period 600s `
  --tmpfs /run `
  --tmpfs /run/lock `
  --memory="4g" `
  --memory-swap="4g" `
  --cpus="2" `
  --cap-add SYS_ADMIN `
  --cap-add NET_ADMIN `
  --cap-add SYS_PTRACE `
  --security-opt "seccomp:unconfined" `
  -v "./hydro-data:/data-host" `
  -v "./hydro-logs:/var/log/hydro" `
  hydro-leeson:v1.0