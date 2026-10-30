// Klaviyo 事件（老板 10/30 定通知走 Klaviyo）：我们只推"事件 + 属性"，短信 / 邮件模板与退订合规在 Klaviyo 里配 Flow。
// 没有 KLAVIYO_PRIVATE_KEY 时只记日志，不报错（上线前可先跑通流程）。
// 事件名：Service Received / Service Ready / Service Delayed / Service Reminder（Klaviyo 里按这些名字建 Flow）。

const KLAVIYO_REVISION = "2026-01-15";

export type KlaviyoProfile = { email?: string | null; phone?: string | null; firstName?: string | null; lastName?: string | null };

export function klaviyoConfigured(): boolean {
  return Boolean(process.env.KLAVIYO_PRIVATE_KEY);
}

/** 返回 {ok, skipped, error}。电话要 E.164（+1…）。 */
export async function sendKlaviyoEvent(
  metricName: string,
  profile: KlaviyoProfile,
  properties: Record<string, unknown>,
  uniqueId?: string,
): Promise<{ ok: boolean; skipped: boolean; error?: string }> {
  const key = process.env.KLAVIYO_PRIVATE_KEY;
  const attrs: Record<string, unknown> = {};
  if (profile.email) attrs.email = profile.email;
  if (profile.phone) attrs.phone_number = profile.phone.startsWith("+") ? profile.phone : `+${profile.phone.replace(/\D/g, "")}`;
  if (profile.firstName) attrs.first_name = profile.firstName;
  if (profile.lastName) attrs.last_name = profile.lastName;
  if (!attrs.email && !attrs.phone_number) return { ok: false, skipped: true, error: "no email or phone" };
  if (!key) {
    console.log(`[klaviyo] (not configured) would send ${metricName} to ${attrs.email ?? attrs.phone_number}`);
    return { ok: false, skipped: true, error: "KLAVIYO_PRIVATE_KEY not set" };
  }
  const body = {
    data: {
      type: "event",
      attributes: {
        properties,
        ...(uniqueId ? { unique_id: uniqueId } : {}),
        metric: { data: { type: "metric", attributes: { name: metricName } } },
        profile: { data: { type: "profile", attributes: attrs } },
      },
    },
  };
  try {
    const res = await fetch("https://a.klaviyo.com/api/events", {
      method: "POST",
      headers: {
        Authorization: `Klaviyo-API-Key ${key}`,
        accept: "application/vnd.api+json",
        "content-type": "application/vnd.api+json",
        revision: KLAVIYO_REVISION,
      },
      body: JSON.stringify(body),
    });
    if (res.status === 202 || res.ok) return { ok: true, skipped: false };
    const text = await res.text().catch(() => "");
    return { ok: false, skipped: false, error: `HTTP ${res.status} ${text.slice(0, 200)}` };
  } catch (e) {
    return { ok: false, skipped: false, error: (e as Error).message };
  }
}
