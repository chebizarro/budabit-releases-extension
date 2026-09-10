import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';

const productionBundle = readFileSync('packages/iframe-app/dist/index.html', 'utf8');

test.beforeEach(async ({ page, context }) => {
  // Test the self-contained production artifact, not Vite's development transform.
  await page.route('http://localhost:5179/', (route) =>
    route.fulfill({ contentType: 'text/html', body: productionBundle })
  );
  await context.route('https://**/*', (route) =>
    route.fulfill({ contentType: 'text/plain', body: 'test' })
  );
  await page.goto('/test-host/');
  await expect(
    page.frameLocator('iframe').getByRole('button', { name: 'New Release', exact: true })
  ).toBeEnabled();
});

test('ships a self-contained production artifact without the dev signing fixture', async ({
  page,
}) => {
  expect(productionBundle).not.toContain('releaseHarness');
  expect(productionBundle).not.toContain('fixture-publish-attempts');
  await expect(
    page.frameLocator('iframe').locator('script[src], link[rel=stylesheet][href]')
  ).toHaveCount(0);
});

test('ignores a delayed fallback response after a newer logout update', async ({ page }) => {
  await page.goto('/test-host/?holdFallback=1');
  const widget = page.frameLocator('iframe');
  await expect(widget.getByRole('button', { name: 'New Release', exact: true })).toBeEnabled();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as { releaseHarness: { fallbackPending: boolean } }).releaseHarness
            .fallbackPending
      )
    )
    .toBe(true);
  await page.getByRole('button', { name: 'Log out', exact: true }).click();
  await expect(widget.getByRole('button', { name: 'New Release', exact: true })).toHaveCount(0);
  await page.evaluate(() =>
    (
      window as unknown as { releaseHarness: { resolveFallback: () => void } }
    ).releaseHarness.resolveFallback()
  );
  // A subsequent round-trip proves the stale response has passed through the widget.
  await widget.locator('.release-card').click();
  await expect(
    widget.getByRole('heading', { name: 'Assets (1 resolved / 1 referenced)' })
  ).toBeVisible();
  await widget.getByRole('button', { name: '← Releases', exact: true }).click();
  await expect(widget.getByRole('button', { name: 'New Release', exact: true })).toHaveCount(0);
});

