import { type Page } from '@playwright/test';

/**
 * Chromium logs a "Failed to load resource" console error for any non-2xx or
 * failed network request, independent of whether the application handled it
 * correctly. Chatto's own auth/session tests deliberately trigger 401s (e.g.
 * an expired session, or the request racing account deletion), so this is
 * expected browser noise, not an application bug -- confirmed against a real
 * CI failure where `account-deletion.test.ts` correctly deletes the account,
 * then the now-invalidated session's trailing GetViewer/session-migrate calls
 * get 401s the browser logs on its own.
 */
const isBrowserNetworkDiagnostic = (message: string): boolean =>
  message.startsWith('Failed to load resource:');

/**
 * Collect uncaught page errors and unexpected console.error messages.
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
    const text = message.text();
    if (isBrowserNetworkDiagnostic(text)) return;
    const location = message.location();
    errors.push(location.url ? `${text} (${location.url})` : text);
  });
  return errors;
}
