import { test, expect } from '@playwright/test';

test('has title', async ({ page }) => {
  await page.goto('https://themedion.com/');

  // Expect a title "to contain" a substring.
  await expect(page).toHaveTitle(/메디온/);
});

test('get started link', async ({ page }) => {
  await page.goto('https://themedion.com/');

  // Click the get started link.
  await page.getByRole('link', { name: '전제품' }).click();

  // Expects page to have a heading with the name of Installation.
  await expect(page.locator('body')).toBeVisible();
});
