// rotate_clicks_auth_proxies.js
// npm i puppeteer axios
// node rotate_clicks_auth_proxies.js

const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

const CONCURRENT_BROWSERS = 12;  // <= set this to how many parallel run() instances you want

const TARGET_URL = 'https://www.newsobserver.com/living/food-drink/article312455820.html';

// List proxies in 2captcha-style URL form (protocol optional):
// e.g. https://username:password@ip:port
const PROXIES = [
  'https://u7b01a970566505c1-zone-custom-region-us-st-northcarolina:u7b01a970566505c1@170.106.118.114:2334',
];

const CLICKS_PER_PROXY = 3;       // not used to change logic here (rotation occurs after a successful click)
const TOTAL_CLICKS = 2000;
const HEADLESS = false;
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36';

const LOG_CSV = path.resolve(__dirname, 'click_log.csv');
const axios = require('axios');

const TWO_CAPTCHA_API_KEY = 'YOUR_2CAPTCHA_API_KEY';

// ensure log header
if (!fs.existsSync(LOG_CSV)) {
  fs.writeFileSync(LOG_CSV, 'timestamp,proxy,click_number,click_result,notes\n', { encoding: 'utf8' });
}

function delay(ms) {
  return new Promise((res) => setTimeout(res, ms));
}

/**
 * Accepts:
 *  - https://username:password@host:port
 *  - http://username:password@host:port
 *  - username:password@host:port
 *  - host:port:username:password (legacy colon style)
 *
 * Returns { server: 'host:port', auth: { username, password }, raw }
 */
function parseProxyEntry(entry) {
  if (!entry || typeof entry !== 'string') return null;
  let s = entry.trim();

  // Strip leading protocol if present
  s = s.replace(/^\s*https?:\/\//i, '');

  // If it contains '@', attempt username:password@host:port
  if (s.includes('@')) {
    const atIndex = s.lastIndexOf('@');
    const authPart = s.slice(0, atIndex);
    const hostPart = s.slice(atIndex + 1);

    const authSplit = authPart.split(':');
    const hostSplit = hostPart.split(':');

    if (authSplit.length >= 2 && hostSplit.length >= 2) {
      const username = authSplit.slice(0, authSplit.length - 1).join(':');
      const password = authSplit[authSplit.length - 1];
      const host = hostSplit.slice(0, hostSplit.length - 1).join(':');
      const port = hostSplit[hostSplit.length - 1];
      if (username && password && host && port) {
        return { server: `${host}:${port}`, auth: { username, password }, raw: entry };
      }
    }
  }

  // Fallback legacy colon style: host:port:username:password
  const parts = s.split(':');
  if (parts.length >= 4) {
    const password = parts.pop();
    const username = parts.pop();
    const port = parts.pop();
    const host = parts.join(':');
    return { server: `${host}:${port}`, auth: { username, password }, raw: entry };
  }

  return null;
}

async function launchWithProxy(proxy) {
  // proxy.server is host:port (no protocol). We'll use http://host:port for Chromium arg.
  const serverArg = `http://${proxy.server}`;
  const args = [`--proxy-server=${serverArg}`, '--no-sandbox', '--disable-setuid-sandbox'];

  const browser = await puppeteer.launch({
    headless: HEADLESS,
    args,
    ignoreHTTPSErrors: true,
    defaultViewport: null
  });
  return browser;
}

async function safeClearStorage(page) {
  try {
    const cookies = await page.cookies();
    if (cookies && cookies.length) await page.deleteCookie(...cookies);
  } catch (e) {
    console.warn('Could not delete cookies:', e.message);
  }
  try {
    await page.evaluate(() => {
      try {
        localStorage.clear();
      } catch (e) {}
      try {
        sessionStorage.clear();
      } catch (e) {}
    });
  } catch (e) {
    console.warn('Could not clear storage via page.evaluate():', e.message);
  }
}

async function handleCookieConsent(page) {
  try {
    await delay(1000);
    const clicked = await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('button'));
      for (const btn of buttons) {
        const text = btn.innerText?.trim().toLowerCase();
        if (text && (text.includes('accept all') || text.includes('agree and close') || text.includes('continue with essential') || text.includes('accept'))) {
          try {
            btn.click();
          } catch (e) {}
          return true;
        }
      }
      return false;
    });

    if (clicked) {
      console.log('-> Clicked cookie consent button.');
      await delay(1000);
    } else {
      console.log('-> No cookie consent button found.');
    }
    return clicked;
  } catch (err) {
    console.warn('-> Error while handling cookie modal:', err.message);
    return false;
  }
}

/* -----------------------
   KEEP YOUR findAndClickGenRamen LOGIC EXACTLY
   ----------------------- */
