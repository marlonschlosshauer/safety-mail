import { test, expect } from '@playwright/test';

test('warnings, true destination, focus containment, and cancellation', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Pause before acting' })).toBeVisible();
  const link = page.getByRole('button', { name: 'Review link' });
  await expect(link).toBeDisabled();
  await page.getByRole('checkbox', { name: /I have read the warning/ }).check();
  await link.click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByRole('dialog').getByText('account-check.example', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Stay in mail' })).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(page.getByRole('button', { name: 'Continue to website' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await expect(link).toBeFocused();
});

test('keyboard reading, unchecked state, and saved accessibility preferences', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /Anna.*Coffee on Saturday/ }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Coffee on Saturday?' })).toBeFocused();
  await expect(page.getByRole('heading', { name: 'No obvious warning signs found' })).toBeVisible();
  await page.getByRole('button', { name: /Community Library/ }).click();
  await expect(page.getByRole('heading', { name: 'This message has not been checked' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Review link' })).toBeDisabled();
  await page.getByRole('button', { name: 'High contrast' }).click();
  await page.reload();
  await expect(page.getByRole('button', { name: 'High contrast' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('button', { name: 'Aa Larger text' })).toHaveAttribute('aria-pressed', 'true');
});

test('does not load remote email content or render mail as HTML', async ({ page }) => {
  const remote: string[] = [];
  const errors: string[] = [];
  page.on('request', request => { if (!request.url().startsWith('http://127.0.0.1:4173')) remote.push(request.url()); });
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Pause before acting' })).toBeVisible();
  await expect(page.locator('.message-body a, .message-body img, .message-body iframe')).toHaveCount(0);
  expect(remote).toEqual([]); expect(errors).toEqual([]);
  await page.screenshot({ path: 'work/inbox-preview.png', fullPage: true });
});
