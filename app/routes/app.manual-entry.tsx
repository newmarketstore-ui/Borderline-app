import { useEffect, useRef, useState } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData, useNavigate } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { useAppBridge } from "@shopify/app-bridge-react";

import { requireModule } from "../models/modules.server";
import { authenticate } from "../shopify.server";
import { CHANNELS, TRAFFIC_FACTORS } from "../lib/channels";
import { torontoToday, torontoYesterday, isValidDate } from "../lib/dates";
import { getManualMetric, upsertManualMetric } from "../models/manualMetrics.server";
import { buildAndSendLocationStoreReport } from "../models/dailyStoreReport.server";
import { getOfflineAdmin } from "../models/shopAdmin.server";
import type { ManualMetricInput } from "../lib/metricValidation";

type LocationOption = { id: string; name: string };

// Polaris web component 事件：currentTarget 是对应的自定义元素
const fieldValue = (e: Event) => (e.currentTarget as HTMLInputElement).value;
const choiceValues = (e: Event) =>
  (e.currentTarget as unknown as { values: string[] }).values;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  // 在线 session 只用来认人 / 认店；读门店用店铺离线 token，不受当前员工后台权限影响
  const { session } = await authenticate.admin(request);
  await requireModule(session.shop, "store_metrics");
  const { admin } = await getOfflineAdmin(session.shop);

  const url = new URL(request.url);
  const businessDate = isValidDate(url.searchParams.get("date"))
    ? (url.searchParams.get("date") as string)
    : torontoYesterday();

  const locResp = await admin.graphql(
    `#graphql
    query AppLocations { locations(first: 50) { edges { node { id name } } } }`,
  );
  const locJson = await locResp.json();
  const locations: LocationOption[] = (locJson.data?.locations?.edges ?? []).map(
    (e: { node: LocationOption }) => ({ id: e.node.id, name: e.node.name }),
  );

  const locationId = url.searchParams.get("location") || locations[0]?.id || "";
  const existing = locationId
    ? await getManualMetric({ shopDomain: session.shop, businessDate, locationId })
    : null;

  return {
    shop: session.shop,
    locations,
    businessDate,
    locationId,
    today: torontoToday(),
    existing,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  await requireModule(session.shop, "store_metrics");
  const form = await request.formData();

  let input: ManualMetricInput;
  try {
    input = JSON.parse(String(form.get("payload")));
  } catch {
    return { ok: false as const, errors: ["提交数据格式错误"] };
  }

  const result = await upsertManualMetric({ shopDomain: session.shop, input });
  if (!result.ok) return { ok: false as const, errors: result.errors };

  let report:
    | { status: "sent"; locationName: string; notificationResults: Array<{ ok: boolean; target: string; status?: number; error?: string }> }
    | { status: "ready_no_target"; locationName: string }
    | { status: "error"; error: string };

  try {
    // 拉订单生成报告用店铺离线 token（不是当前员工的在线 token）
    const offline = (await getOfflineAdmin(session.shop)).session;
    if (!offline.accessToken) {
      report = { status: "error", error: "店铺离线 session 没有 accessToken，无法拉订单生成报告。" };
    } else {
      const reportResult = await buildAndSendLocationStoreReport({
        shopDomain: session.shop,
        accessToken: offline.accessToken,
        businessDate: input.businessDate,
        locationId: input.locationId,
        locationName: input.locationName,
      });

      if (reportResult.notificationResults.length === 0) {
        report = { status: "ready_no_target", locationName: reportResult.locationName };
      } else {
        report = {
          status: "sent",
          locationName: reportResult.locationName,
          notificationResults: reportResult.notificationResults,
        };
      }
    }
  } catch (error) {
    console.error("daily store report generation failed", error);
    report = {
      status: "error",
      error: error instanceof Error ? error.message : String(error),
    };
  }

  return { ok: true as const, savedAt: new Date().toISOString(), report };
};

type LoaderData = Awaited<ReturnType<typeof loader>>;

