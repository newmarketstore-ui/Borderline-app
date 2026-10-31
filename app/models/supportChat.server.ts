// AI 客服一轮对话：Claude Sonnet（老板 10/31 定只用 Sonnet）+ 只读工具，手写循环（不依赖 beta runner）。
import Anthropic from "@anthropic-ai/sdk";

import { knowledgeBasePrompt, SUPPORT_RULES_PROMPT, turnContextText, type TurnContext } from "../lib/supportPrompt";
import { UI_TEXT, type SupportLocale, type UsageLike } from "../lib/supportRules";
import { getSupportConfig, listKb, type SupportConversation, type SupportMessage } from "./support.server";
import { runTool, SUPPORT_TOOLS, type ProductCard, type ToolContext, type ToolRun } from "./supportTools.server";

const MAX_TOOL_ROUNDS = 6;
const MAX_HISTORY = 30; // 条消息
const TOOL_RESULT_CHARS = 14_000;

let client: Anthropic | null = null;
function anthropic(): Anthropic {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY not set");
  if (!client) client = new Anthropic({ timeout: 50_000, maxRetries: 1 });
  return client;
}

export function assistantConfigured(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

export type TurnResult = {
  text: string;
  usage: UsageLike;
  model: string;
  tools: ToolRun[];
  cards: ProductCard[];
  stop: string;
  handoff: boolean;
  latencyMs: number;
};

function historyToMessages(history: SupportMessage[]): Anthropic.MessageParam[] {
  const out: Anthropic.MessageParam[] = [];
  for (const m of history.slice(-MAX_HISTORY)) {
    if (m.role === "system") continue;
    const role = m.role === "user" ? "user" : "assistant";
    const content = m.role === "staff" ? `[Reply sent by store staff] ${m.content}` : m.content;
    const last = out[out.length - 1];
    if (last && last.role === role && typeof last.content === "string") last.content = `${last.content}\n\n${content}`;
    else out.push({ role, content });
  }
  // 第一条必须是 user
  while (out.length && out[0].role !== "user") out.shift();
  return out;
}

function addUsage(a: UsageLike, b: Anthropic.Usage): UsageLike {
  return {
    input_tokens: a.input_tokens + b.input_tokens,
    output_tokens: a.output_tokens + b.output_tokens,
    cache_read_input_tokens: (a.cache_read_input_tokens ?? 0) + (b.cache_read_input_tokens ?? 0),
    cache_creation_input_tokens: (a.cache_creation_input_tokens ?? 0) + (b.cache_creation_input_tokens ?? 0),
  };
}

function todayLabel(d = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto", weekday: "long", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

export async function runAssistantTurn(p: {
  shop: string;
  conversation: SupportConversation;
  history: SupportMessage[]; // 不含这次的用户消息
  userText: string;
  locale: SupportLocale;
  customer: TurnContext["customer"];
}): Promise<TurnResult> {
  const t0 = Date.now();
  const [cfg, kb] = await Promise.all([getSupportConfig(p.shop), listKb(p.shop, { enabledOnly: true })]);
  const model = cfg.model || "claude-sonnet-5-5";
  const system: Anthropic.TextBlockParam[] = [
    { type: "text", text: SUPPORT_RULES_PROMPT + (cfg.extraPrompt?.trim() ? `\nAdditional store rules\n${cfg.extraPrompt.trim()}\n` : "") },
    { type: "text", text: knowledgeBasePrompt(kb), cache_control: { type: "ephemeral", ttl: "1h" } },
  ];
  const contactKnown = Boolean(p.conversation.email || p.conversation.phone);
  const ctxText = turnContextText({
    locale: p.locale,
    today: todayLabel(),
    pageUrl: p.conversation.pageUrl,
    productHandle: p.conversation.productHandle,
    customer: p.customer,
    conversationStatus: p.conversation.status,
    contactKnown,
  });
  const messages: Anthropic.MessageParam[] = [...historyToMessages(p.history), { role: "user", content: `${ctxText}\n\n${p.userText}` }];
  const toolCtx: ToolContext = { shop: p.shop, conversationId: p.conversation.id, customerGid: p.conversation.customerGid, memberId: p.conversation.memberId, contactKnown };

  let usage: UsageLike = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  const tools: ToolRun[] = [];
  let cards: ProductCard[] = [];
  let handoff = false;
  let stop = "";
  let text = "";

  for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
    const res = await anthropic().messages.create({
      model,
      max_tokens: 1500,
      system,
      tools: SUPPORT_TOOLS,
      messages,
      output_config: { effort: "low" },
    });
    usage = addUsage(usage, res.usage);
    stop = res.stop_reason ?? "";
    const texts = res.content.filter((b): b is Anthropic.TextBlock => b.type === "text").map((b) => b.text.trim()).filter(Boolean);
    if (texts.length) text = texts.join("\n\n");

    if (res.stop_reason === "refusal") {
      text = UI_TEXT[p.locale].handoff_ask_contact;
      break;
    }
    const toolUses = res.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
    if (res.stop_reason !== "tool_use" || !toolUses.length) break;
    if (round === MAX_TOOL_ROUNDS) break;

    messages.push({ role: "assistant", content: res.content });
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const tu of toolUses) {
      const input = (tu.input ?? {}) as Record<string, unknown>;
      const s = Date.now();
      let out: unknown;
      let ok = true;
      try {
        out = await runTool(toolCtx, tu.name, input);
        if (tu.name === "request_human") {
          handoff = true;
          toolCtx.contactKnown = contactKnown;
        }
        if (tu.name === "show_products" && out && typeof out === "object" && Array.isArray((out as { cards?: ProductCard[] }).cards)) cards = (out as { cards: ProductCard[] }).cards;
      } catch (e) {
        ok = false;
        out = { error: `Tool failed: ${(e as Error).message}. Tell the customer you could not check this right now and offer to hand off to staff.` };
      }
      const json = JSON.stringify(out);
      tools.push({ name: tu.name, input, ok, ms: Date.now() - s, summary: json.slice(0, 160) });
      results.push({ type: "tool_result", tool_use_id: tu.id, content: json.length > TOOL_RESULT_CHARS ? `${json.slice(0, TOOL_RESULT_CHARS)}…(truncated)` : json, is_error: !ok });
    }
    messages.push({ role: "user", content: results });
  }

  if (!text) text = UI_TEXT[p.locale].error;
  return { text, usage, model, tools, cards, stop, handoff, latencyMs: Date.now() - t0 };
}
