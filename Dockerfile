FROM node:20-alpine
RUN apk add --no-cache openssl

EXPOSE 3000

WORKDIR /app

ENV NODE_ENV=production

COPY package.json package-lock.json* ./

# 注意：build（react-router build）需要 vite 等 devDependencies，所以这里装全部依赖。
RUN npm ci && npm cache clean --force

COPY . .

RUN npm run build

CMD ["npm", "run", "docker-start"]
