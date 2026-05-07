async function runScript(page, config, result, browserId) {
  const {
    searchQuery = 'Playwright',
    targetUrl = 'https://www.google.com'
  } = config;

  result.timings = result.timings || {};

  // Hook network telemetry — must be installed before navigation
  trackNetwork(page, result);

  // ── Navigate to URL ──
  await timed(result, 'navigation', () =>
    page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }),
    browserId
  );

	await barrier(result, 'queryReady', { config, browserId });
  // ── Type in search box ──
  await timed(result, 'typeDelay', async () => {
    const searchSelector = await Promise.race([
      page.waitForSelector('textarea[name="q"]', { timeout: 5000 }).then(() => 'textarea[name="q"]').catch(() => null),
      page.waitForSelector('input[name="q"]',    { timeout: 5000 }).then(() => 'input[name="q"]').catch(() => null),
      page.waitForSelector('[role="combobox"]',  { timeout: 5000 }).then(() => '[role="combobox"]').catch(() => null),
    ].filter(Boolean));
    const sel = searchSelector || 'input[name="q"]';
    await page.fill(sel, searchQuery);
  }, browserId);

  // ── Submit search ──
  // Sync up across all browsers/VMs so the search submit hits Google at the
  // same moment (fail-open: any laggard past the timeout is left behind).
  await barrier(result, 'preSearch', { config, browserId });
  await timed(result, 'searchResponse', async () => {
    await page.keyboard.press('Enter');
    await page.waitForLoadState('domcontentloaded', { timeout: 30000 });
  }, browserId);

  // ── Wait for results ──
  await timed(result, 'resultsRendered', () =>
    page.waitForSelector('#search, #rso, .g', { timeout: 15000 }).catch(() => {}),
    browserId
  );

  // ── Capture result count ──
  result.resultStats = await page.$eval('#result-stats', el => el.innerText).catch(() => 'N/A');

  // ── Capture top 3 result titles ──
  result.topResults = await page.$$eval('h3', els =>
    els.slice(0, 3).map(el => el.innerText.trim()).filter(Boolean)
  ).catch(() => []);
  setMetric(result, 'itemsScraped', result.topResults.length);

  sumTimings(result, ['navigation', 'searchResponse', 'resultsRendered'], 'totalTime');
}

module.exports = runScript;