/* Borderline Points · theme app block script (product-page badge + cart banner).
   Reads two App Proxy endpoints: <proxy>/estimate (rules, cacheable) and <proxy>/me (logged-in balance, no cache).
   The proxy path comes from the block setting (data-proxy); the store install is /apps/loyalty-1. */
(function () {
  if (window.__blLoyaltyLoaded) return;
  window.__blLoyaltyLoaded = true;

  var base = (window.Shopify && window.Shopify.routes && window.Shopify.routes.root) || "/";
  base = base.replace(/\/$/, "");
  var estimateCache = {};
  var mePromise = null;
  function proxyBase(el) {
    var p = (el && el.getAttribute("data-proxy")) || "/apps/loyalty-1";
    return base + (p.charAt(0) === "/" ? p : "/" + p).replace(/\/$/, "");
  }

  function fmt(template, vars) {
    // 占位符用 [points] / [paid] / [balance]（主题编辑器的默认值不允许出现 {{ }}）
    return String(template || "").replace(/\[(\w+)\]/g, function (_, k) {
      return vars[k] != null ? vars[k] : "";
    });
  }
  function estimate(cents, el) {
    var c = Math.max(0, parseInt(cents, 10) || 0);
    if (!estimateCache[c]) {
      estimateCache[c] = fetch(proxyBase(el) + "/estimate?cents=" + c, { credentials: "same-origin" }).then(function (r) {
        return r.ok ? r.json() : null;
      });
    }
    return estimateCache[c];
  }
  function me(el) {
    if (!mePromise) {
      mePromise = fetch(proxyBase(el) + "/me", { credentials: "same-origin", cache: "no-store" }).then(function (r) {
        return r.ok ? r.json() : { loggedIn: false };
      }).catch(function () { return { loggedIn: false }; });
    }
    return mePromise;
  }

  function initBadge(el) {
    var cents = el.getAttribute("data-cents");
    var loggedIn = el.getAttribute("data-logged-in") === "1";
    Promise.all([estimate(cents, el), loggedIn ? me(el) : Promise.resolve(null)]).then(function (res) {
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
    Promise.all([estimate(cents, el), loggedIn ? me(el) : Promise.resolve(null)]).then(function (res) {
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
