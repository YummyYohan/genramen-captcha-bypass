// rotate_clicks_proxies.js
// npm i puppeteer axios
// node rotate_clicks_proxies.js

import fetch from "node-fetch";

const API_URL = "https://api.2captcha.com/createTask";
const CLIENT_KEY = "c366faaaac949cca97f9333134246398"; // <-- replace this

const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs');
const path = require('path');
const axios = require('axios');

puppeteer.use(StealthPlugin());

const TARGET_URL = 'https://www.newsobserver.com/living/food-drink/article312455820.html';

const { getWorkingProxies } = require('./test_proxies.js'); // save the above code as proxyUtils.js



async function fetchProxies() {
    // fetch working SOCKS4 proxies
    const proxies = await getWorkingProxies(); // returns only working proxies
    if (!proxies || proxies.length === 0) {
        console.error('[!] No working proxies available from test_proxies.js');
        return [];
    }
    console.log(`[+] Using ${proxies.length} working SOCKS4 proxies`);
    return proxies;
}


const CLICKS_PER_PROXY = 2;       // rotate every 2 clicks
const TOTAL_CLICKS = 500;          // adjust to how many total clicks you need
const HEADLESS = false;           // false while testing so you can watch

// A small sample of User-Agents (rotated per-proxy)
const USER_AGENTS = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.5993.117 Safari/537.36",
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
];

const LOG_CSV = path.resolve(__dirname, 'click_log.csv');
const CAPTCHA_FILE = path.resolve(__dirname, 'proxies_with_captcha.txt'); // proxies that had captcha but were NOT access denied

// Helper: append CSV header if missing
if (!fs.existsSync(LOG_CSV)) {
    fs.writeFileSync(LOG_CSV, 'timestamp,proxy,click_number,click_result,notes\n', { encoding: 'utf8' });
}

// Ensure captcha file exists
if (!fs.existsSync(CAPTCHA_FILE)) {
    fs.writeFileSync(CAPTCHA_FILE, '', { encoding: 'utf8' });
}

function delay(ms) { return new Promise(res => setTimeout(res, ms)); }

function parseProxyEntry(entry) {
    const parts = entry.split(':');
    if (parts.length === 2) {
        // No auth
        const [host, port] = parts;
        return { server: `${host}:${port}`, auth: null, raw: entry };
    } else if (parts.length >= 4) {
        const password = parts.pop();
        const username = parts.pop();
        const port = parts.pop();
        const host = parts.join(':');
        return { server: `${host}:${port}`, auth: { username, password }, raw: entry };
    } else {
        return null;
    }
}

function sanitizeFilenamePart(s) {
    return String(s).replace(/[^a-z0-9_\-\.]/gi, '_').slice(0, 80);
}

function cookieFilenameFor(proxy) {
    // prefer username if present, else server
    const id = proxy && proxy.auth && proxy.auth.username ? proxy.auth.username : proxy.server;
    return path.join(__dirname, `cookies_${sanitizeFilenamePart(id)}.json`);
}

function localStorageFilenameFor(proxy) {
    const id = proxy && proxy.auth && proxy.auth.username ? proxy.auth.username : proxy.server;
    return path.join(__dirname, `localStorage_${sanitizeFilenamePart(id)}.json`);
}

async function launchWithProxy(proxy) {
    const args = ['--no-sandbox', '--disable-setuid-sandbox'];

    if (proxy && proxy.server) {
        // Puppeteer expects protocol://host:port — here we force SOCKS4
        args.push(`--proxy-server=socks4://${proxy.server}`);
    }

    const browser = await puppeteer.launch({
        headless: HEADLESS,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox'
        ],
        ignoreHTTPSErrors: true,  // <-- this is key
        executablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
    });


    return browser;
}