test('shows only authorized releases, reconciles replacements and account/context changes', async ({
  page,
}) => {
  const widget = page.frameLocator('iframe');
  await expect(widget.locator('.release-card')).toHaveCount(1);
  await expect(widget.getByText('ATTACKER RELEASE')).toHaveCount(0);
  await page.getByRole('button', { name: 'Replace release', exact: true }).click();
  await expect(widget.locator('.release-card')).toHaveCount(1);
  await expect(widget.locator('.release-card')).toContainText('Replacement notes');
  await page.getByRole('button', { name: 'Log out', exact: true }).click();
  await expect(widget.getByRole('button', { name: 'New Release', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Clear repository', exact: true }).click();
  await expect(widget.getByText('Waiting for repository context…')).toBeVisible();
  await expect(page.locator('#metrics')).toContainText('Active subscriptions: 0');
});

test('sanitizes notes and allows a user-activated popup without navigating the widget', async ({
  page,
}) => {
  const widget = page.frameLocator('iframe');
  await widget.locator('.release-card').click();
  await expect(
    widget.getByRole('heading', { name: 'Assets (1 resolved / 1 referenced)' })
  ).toBeVisible();
  await expect(widget.locator('.release-notes img, .release-notes script')).toHaveCount(0);
  const popup = page.waitForEvent('popup');
  await widget.getByRole('link', { name: 'Download', exact: true }).click();
  const opened = await popup;
  await expect(opened).toHaveURL('https://files.example.invalid/fixture.bin');
  await expect(
    widget.getByRole('heading', { name: 'Assets (1 resolved / 1 referenced)' })
  ).toBeVisible();
  await opened.close();
  await widget.getByLabel('Verify local file').setInputFiles({
    name: 'fixture.bin',
    mimeType: 'application/octet-stream',
    buffer: Buffer.from('test'),
  });
  await expect(widget.getByRole('status')).toHaveText('SHA-256 matches signed metadata');
});

test('selects one verified run, pins signatures and resumes identical publication IDs', async ({
  page,
}) => {
  const widget = page.frameLocator('iframe');
  await page.getByRole('button', { name: 'Fail next publication', exact: true }).click();
  await widget.getByRole('button', { name: 'New Release', exact: true }).click();
  await widget
    .getByRole('combobox', { name: 'Application', exact: true })
    .selectOption({ index: 1 });
  await widget.getByLabel('Version', { exact: true }).fill('2');
  await widget
    .getByRole('combobox', { name: 'Authenticated pipeline run', exact: true })
    .selectOption({ index: 1 });
  await widget.getByLabel('Verify local file').setInputFiles({
    name: 'fixture.bin',
    mimeType: 'application/octet-stream',
    buffer: Buffer.from('evil'),
  });
  await expect(widget.getByRole('status')).toContainText('mismatch');
  await expect(widget.getByRole('checkbox', { name: 'Include fixture.bin' })).toBeDisabled();
  await widget.getByLabel('Verify local file').setInputFiles({
    name: 'fixture.bin',
    mimeType: 'application/octet-stream',
    buffer: Buffer.from('test'),
  });
  await expect(widget.getByRole('status')).toHaveText('SHA-256 matches');
  await widget.getByRole('checkbox', { name: 'Include fixture.bin' }).check();
  await widget.getByLabel('Verify local file').setInputFiles({
    name: 'fixture.bin',
    mimeType: 'application/octet-stream',
    buffer: Buffer.from('evil'),
  });
  await expect(widget.getByRole('checkbox', { name: 'Include fixture.bin' })).not.toBeChecked();
  await expect(widget.getByRole('button', { name: 'Publish Release', exact: true })).toBeDisabled();
  await widget.getByLabel('Verify local file').setInputFiles({
    name: 'fixture.bin',
    mimeType: 'application/octet-stream',
    buffer: Buffer.from('test'),
  });
  await expect(widget.getByRole('status')).toHaveText('SHA-256 matches');
  await widget.getByRole('checkbox', { name: 'Include fixture.bin' }).check();
  await widget.getByRole('button', { name: 'Publish Release', exact: true }).click();
  await expect(widget.getByRole('alert')).toContainText('Synthetic relay timeout');
  await expect(widget.getByRole('button', { name: 'Resume publication' })).toBeEnabled();
  await page.reload();
  await widget.getByRole('button', { name: 'New Release', exact: true }).click();
  await widget.getByRole('button', { name: 'Resume publication' }).click();
  await expect(widget.locator('.release-card')).toHaveCount(2);
  await expect(page.locator('#metrics')).toContainText('signatures: 0');
  expect(
    await page.evaluate(() => {
      const ids = (window as unknown as { releaseHarness: { published: string[] } }).releaseHarness
        .published;
      return ids.length === 3 && ids[0] === ids[1];
    })
  ).toBe(true);
});

test('marks incomplete discovery and recovers without leaking subscriptions', async ({ page }) => {
  const widget = page.frameLocator('iframe');
  await page.getByRole('button', { name: 'Toggle partial query', exact: true }).click();
  await page.getByRole('button', { name: 'Log out', exact: true }).click();
  await page.getByRole('button', { name: 'Test maintainer', exact: true }).click();
  await expect(widget.getByRole('alert')).toContainText('incomplete');
  await expect(widget.getByRole('button', { name: 'New Release', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Toggle partial query', exact: true }).click();
  await widget.getByRole('button', { name: 'Retry discovery' }).click();
  await expect(widget.getByRole('button', { name: 'New Release', exact: true })).toBeEnabled();
  await expect(page.locator('#metrics')).toContainText('Active subscriptions: 1');
});

test('recovers a corrupt journal only after confirmed discard, preserving it on cancel or storage failure', async ({
  page,
}) => {
  const widget = page.frameLocator('iframe');
  await page.evaluate(() =>
    (
      window as unknown as { releaseHarness: { corruptJournal(): void } }
    ).releaseHarness.corruptJournal()
  );
  await widget.getByRole('button', { name: 'New Release', exact: true }).click();
  await expect(
    widget.getByRole('heading', { name: 'Saved publication could not be validated' })
  ).toBeVisible();
  await widget.getByRole('button', { name: 'Retry recovery', exact: true }).click();
  await expect(widget.getByRole('alert')).toContainText('invalid');
  await widget.getByRole('button', { name: 'Discard local recovery data', exact: true }).click();
  await expect(
    widget.getByText('Discarding local recovery data does not undo', { exact: false })
  ).toBeVisible();
  await widget.getByRole('button', { name: 'Keep recovery data', exact: true }).click();
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { releaseHarness: { hasJournal: boolean } }).releaseHarness.hasJournal
    )
  ).toBe(true);
  await page.evaluate(() =>
    (window as unknown as { releaseHarness: { failDiscard(): void } }).releaseHarness.failDiscard()
  );
  await widget.getByRole('button', { name: 'Discard local recovery data', exact: true }).click();
  await widget.getByRole('button', { name: 'Confirm discard', exact: true }).click();
  await expect(widget.getByRole('alert')).toHaveText('Synthetic storage failure');
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { releaseHarness: { hasJournal: boolean } }).releaseHarness.hasJournal
    )
  ).toBe(true);
  await widget.getByRole('button', { name: 'Confirm discard', exact: true }).click();
  await expect(
    widget
      .getByRole('combobox', { name: 'Authenticated pipeline run', exact: true })
      .locator('option')
  ).toHaveCount(2);
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { releaseHarness: { hasJournal: boolean } }).releaseHarness.hasJournal
    )
  ).toBe(false);
  await expect(page.locator('#metrics')).toContainText('publish attempts: 0');
});

