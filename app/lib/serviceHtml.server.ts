// 扫码表单 / 进度页的独立 HTML（走 App Proxy，域名是 borderlinestore.ca，不进主题布局）。手机优先，品牌色炭黑 + 橙。
import type { ServiceStore, ServiceTicket, ServiceType } from "@prisma/client";

import { STATUS_LABEL, type TicketStatus } from "./serviceRules";

const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);

const CSS = `
:root{--ink:#202321;--orange:#F26B38;--snow:#f7f7f5;--line:#e3e1dc;--muted:#6b6b66}
*{box-sizing:border-box}body{margin:0;font:16px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;color:var(--ink);background:var(--snow)}
.wrap{max-width:560px;margin:0 auto;padding:20px 16px 48px}
h1{font-size:22px;margin:0 0 4px}h2{font-size:17px;margin:22px 0 8px}.sub{color:var(--muted);margin:0 0 18px}
.card{background:#fff;border:1px solid var(--line);border-radius:12px;padding:16px;margin:12px 0}
label{display:block;font-weight:600;font-size:14px;margin:12px 0 4px}
input[type=text],input[type=email],input[type=tel],input[type=number],select,textarea{width:100%;padding:12px;border:1px solid var(--line);border-radius:8px;font-size:16px;background:#fff}
.hint{font-size:13px;color:var(--muted);margin-top:4px}
.svc{display:flex;gap:10px;align-items:flex-start;padding:10px 0;border-top:1px solid var(--line)}.svc:first-of-type{border-top:0}
.svc input{width:20px;height:20px;margin-top:3px}.svc .n{font-weight:600}.svc .p{color:var(--muted);font-size:13px}
.btn{display:block;width:100%;padding:14px;border:0;border-radius:10px;background:var(--orange);color:#fff;font-size:17px;font-weight:700;margin-top:18px;cursor:pointer}
.err{background:#fde8e4;border:1px solid #f3b6a7;color:#8a2a12;border-radius:10px;padding:12px;margin:12px 0}
.ok{background:#e8f5ec;border:1px solid #b7e0c3;border-radius:10px;padding:12px;margin:12px 0}
.row{display:flex;gap:10px}.row>div{flex:1}
.tag{font-size:40px;font-weight:800;letter-spacing:1px}
.status{display:inline-block;padding:4px 10px;border-radius:999px;background:var(--ink);color:#fff;font-size:13px;font-weight:600}
.status.ready{background:#1f7a3a}.status.picked_up{background:#6b6b66}
.steps{display:flex;gap:6px;margin:12px 0}.steps span{flex:1;height:6px;border-radius:3px;background:var(--line)}.steps span.on{background:var(--orange)}
.foot{color:var(--muted);font-size:13px;margin-top:28px;text-align:center}
.hidden{display:none}
small{color:var(--muted)}
`;

function page(title: string, body: string) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>${CSS}</style></head><body><div class="wrap">${body}<p class="foot">Borderline Outdoor · Service desk</p></div></body></html>`;
}

const money = (c: number | null) => (c === null ? "" : `$${(c / 100).toFixed(c % 100 === 0 ? 0 : 2)}`);

export type FormValues = Partial<Record<string, string>> & { services?: string[] };

export function renderIntakeForm(opts: {
  store: ServiceStore;
  catalog: ServiceType[];
  values: FormValues;
  errors: string[];
  eta: { label: string; date: string; ahead: number } | null;
  loggedInName?: string | null;
}) {
  const v = opts.values;
  const sel = new Set(v.services ?? []);
  const services = opts.catalog
    .map(
      (s) => `<label class="svc"><input type="checkbox" name="services" value="${esc(s.key)}" data-edge="${s.needsEdgeAngle ? 1 : 0}" data-mount="${s.needsBodyMetrics ? 1 : 0}" ${sel.has(s.key) ? "checked" : ""}>
      <span><span class="n">${esc(s.name)}</span><br><span class="p">${money(s.priceCents)}${s.memberPriceCents !== null ? ` · members ${money(s.memberPriceCents)}` : ""}${s.priceCents !== null && s.key === "rust_removal" ? "+" : ""}</span></span></label>`,
    )
    .join("");
  const errors = opts.errors.length ? `<div class="err"><strong>Please fix:</strong><ul>${opts.errors.map((e) => `<li>${esc(e)}</li>`).join("")}</ul></div>` : "";
  const eta = opts.eta
    ? `<div class="card"><strong>Current turnaround at ${esc(opts.store.name)}:</strong> ${esc(opts.eta.label)} (${esc(opts.eta.date)})<br><small>${opts.eta.ahead} board${opts.eta.ahead === 1 ? "" : "s"} ahead of you. Final pickup date is confirmed after you submit.</small></div>`
    : "";
  const body = `