async function findAndClickGenRamen(page) {
  const MAX_RETRIES = 15;
  const RETRY_DELAY = 2000;
  for (let i = 0; i < MAX_RETRIES; i++) {
    try {
      await page.evaluate(() => window.scrollBy(0, 300));
      const beopWidget = await page.$('beop-widget');
      if (!beopWidget) {
        console.log(`Attempt ${i + 1}: <beop-widget> not found`);
        await delay(RETRY_DELAY);
        continue;
      }

      const shadowRoot = await beopWidget.evaluateHandle((el) => el.shadowRoot).catch(() => null);
      if (!shadowRoot) {
        console.log(`Attempt ${i + 1}: shadowRoot not ready`);
        await delay(RETRY_DELAY);
        continue;
      }

      const choiceHandles = await shadowRoot.evaluateHandle((root) =>
        Array.from(root.querySelectorAll('.BeOp__QuestionChoiceTextBlock'))
      );
      const props = await choiceHandles.getProperties();

      for (const h of props.values()) {
        const txt = await (await h.getProperty('innerText')).jsonValue();
        if (txt && txt.trim().toLowerCase().includes('gen ramen')) {
          console.log(`✅ Found and clicked choice: "${txt.trim()}"`);
          await h.click();
          await delay(7000); // wait for captcha to appear
          return true;
        }
      }

      console.log(`Attempt ${i + 1}: "Gen Ramen" not visible yet`);
      await delay(RETRY_DELAY);
    } catch (err) {
      console.log(`Attempt ${i + 1} error: ${err.message}`);
      await delay(RETRY_DELAY);
    }
  }
  return false;
}
/* -----------------------
   end unchanged function
   ----------------------- */

function logClick(proxyRaw, clickNumber, result, notes = '') {
  const ts = new Date().toISOString();
  const line = `${ts},"${proxyRaw}",${clickNumber},${result},"${String(notes).replace(/"/g, '""')}"\n`;
  fs.appendFileSync(LOG_CSV, line, 'utf8');
}

async function run() {
  const parsed = PROXIES.map(parseProxyEntry).filter(Boolean);
  if (parsed.length === 0) {
    console.error('No valid proxy entries found.');
    return;
  }

  let clicksDone = 0;
  let proxyIndex = 0;

  while (clicksDone < TOTAL_CLICKS) {
    const proxy = parsed[proxyIndex % parsed.length];
    console.log(`\n[*] Using proxy ${proxy.server} (user=${proxy.auth?.username || 'none'})`);

    let browser;
    try {
      browser = await launchWithProxy(proxy);
      const page = await browser.newPage();
      await page.setUserAgent(USER_AGENT);
      await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });
      page.setDefaultNavigationTimeout(30000);

      // set proxy auth on this page if provided
      if (proxy.auth && proxy.auth.username) {
        try {
          await page.authenticate(proxy.auth);
        } catch (e) {
          // ignore auth errors (some environments handle it differently)
        }
      }

      await safeClearStorage(page);

      try {
        await page.goto(TARGET_URL, { waitUntil: 'networkidle2', timeout: 30000 });
        try {
          await page.waitForSelector('.osano-cm-accept-all', { timeout: 5000 });
          await page.click('.osano-cm-accept-all');
          console.log('-> Clicked Osano cookie banner "Accept All"');
          await delay(1000);
        } catch {
          console.log('-> Osano cookie banner not found or already dismissed.');
        }

        await handleCookieConsent(page);
      } catch (e) {
        console.warn('[!] Navigation failed:', e.message);
      }

      // --- Try clicking "Gen Ramen" ---
      const found = await findAndClickGenRamen(page);

      if (found) {
        clicksDone++;
        console.log(`  -> Clicked "Gen Ramen" (#${clicksDone}) via ${proxy.server}`);
        logClick(proxy.raw, clicksDone, 'success', 'clicked');

        // --- After the click, check for MTCaptcha ---
        await delay(10000); // give page time for captcha to load
        const mtCaptchaAppeared = await page.evaluate(() => {
          return !!document.querySelector('iframe[src*="mtcaptcha"], div[id*="mtcaptcha"], .mtcaptcha');
        });

        if (mtCaptchaAppeared) {
          console.log(`[⚠️] MTCaptcha detected after click on ${proxy.server}.`);
          logClick(proxy.raw, clicksDone, 'captcha-detected', 'after-click');
        } else {
          console.log(`[✅] No MTCaptcha appeared — rotating to next proxy.`);
          logClick(proxy.raw, clicksDone, 'success', 'no-captcha-after-click');
        }

        await browser.close();
        proxyIndex++; // move to next proxy after one click
        continue; // skip rest of loop
      } else {
        console.warn(`  -> "Gen Ramen" not found — retrying...`);
        logClick(proxy.raw, clicksDone + 1, 'fail', 'button-not-found');
      }

      await browser.close();
    } catch (err) {
      console.error(`[!] Error with proxy ${proxy.server}:`, err.message || err);
    } finally {
      try {
        if (browser) await browser.close();
      } catch (_) {}
    }

    proxyIndex++;
    await delay(500 + Math.floor(Math.random() * 1000));
  }

  console.log('\nAll done. Clicks completed:', clicksDone);
}

// launch multiple run() instances concurrently (preserves your logic)
async function main() {
  const tasks = [];
  for (let i = 0; i < CONCURRENT_BROWSERS; i++) {
    tasks.push(run());
    await delay(1000); // small stagger
  }
  await Promise.all(tasks);
  console.log('\n✅ All concurrent browser instances finished.');
}

main().catch((err) => {
  console.error('Fatal error in main():', err);
  process.exit(1);
});
