# Minimal Test Module Pattern

**Zero boilerplate. Auto-everything.**

## Complete Example

```javascript
// src/myTest.js
module.exports = {
  test: async ({ step, sync, metric, page, config, result, browserId }) => {
    const { targetUrl = 'https://example.com' } = config;

    // 1. Steps auto-discover timing keys
    await step('pageLoad', () => page.goto(targetUrl));
    
    // 2. Barriers sync across all browsers/VMs
    await sync('ready');
    
    // 3. Metrics auto-initialize on first call
    await step('interact', async () => {
      await page.click('button');
      metric('clickCount', 1);
    });

    // 4. Capture any additional data
    result.pageTitle = await page.title();
  },
};
```

## What's Auto-Handled

| Feature | Auto? | How |
|---------|-------|-----|
| **Test name** | ✅ | Derived from filename (`myTest.js` → `myTest`) |
| **Timing keys** | ✅ | Discovered from `step()` calls you execute |
| **Metrics** | ✅ | Initialized on first `metric()` call |
| **Network tracking** | ✅ | Enabled by default |
| **Report grouping** | ✅ | Metrics grouped by test name in output |
| **Request counting** | ✅ | Tracked automatically |
| **Error handling** | ✅ | Failures captured with stack traces |

## What You Write

**Just the test logic:**
```javascript
{
  test: async ({ step, sync, metric, page, config, result, browserId }) => {
    // Your Playwright code here
    // Step 1: Navigate
    // Step 2: Interact
    // Step 3: Measure
    // Done!
  }
}
```

**No need to specify:**
- ~~`name: 'myTest'`~~ (auto-derived)
- ~~`defaultMetrics: { ... }`~~ (auto-initialized)
- ~~`timingKeys: [...]`~~ (auto-discovered)

## Report Output Example

```
[TEST: myTest]
  My Test.Page Load       427ms
  My Test.Click Count       5
  My Test.Page Title      "Example"

[TEST: anotherTest]
  Another Test.Setup      892ms
  Another Test.Verify      15ms
```

## Bundling Multiple Tests

```bash
node coordinator/coordinator.js \
  --script=src/mainTest.js \
  --modules=src/module1.js,src/module2.js \
  --iterations=1 --vms local --browsers 2
```

Each module runs sequentially on the same browser instance:
1. module1 executes → metrics captured with `[TEST: module1]` prefix
2. module2 executes → metrics captured with `[TEST: module2]` prefix
3. mainTest executes → metrics captured with `[TEST: mainTest]` prefix

---

## Framework API Reference

### `step(name, fn)`
Wraps an operation with timing. Auto-discovered in reports.
```javascript
await step('load', () => page.goto(url));
```

### `sync(barrier)`
Cross-browser/VM synchronization point. All browsers wait here.
```javascript
await sync('allReady');
```

### `metric(name, value)`
Record a custom metric (counter or gauge).
```javascript
metric('itemCount', 42);
```

### `count(name)`
Increment a counter.
```javascript
count('errors');  // errors: 1
```

### `result`
Store arbitrary test output for inclusion in final report.
```javascript
result.pageTitle = await page.title();
result.itemsFound = items.length;
```

### `config`
Destructure test parameters:
```javascript
const { targetUrl = 'https://example.com' } = config;
```

---

## That's It!

Write your test logic in Playwright. Let the framework handle metrics, naming, timing, and reporting. 🎯