<h1>Service drop-off · ${esc(opts.store.name)}</h1>
<p class="sub">Fill this in once staff hand you a numbered tag. Takes about a minute.</p>
${errors}${eta}
<form method="post" novalidate>
  <div class="card">
    <label>Tag number <span class="hint" style="display:inline">(printed on the tag, ${opts.store.tagMin}–${opts.store.tagMax})</span></label>
    <input type="number" name="tagNumber" inputmode="numeric" min="${opts.store.tagMin}" max="${opts.store.tagMax}" value="${esc(v.tagNumber)}" required>
    <label>Your name</label><input type="text" name="customerName" value="${esc(v.customerName ?? opts.loggedInName ?? "")}" autocomplete="name" required>
    <div class="row"><div><label>Mobile</label><input type="tel" name="phone" value="${esc(v.phone)}" autocomplete="tel" placeholder="416 555 0123"></div>
    <div><label>Email</label><input type="email" name="email" value="${esc(v.email)}" autocomplete="email"></div></div>
    <p class="hint">We text and email you when it is ready. One of the two is enough.</p>
  </div>

  <div class="card">
    <h2 style="margin-top:0">What are we working on?</h2>
    <label>Equipment</label>
    <select name="equipment">
      ${["ski|Skis", "snowboard|Snowboard", "boots|Boots", "other|Other"].map((o) => { const [val, lab] = o.split("|"); return `<option value="${val}" ${(v.equipment ?? "ski") === val ? "selected" : ""}>${lab}</option>`; }).join("")}
    </select>
    <label>Brand / model / length <small>(optional)</small></label><input type="text" name="boardInfo" value="${esc(v.boardInfo)}" placeholder="e.g. Atomic Bent 100 · 180 cm">
    <h2>Services</h2>
    ${services}
  </div>

  <div class="card hidden" id="edgeBox">
    <h2 style="margin-top:0">Edge angle</h2>
    <label>Any angle request? <small>(optional)</small></label>
    <input type="text" name="edgeAngle" value="${esc(v.edgeAngle)}" placeholder="Leave blank for factory default (e.g. 88° side / 1° base)">
  </div>

  <div class="card hidden" id="mountBox">
    <h2 style="margin-top:0">Binding setup</h2>
    <div id="skiFields">
      <div class="row"><div><label>Height (cm)</label><input type="number" name="heightCm" inputmode="numeric" value="${esc(v.heightCm)}"></div>
      <div><label>Weight (kg)</label><input type="number" name="weightKg" inputmode="numeric" value="${esc(v.weightKg)}"></div></div>
      <label>DIN <small>(optional)</small></label><input type="text" name="din" value="${esc(v.din)}" placeholder="Leave blank and we set the recommended value">
      <p class="hint">Please bring your boots: we cannot mount or adjust without them. You will sign the binding waiver in store after the work is checked.</p>
    </div>
    <div id="sbFields" class="hidden">
      <div class="row"><div><label>Front angle</label><input type="text" name="stanceFront" value="${esc(v.stanceFront)}" placeholder="+15"></div>
      <div><label>Back angle</label><input type="text" name="stanceBack" value="${esc(v.stanceBack)}" placeholder="-9"></div>
      <div><label>Stance width</label><input type="text" name="stanceWidth" value="${esc(v.stanceWidth)}" placeholder="56 cm / ref"></div></div>
      <p class="hint">All optional. Blank = we set a standard duck stance centred on the reference marks.</p>
    </div>
  </div>

  <div class="card">
    <label>Anything else we should know? <small>(optional)</small></label>
    <textarea name="customerNotes" rows="2">${esc(v.customerNotes)}</textarea>
    <label class="svc" style="border:0"><input type="checkbox" name="consentSms" value="1" ${v.consentSms === "0" ? "" : "checked"}><span>Text me updates about this service</span></label>
    <label class="svc"><input type="checkbox" name="consentEmail" value="1" ${v.consentEmail === "0" ? "" : "checked"}><span>Email me updates about this service</span></label>
  </div>
  <input type="hidden" name="store" value="${esc(opts.store.key)}">
  <button class="btn" type="submit">Submit drop-off</button>
