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
    productListUrl?: string;
    category?: SelectorSpec;
    productLink: string;
    cartButton: string;
    basketUrl: string;
    orderButton: string;
  };
  // 검색 여정에서 사용할 사이트별 키워드 (없으면 검색 여정 스킵)
  searchKeyword?: string;
}

interface CoverageEntry {
  url: string;
  totalBytes: number;
  usedBytes: number;
  unusedBytes: number;
  unusedPercentage: string;
}

interface Journey {
  id: string;
  name: string;
  run: (page: Page, site: Site) => Promise<void>;
  // 이 여정에 사이트가 필요로 하는 데이터가 없으면 false 반환 → 스킵
  isApplicable?: (site: Site) => boolean;
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

// ───────────────────────────────────────────────────────────────────────────
// 여정(Journey) 정의 — 같은 사이트라도 여러 여정을 돌면 커버되는 코드가 달라지고,
// 여러 여정의 합집합 기준으로 분석하면 "사이트 전체에서 진짜 안 쓰이는 코드"에
// 더 가까운 결과가 나온다. (analyze-js.js 에서 union 처리)
// ───────────────────────────────────────────────────────────────────────────

async function purchaseFlow(page: Page, site: Site): Promise<void> {
  await test.step('1. 메인 페이지 방문 및 스크롤', async () => {
    await page.goto(site.baseUrl);
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(1000);
  });

  await test.step('2. 카테고리 이동', async () => {
    if (site.selectors.productListUrl) {
      await page.goto(site.selectors.productListUrl);
      await page.waitForLoadState('domcontentloaded');
    } else if (site.selectors.category) {
      await resolveLocator(page, site.selectors.category).click();
    } else {
      throw new Error(`[${site.id}] productListUrl 또는 category selector 중 하나는 필요합니다.`);
    }
  });

  await test.step('3. 상품 상세 진입', async () => {
    const productLink = page.locator(site.selectors.productLink).first();
    try {
      await productLink.waitFor({ state: 'attached', timeout: 15000 });
    } catch {
      console.log(`[${site.id}] list 페이지에서 상품 못 찾음, 메인 페이지에서 fallback 시도`);
      await page.goto(site.baseUrl);
      await page.waitForLoadState('domcontentloaded');
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(1500);
      await productLink.waitFor({ state: 'attached', timeout: 30000 });
    }
    const href = await productLink.getAttribute('href');
    if (!href) throw new Error(`[${site.id}] product link 에 href 없음`);
    const detailUrl = new URL(href, page.url()).toString();
    await page.goto(detailUrl);
    await page.waitForLoadState('domcontentloaded');
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
}

const journeys: Journey[] = [
  {
    id: 'purchase',
    name: '구매 여정 (PC)',
    run: purchaseFlow,
  },
  {
    id: 'search',
    name: '검색 여정',
    isApplicable: (site) => !!site.searchKeyword,
    run: async (page, site) => {
      await test.step('1. 메인 페이지 방문 및 스크롤', async () => {
        await page.goto(site.baseUrl);
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        await page.waitForTimeout(1000);
      });

      await test.step('2. 검색 결과 페이지 진입', async () => {
        const keyword = site.searchKeyword as string;
        const searchUrl = `${site.baseUrl.replace(/\/$/, '')}/product/search.html?keyword=${encodeURIComponent(keyword)}`;
        await page.goto(searchUrl);
        await page.waitForLoadState('domcontentloaded');
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        await page.waitForTimeout(1500);
      });

      await test.step('3. 검색 결과에서 상품 상세 진입', async () => {
        const productLink = page.locator(site.selectors.productLink).first();
        try {
          await productLink.waitFor({ state: 'attached', timeout: 20000 });
        } catch {
          console.log(`[${site.id}] 검색 결과에 상품 없음, 메인 페이지에서 fallback 시도`);
          await page.goto(site.baseUrl);
          await page.waitForLoadState('domcontentloaded');
          await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
          await page.waitForTimeout(1500);
          await productLink.waitFor({ state: 'attached', timeout: 30000 });
        }
        const href = await productLink.getAttribute('href');
        if (!href) throw new Error(`[${site.id}] product link 에 href 없음`);
        await page.goto(new URL(href, page.url()).toString());
        await page.waitForLoadState('domcontentloaded');
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        await page.waitForTimeout(500);
      });
    },
  },
  {
    id: 'mobile',
    name: '모바일 구매 여정',
    run: async (page, site) => {
      // 모바일 viewport 로 변경 후 구매 흐름 재사용. UA 는 context 레벨이라
      // page 에서 변경 불가 → 일단 viewport 만 모바일. responsive CSS/JS 분기
      // 측정에 유효함.
      await page.setViewportSize({ width: 390, height: 844 });
      await purchaseFlow(page, site);
    },
  },
];

// ───────────────────────────────────────────────────────────────────────────
// 사이트 × 여정 조합으로 독립 test() 동적 생성
// → 한 조합이 실패해도 다른 조합은 계속 진행 (Playwright test 단위 격리)
// → 결과 JSON 은 coverage-results/{siteId}__{journeyId}.json
// ───────────────────────────────────────────────────────────────────────────

for (const site of sites) {
  for (const journey of journeys) {
    if (journey.isApplicable && !journey.isApplicable(site)) continue;

    test(`coverage: ${site.name} / ${journey.name} (${site.id}__${journey.id})`, async ({ page }) => {
      page.on('dialog', (d) => { d.dismiss().catch(() => {}); });

      await page.coverage.startJSCoverage();
      await page.coverage.startCSSCoverage();

      try {
        await journey.run(page, site);
        await expect(page.locator('body')).toBeVisible();
      } finally {
        const jsCoverage = await page.coverage.stopJSCoverage();
        const cssCoverage = await page.coverage.stopCSSCoverage();

        const js = summarizeJs(jsCoverage);
        const css = summarizeCss(cssCoverage);

        const jsTotal = js.reduce((s, e) => s + e.totalBytes, 0);
        const jsUsed = js.reduce((s, e) => s + e.usedBytes, 0);
        const cssTotal = css.reduce((s, e) => s + e.totalBytes, 0);
        const cssUsed = css.reduce((s, e) => s + e.usedBytes, 0);

        console.log(`================================`);
        console.log(`📊 [${site.name} / ${journey.name}] 커버리지 요약`);
        console.log(`JS  total: ${(jsTotal / 1024).toFixed(1)} KB / used: ${(jsUsed / 1024).toFixed(1)} KB / unused: ${(((jsTotal - jsUsed) / Math.max(1, jsTotal)) * 100).toFixed(2)}%`);
        console.log(`CSS total: ${(cssTotal / 1024).toFixed(1)} KB / used: ${(cssUsed / 1024).toFixed(1)} KB / unused: ${(((cssTotal - cssUsed) / Math.max(1, cssTotal)) * 100).toFixed(2)}%`);
        console.log(`================================`);

        if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
        const out = {
          site: { id: site.id, name: site.name, baseUrl: site.baseUrl },
          journey: { id: journey.id, name: journey.name },
          js,
          css,
        };
        fs.writeFileSync(
          path.join(OUTPUT_DIR, `${site.id}__${journey.id}.json`),
          JSON.stringify(out, null, 2),
        );
      }
    });
  }
}
