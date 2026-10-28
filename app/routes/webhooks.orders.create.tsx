import type { ActionFunctionArgs } from "react-router";
import { landWebhook } from "../models/webhookEvents.server";

// orders/create：只落库（不计分，计分走 orders/paid），校验 HMAC + webhookId 去重后立即 200。处理逻辑见 app/models/webhookEvents.server.ts
export const action = async ({ request }: ActionFunctionArgs) => landWebhook(request);
