import { test, expect, Page, Locator } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

// sites.config.js (CommonJS) 를 require 로 로드
// eslint-disable-next-line @typescript-eslint/no-var-requires
const sites = require('../sites.config.js') as Site[];

type SelectorSpec =
  | string
  | { role: Parameters<Page['getByRole']>[0]; name: string; exact?: boolean };

interface Site {
  id: string;
  name: string;
  baseUrl: string;
  selectors: {
    category: SelectorSpec;
    productLink: string;
    cartButton: string;
    basketUrl: string;
    orderButton: string;
  };
}

interface CoverageEntry {
  url: string;
  totalBytes: number;
  usedBytes: number;
  unusedBytes: number;
  unusedPercentage: string;
}

const OUTPUT_DIR = path.resolve(__dirname, '..', 'coverage-results');

function resolveLocator(page: Page, spec: SelectorSpec): Locator {
  if (typeof spec === 'string') return page.locator(spec).first();
  return page.getByRole(spec.role, { name: spec.name, exact: spec.exact });
}

function summarizeJs(entries: Array<{ url: string; source?: string; functions: Array<{ ranges: Array<{ count: number; startOffset: number; endOffset: number }> }> }>): CoverageEntry[] {
  return entries.map((entry) => {
    const sourceText = entry.source || '';
    let unused = 0;
    for (const f of entry.functions) {
      for (const r of f.ranges) {
        if (r.count === 0) unused += r.endOffset - r.startOffset;
      }
    }
    unused = Math.min(unused, sourceText.length);
    const used = sourceText.length - unused;
    return {
      url: entry.url,
      totalBytes: sourceText.length,
      usedBytes: used,
      unusedBytes: unused,
      unusedPercentage: (unused / Math.max(1, sourceText.length) * 100).toFixed(2) + '%',
    };
  });
}

function summarizeCss(entries: Array<{ url: string; text?: string; ranges: Array<{ start: number; end: number }> }>): CoverageEntry[] {
  return entries.map((entry) => {
    const text = entry.text || '';
    let used = 0;
    for (const r of entry.ranges) used += r.end - r.start;
    used = Math.min(used, text.length);
    const unused = text.length - used;
    return {
      url: entry.url,
      totalBytes: text.length,
      usedBytes: used,
      unusedBytes: unused,
      unusedPercentage: (unused / Math.max(1, text.length) * 100).toFixed(2) + '%',
    };
  });
}

// 사이트마다 독립 test() 를 생성 → 한 사이트 selector 가 깨져도 다른 사이트는 계속 진행
for (const site of sites) {
  test(`coverage: ${site.name} (${site.id})`, async ({ page }) => {
    // 사이트가 alert/confirm 을 띄워 page 가 멈추는 것을 방지 (자동 dismiss)
    page.on('dialog', (d) => { d.dismiss().catch(() => {}); });

    await page.coverage.startJSCoverage();
    await page.coverage.startCSSCoverage();

    await test.step('1. 메인 페이지 방문 및 스크롤', async () => {
      await page.goto(site.baseUrl);
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(1000);
    });

    await test.step('2. 카테고리 이동', async () => {
      await resolveLocator(page, site.selectors.category).click();
    });

    await test.step('3. 상품 상세 진입', async () => {
      const productLink = page.locator(site.selectors.productLink).first();
      await productLink.waitFor({ state: 'visible', timeout: 15000 });
      await productLink.click();
      await expect(page.locator('body')).toBeVisible();
      // 상세 페이지의 동적 로드 자극을 위해 짧게 스크롤
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(500);
    });

    await test.step('4. 장바구니 담기', async () => {
      const cartBtn = page.locator(site.selectors.cartButton).first();
      if (await cartBtn.isVisible()) {
        await cartBtn.click();
      }
      await page.goto(site.selectors.basketUrl);
      await page.waitForLoadState('domcontentloaded');
    });

    await test.step('5. 결제/로그인 페이지 진입', async () => {
      const orderBtn = page.locator(site.selectors.orderButton).first();
      if (await orderBtn.isVisible()) {
        await orderBtn.click();
      }
      await page.waitForTimeout(2000);
    });

    const jsCoverage = await page.coverage.stopJSCoverage();
    const cssCoverage = await page.coverage.stopCSSCoverage();

    const js = summarizeJs(jsCoverage);
    const css = summarizeCss(cssCoverage);

    const jsTotal = js.reduce((s, e) => s + e.totalBytes, 0);
    const jsUsed = js.reduce((s, e) => s + e.usedBytes, 0);
    const cssTotal = css.reduce((s, e) => s + e.totalBytes, 0);
    const cssUsed = css.reduce((s, e) => s + e.usedBytes, 0);

    console.log(`================================`);
    console.log(`📊 [${site.name}] 커버리지 요약`);
    console.log(`JS  total: ${(jsTotal / 1024).toFixed(1)} KB / used: ${(jsUsed / 1024).toFixed(1)} KB / unused: ${(((jsTotal - jsUsed) / Math.max(1, jsTotal)) * 100).toFixed(2)}%`);
    console.log(`CSS total: ${(cssTotal / 1024).toFixed(1)} KB / used: ${(cssUsed / 1024).toFixed(1)} KB / unused: ${(((cssTotal - cssUsed) / Math.max(1, cssTotal)) * 100).toFixed(2)}%`);
    console.log(`================================`);

    if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    const out = {
      site: { id: site.id, name: site.name, baseUrl: site.baseUrl },
      js,
      css,
    };
    fs.writeFileSync(path.join(OUTPUT_DIR, `${site.id}.json`), JSON.stringify(out, null, 2));
  });
}
