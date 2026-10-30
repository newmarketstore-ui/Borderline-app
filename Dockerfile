FROM node:20-alpine
RUN apk add --no-cache openssl

EXPOSE 3000

WORKDIR /app

ENV NODE_ENV=production

COPY package.json package-lock.json* ./

# 注意：build（react-router build）需要 vite 等 devDependencies，所以这里装全部依赖。
# 注意：不能加 --omit=optional，rollup / esbuild 的平台二进制也是 optional 依赖（10/29 DO 构建因此失败过）
RUN npm ci && npm cache clean --force

COPY . .

RUN npm run build

CMD ["npm", "run", "docker-start"]
