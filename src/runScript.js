
module.exports = {
  test: async ({ step, sync, metric, page, config, result, browserId }) => {
    const {
      targetUrl = 'https://www.google.com'
    } = config;

    // Navigate to URL
    await step('navigation', () =>
      page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 })
    );

    await sync('queryReady');

    // Type in search box
    await step('typeDelay', async () => {
      const searchSelector = await Promise.race([
        page.waitForSelector('textarea[name="q"]', { timeout: 5000 }).then(() => 'textarea[name="q"]').catch(() => null),
        page.waitForSelector('input[name="q"]',    { timeout: 5000 }).then(() => 'input[name="q"]').catch(() => null),
        page.waitForSelector('[role="combobox"]',  { timeout: 5000 }).then(() => '[role="combobox"]').catch(() => null),
      ].filter(Boolean));
      const sel = searchSelector || 'input[name="q"]';
      await page.fill(sel, "Playwright");
    });

    // Submit search in sync across all browsers/VMs.
    await sync('preSearch');
    await step('searchResponse', async () => {
      await page.keyboard.press('Enter');
      await page.waitForLoadState('domcontentloaded', { timeout: 30000 });
    });

    // Wait for results
    await step('resultsRendered', () =>
      page.waitForSelector('#search, #rso, .g', { timeout: 15000 }).catch(() => {})
    );
  },
};