async function proxyHealthCheck(proxy) {
    const [host, port] = proxy.server.split(':');
    const agent = {
        host,
        port: parseInt(port),
        auth: proxy.auth ? { username: proxy.auth.username, password: proxy.auth.password } : undefined,
        protocol: 'http'
    };

    try {
        const res = await axios.get('https://api.ipify.org?format=text', {
            proxy: agent,
            timeout: 3000  // 3 seconds max
        });
        return !!res.data;
    } catch (e) {
        return false;
    }
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

async function loadCookiesForProxy(page, proxy) {
    const fname = cookieFilenameFor(proxy);
    if (!fs.existsSync(fname)) return;
    try {
        const raw = fs.readFileSync(fname, 'utf8');
        const cookies = JSON.parse(raw);
        if (!Array.isArray(cookies) || cookies.length === 0) return;
        // set cookies before navigation
        await page.setCookie(...cookies);
        console.log(`-> Loaded ${cookies.length} cookies for ${proxy.server}`);
    } catch (e) {
        console.warn('Failed to load cookies:', e.message);
    }
}

async function loadLocalStorageForProxy(page, proxy) {
    const fname = localStorageFilenameFor(proxy);
    if (!fs.existsSync(fname)) return;
    try {
        const raw = fs.readFileSync(fname, 'utf8');
        const data = JSON.parse(raw);
        // localStorage is origin-bound — set it after we've navigated to the target origin
        if (data && Object.keys(data).length > 0) {
            await page.evaluate((obj) => {
                try {
                    for (const k of Object.keys(obj)) {
                        localStorage.setItem(k, obj[k]);
                    }
                } catch (e) { }
            }, data);
            console.log(`-> Restored localStorage for ${proxy.server}`);
        }
    } catch (e) {
        console.warn('Failed to load localStorage:', e.message);
    }
}

async function saveCookiesForProxy(page, proxy) {
    const fname = cookieFilenameFor(proxy);
    try {
        const cookies = await page.cookies();
        fs.writeFileSync(fname, JSON.stringify(cookies, null, 2), 'utf8');
        console.log(`-> Saved ${cookies.length} cookies for ${proxy.server} -> ${path.basename(fname)}`);
    } catch (e) {
        console.warn('Failed to save cookies:', e.message);
    }
}

async function saveLocalStorageForProxy(page, proxy) {
    const fname = localStorageFilenameFor(proxy);
    try {
        const data = await page.evaluate(() => {
            const out = {};
            try {
                for (let i = 0; i < localStorage.length; i++) {
                    const key = localStorage.key(i);
                    out[key] = localStorage.getItem(key);
                }
            } catch (e) { }
            return out;
        });
        fs.writeFileSync(fname, JSON.stringify(data, null, 2), 'utf8');
        console.log(`-> Saved localStorage for ${proxy.server} -> ${path.basename(fname)}`);
    } catch (e) {
        console.warn('Failed to save localStorage:', e.message);
    }
}

async function queryShadowSelector(page, selectorChain) {
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
            await new Promise(res => setTimeout(res, 1000));
        }
        return clicked;
    } catch (err) {
        console.warn('-> Error while handling cookie modal:', err.message);
        return false;
    }
}

async function findAndClickGenRamen(page) {
    try {
        await page.waitForSelector('beop-widget', { timeout: 10000 });

        const beopWidgetHandle = await page.$('beop-widget');
        if (!beopWidgetHandle) {
            return false;
        }

        const shadowRootHandle = await beopWidgetHandle.evaluateHandle(el => el.shadowRoot);
        if (!shadowRootHandle) {
            return false;
        }

        const matchingHandles = await shadowRootHandle.evaluateHandle(root => {
            return Array.from(root.querySelectorAll('.BeOp__QuestionChoiceTextBlock'));
        });

        const properties = await matchingHandles.getProperties();
        for (const handle of properties.values()) {
            const text = await (await handle.getProperty('innerText')).jsonValue();
            if (text.trim().toLowerCase().includes('gen ramen')) {
                await handle.click();
                await new Promise(resolve => setTimeout(resolve, 8000));
                return true;
            }
        }
        return false;
    } catch (err) {
        return false;
    }
}

function logClick(proxyRaw, clickNumber, result, notes = '') {
    const ts = new Date().toISOString();
    const line = `${ts},"${proxyRaw}",${clickNumber},${result},"${String(notes).replace(/"/g, '""')}"\n`;
    fs.appendFileSync(LOG_CSV, line, 'utf8');
}

function appendProxyIfMissing(filePath, proxyRaw) {
    try {
        const existing = fs.readFileSync(filePath, 'utf8').split(/\r?\n/).filter(Boolean);
        if (!existing.includes(proxyRaw)) {
            fs.appendFileSync(filePath, proxyRaw + '\n', 'utf8');
        }
    } catch (e) {
        console.warn('Could not write to captcha file:', e.message);
    }
}
// --- For Proxyless task ---
async function createMtCaptchaTaskProxyless() {
  const payload = {
    clientKey: CLIENT_KEY,
    task: {
      type: "MtCaptchaTaskProxyless",
      websiteURL: "https://service.mtcaptcha.com/mtcv1/demo/index.html",
      websiteKey: "MTPublic-DemoKey9M"
    }
  };

  const res = await fetch(API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });

  const data = await res.json();
  console.log(data);
}

