// 业务日期统一按店铺时区 America/Toronto，格式 YYYY-MM-DD。
const TZ = "America/Toronto";

export function torontoToday(): string {
  // en-CA 本地化格式即 YYYY-MM-DD
  return new Date().toLocaleDateString("en-CA", { timeZone: TZ });
}

export function torontoYesterday(): string {
  const y = new Date(Date.now() - 24 * 60 * 60 * 1000);
  return y.toLocaleDateString("en-CA", { timeZone: TZ });
}

export function isValidDate(s: string | null | undefined): boolean {
  return !!s && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
}
