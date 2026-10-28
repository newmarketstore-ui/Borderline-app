import { defineConfig } from "vitest/config";

// 单测不加载 React Router 的 vite 插件（vite.config.ts 里那套只给 app 构建用）。
export default defineConfig({
  test: {
    include: ["app/**/*.test.ts"],
    environment: "node",
  },
});
