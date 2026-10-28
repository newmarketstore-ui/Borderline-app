import * as crypto from "node:crypto";

export type NotificationResult =
  | { ok: true; target: "wecom" | "hermes"; status: number }
  | { ok: false; target: "wecom" | "hermes"; status?: number; error: string };

async function postJson(url: string, payload: unknown, headers: Record<string, string> = {}) {
  const body = JSON.stringify(payload);
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...headers,
    },
    body,
  });
  const text = await response.text().catch(() => "");
  return { response, text, body };
}

export async function sendWecomMarkdown(content: string): Promise<NotificationResult | null> {
  const url = process.env.WECOM_REPORT_WEBHOOK_URL;
  if (!url) return null;

  try {
    const { response, text } = await postJson(url, {
      msgtype: "markdown",
      markdown: { content },
    });
    if (!response.ok) {
      return { ok: false, target: "wecom", status: response.status, error: text.slice(0, 500) };
    }
    return { ok: true, target: "wecom", status: response.status };
  } catch (error) {
    return {
      ok: false,
      target: "wecom",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function triggerHermesWebhook(payload: unknown): Promise<NotificationResult | null> {
  const url = process.env.HERMES_REPORT_WEBHOOK_URL;
  if (!url) return null;

  try {
    const body = JSON.stringify(payload);
    const headers: Record<string, string> = {};
    const secret = process.env.HERMES_REPORT_WEBHOOK_SECRET;
    if (secret) {
      const signature = crypto.createHmac("sha256", secret).update(body).digest("hex");
      headers["X-Hub-Signature-256"] = `sha256=${signature}`;
    }

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...headers,
      },
      body,
    });
    const text = await response.text().catch(() => "");
    if (!response.ok) {
      return { ok: false, target: "hermes", status: response.status, error: text.slice(0, 500) };
    }
    return { ok: true, target: "hermes", status: response.status };
  } catch (error) {
    return {
      ok: false,
      target: "hermes",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function sendReportNotifications(params: {
  markdown: string;
  payload: unknown;
}): Promise<NotificationResult[]> {
  // 门店日报需要由 Hermes Agent 做最终分析；Shopify App 只发送结构化数据给 Hermes。
  // 直接企业微信机器人发送保留为低层能力，但不在日报流程里使用，避免绕过 Hermes 分析。
  const hermes = await triggerHermesWebhook(params.payload);
  return hermes ? [hermes] : [];
}
