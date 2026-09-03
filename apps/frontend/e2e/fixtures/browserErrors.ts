import { type Page } from '@playwright/test';

/**
 * Collect uncaught page errors and console.error messages.
 * Useful for detecting unexpected browser-side failures during e2e tests.
 * Install immediately before the code section to be tested.
 * @param page The Playwright page object
 * @returns An array of error messages collected during the test
 */
export function collectBrowserErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (error) => {
    errors.push(error.message);
  });
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    const location = message.location();
    errors.push(location.url ? `${message.text()} (${location.url})` : message.text());
  });
  return errors;
}