function initForm(existing: LoaderData["existing"]) {
  const channels: Record<string, string> = {};
  for (const c of CHANNELS) {
    channels[c.key] = existing ? String((existing as unknown as Record<string, unknown>)[c.field] ?? 0) : "";
  }
  return {
    storeVisitGroups: existing ? String(existing.storeVisitGroups ?? 0) : "",
    channels,
    trafficFactors: (existing?.trafficFactors as string[]) ?? [],
    notes: existing?.notes ?? "",
    recordedBy: existing?.submittedByName ?? "",
  };
}

export default function ManualEntry() {
  const data = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const navigate = useNavigate();
  const shopify = useAppBridge();

  const sig = `${data.businessDate}:${data.locationId}`;
  const prevSig = useRef(sig);
  const [form, setForm] = useState(() => initForm(data.existing));

  // 切换日期/门店导致 loader 数据变化时，用新数据重置表单
  useEffect(() => {
    if (prevSig.current !== sig) {
      setForm(initForm(data.existing));
      prevSig.current = sig;
    }
  }, [sig, data.existing]);

  const isSaving =
    fetcher.state !== "idle" && fetcher.formMethod === "POST";

  useEffect(() => {
    if (!fetcher.data?.ok) return;
    const report = fetcher.data.report;
    if (report?.status === "sent") {
      shopify.toast.show(`${report.locationName} 单店报告已交给 Hermes 分析并发送`);
    } else if (report?.status === "ready_no_target") {
      shopify.toast.show(`${report.locationName} 单店报告已生成，但还未配置 Hermes webhook`);
    } else if (report?.status === "error") {
      shopify.toast.show("已保存，但报告生成失败，请查看提示");
    } else {
      shopify.toast.show("已保存，今日日报会用到这份数据");
    }
  }, [fetcher.data, shopify]);

  const go = (date: string, location: string) =>
    navigate(`/app/manual-entry?date=${date}&location=${location}`);

  const knownTotal = CHANNELS.reduce(
    (s, c) => s + (Number(form.channels[c.key]) || 0),
    0,
  );
  const groups = Number(form.storeVisitGroups) || 0;
  const unknown = Math.max(0, groups - knownTotal);
  const overflow = knownTotal > groups;
  const isPastDate = data.businessDate < data.today;

  const setChannel = (key: string, value: string) =>
    setForm((f) => ({ ...f, channels: { ...f.channels, [key]: value } }));

  const save = () => {
    const payload: ManualMetricInput = {
      businessDate: data.businessDate,
      locationId: data.locationId,
      locationName:
        data.locations.find((l) => l.id === data.locationId)?.name ?? null,
      storeVisitGroups: groups,
      channels: Object.fromEntries(
        CHANNELS.map((c) => [c.key, Number(form.channels[c.key]) || 0]),
      ),
      trafficFactors: form.trafficFactors,
      notes: form.notes,
      recordedBy: form.recordedBy,
    };
    fetcher.submit({ payload: JSON.stringify(payload) }, { method: "POST" });
  };

  const errors = (fetcher.data && !fetcher.data.ok && fetcher.data.errors) || [];
  const report = fetcher.data?.ok ? fetcher.data.report : null;

  return (
    <s-page heading="每日到店数据录入">
      <s-button
        slot="primary-action"
        variant="primary"
        onClick={save}
        {...(isSaving ? { loading: true } : {})}
        {...(overflow || !data.locationId ? { disabled: true } : {})}
      >
        保存
      </s-button>

      {errors.length > 0 && (
        <s-banner tone="critical" heading="请修正后再保存">
          <s-unordered-list>
            {errors.map((e: string, i: number) => (
              <s-list-item key={i}>{e}</s-list-item>
            ))}
          </s-unordered-list>
        </s-banner>
      )}

      {report?.status === "sent" && (
        <s-banner tone="success" heading={`${report.locationName} 单店报告已发送给 Hermes`}>
          <s-paragraph>
            系统已只合并该门店的 Shopify 订单、销售额、产品和人流量数据，并交给 Hermes 生成最终企业微信分析报告。
          </s-paragraph>
        </s-banner>
      )}

      {report?.status === "ready_no_target" && (
        <s-banner tone="warning" heading={`${report.locationName} 报告已生成，但还没有配置 Hermes webhook`}>
          <s-paragraph>
            请在部署环境设置 HERMES_REPORT_WEBHOOK_URL 和 HERMES_REPORT_WEBHOOK_SECRET 后，系统即可让 Hermes 自动分析并发送到企业微信。
          </s-paragraph>
        </s-banner>
      )}

      {report?.status === "error" && (
        <s-banner tone="critical" heading="已保存，但报告生成/发送失败">
          <s-paragraph>{report.error}</s-paragraph>
        </s-banner>
      )}

      {data.locations.length === 0 && (
        <s-banner tone="warning" heading="未找到门店">
          <s-paragraph>
            Shopify 没有返回任何 Location。请在 Settings → Locations 添加门店后再录入。
          </s-paragraph>
        </s-banner>
      )}

      {isPastDate && data.locations.length > 0 && (
        <s-banner tone="info" heading={`你正在录入 / 修改历史日期 ${data.businessDate}`} />
      )}

      <s-section heading="日期与门店">
        <s-stack direction="block" gap="base">
          <s-stack direction="inline" gap="base">
            <s-text>业务日期：{data.businessDate}（America/Toronto）</s-text>
          </s-stack>
          <s-stack direction="inline" gap="base">
            <s-button
              variant={data.businessDate === torontoYesterday() ? "primary" : "secondary"}
              onClick={() => go(torontoYesterday(), data.locationId)}
            >
              昨天
            </s-button>
            <s-button
              variant={data.businessDate === data.today ? "primary" : "secondary"}
              onClick={() => go(data.today, data.locationId)}
            >
              今天
            </s-button>
          </s-stack>
          <s-select
            label="门店"
            name="locationId"
            value={data.locationId}
            onChange={(e: Event) => go(data.businessDate, fieldValue(e))}
          >
            {data.locations.map((l) => (
              <s-option key={l.id} value={l.id}>
                {l.name}
              </s-option>
            ))}
          </s-select>
        </s-stack>
      </s-section>

      <s-section heading="到店总组数">
        <s-number-field
          label="到店组数（一伙同行算 1 组）"
          name="storeVisitGroups"
          min={0}
          value={form.storeVisitGroups}
          onChange={(e: Event) =>
            setForm((f) => ({ ...f, storeVisitGroups: fieldValue(e) }))
          }
        />
      </s-section>

      <s-section heading="客人来源渠道（按组数填）">
        {overflow && (
          <s-banner tone="critical" heading="渠道合计超过到店总组数">
            <s-paragraph>
              已知渠道合计 {knownTotal} 组，超过了到店总组数 {groups} 组。请检查。
            </s-paragraph>
          </s-banner>
        )}
        <s-stack direction="block" gap="base">
          {CHANNELS.map((c) => (
            <s-number-field
              key={c.key}
              label={c.label}
              name={`channel_${c.key}`}
              min={0}
              value={form.channels[c.key]}
              onChange={(e: Event) => setChannel(c.key, fieldValue(e))}
            />
          ))}
          <s-box padding="base" borderWidth="base" borderRadius="base" background="subdued">
            <s-text>
              已知渠道合计 {knownTotal} / 到店总组数 {groups}；未知来源自动计为 {unknown} 组。
            </s-text>
          </s-box>
        </s-stack>
      </s-section>

      <s-section heading="客流影响因素与备注">
        <s-stack direction="block" gap="base">
          <s-choice-list
            label="客流影响因素（可多选）"
            name="trafficFactors"
            multiple
            values={form.trafficFactors}
            onChange={(e: Event) =>
              setForm((f) => ({ ...f, trafficFactors: choiceValues(e) }))
            }
          >
            {TRAFFIC_FACTORS.map((t) => (
              <s-choice key={t.value} value={t.value}>
                {t.label}
              </s-choice>
            ))}
          </s-choice-list>
          <s-text-area
            label="备注 / 异常说明"
            name="notes"
            rows={3}
            value={form.notes}
            onChange={(e: Event) =>
              setForm((f) => ({ ...f, notes: fieldValue(e) }))
            }
          />
          <s-text-field
            label="记录人（可选）"
            name="recordedBy"
            value={form.recordedBy}
            onChange={(e: Event) =>
              setForm((f) => ({ ...f, recordedBy: fieldValue(e) }))
            }
          />
        </s-stack>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
