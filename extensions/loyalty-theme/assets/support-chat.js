/* Borderline support chat · theme app embed script.
   Talks to the App Proxy: POST <proxy>/chat (message) and <proxy>/chat/handoff (leave contact), GET <proxy>/chat (history).
   State in localStorage: visitor id + current conversation id. ?bl-chat=<token> in the URL reopens a conversation from an email link.
   Never throws into the page: any failure shows the offline text + contact form. */
(function () {
  if (window.__blSupportChat) return;
  window.__blSupportChat = true;
  var root = document.getElementById("bl-support-chat");
  if (!root) return;
  if (root.getAttribute("data-hide-mobile") === "1" && window.matchMedia("(max-width: 600px)").matches) return;

  var base = ((window.Shopify && window.Shopify.routes && window.Shopify.routes.root) || "/").replace(/\/$/, "");
  var p = root.getAttribute("data-proxy") || "/apps/loyalty-1";
  var proxy = base + (p.charAt(0) === "/" ? p : "/" + p).replace(/\/$/, "");
  var locale = (root.getAttribute("data-locale") || "en").slice(0, 2) === "fr" ? "fr" : "en";
  var product = root.getAttribute("data-product") || "";
  var accent = root.getAttribute("data-accent") || "#202321";
  var T = {
    en: { open: "Ask us", placeholder: "Type your question…", send: "Send", close: "Close", staff: "Store staff", you: "You",
      sub: "Usually answers in a few seconds", offline: "Our assistant is taking a break. Leave your question and a way to reach you — a staff member will reply by email.",
      contactTitle: "Leave your contact so staff can reply", name: "Name (optional)", email: "Email", phone: "Phone (optional)", submit: "Send to staff",
      need: "Enter an email or phone number", thanks: "Thanks — your question is with our team. We reply by email during store hours.",
      err: "Sorry, something went wrong. Please try again or leave your contact below.", soldout: "sold out", foot: "AI assistant · may make mistakes · staff can take over any time", person: "Talk to a person" },
    fr: { open: "Question ?", placeholder: "Écrivez votre question…", send: "Envoyer", close: "Fermer", staff: "Équipe du magasin", you: "Vous",
      sub: "Répond généralement en quelques secondes", offline: "Notre assistant fait une pause. Laissez votre question et un moyen de vous joindre — un membre de l’équipe vous répondra par courriel.",
      contactTitle: "Laissez vos coordonnées pour que l’équipe vous réponde", name: "Nom (facultatif)", email: "Courriel", phone: "Téléphone (facultatif)", submit: "Envoyer à l’équipe",
      need: "Entrez un courriel ou un numéro de téléphone", thanks: "Merci — votre question est transmise à notre équipe. Nous répondons par courriel pendant les heures d’ouverture.",
      err: "Désolé, une erreur s’est produite. Réessayez ou laissez vos coordonnées ci-dessous.", soldout: "épuisé", foot: "Assistant IA · peut se tromper · l’équipe peut prendre le relais", person: "Parler à quelqu’un" }
  }[locale];
  var title = (locale === "fr" ? root.getAttribute("data-title-fr") : root.getAttribute("data-title")) || "Ask Borderline";
  var greeting = (locale === "fr" ? root.getAttribute("data-greeting-fr") : root.getAttribute("data-greeting")) || "";
  var chips = ((locale === "fr" ? root.getAttribute("data-chips-fr") : root.getAttribute("data-chips")) || "").split("|").map(function (s) { return s.trim(); }).filter(Boolean);

  function store(k, v) { try { if (v === undefined) return localStorage.getItem(k); if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) { return null; } }
  function rid() { var a = new Uint8Array(18); (window.crypto || window.msCrypto).getRandomValues(a); return "v_" + Array.prototype.map.call(a, function (b) { return ("0" + b.toString(16)).slice(-2); }).join(""); }
  var visitor = store("bl_chat_visitor"); if (!visitor || !/^v_[A-Za-z0-9_-]{16,64}$/.test(visitor)) { visitor = rid(); store("bl_chat_visitor", visitor); }
  var conversationId = store("bl_chat_conversation") || null;
  var resumeToken = (new URLSearchParams(location.search).get("bl-chat") || "").trim();

  // ── DOM ──
  root.hidden = false;
  root.className = "blsc blsc--" + (root.getAttribute("data-position") === "left" ? "left" : "right") + (root.getAttribute("data-hide-mobile") === "1" ? " blsc--hide-mobile" : "");
  root.style.setProperty("--blsc-accent", accent);
  var ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a8 8 0 0 1-8 8H7l-4 3v-6a8 8 0 1 1 18-5z"/></svg>';
  var bubble = el("button", { class: "blsc__bubble", type: "button", "aria-label": title, "aria-expanded": "false" }); bubble.innerHTML = ICON + "<span>" + esc(T.open) + "</span>";
  var badge = el("span", { class: "blsc__badge", hidden: "" }); bubble.appendChild(badge);
  root.appendChild(bubble);
  var panel = null, log = null, input = null, sendBtn = null, chipsEl = null, contactEl = null, opened = false, busy = false, messages = [];

  function el(tag, attrs, text) { var e = document.createElement(tag); for (var k in attrs || {}) { if (attrs[k] === null || attrs[k] === undefined) continue; e.setAttribute(k, attrs[k]); } if (text != null) e.textContent = text; return e; }
  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function linkify(s) { return esc(s).replace(/(https?:\/\/[^\s)]+)/g, function (u) { return '<a href="' + u + '" target="_blank" rel="noopener">' + u.replace(/^https?:\/\//, "").replace(/^borderlinestore\.ca\/?/, "borderlinestore.ca/") + "</a>"; }); }

  function build() {
    panel = el("div", { class: "blsc__panel", role: "dialog", "aria-label": title });
    var head = el("div", { class: "blsc__head" }); head.innerHTML = ICON + "<div><b>" + esc(title) + "</b><small>" + esc(T.sub) + "</small></div>";
    var close = el("button", { class: "blsc__close", type: "button", "aria-label": T.close }, "×"); close.addEventListener("click", toggle); head.appendChild(close);
    log = el("div", { class: "blsc__log", "aria-live": "polite" });
    chipsEl = el("div", { class: "blsc__chips" });
    chips.forEach(function (c) { var b = el("button", { class: "blsc__chip", type: "button" }, c); b.addEventListener("click", function () { send(c); }); chipsEl.appendChild(b); });
    var form = el("form", { class: "blsc__form" });
    input = el("textarea", { class: "blsc__input", rows: "1", placeholder: T.placeholder, maxlength: "2000", "aria-label": T.placeholder });
    input.addEventListener("keydown", function (e) { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); form.requestSubmit ? form.requestSubmit() : send(input.value); } });
    input.addEventListener("input", function () { input.style.height = "auto"; input.style.height = Math.min(110, input.scrollHeight) + "px"; });
    sendBtn = el("button", { class: "blsc__send", type: "submit", "aria-label": T.send }); sendBtn.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 2 11 13"/><path d="M22 2 15 22l-4-9-9-4z"/></svg>';
    form.addEventListener("submit", function (e) { e.preventDefault(); send(input.value); });
    form.appendChild(input); form.appendChild(sendBtn);
    panel.appendChild(head); panel.appendChild(log); panel.appendChild(chipsEl); panel.appendChild(form); panel.appendChild(el("div", { class: "blsc__foot" }, T.foot));
    root.appendChild(panel);
  }

  function add(role, text, cards) {
    var m = el("div", { class: "blsc__msg blsc__msg--" + role, "data-label": role === "staff" ? T.staff : null });
    m.innerHTML = role === "user" ? esc(text) : linkify(text);
    log.appendChild(m);
    if (cards && cards.length) {
      var row = el("div", { class: "blsc__cards" });
      cards.forEach(function (c) {
        var a = el("a", { class: "blsc__card", href: c.url, target: "_blank", rel: "noopener" });
        a.innerHTML = (c.image ? '<img src="' + esc(c.image) + '" alt="" loading="lazy">' : '<span class="blsc__card-noimg"></span>') +
          '<span class="blsc__card-body"><b>' + esc(c.title) + '</b><span>' + esc(c.price) + (c.available === false ? " · " + esc(T.soldout) : "") + '</span></span>';
        row.appendChild(a);
      });
      log.appendChild(row);
    }
    log.scrollTop = log.scrollHeight; return m;
  }
  var typingEl = null;
  function typing(on) { if (on && !typingEl) { typingEl = el("div", { class: "blsc__typing" }); typingEl.innerHTML = "<i></i><i></i><i></i>"; log.appendChild(typingEl); log.scrollTop = log.scrollHeight; } if (!on && typingEl) { typingEl.remove(); typingEl = null; } }

  function showContact(intro) {
    if (contactEl) { contactEl.remove(); }
    contactEl = el("div", { class: "blsc__contact" });
    contactEl.innerHTML = "<p>" + esc(intro || T.contactTitle) + "</p>";
    var name = el("input", { type: "text", placeholder: T.name, autocomplete: "name" });
    var email = el("input", { type: "email", placeholder: T.email, autocomplete: "email" });
    var phone = el("input", { type: "tel", placeholder: T.phone, autocomplete: "tel" });
    var err = el("div", { class: "blsc__err" });
    var btn = el("button", { type: "button" }, T.submit);
    btn.addEventListener("click", function () {
      if (!email.value.trim() && !phone.value.trim()) { err.textContent = T.need; return; }
      btn.disabled = true; err.textContent = "";
      post(proxy + "/chat/handoff", { visitorId: visitor, conversationId: conversationId, locale: locale, pageUrl: location.href, productHandle: product, name: name.value, email: email.value, phone: phone.value, message: "" })
        .then(function (r) { if (r && r.ok) { if (r.conversationId) setConversation(r.conversationId); contactEl.remove(); contactEl = null; add("assistant", r.reply || T.thanks); } else { err.textContent = (r && r.error) || T.err; btn.disabled = false; } })
        .catch(function () { err.textContent = T.err; btn.disabled = false; });
    });
    contactEl.appendChild(name); contactEl.appendChild(email); contactEl.appendChild(phone); contactEl.appendChild(err); contactEl.appendChild(btn);
    log.appendChild(contactEl); log.scrollTop = log.scrollHeight;
  }

  function setConversation(id) { conversationId = id; store("bl_chat_conversation", id); }
  function post(url, body) {
    return fetch(url, { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify(body) })
      .then(function (r) { return r.json().catch(function () { return { error: "bad response", status: r.status }; }); });
  }

  function send(text) {
    text = String(text || "").trim(); if (!text || busy) return;
    busy = true; sendBtn.disabled = true; input.value = ""; input.style.height = "auto"; if (chipsEl) chipsEl.hidden = true;
    add("user", text); typing(true);
    post(proxy + "/chat", { visitorId: visitor, conversationId: conversationId, message: text, locale: locale, pageUrl: location.href, productHandle: product })
      .then(function (r) {
        typing(false);
        if (!r || r.error) { add("assistant", T.err); showContact(); return; }
        if (r.conversationId) setConversation(r.conversationId);
        add("assistant", r.reply || T.err, r.cards);
        if (r.mode === "offline" || r.mode === "error" || r.needsContact) showContact(r.mode === "offline" ? null : undefined);
      })
      .catch(function () { typing(false); add("assistant", T.err); showContact(); })
      .then(function () { busy = false; sendBtn.disabled = false; input.focus(); });
  }

  function load() {
    var url = resumeToken ? proxy + "/chat?token=" + encodeURIComponent(resumeToken) : (conversationId ? proxy + "/chat?visitor=" + encodeURIComponent(visitor) + "&conversation=" + encodeURIComponent(conversationId) : null);
    if (!url) { if (greeting) add("assistant", greeting); return Promise.resolve(); }
    return fetch(url, { credentials: "same-origin", cache: "no-store" }).then(function (r) { return r.ok ? r.json() : null; }).then(function (d) {
      if (!d || !d.messages) { conversationId = null; store("bl_chat_conversation", null); if (greeting) add("assistant", greeting); return; }
      if (resumeToken && d.conversationId) { /* 邮件链接打开的会话：这台设备可能不是原访客，只读显示，继续聊会开新会话 */ }
      else if (d.conversationId) setConversation(d.conversationId);
      if (greeting) add("assistant", greeting);
      d.messages.forEach(function (m) { if (m.role === "user" || m.role === "assistant" || m.role === "staff") add(m.role, m.content, m.cards); });
      if (chipsEl && d.messages.length) chipsEl.hidden = true;
    }).catch(function () { if (greeting) add("assistant", greeting); });
  }

  function toggle() {
    if (!panel) build();
    opened = !opened; panel.style.display = opened ? "flex" : "none"; bubble.setAttribute("aria-expanded", String(opened));
    if (opened) { badge.hidden = true; if (!messages.length) { messages.push(1); load().then(function () { input.focus(); }); } else input.focus(); }
  }
  bubble.addEventListener("click", toggle);
  document.addEventListener("keydown", function (e) { if (e.key === "Escape" && opened) toggle(); });
  if (resumeToken) { setTimeout(toggle, 300); }
  // 有店员新回复时亮个点（回访时查一次，不轮询）
  if (conversationId && !resumeToken) {
    fetch(proxy + "/chat?visitor=" + encodeURIComponent(visitor) + "&conversation=" + encodeURIComponent(conversationId), { credentials: "same-origin", cache: "no-store" })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) { if (d && d.messages && d.messages.length && d.messages[d.messages.length - 1].role === "staff" && store("bl_chat_seen") !== d.messages[d.messages.length - 1].at) { badge.textContent = "1"; badge.hidden = false; store("bl_chat_seen", d.messages[d.messages.length - 1].at); } })
      .catch(function () {});
  }
})();
