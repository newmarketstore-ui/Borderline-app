// 渠道与客流因素的唯一真源（Phase 3 会镜像同样的枚举到 Python config）。
// channels.ts 的 key 即对外 JSON / 导出 API 用的 key；field 是 Prisma 列名。

export type ChannelField =
  | "channelWalkIn"
  | "channelGoogleMaps"
  | "channelMeta"
  | "channelTiktok"
  | "channelXiaohongshu"
  | "channelReferral"
  | "channelRepeatCustomer"
  | "channelWebsite"
  | "channelPhoneSms"
  | "channelOther";

export type ChannelDef = {
  key: string;
  field: ChannelField;
  label: string;
};

// 员工可填的“已知来源”渠道；unknown 由服务端 = 到店总组数 - 已知合计 自动算，不在此列。
export const CHANNELS: ChannelDef[] = [
  { key: "walk_in", field: "channelWalkIn", label: "自然路过 / 直接到店" },
  { key: "google_maps", field: "channelGoogleMaps", label: "Google / Google Maps" },
  { key: "meta", field: "channelMeta", label: "Facebook / Instagram / Meta" },
  { key: "tiktok", field: "channelTiktok", label: "TikTok" },
  { key: "xiaohongshu", field: "channelXiaohongshu", label: "小红书" },
  { key: "referral", field: "channelReferral", label: "朋友推荐 / 转介绍" },
  { key: "repeat_customer", field: "channelRepeatCustomer", label: "老客回访" },
  { key: "website", field: "channelWebsite", label: "官网导流" },
  { key: "phone_sms", field: "channelPhoneSms", label: "电话 / 短信 / 私信预约" },
  { key: "other", field: "channelOther", label: "其他已知来源" },
];

// 客流影响因素（结构化多选标签）
export const TRAFFIC_FACTORS: Array<{ value: string; label: string }> = [
  { value: "weather_bad", label: "天气恶劣" },
  { value: "holiday", label: "节假日" },
  { value: "promo", label: "促销活动" },
  { value: "nearby_event", label: "周边活动" },
  { value: "equipment_issue", label: "设备故障" },
  { value: "store_closed_part", label: "部分时段闭店" },
  { value: "other", label: "其他" },
];
