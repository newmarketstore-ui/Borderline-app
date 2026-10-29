// POS 扩展 → 我们后端。APP_URL 在部署到 DigitalOcean 后改成正式域名（见 DEPLOY.md 第 3 步），然后 `shopify app deploy`。
export const APP_URL = "https://borderline-ai.fly.dev";

async function authHeaders() {
  const token = await shopify.session.getSessionToken();
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

export async function getMember(customerId) {
  const res = await fetch(`${APP_URL}/api/pos/member?customerId=${encodeURIComponent(customerId)}&channel=pos`, {
    headers: await authHeaders(),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

export async function redeem(customerId, points, idempotencyKey) {
  const res = await fetch(`${APP_URL}/api/pos/redeem`, {
    method: "POST",
    headers: await authHeaders(),
    body: JSON.stringify({ customerId, points, idempotencyKey }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

export async function orderEarned(orderId) {
  const res = await fetch(`${APP_URL}/api/pos/order?orderId=${encodeURIComponent(orderId)}`, {
    headers: await authHeaders(),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

export const newKey = () =>
  (globalThis.crypto && crypto.randomUUID ? crypto.randomUUID() : `k${Date.now()}${Math.random().toString(36).slice(2)}`).replace(/[^0-9a-zA-Z_-]/g, "");

export const money = (cents) => `$${(cents / 100).toFixed(2)}`;
