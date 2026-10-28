import { describe, expect, it } from "vitest";
import {
  memberFromBulk,
  membersFromCsv,
  parseCsv,
  parseMigrateRows,
  planImportRow,
  summarizePlans,
} from "./appstleImport";

// 合成数据（不含任何真实顾客资料）
const NOW = new Date("2026-11-01T05:00:00Z");
const rowsText = [
  { shopifyCustomerId: "gid://shopify/Customer/101", email: "a@example.test", availablePoints: 1234, pendingPoints: 0, flags: [], raw: { availablePoints: 1234.6 } },
  { shopifyCustomerId: "gid://shopify/Customer/102", email: null, availablePoints: -279, pendingPoints: 329.0, flags: ["negative_points", "no_email"], raw: {} },
  { shopifyCustomerId: "103", email: "c@example.test", availablePoints: 99989500, pendingPoints: 0, flags: ["anomaly_huge_balance"], raw: {} },
  { shopifyCustomerId: "gid://shopify/Customer/104", email: "d@example.test", availablePoints: 12.9, pendingPoints: 0, flags: ["non_integer_points"], raw: {} },
]
  .map((o) => JSON.stringify(o))
  .join("\n");

describe("parseMigrateRows + planImportRow", () => {
  const rows = parseMigrateRows(rowsText + "\n\n");
  it("normalises ids", () => {
    expect(rows).toHaveLength(4);
    expect(rows[2].shopifyCustomerId).toBe("gid://shopify/Customer/103");
  });
  it("maps available and pending to separate migrate ledger rows, floored", () => {
    const p = planImportRow(rows[1], undefined, { includeAnomalies: false, pendingDays: 0, now: NOW });
    expect(p.skip).toBeNull();
    expect(p.ledger).toEqual([
      { kind: "available", referenceId: "appstle:102", delta: -279, availableAt: NOW, note: "Appstle balance migrated" },
      { kind: "pending", referenceId: "appstle:102:pending", delta: 329, availableAt: NOW, note: "Appstle pending points migrated" },
    ]);
    expect(planImportRow(rows[3], undefined, { includeAnomalies: false, pendingDays: 0, now: NOW }).ledger[0].delta).toBe(12);
  });
  it("delays pending points by pendingDays", () => {
    const p = planImportRow(rows[1], undefined, { includeAnomalies: false, pendingDays: 14, now: NOW });
    expect(p.ledger[1].availableAt.toISOString()).toBe("2026-11-15T05:00:00.000Z");
  });
  it("skips anomalies unless --include-anomalies", () => {
    expect(planImportRow(rows[2], undefined, { includeAnomalies: false, pendingDays: 0, now: NOW }).skip).toBe("anomaly_huge_balance");
    expect(planImportRow(rows[2], undefined, { includeAnomalies: true, pendingDays: 0, now: NOW }).skip).toBeNull();
  });
  it("summarises without emails", () => {
    const plans = rows.map((r) => planImportRow(r, undefined, { includeAnomalies: false, pendingDays: 0, now: NOW }));
    const s = summarizePlans(plans, "gold-membership");
    expect(s).toMatchObject({ rows: 4, planned: 3, skippedAnomaly: 1, ledgerRows: 4, availablePoints: 1234 - 279 + 12, pendingPoints: 329, negativeRows: 1 });
    expect(JSON.stringify(s)).not.toContain("@");
  });
});

describe("member sources", () => {
  it("bulk jsonl line → member with tags and Appstle memberships", () => {
    const m = memberFromBulk({
      id: "gid://shopify/Customer/101",
      email: "a@example.test",
      phone: null,
      firstName: "Ann",
      lastName: "",
      tags: ["Gold", "gold-membership"],
      msub: { value: JSON.stringify([{ id: 555, sellingPlanNames: ["Annual Membership"], status: "active" }]) },
    });
    expect(m).toMatchObject({ shopifyCustomerId: "gid://shopify/Customer/101", firstName: "Ann", lastName: null, tags: ["Gold", "gold-membership"] });
    expect(m?.subscriptions[0]).toMatchObject({ externalId: "555", status: "active", planName: "Annual Membership" });
  });
  it("CSV row → member; pipe-separated tags and contract ids", () => {
    const csv =
      "﻿shopifyCustomerId,email,phone,firstName,lastName,tags,membership_statuses,membership_plan,membership_start,membership_next_billing,membership_contract_ids\r\n" +
      'gid://shopify/Customer/101,a@example.test,,Ann,"O""Neil, Jr",gold-membership|Silver,active,"Annual Membership; Store",2025-03-06T00:32:39Z,2027-03-06T00:00:00Z,111|222\r\n' +
      "gid://shopify/Customer/102,,,,,,,,,,\r\n";
    expect(parseCsv(csv)[1][4]).toBe('O"Neil, Jr');
    const map = membersFromCsv(csv);
    const a = map.get("gid://shopify/Customer/101");
    expect(a?.tags).toEqual(["gold-membership", "Silver"]);
    expect(a?.subscriptions.map((s) => s.externalId)).toEqual(["111", "222"]);
    expect(a?.subscriptions[1].renewsAt?.toISOString()).toBe("2027-03-06T00:00:00.000Z");
    expect(map.get("gid://shopify/Customer/102")?.subscriptions).toEqual([]);
  });
  it("export member data wins over the migrate row email", () => {
    const [row] = parseMigrateRows(rowsText);
    const member = memberFromBulk({ id: "gid://shopify/Customer/101", email: "new@example.test", tags: ["gold-membership"] }) ?? undefined;
    const p = planImportRow(row, member, { includeAnomalies: false, pendingDays: 0, now: NOW });
    expect(p.member.email).toBe("new@example.test");
    expect(p.hasMemberRecord).toBe(true);
    expect(summarizePlans([p], "gold-membership").memberTagged).toBe(1);
  });
});
