"""把应用的公网地址一次改到四处（DEPLOY.md 第 3 步）：
  shopify.app.toml      application_url / redirect_urls / [app_proxy] url
  .do/app.yaml          SHOPIFY_APP_URL
  extensions/loyalty-pos/src/api.js, extensions/loyalty-account/src/api.js  APP_URL
用法：python scripts/set_app_url.py https://xxx.ondigitalocean.app   （不带结尾斜杠）
改完要：git commit → push（DO 自动重部署）→ shopify app deploy（登记新地址 / webhook / 扩展）。
"""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OLD_HOSTS = r"https://[a-z0-9.-]+\.(fly\.dev|ondigitalocean\.app)"


def main() -> None:
    if len(sys.argv) != 2 or not sys.argv[1].startswith("https://"):
        sys.exit(__doc__)
    new = sys.argv[1].rstrip("/")
    changed = 0

    def sub(path: Path, pattern: str, repl: str) -> None:
        nonlocal changed
        text = path.read_text(encoding="utf-8")
        out, n = re.subn(pattern, repl, text)
        if n:
            path.write_text(out, encoding="utf-8")
            changed += n
            print(f"{path.relative_to(ROOT)}: {n} replaced")

    sub(ROOT / "shopify.app.toml", OLD_HOSTS, new)
    sub(ROOT / ".do" / "app.yaml", OLD_HOSTS, new)
    for ext in ("loyalty-pos", "loyalty-account"):
        sub(ROOT / "extensions" / ext / "src" / "api.js", r'export const APP_URL = "[^"]+"', f'export const APP_URL = "{new}"')
    print(f"done, {changed} replacements -> {new}")


if __name__ == "__main__":
    main()
