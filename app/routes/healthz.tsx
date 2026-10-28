// 平台健康检查（DigitalOcean App Platform / 监控）。不鉴权，不碰数据库，只证明进程活着。
export const loader = () =>
  new Response("ok", { status: 200, headers: { "content-type": "text/plain" } });
