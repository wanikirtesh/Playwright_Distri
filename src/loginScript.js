
const bData = { 
  "my-machine-browser-1": {"viewId":"9298", "properties":30},
  "my-machine-browser-2": {"viewId":"13918","properties":30},
  "my-machine-browser-3": {"viewId":"13919","properties":30},
  "my-machine-browser-4": {"viewId":"13920","properties":30},
  "my-machine-browser-5": {"viewId":"13921","properties":30} };
async function runScript(page, config, result, browserId) {
  const {
    targetUrl = 'https://mn4sg3xappl501.ideasstg.int/solutions',
    username = 'sso@ideas.com',
    password = 'password'
  } = config;

  result.timings = result.timings || {};
  const tokenSelector = '#propertySelectorTokenField .v-button-link';
  const tokenWaitTimeoutMs = Number(config.propertyTokenTimeoutMs || 30000);

  const waitForTokenIncrease = async (minCount, timeoutMs) => {
    await page.waitForFunction(
      ({ sel, previousCount }) => document.querySelectorAll(sel).length > previousCount,
      { sel: tokenSelector, previousCount: minCount },
      { timeout: timeoutMs }
    );
  };

  // Hook network telemetry — must be installed before navigation
  trackNetwork(page, result);

  // ── Navigate to login URL ──
  await timed(result, 'navigation', () =>
    page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }),
    browserId
  );

  // ── Wait for login form to be ready ──
  await timed(result, 'loginFormReady', () =>
    page.waitForSelector('input[type="email"], input[name="username"], input[name="email"], input[id*="user" i], input[id*="email" i]', { timeout: 15000 }),
    browserId
  );

  await barrier(result, 'preLogin', { config, browserId });

  // ── Fill username ──
  await timed(result, 'typeUsername', async () => {
    const userSelector = await Promise.race([
      page.waitForSelector('input[type="email"]',       { timeout: 5000 }).then(() => 'input[type="email"]').catch(() => null),
      page.waitForSelector('input[name="username"]',    { timeout: 5000 }).then(() => 'input[name="username"]').catch(() => null),
      page.waitForSelector('input[name="email"]',       { timeout: 5000 }).then(() => 'input[name="email"]').catch(() => null),
      page.waitForSelector('input[id*="user" i]',       { timeout: 5000 }).then(() => 'input[id*="user" i]').catch(() => null),
      page.waitForSelector('input[id*="email" i]',      { timeout: 5000 }).then(() => 'input[id*="email" i]').catch(() => null),
    ].filter(Boolean));
    const sel = userSelector || 'input[name="username"]';
    await page.fill(sel, username);
  }, browserId);

  // ── Fill password ──
  await timed(result, 'typePassword', async () => {
    const sel = 'input[type="password"]';
    await page.waitForSelector(sel, { timeout: 10000 });
    await page.fill(sel, password);
  }, browserId);

  // ── Submit login (sync across all browsers/VMs) ──
  await barrier(result, 'preSubmit', { config, browserId });
  await timed(result, 'loginResponse', async () => {
    const submitSelector = await Promise.race([
      page.waitForSelector('button[type="submit"]', { timeout: 5000 }).then(() => 'button[type="submit"]').catch(() => null),
      page.waitForSelector('input[type="submit"]',  { timeout: 5000 }).then(() => 'input[type="submit"]').catch(() => null),
      page.waitForSelector('button:has-text("Sign in")', { timeout: 5000 }).then(() => 'button:has-text("Sign in")').catch(() => null),
      page.waitForSelector('button:has-text("Log in")',  { timeout: 5000 }).then(() => 'button:has-text("Log in")').catch(() => null),
    ].filter(Boolean));

    if (submitSelector) {
      await page.click(submitSelector);
    } else {
      await page.keyboard.press('Enter');
    }

    await page.waitForLoadState('domcontentloaded', { timeout: 30000 });
  }, browserId);

  // ── Wait for post-login landing ──
  await timed(result, 'postLoginRendered', async () => {
    await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
  }, browserId);

  // ── Capture post-login state ──
  result.finalUrl = page.url();
  result.pageTitle = await page.title().catch(() => 'N/A');

  const passwordStillVisible = await page.$('input[type="password"]').then(el => !!el).catch(() => false);
  result.loginSuccess = !passwordStillVisible;
  setMetric(result, 'loginSuccess', result.loginSuccess ? 1 : 0);

  // ── Navigate: Manage → Group Pricing ──
  await barrier(result, 'preGroupNavigation', { config, browserId });

  await timed(result, 'GroupPricingLandingPage', async () => {
    await page.goto(`${targetUrl}/group-pricing-evaluation#/pg${bData[browserId].viewId}`,  { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForLoadState('domcontentloaded', { timeout: 30000 });
    await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
  }, browserId);

  // Verify title without expect() — use waitForFunction instead
  const titleMatches = await page.evaluate(() => /IDeaS G3 - Group Pricing/i.test(document.title));
  if (!titleMatches) console.warn('[SCRIPT] Warning: page title does not match expected pattern');
  
  await page.getByRole('button', { name: 'New Evaluation' }).waitFor({ state: 'visible', timeout: 30_000 });

  // 4. Click the 'New Evaluation' button to open the overlay
  await page.getByRole('button', { name: 'New Evaluation' }).click();
  // Wait for the dialog (rendered into v-overlay-container) to appear.
  await page.locator('#propertySelectorTokenField').waitFor({ state: 'visible' });

  for (let i = 0; i < bData[browserId].properties; i++) {
      const propInput = page.locator('#propertySelectorTokenField input.v-filterselect-input');
      await propInput.waitFor({ state: 'visible' });
      const beforeCount = await page.locator(tokenSelector).count();
      await propInput.click();
      await propInput.press(`P`,{ delay: 80 });
      const popupItems = page.locator('.v-filterselect-suggestpopup td.gwt-MenuItem');
      // The first row is a blank placeholder; the first real option is at index 1.
      await popupItems.nth(1).waitFor({ state: 'visible' });
      await popupItems.nth(1).click();
      // Wait for Vaadin roundtrip to materialize a new token; retry with another option if needed.
      try {
        await waitForTokenIncrease(beforeCount, tokenWaitTimeoutMs);
      } catch {
        const fallbackIndex = 2;
        await propInput.click();
        await propInput.press(`P`, { delay: 80 });
        await popupItems.nth(fallbackIndex).waitFor({ state: 'visible', timeout: 5000 });
        await popupItems.nth(fallbackIndex).click();
        await waitForTokenIncrease(beforeCount, tokenWaitTimeoutMs);
      }
    }

    const groupName = `AutoEval-${Date.now()}`;
    await page.locator('#groupNameField').fill(groupName);
   
    // 7. Open Market Segment dropdown and select the first option
    await page.locator('#marketSegmentField input').click();
    const marketItems = page.locator('.v-filterselect-suggestpopup td.gwt-MenuItem');
    await marketItems.first().waitFor({ state: 'visible' });
    await marketItems.first().click();

    const day30 = page.locator('.v-window td:not(.date-out-of-range) .v-calendar-month-day', {
      has: page.locator('.v-calendar-day-number', { hasText: /^30$/ })
    }).first();
    await day30.click();

    const roomsField = page.locator('#roomsField');
    await roomsField.click();
    await page.keyboard.press('5');
    await page.keyboard.press('Enter');
    await barrier(result, 'groupEvaluation', { config, browserId });

  await timed(result, 'GroupEvaluation', async () => {
      await page.locator('#detailsSaveButton').click();
      await page.waitForLoadState('domcontentloaded', { timeout: 30000 });
      await Promise.race([
       page.locator('.functionspace-result').waitFor({ state: 'attached', timeout: 300_000 }),
       page.locator('.v-Notification-error').waitFor({ state: 'attached', timeout: 300_000 }),
      ]);
    }, browserId);
   

 
  result.groupPricingUrl = page.url();
  result.groupPricingTitle = await page.title().catch(() => 'N/A');
  const onGroupPricing = /group[-_ ]?pricing/i.test(result.groupPricingUrl)
    || await page.locator('.functionspace-result').first().isVisible().catch(() => false);
  setMetric(result, 'groupPricingReached', onGroupPricing ? 1 : 0);

  sumTimings(
    result,
    ['navigation', 'loginFormReady', 'typeUsername', 'typePassword', 'loginResponse', 'postLoginRendered', 'GroupPricingLandingPage','GroupEvaluation'],
    'totalTime'
  );
}

module.exports = runScript;
