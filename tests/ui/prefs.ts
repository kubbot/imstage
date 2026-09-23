/**
 * Shared UI-test fixtures for creator preferences onboarding.
 *
 * Synthetic accounts are real accounts, so a new registration now enters the
 * one-time onboarding page. These helpers either skip it through the real UI
 * (keeping the production behaviour under test) or mark it completed through
 * the real API for specs that seed a session with `page.request` and never
 * render the login page.
 */

import { expect, type Page } from '@playwright/test';

/** If the current page is onboarding, finish it through the real skip action. */
export async function completeOnboarding(page: Page): Promise<void> {
  // The post-auth redirect to onboarding is asynchronous (it waits for the
  // pending preferences), so wait for it explicitly before looking for the skip
  // action. A returned-to-account without onboarding (already completed) simply
  // times out here and continues.
  try {
    await page.waitForURL(/\/welcome/, { timeout: 8000 });
  } catch {
    return;
  }
  await page.getByTestId('prefs-skip').click();
  await expect(page).not.toHaveURL(/\/welcome/);
}

/** Mark onboarding completed for a session created via `page.request`. */
export async function markOnboarded(page: Page): Promise<void> {
  const origin = new URL(page.url()).origin;
  const response = await page.request.put('/api/preferences', {
    headers: { Origin: origin, 'X-IMStage-Request': '1' },
    data: { revision: 1, onboardingStatus: 'completed' },
  });
  expect(response.ok()).toBeTruthy();
}
