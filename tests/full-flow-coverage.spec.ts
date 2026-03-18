import { test, expect } from '@playwright/test';
import * as fs from 'fs';

test('메디온 일반 소비자 통합 여정 및 JS 커버리지 추출', async ({ page }) => {
  // 1. JS 커버리지 측정 시작
  await page.coverage.startJSCoverage();

  await test.step('1. 메인 페이지 방문 및 스크롤', async () => {
    await page.goto('https://themedion.com/');
    // 페이지 끝까지 스크롤하여 지연 로딩(Lazy Load)되는 기능 자극
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(1000); 
  });

  await test.step('2. 카테고리 이동', async () => {
    await page.getByRole('link', { name: '전제품' }).click();
  });

  await test.step('3. 상품 상세 진입 및 옵션 선택', async () => {
    // 페이지 전환 후 상품 링크가 보일 때까지 대기
    const productLink = page.locator('a[href*="/product/detail"]').first();
    await productLink.waitFor({ state: 'visible', timeout: 15000 });
    await productLink.click();

    await expect(page.locator('body')).toBeVisible();
    
    // 옵션 선택은 상품마다 다를 수 있으므로 예외 처리 적용
    try {
      const optionTrigger = page.locator('.xans-product-detail .option_layer .xans-product-option .value').first();
      await optionTrigger.waitFor({ state: 'visible', timeout: 5000 });
      await optionTrigger.click();
      
      // 옵션이 렌더링될 약간의 대기
      await page.waitForTimeout(1000);
      
      // 'box'나 '세트', '개' 등이 포함된 옵션 요소를 유연하게 찾아서 클릭
      const anyOption = page.locator('.xans-product-option li, .xans-product-option option, text=/box|세트|개/i').nth(1);
      if (await anyOption.isVisible()) {
        await anyOption.click();
      } else {
        // 첫 번째 매칭되는 요소 시도
        const fallbackOption = page.locator('text=/box|세트|개/i').first();
        if (await fallbackOption.isVisible()) await fallbackOption.click();
      }
    } catch (e) {
      console.log('선택 가능 옵션이 없거나 다르게 생겼으므로 기본 상태로 담기를 시도합니다.');
    }
  });

  await test.step('4. 장바구니 담기', async () => {
    const cartBtn = page.locator('text="장바구니"').first(); 
    if (await cartBtn.isVisible()) {
      await cartBtn.click();
    }
    
    // 장바구니 페이지로 명시적 이동 (팝업이 안뜰 경우 대비)
    await page.goto('https://themedion.com/order/basket.html');
    await page.waitForLoadState('domcontentloaded');
  });

  await test.step('5. 결제/로그인 페이지 진입', async () => {
    const orderBtn = page.locator('text="전체상품주문", text="주문하기", a:has-text("주문하기")').first();
    if (await orderBtn.isVisible()) {
      await orderBtn.click();
    }
    await page.waitForTimeout(2000);
  });

  // 2. JS 커버리지 측정 종료 및 결과 반환
  const coverage = await page.coverage.stopJSCoverage();

  // 3. 결과 데이터를 가공하여 JSON 파일로 저장
  let totalBytes = 0;
  let usedBytes = 0;
  
  const coverageSummary = coverage.map((entry) => {
    const sourceText = entry.source || '';
    totalBytes += sourceText.length;
    
    let entryUnusedBytes = 0;
    for (const f of entry.functions) {
      for (const r of f.ranges) {
        if (r.count === 0) {
          entryUnusedBytes += r.endOffset - r.startOffset;
        }
      }
    }
    
    // 혹시라도 전체 길이를 넘는다면 보정
    entryUnusedBytes = Math.min(entryUnusedBytes, sourceText.length);
    const entryUsedBytes = sourceText.length - entryUnusedBytes;
    usedBytes += entryUsedBytes;
    
    return {
      url: entry.url,
      totalBytes: sourceText.length,
      usedBytes: entryUsedBytes,
      unusedBytes: entryUnusedBytes,
      unusedPercentage: ((entryUnusedBytes) / Math.max(1, sourceText.length) * 100).toFixed(2) + '%'
    };
  });

  console.log(`================================`);
  console.log(`📊 웹사이트 JS 커버리지 요약`);
  console.log(`전체 로드된 JS 크기: ${(totalBytes / 1024).toFixed(2)} KB`);
  console.log(`실제 사용된 JS 크기: ${(usedBytes / 1024).toFixed(2)} KB`);
  console.log(`사용 안 된 JS 비율 : ${((totalBytes - usedBytes) / totalBytes * 100).toFixed(2)} %`);
  console.log(`================================`);

  fs.writeFileSync('js-coverage-result.json', JSON.stringify(coverageSummary, null, 2));
});