// --- For Proxy-based task ---
async function createMtCaptchaTaskWithProxy() {
  const payload = {
    clientKey: CLIENT_KEY,
    task: {
      type: "MtCaptchaTask",
      websiteURL: "https://service.mtcaptcha.com/mtcv1/demo/index.html",
      websiteKey: "MTPublic-DemoKey9M",
      proxyType: "http",
      proxyAddress: "78.12.193.250",   // <-- your proxy IP
      proxyPort: "16010",              // <-- your proxy port
      proxyLogin: "user23",            // optional
      proxyPassword: "p4$w0rd"         // optional
    }
  };

  const res = await fetch(API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });

  const data = await res.json();
  console.log(data);
}

async function run() {
    createMtCaptchaTaskProxyless();

    const fetchedProxies = await fetchProxies();
    const parsed = fetchedProxies.map(parseProxyEntry).filter(Boolean);
    if (parsed.length === 0) {
        console.error('No valid proxies available.');
        return;
    }



    let clicksDone = 0;
    let proxyIndex = 0;

    while (clicksDone < TOTAL_CLICKS) {
        const proxy = parsed[proxyIndex % parsed.length];

        // --- rotate user agent per proxy run ---
        const USER_AGENT = USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];

        const username = proxy.auth?.username || 'none';
        console.log(`\n[*] Using proxy ${proxy.server} (user=${username}) with UA: ${USER_AGENT} for up to ${CLICKS_PER_PROXY} clicks.`);


        let browser;
        try {
            browser = await launchWithProxy(proxy);

            console.log(`[+] Proxy ${proxy.server} passed health check.`);

            const page = await browser.newPage();
            await page.setUserAgent(USER_AGENT);
            await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });
            page.setDefaultNavigationTimeout(30000);

            try { await page.authenticate(proxy.auth); } catch (e) { /* ignore */ }

            // Clear ephemeral storage, then load saved cookies (if any)
            try { await safeClearStorage(page); } catch (_) { }
            await loadCookiesForProxy(page, proxy);

            // Now navigate
            let navResponse = null;
            try {
                navResponse = await page.goto(TARGET_URL, { waitUntil: 'networkidle2', timeout: 30000 });
                // Try to click Osano banner if present
                try {
                    await page.waitForSelector('.osano-cm-accept-all', { timeout: 5000 });
                    await page.click('.osano-cm-accept-all');
                    await new Promise(res => setTimeout(res, 1000));
                } catch (_) { }
                await handleCookieConsent(page);
                // after cookie consent, restore localStorage if we have it
                await loadLocalStorageForProxy(page, proxy);
            } catch (e) {
                console.warn('[!] Navigation to target failed (will still try find/click):', e.message);
                // navResponse may be null here
            }

            // Check if page initially looked like Access Denied
            let initialAccessDenied = false;
            try {
                const status = navResponse ? navResponse.status() : null;
                if (status === 403) initialAccessDenied = true;
                const bodySnippet = await page.evaluate(() => document.body ? document.body.innerText.slice(0, 1000).toLowerCase() : '');
                if (bodySnippet && bodySnippet.includes('access denied')) initialAccessDenied = true;
            } catch (e) { /* ignore */ }

            if (initialAccessDenied) {
                console.warn(`-> Proxy ${proxy.server} got Access Denied on initial navigation. Skipping proxy.`);
                // log and skip this proxy without saving to captcha file
                logClick(proxy.raw, clicksDone + 1, 'fail', 'access-denied-initial');
                try { await page.close(); } catch (_) { }
                try { await browser.close(); } catch (_) { }
                proxyIndex++;
                await delay(500 + Math.floor(Math.random() * 1000));
                continue;
            }

            const clicksThisProxy = Math.min(CLICKS_PER_PROXY, TOTAL_CLICKS - clicksDone);

            // If a captcha appears at any point while using this proxy: save proxy to file (if not access denied) and rotate (stop using this proxy).
            let rotateProxyEarly = false;

            for (let i = 0; i < clicksThisProxy; i++) {
                const clickAttemptNumber = clicksDone + 1;

                // Detect MTCaptcha but DO NOT solve it. If found -> record proxy (only if NOT access denied) and rotate to next proxy.
                const mtCaptchaSiteKey = await page.evaluate(() => {
                    function deepFindSiteKey(root) {
                        if (!root) return null;
                        try {
                            const iframes = Array.from(root.querySelectorAll ? root.querySelectorAll('iframe') : []);
                            for (const iframe of iframes) {
                                if (iframe.src && iframe.src.includes('widget.collectiveaudience.co/mtcaptcha')) {
                                    try {
                                        const url = new URL(iframe.src);
                                        const key = url.searchParams.get('channel');
                                        if (key) return key;
                                    } catch (e) { }
                                    return 'unknown-sitekey';
                                }
                            }
                        } catch (e) { }

                        try {
                            const scripts = Array.from(root.querySelectorAll ? root.querySelectorAll('script[src*="mtcaptcha"]') : []);
                            for (const s of scripts) {
                                try {
                                    const u = new URL(s.src, window.location.href);
                                    const key = u.searchParams.get('sitekey');
                                    if (key) return key;
                                } catch (e) { }
                            }
                        } catch (e) { }

                        try {
                            const elWithKey = Array.from(root.querySelectorAll ? root.querySelectorAll('[data-sitekey], [data-mtcaptcha], [data-site-key]') : []);
                            for (const el of elWithKey) {
                                const candidates = [el.getAttribute('data-sitekey'), el.getAttribute('data-mtcaptcha'), el.getAttribute('data-site-key')].filter(Boolean);
                                if (candidates.length) return candidates[0];
                            }
                        } catch (e) { }

                        try {
                            const children = Array.from(root.querySelectorAll ? root.querySelectorAll('*') : []);
                            for (const c of children) {
                                if (c.shadowRoot) {
                                    const found = deepFindSiteKey(c.shadowRoot);
                                    if (found) return found;
                                }
                            }
                        } catch (e) { }

                        return null;
                    }

                    try {
                        const widgets = Array.from(document.querySelectorAll('beop-widget'));
                        for (const w of widgets) {
                            if (w.shadowRoot) {
                                const k = deepFindSiteKey(w.shadowRoot);
                                if (k) return k;
                            }
                        }
                    } catch (e) { }

                    return deepFindSiteKey(document);
                });

                if (mtCaptchaSiteKey) {
                    console.log('[⚠️] MTCaptcha detected — rotating proxy (no solving).');

                    // double-check page isn't Access Denied now (maybe different from initial)
                    let nowAccessDenied = false;
                    try {
                        const status = await (await page.goto(page.url(), { waitUntil: 'domcontentloaded', timeout: 8000 })).status();
                        if (status === 403) nowAccessDenied = true;
                    } catch (e) {
                        // If goto failed, try body check
                    }
                    try {
                        const body = await page.evaluate(() => document.body ? document.body.innerText.toLowerCase() : '');
                        if (body && body.includes('access denied')) nowAccessDenied = true;
                    } catch (e) { }

                    if (!nowAccessDenied) {
                        // Save proxy to captcha list (unique)
                        appendProxyIfMissing(CAPTCHA_FILE, proxy.raw);
                        logClick(proxy.raw, clickAttemptNumber, 'captcha-detected', 'saved-to-captcha-list');
                    } else {
                        logClick(proxy.raw, clickAttemptNumber, 'fail', 'access-denied-after-captcha-detected');
                    }

                    rotateProxyEarly = true;
                    break; // break clicks loop to rotate to next proxy
                } else {
                    console.log('[i] No MTCaptcha detected on this page.');
                }

                // Attempt the Gen Ramen click as before
                const found = await findAndClickGenRamen(page);
                if (found) {
                    clicksDone++;
                    console.log(`  -> Clicked Gen Ramen (#${clicksDone}) via ${proxy.server}`);
                    logClick(proxy.raw, clickAttemptNumber, 'success', 'clicked');

                    // save cookies/localStorage after successful action to persist session
                    try {
                        await saveCookiesForProxy(page, proxy);
                        await saveLocalStorageForProxy(page, proxy);
                    } catch (e) {
                        console.warn('Error saving session data:', e.message || e);
                    }

                } else {
                    console.warn(`  -> Gen Ramen button not found (attempt ${clickAttemptNumber}).`);
                    await delay(1200);
                    const retry = await findAndClickGenRamen(page);
                    if (retry) {
                        clicksDone++;
                        console.log(`  -> Retry click succeeded (#${clicksDone}).`);
                        logClick(proxy.raw, clickAttemptNumber, 'success', 'retry-clicked');

                        try {
                            await saveCookiesForProxy(page, proxy);
                            await saveLocalStorageForProxy(page, proxy);
                        } catch (e) {
                            console.warn('Error saving session data:', e.message || e);
                        }
                    } else {
                        console.warn('  -> Retry failed. Moving on.');
                        logClick(proxy.raw, clickAttemptNumber, 'fail', 'button-not-found');
                    }
                }

                await delay(1000 + Math.floor(Math.random() * 2000));
            } // end clicks loop

            try { await page.close(); } catch (e) { }
            if (rotateProxyEarly) {
                try { await browser.close(); } catch (_) { }
                proxyIndex++;
                await delay(500 + Math.floor(Math.random() * 1000));
                continue; // move to next proxy
            }
        } catch (err) {
            console.error(`[!] Unexpected error with proxy ${proxy.server}:`, err.message || err);
        } finally {
            try { if (browser) await browser.close(); } catch (_) { }
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
