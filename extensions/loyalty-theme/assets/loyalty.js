/* Borderline Points · 主题 app block 共用脚本（商品页徽章 + 购物车积分条）。
   只读两个 App Proxy 接口：/apps/loyalty/estimate（规则，可缓存）和 /apps/loyalty/me（登录顾客余额，不缓存）。 */
(function () {
  if (window.__blLoyaltyLoaded) return;
  window.__blLoyaltyLoaded = true;

  var base = (window.Shopify && window.Shopify.routes && window.Shopify.routes.root) || "/";
  base = base.replace(/\/$/, "");
  var estimateCache = {};
  var mePromise = null;

  function fmt(template, vars) {
    // 占位符用 [points] / [paid] / [balance]（主题编辑器的默认值不允许出现 {{ }}）
    return String(template || "").replace(/\[(\w+)\]/g, function (_, k) {
      return vars[k] != null ? vars[k] : "";
    });
  }
  function estimate(cents) {
    var c = Math.max(0, parseInt(cents, 10) || 0);
    if (!estimateCache[c]) {
      estimateCache[c] = fetch(base + "/apps/loyalty/estimate?cents=" + c, { credentials: "same-origin" }).then(function (r) {
        return r.ok ? r.json() : null;
      });
    }
    return estimateCache[c];
  }
  function me() {
    if (!mePromise) {
      mePromise = fetch(base + "/apps/loyalty/me", { credentials: "same-origin", cache: "no-store" }).then(function (r) {
        return r.ok ? r.json() : { loggedIn: false };
      }).catch(function () { return { loggedIn: false }; });
    }
    return mePromise;
  }

  function initBadge(el) {
    var cents = el.getAttribute("data-cents");
    var loggedIn = el.getAttribute("data-logged-in") === "1";
    Promise.all([estimate(cents), loggedIn ? me() : Promise.resolve(null)]).then(function (res) {
      var est = res[0], m = res[1];
      if (!est) return;
      var paid = m && m.loggedIn && m.isPaidMember;
      var text = paid
        ? fmt(el.getAttribute("data-label-paid"), { points: est.paid })
        : fmt(el.getAttribute("data-label-standard"), { points: est.standard }) + " " + fmt(el.getAttribute("data-label-member"), { paid: est.paid });
      el.querySelector("[data-bl-points-text]").textContent = text.trim();
      el.hidden = false;
    }).catch(function () {});
  }

  function initBanner(el) {
    var cents = el.getAttribute("data-cart-cents");
    var loggedIn = el.getAttribute("data-logged-in") === "1";
    var textEl = el.querySelector("[data-bl-banner-text]");
    var link = el.querySelector("[data-bl-banner-link]");
    Promise.all([estimate(cents), loggedIn ? me() : Promise.resolve(null)]).then(function (res) {
      var est = res[0], m = res[1];
      if (!est) return;
      if (m && m.loggedIn) {
        var pts = m.isPaidMember ? est.paid : est.standard;
        textEl.textContent = fmt(el.getAttribute("data-text-balance"), { balance: m.balance }) + " · " + fmt(el.getAttribute("data-text-logged-in"), { points: pts });
        link.textContent = el.getAttribute("data-text-link");
        link.href = el.getAttribute("data-account-url");
      } else {
        textEl.textContent = fmt(el.getAttribute("data-text-guest"), { points: est.standard });
        link.textContent = el.getAttribute("data-text-link");
        link.href = el.getAttribute("data-login-url");
      }
      el.hidden = false;
    }).catch(function () {});
  }

  function boot(root) {
    (root || document).querySelectorAll("[data-bl-points-badge]:not([data-bl-ready])").forEach(function (el) {
      el.setAttribute("data-bl-ready", "1");
      initBadge(el);
    });
    (root || document).querySelectorAll("[data-bl-points-banner]:not([data-bl-ready])").forEach(function (el) {
      el.setAttribute("data-bl-ready", "1");
      initBanner(el);
    });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", function () { boot(); });
  else boot();
  // 主题编辑器 / 购物车抽屉重渲染后再扫一遍
  document.addEventListener("shopify:section:load", function (e) { boot(e.target); });
  document.addEventListener("cart:refresh", function () { boot(); });
  // 变体切换：主题会改 URL ?variant=，徽章按变体价重算
  document.addEventListener("change", function (e) {
    var form = e.target && e.target.closest && e.target.closest("form[action*='/cart/add']");
    if (!form) return;
    setTimeout(function () {
      document.querySelectorAll("[data-bl-points-badge]").forEach(function (el) {
        var priceEl = document.querySelector("[data-bl-variant-price]");
        if (priceEl && priceEl.getAttribute("data-bl-variant-price")) {
          el.setAttribute("data-cents", priceEl.getAttribute("data-bl-variant-price"));
          el.removeAttribute("data-bl-ready");
        }
      });
      boot();
    }, 50);
  });
})();
