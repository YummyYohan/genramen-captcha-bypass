

// rotate_clicks_auth_proxies.js
// npm i puppeteer
// node rotate_clicks_auth_proxies.js

const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const CONCURRENT_BROWSERS = 10;  // adjust to your CPU/network capacity


const TARGET_URL = 'https://www.newsobserver.com/living/food-drink/article312455820.html';

// Your proxies: host:port:username:password (you provided these)
const PROXIES = [
    'pm0.prxgo.com:7778:rotating:KTlb72ow4IVF2jUP',
];

const CLICKS_PER_PROXY = 2;       // rotate every 2 clicks
const TOTAL_CLICKS = 36;          // adjust to how many total clicks you need
const HEADLESS = false;           // false while testing so you can watch
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36';

const LOG_CSV = path.resolve(__dirname, 'click_log.csv');
const axios = require('axios');

const TWO_CAPTCHA_API_KEY = 'YOUR_2CAPTCHA_API_KEY';


// Helper: append CSV header if missing
if (!fs.existsSync(LOG_CSV)) {
    fs.writeFileSync(LOG_CSV, 'timestamp,proxy,click_number,click_result,notes\n', { encoding: 'utf8' });
}

function delay(ms) { return new Promise(res => setTimeout(res, ms)); }

function parseProxyEntry(entry) {
    // entry must be host:port:username:password
    const parts = entry.split(':');
    if (parts.length < 4) return null;
    const password = parts.pop();
    const username = parts.pop();
    const port = parts.pop();
    const host = parts.join(':'); // supports hostnames without extra colons
    return {
        server: `${host}:${port}`,
        auth: { username, password },
        raw: entry
    };
}

async function launchWithProxy(proxy) {
    // proxy.server = host:port
    const serverArg = `http://${proxy.server}`;
    const args = [
        `--proxy-server=${serverArg}`,
        '--no-sandbox',
        '--disable-setuid-sandbox'
    ];

    const browser = await puppeteer.launch({
        headless: HEADLESS,
        args,
        ignoreHTTPSErrors: true
        // Option: add executablePath if you want to force system Chrome
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
        await page.evaluate(() => { try { localStorage.clear(); } catch (e) { } try { sessionStorage.clear(); } catch (e) { } });
    } catch (e) {
        console.warn('Could not clear storage via page.evaluate():', e.message);
    }
}

async function queryShadowSelector(page, selectorChain) {
    // selectorChain is like: ['beop-widget', '.BeOp__QuestionChoiceTextBlock']
    return await page.evaluateHandle((selectors) => {
        let el = document;
        for (const sel of selectors) {
            el = el.querySelector(sel);
            if (!el) return null;
            if (el.shadowRoot) el = el.shadowRoot;
        }
        return el;
    }, selectorChain);
}

async function handleCookieConsent(page) {
    try {
        // Wait up to 5s for any consent modal to appear
        await new Promise(res => setTimeout(res, 1000));

        const clicked = await page.evaluate(() => {
            const buttons = Array.from(document.querySelectorAll('button'));
            for (const btn of buttons) {
                const text = btn.innerText?.trim().toLowerCase();
                if (text && (text.includes('accept all') || text.includes('agree and close') || text.includes('continue with essential'))) {
                    btn.click();
                    return true;
                }
            }
            return false;
        });

        if (clicked) {
            console.log('-> Clicked cookie consent button.');
            await new Promise(res => setTimeout(res, 1000));
        } else {
            console.log('-> No cookie consent button found.');
        }

        return clicked;
    } catch (err) {
        console.warn('-> Error while handling cookie modal:', err.message);
        return false;
    }
}




async function findAndClickGenRamen(page) {
    const MAX_RETRIES = 22;
    const RETRY_DELAY = 2000;
    for (let i = 0; i < MAX_RETRIES; i++) {
        try {
            await page.evaluate(() => window.scrollBy(0, 300));
            const beopWidget = await page.$('beop-widget');
            if (!beopWidget) { console.log(`Attempt ${i + 1}: <beop-widget> not found`); await delay(RETRY_DELAY); continue; }

            const shadowRoot = await beopWidget.evaluateHandle(el => el.shadowRoot).catch(() => null);
            if (!shadowRoot) { console.log(`Attempt ${i + 1}: shadowRoot not ready`); await delay(RETRY_DELAY); continue; }

            const choiceHandles = await shadowRoot.evaluateHandle(root =>
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
        console.log(`\n[*] Using proxy ${proxy.server} (user=${proxy.auth.username})`);

        let browser;
        try {
            browser = await launchWithProxy(proxy);
            const page = await browser.newPage();
            await page.setUserAgent(USER_AGENT);
            await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });
            page.setDefaultNavigationTimeout(30000);
            try { await page.authenticate(proxy.auth); } catch (e) { }
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
                await delay(4000); // give page time for captcha to load
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
            console.error(`[!] Error with proxy ${proxy.server}:`, err.message);
            if (browser) await browser.close().catch(() => { });
        }

        proxyIndex++;
        await delay(500 + Math.floor(Math.random() * 1000));
    }


    console.log('\nAll done. Clicks completed:', clicksDone);
}

run().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});

async function main() {
    const tasks = [];
    for (let i = 0; i < CONCURRENT_BROWSERS; i++) {
        tasks.push(run());
        await delay(1000); // small stagger so they don't all start at once
    }
    await Promise.all(tasks);
    console.log('\n✅ All concurrent browser instances finished.');
}

main().catch(err => {
    console.error('Fatal error in main():', err);
    process.exit(1);
});
