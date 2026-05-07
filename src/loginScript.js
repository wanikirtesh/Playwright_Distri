async function runScript(page, config, result, browserId) {
  const {
    targetUrl = 'https://mn4sg3xappl501.ideasstg.int/solutions',
    username = 'sso@ideas.com',
    password = 'password'
  } = config;

  result.timings = result.timings || {};

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
    await page.goto(`${targetUrl}/group-pricing-evaluation#/p30001`,  { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForLoadState('domcontentloaded', { timeout: 30000 });
    await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
  }, browserId);

 
  result.groupPricingUrl = page.url();
  result.groupPricingTitle = await page.title().catch(() => 'N/A');
  const onGroupPricing = /group[-_ ]?pricing/i.test(result.groupPricingUrl)
    || await page.locator('text=/Group Pricing/i').first().isVisible().catch(() => false);
  setMetric(result, 'groupPricingReached', onGroupPricing ? 1 : 0);

  sumTimings(
    result,
    ['navigation', 'loginFormReady', 'typeUsername', 'typePassword', 'loginResponse', 'postLoginRendered', 'GroupPricingLandingPage'],
    'totalTime'
  );
}

module.exports = runScript;
