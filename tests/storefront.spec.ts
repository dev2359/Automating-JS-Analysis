import { test, expect } from '@playwright/test';

test('상품 상세 페이지 진입', async ({ page }) => {
  await page.goto('https://themedion.com/');

  await page.getByRole('link', { name: '전제품' }).click();
  await page.locator('a[href*="/product/detail"]').first().click();

  await expect(page.locator('body')).toBeVisible();
  await expect(page.locator('.xans-product-option .value').first()).toBeVisible();
  await expect(page.locator('#btnBuy').first()).toBeVisible();
});

test('상품 옵션 선택 가능', async ({ page }) => {
  await page.goto('https://themedion.com/');

  await page.getByRole('link', { name: '전제품' }).click();
  await page.locator('a[href*="/product/detail"]').first().click();


  const optionTrigger = page.locator('.xans-product-detail .option_layer .xans-product-option .value').first();
  await expect(optionTrigger).toBeVisible();
  await optionTrigger.click();
  
const option = page.getByText(/7\+3box/i).first();
console.log('7+3box count:', await page.getByText(/7\+3box/i).count());
await expect(option).toBeVisible();
await option.click();

  await expect(page.locator('#btnBuy').first()).toBeVisible();
});