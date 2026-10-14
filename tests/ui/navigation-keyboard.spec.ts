import { test, expect } from '@playwright/test';

for (const locale of ['zh', 'en'] as const) {
  test(`mobile navigation opens to its links and Escape returns focus: ${locale}`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const openLabel = locale === 'zh' ? '打开导航' : 'Open navigation';
    const navLabel = locale === 'zh' ? '主导航' : 'Main navigation';
    for (const route of ['', '#/docs']) {
      await page.goto(`/?lang=${locale}${route}`);
      const toggle = page.getByRole('button', { name: openLabel, exact: true });
      await toggle.focus();
      await page.keyboard.press('Enter');
      const firstLink = page.getByRole('navigation', { name: navLabel }).getByRole('link').first();
      await expect(firstLink).toBeFocused();
      await page.keyboard.press('Escape');
      await expect(toggle).toHaveAttribute('aria-expanded', 'false');
      await expect(toggle).toBeFocused();
    }
  });
}
