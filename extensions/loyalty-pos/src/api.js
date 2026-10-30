// POS 扩展 → 我们后端。APP_URL 在部署到 DigitalOcean 后改成正式域名（见 DEPLOY.md 第 3 步），然后 `shopify app deploy`。
export const APP_URL = "https://borderline-app-lntir.ondigitalocean.app";

async function authHeaders() {
  const token = await shopify.session.getSessionToken();
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

async function call(path, init) {
  const res = await fetch(`${APP_URL}${path}`, { ...init, headers: await authHeaders() });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

export const getMember = (customerId) =>
  call(`/api/pos/member?customerId=${encodeURIComponent(customerId)}&channel=pos`);

/** mode: "store_credit" | "cart_discount"；maxAmountCents 只在 cart_discount 下传（购物车小计，分） */
export const redeem = (customerId, points, idempotencyKey, mode, maxAmountCents) =>
  call(`/api/pos/redeem`, {
    method: "POST",
    body: JSON.stringify({ customerId, points, idempotencyKey, mode, maxAmountCents }),
  });

/** 抵扣已扣分但 POS 套不上折扣 → 立刻退分 */
export const release = (redemptionId) =>
  call(`/api/pos/release`, { method: "POST", body: JSON.stringify({ redemptionId }) });

export const orderEarned = (orderId) => call(`/api/pos/order?orderId=${encodeURIComponent(orderId)}`);

export const newKey = () =>
  (globalThis.crypto && crypto.randomUUID ? crypto.randomUUID() : `k${Date.now()}${Math.random().toString(36).slice(2)}`).replace(/[^0-9a-zA-Z_-]/g, "");

export const money = (cents) => `$${(cents / 100).toFixed(2)}`;
/** POS 的金额字符串（"123.45"）→ 分 */
export const toCents = (s) => Math.round(Number(String(s ?? "0").replace(/[^0-9.-]/g, "")) * 100) || 0;
