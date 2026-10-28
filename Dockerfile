FROM node:20-alpine
RUN apk add --no-cache openssl

EXPOSE 3000

WORKDIR /app

ENV NODE_ENV=production

COPY package.json package-lock.json* ./

# 注意：build（react-router build）需要 vite 等 devDependencies，所以这里装全部依赖。
# --omit=optional：跳过 embedded-postgres 的平台二进制（只用于本地验证），镜像更小
RUN npm ci --omit=optional && npm cache clean --force

COPY . .

RUN npm run build

CMD ["npm", "run", "docker-start"]
