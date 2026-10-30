// 顾客账户扩展 → 我们后端。APP_URL 部署后改成正式域名（DEPLOY.md 第 3 步）。
export const APP_URL = "https://borderline-app-lntir.ondigitalocean.app";

async function authHeaders() {
  const token = await shopify.sessionToken.get();
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

export async function getMe() {
  const res = await fetch(`${APP_URL}/api/account/me`, { headers: await authHeaders() });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

export async function redeem(points, idempotencyKey) {
  const res = await fetch(`${APP_URL}/api/account/redeem`, {
    method: "POST",
    headers: await authHeaders(),
    body: JSON.stringify({ points, idempotencyKey }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

export const newKey = () =>
  (globalThis.crypto && crypto.randomUUID ? crypto.randomUUID() : `k${Date.now()}${Math.random().toString(36).slice(2)}`).replace(/[^0-9a-zA-Z_-]/g, "");
