FROM node:22-alpine

# 作業ディレクトリを作成
WORKDIR /usr/src/app


# package.jsonとpackage-lock.jsonをコピー
COPY /app/package*.json ./


# 依存関係をインストール
RUN npm install

# アプリケーションコードをコピー
COPY . .


# Expose the internal port
EXPOSE 3000

# アプリを開発モードで起動
CMD ["npm", "start"]