test('stops same-session resume after app revocation and exposes recovery when reopened', async ({
  page,
}) => {
  const widget = page.frameLocator('iframe');
  await page.getByRole('button', { name: 'Fail next publication', exact: true }).click();
  await widget.getByRole('button', { name: 'New Release', exact: true }).click();
  await widget
    .getByRole('combobox', { name: 'Application', exact: true })
    .selectOption({ index: 1 });
  await widget.getByLabel('Version', { exact: true }).fill('2');
  await widget
    .getByRole('combobox', { name: 'Authenticated pipeline run', exact: true })
    .selectOption({ index: 1 });
  await widget
    .getByLabel('Verify local file')
    .setInputFiles({
      name: 'fixture.bin',
      mimeType: 'application/octet-stream',
      buffer: Buffer.from('test'),
    });
  await widget.getByRole('checkbox', { name: 'Include fixture.bin' }).check();
  await widget.getByRole('button', { name: 'Publish Release', exact: true }).click();
  await expect(widget.getByRole('alert')).toContainText('Synthetic relay timeout');
  await page.getByRole('button', { name: 'Revoke application', exact: true }).click();
  await widget.getByRole('button', { name: 'Resume publication', exact: true }).click();
  await expect(widget.getByRole('alert')).toContainText('application links');
  await expect(page.locator('#metrics')).toContainText('publish attempts: 1');
  await widget.getByRole('button', { name: '← Releases', exact: true }).click();
  await widget.getByRole('button', { name: 'New Release', exact: true }).click();
  await expect(
    widget.getByRole('heading', { name: 'Saved publication could not be validated' })
  ).toBeVisible();
  await widget.getByRole('button', { name: 'Discard local recovery data', exact: true }).click();
  await widget.getByRole('button', { name: 'Confirm discard', exact: true }).click();
  await expect(
    widget
      .getByRole('combobox', { name: 'Authenticated pipeline run', exact: true })
      .locator('option')
  ).toHaveCount(2);
  await expect(page.locator('#metrics')).toContainText('publish attempts: 1');
});

