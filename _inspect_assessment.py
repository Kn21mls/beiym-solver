from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent
URL = "https://beyim.ai/ru/assessment/17"

with sync_playwright() as p:
    ctx = p.chromium.launch_persistent_context(
        str(ROOT / ".state" / "browser"),
        channel="msedge",
        headless=True,
        viewport={"width": 1280, "height": 900},
    )
    page = ctx.pages[0] if ctx.pages else ctx.new_page()
    page.goto(URL, wait_until="domcontentloaded", timeout=60000)
    page.wait_for_timeout(8000)
    print("URL:", page.url)
    print("TITLE:", page.title())
    print("TEXT:", page.inner_text("body")[:2000].replace("\n", " | "))
    counts = page.evaluate("""() => {
      const sels = ['div.activity.relative','form.activity','.swiper-slide','.swiper-slide-active','input[type=radio]','input[type=checkbox]','[role=radio]','[role=checkbox]','fieldset','[role=radiogroup]','[data-question]','[data-testid=question]','form','button'];
      const out = {};
      for (const s of sels) out[s] = document.querySelectorAll(s).length;
      return out;
    }""")
    print("COUNTS:", counts)
    print("MAIN_HTML:")
    print(page.evaluate("""() => {
      const main = document.querySelector('main') || document.body;
      return main.outerHTML.slice(0, 12000);
    }"""))
    page.screenshot(path=str(ROOT / ".state" / "assessment-inspect.png"), full_page=True)
    ctx.close()
