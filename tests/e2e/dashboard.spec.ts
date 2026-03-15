/**
 * D1-D4 — Dashboard UI testy (Playwright)
 * Předpoklad: aplikace běží na http://localhost:3001
 */

import { test, expect } from '@playwright/test';

test.describe('D1 — Dashboard se načte', () => {
  test('stránka se načte bez JS chyb', async ({ page }) => {
    const consoleErrors: string[] = [];
    page.on('console', msg => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });

    await page.goto('/');
    // networkidle nelze použít — SSE /api/events drží síť stále aktivní
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(2000); // počkej na Vue hydrataci

    expect(consoleErrors).toHaveLength(0);
  });

  test('navigace obsahuje pluginy', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(2000);

    const nav = page.locator('nav, [role="navigation"], aside');
    await expect(nav.first()).toBeVisible();
  });
});

test.describe('D2 — Simple Chat plugin', () => {
  test('zobrazí input pro zprávu', async ({ page }) => {
    await page.goto('/chat');
    await page.waitForLoadState('domcontentloaded');

    const input = page.locator('.chat-input');
    await expect(input).toBeVisible({ timeout: 10000 });
  });

  test('zobrazí tlačítko odeslat', async ({ page }) => {
    await page.goto('/chat');
    await page.waitForLoadState('domcontentloaded');

    const button = page.locator('.chat-send-btn');
    await expect(button).toBeVisible({ timeout: 10000 });
  });
});

test.describe('D3 — Settings plugin', () => {
  test('settings stránka se načte', async ({ page }) => {
    await page.goto('/settings');
    await page.waitForLoadState('domcontentloaded');

    const title = await page.title();
    expect(title).not.toBe('');
  });
});

test.describe('D4 — Observability plugin', () => {
  test('observability stránka se načte', async ({ page }) => {
    await page.goto('/observability');
    await page.waitForLoadState('domcontentloaded');

    const title = await page.title();
    expect(title).not.toBe('');
  });
});