test('keeps detail authority live through replacement and revocation, including delayed assets', async ({
  page,
}) => {
  const widget = page.frameLocator('iframe');
  await widget.locator('.release-card').click();
  await expect(widget.getByRole('link', { name: 'Download', exact: true })).toBeVisible();
  await expect(page.locator('#metrics')).toContainText('Active subscriptions: 1');
  await page.getByRole('button', { name: 'Replace release', exact: true }).click();
  await expect(widget.getByRole('heading', { name: 'Replacement notes' })).toBeVisible();
  await expect(widget.getByText('This release was replaced.', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Revoke application', exact: true }).click();
  await expect(widget.getByRole('alert')).toContainText('no longer authorized');
  await expect(widget.getByRole('link', { name: 'Download', exact: true })).toHaveCount(0);
  await expect(widget.getByText('Verified metadata publisher:', { exact: false })).toHaveCount(0);

  await page.reload();
  await page.evaluate(() =>
    (window as unknown as { releaseHarness: { holdAssets(): void } }).releaseHarness.holdAssets()
  );
  await widget.locator('.release-card').click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as { releaseHarness: { pendingAssets: number } }).releaseHarness
            .pendingAssets
      )
    )
    .toBeGreaterThan(0);
  await page.getByRole('button', { name: 'Revoke application', exact: true }).click();
  await expect(widget.getByRole('alert')).toContainText('no longer authorized');
  await page.evaluate(() =>
    (
      window as unknown as { releaseHarness: { resolveAssets(): void } }
    ).releaseHarness.resolveAssets()
  );
  await expect(widget.getByRole('link', { name: 'Download', exact: true })).toHaveCount(0);
  await expect(widget.getByRole('alert')).toContainText('no longer authorized');
});

test('keeps filenames readable and confines mobile overflow to the asset table', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const widget = page.frameLocator('iframe');
  await widget.locator('.release-card').click();
  await expect(widget.locator('.col-filename')).toContainText('fixture.bin');
  const size = await widget.locator('.col-filename').boundingBox();
  expect(size?.width).toBeGreaterThan(140);
  expect(await widget.locator('html').evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(
    true
  );
  expect(
    await widget
      .getByRole('region', { name: /Release assets/ })
      .evaluate((el) => el.scrollWidth > el.clientWidth)
  ).toBe(true);
});

test('does not reuse a stale file-check result after retrying asset metadata', async ({ page }) => {
  const widget = page.frameLocator('iframe');
  await page.getByRole('button', { name: 'Toggle partial query', exact: true }).click();
  await widget.locator('.release-card').click();
  await expect(widget.getByRole('button', { name: 'Retry assets', exact: true })).toBeVisible();
  await widget.locator('body').evaluate(() => {
    const read = Blob.prototype.arrayBuffer;
    let first = true;
    Blob.prototype.arrayBuffer = async function () {
      const bytes = await read.call(this);
      if (first) {
        first = false;
        await new Promise<void>((resolve) =>
          Object.assign(window, { releasePendingFileRead: resolve })
        );
      }
      return bytes;
    };
  });
  await widget.getByLabel('Verify local file').setInputFiles({
    name: 'fixture.bin',
    mimeType: 'application/octet-stream',
    buffer: Buffer.from('test'),
  });
  await expect
    .poll(() => widget.locator('body').evaluate(() => 'releasePendingFileRead' in window))
    .toBe(true);
  await widget.getByRole('button', { name: 'Retry assets', exact: true }).click();
  await widget.getByLabel('Verify local file').setInputFiles({
    name: 'other.bin',
    mimeType: 'application/octet-stream',
    buffer: Buffer.from('evil'),
  });
  await expect(widget.getByRole('status')).toContainText('mismatch');
  await widget.locator('body').evaluate(async () => {
    (window as unknown as { releasePendingFileRead: () => void }).releasePendingFileRead();
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  });
  await expect(widget.getByRole('status')).toContainText('mismatch');
});
