
module.exports = {
  test: async ({ step, sync, metric, page, config, result, browserId }) => {
    const { searchQuery = 'GitHub' } = config;

    // Navigate to search engine
    await step('navigation', () =>
      page.goto('https://www.google.com', { waitUntil: 'domcontentloaded', timeout: 30000 })
    );

    await sync('searchReady');

    // Type search query
    await step('typeQuery', async () => {
      const searchSelector = 'input[name="q"]';
      await page.waitForSelector(searchSelector, { timeout: 5000 });
      await page.fill(searchSelector, searchQuery);
    });

    // Submit search
    await sync('preSubmitSearch');
    await step('submitSearch', async () => {
      await page.keyboard.press('Enter');
      await page.waitForLoadState('domcontentloaded', { timeout: 30000 });
    });

    // Wait for results
    await step('resultsReady', () =>
      page.waitForSelector('.g, [data-sokoban-container]', { timeout: 15000 }).catch(() => {})
    );

    // Capture results
    result.searchResultCount = await page.$$eval('.g, [data-sokoban-container]', els => els.length).catch(() => 0);
    metric('searchResultCount', result.searchResultCount);
  },
};
