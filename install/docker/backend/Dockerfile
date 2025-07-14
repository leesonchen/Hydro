FROM node:20

# Install MongoDB client tools
RUN apt-get update && \
    apt-get install -y gnupg wget && \
    wget -qO - https://www.mongodb.org/static/pgp/server-6.0.asc | apt-key add - && \
    echo "deb [ arch=amd64,arm64 ] https://repo.mongodb.org/apt/ubuntu jammy/mongodb-org/6.0 multiverse" | tee /etc/apt/sources.list.d/mongodb-org-6.0.list && \
    apt-get update && \
    apt-get install -y mongodb-database-tools && \
    rm -rf /var/lib/apt/lists/*

COPY ./entrypoint.sh /root/entrypoint.sh

RUN yarn global add pm2 hydrooj @hydrooj/ui-default && \
    chmod +x /root/entrypoint.sh && \
    mkdir -p /root/.hydro

ENTRYPOINT ["/root/entrypoint.sh"]