</form>
<script>
(function(){
  var boxes=[].slice.call(document.querySelectorAll('input[name=services]'));
  var eq=document.querySelector('select[name=equipment]');
  function sync(){
    var edge=false,mount=false;
    boxes.forEach(function(b){ if(b.checked){ if(b.dataset.edge==='1')edge=true; if(b.dataset.mount==='1')mount=true; }});
    document.getElementById('edgeBox').classList.toggle('hidden',!edge);
    document.getElementById('mountBox').classList.toggle('hidden',!mount);
    var sb=eq.value==='snowboard';
    document.getElementById('skiFields').classList.toggle('hidden',sb);
    document.getElementById('sbFields').classList.toggle('hidden',!sb);
  }
  boxes.forEach(function(b){b.addEventListener('change',sync)}); eq.addEventListener('change',sync); sync();
})();
</script>`;
  return page(`Service drop-off · ${opts.store.name}`, body);
}

export function renderConfirmation(t: ServiceTicket, store: ServiceStore, statusUrl: string, etaLabel: string) {
  const services = (t.services as Array<{ name: string }>).map((s) => esc(s.name)).join(", ");
  const body = `
<h1>You're checked in</h1>
<div class="card" style="text-align:center"><div class="hint">Your tag</div><div class="tag">#${t.tagNumber}</div><div class="hint">${esc(store.name)}</div></div>
<div class="ok"><strong>Estimated pickup: ${esc(etaLabel)}</strong>${t.etaAt ? ` · ${esc(fmtDate(t.etaAt, store.timezone))}` : ""}<br><small>We will text / email you when it is ready. If the queue changes we will let you know.</small></div>
<div class="card"><strong>Services:</strong> ${services}<br><strong>Name:</strong> ${esc(t.customerName)}</div>
<a class="btn" href="${esc(statusUrl)}" style="text-align:center;text-decoration:none">Track this service</a>
<p class="hint" style="text-align:center">Bookmark that link or keep the text we send you. Logged-in customers also see it under Account → Rewards.</p>`;
  return page("Checked in", body);
}

export function renderStatus(t: ServiceTicket, store: ServiceStore, ahead: number) {
  const status = t.status as TicketStatus;
  const steps: TicketStatus[] = ["received", "in_progress", "ready", "picked_up"];
  const idx = Math.max(0, steps.indexOf(status === "on_hold" ? "received" : status));
  const services = (t.services as Array<{ name: string }>).map((s) => esc(s.name)).join(", ");
  const timeline = ((t.history as Array<{ at: string; status: string; note?: string | null }>) ?? [])
    .slice()
    .reverse()
    .slice(0, 8)
    .map((h) => `<div><small>${esc(fmtDateTime(new Date(h.at), store.timezone))}</small> · ${esc(STATUS_LABEL[h.status as TicketStatus] ?? h.status)}${h.note && /delayed/.test(h.note) ? ` · ${esc(h.note)}` : ""}</div>`)
    .join("");
  const eta =
    status === "ready"
      ? `<div class="ok"><strong>Ready for pickup.</strong> Bring tag #${t.tagNumber}.</div>`
      : status === "picked_up"
        ? `<div class="card">Picked up ${t.pickedUpAt ? esc(fmtDateTime(t.pickedUpAt, store.timezone)) : ""}. Thanks!</div>`
        : status === "cancelled"
          ? `<div class="card">This ticket was cancelled. Call the store if that is unexpected.</div>`
          : `<div class="card"><strong>Estimated pickup:</strong> ${t.etaAt ? esc(fmtDate(t.etaAt, store.timezone)) : "to be confirmed"}<br><small>${ahead} board${ahead === 1 ? "" : "s"} ahead of yours. Updates automatically as the queue moves; we will text / email you when it is ready.</small></div>`;
  const body = `
<h1>Service status</h1>
<div class="card" style="text-align:center"><div class="hint">Tag</div><div class="tag">#${t.tagNumber}</div><span class="status ${esc(status)}">${esc(STATUS_LABEL[status] ?? status)}</span></div>
<div class="steps">${steps.map((_, i) => `<span class="${i <= idx && status !== "cancelled" ? "on" : ""}"></span>`).join("")}</div>
${eta}
<div class="card"><strong>Services:</strong> ${services}<br><strong>Store:</strong> ${esc(store.name)}${store.address ? `<br>${esc(store.address)}` : ""}${store.hoursText ? `<br><small>${esc(store.hoursText)}</small>` : ""}${store.phone ? `<br><small>${esc(store.phone)}</small>` : ""}</div>
<div class="card"><strong>Timeline</strong>${timeline}</div>`;
  return page(`Tag #${t.tagNumber} · ${STATUS_LABEL[status] ?? status}`, body);
}

export function renderMessage(title: string, text: string) {
  return page(title, `<h1>${esc(title)}</h1><div class="card">${esc(text)}</div>`);
}

export function fmtDate(d: Date, tz: string) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, weekday: "short", month: "short", day: "numeric" }).format(d);
}
export function fmtDateTime(d: Date, tz: string) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(d);
}
