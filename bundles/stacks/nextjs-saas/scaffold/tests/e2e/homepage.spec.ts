import { test, expect } from '@playwright/test';

test('home page renders with the project title', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
});
