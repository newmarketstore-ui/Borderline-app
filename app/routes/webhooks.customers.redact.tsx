import type { ActionFunctionArgs } from "react-router";
import { landWebhook } from "../models/webhookEvents.server";

// customers/redact：校验 HMAC → 落库 WebhookEvent（webhookId 去重）→ 入队 → 立即 200。处理逻辑见 app/models/webhookEvents.server.ts
export const action = async ({ request }: ActionFunctionArgs) => landWebhook(request);
