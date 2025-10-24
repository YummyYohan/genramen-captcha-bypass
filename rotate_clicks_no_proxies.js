// rotate_clicks_sandbox.js
// npm install puppeteer axios
const puppeteer = require("puppeteer");
const axios = require("axios");

const TARGET_URL = "https://www.newsobserver.com/living/food-drink/article312455820.html";
const API_KEY = "c366faaaac949cca97f9333134246398"; // your 2Captcha API key
const KNOWN_SITEKEY = "MTPublic-UJO5aa0iQ"; // fallback if we can't extract live key

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

async function findAndClickGenRamen(page) {
  const MAX_RETRIES = 22;
  const RETRY_DELAY = 2000;
  for (let i = 0; i < MAX_RETRIES; i++) {
    try {
      await page.evaluate(() => window.scrollBy(0, 300));
      const beopWidget = await page.$('beop-widget');
      if (!beopWidget) { console.log(`Attempt ${i+1}: <beop-widget> not found`); await delay(RETRY_DELAY); continue; }

      const shadowRoot = await beopWidget.evaluateHandle(el => el.shadowRoot).catch(()=>null);
      if (!shadowRoot) { console.log(`Attempt ${i+1}: shadowRoot not ready`); await delay(RETRY_DELAY); continue; }

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

      console.log(`Attempt ${i+1}: "Gen Ramen" not visible yet`);
      await delay(RETRY_DELAY);
    } catch (err) {
      console.log(`Attempt ${i+1} error: ${err.message}`);
      await delay(RETRY_DELAY);
    }
  }
  return false;
}

// find an mtcaptcha iframe src by walking DOM and shadow roots
async function extractMTCaptchaIframeSrc(page) {
  return await page.evaluate(() => {
    function* walk(node){
      if (!node) return;
      yield node;
      // include shadowRoot children
      if (node.shadowRoot) {
        yield node.shadowRoot;
        for (const el of node.shadowRoot.querySelectorAll('*')) yield el;
      }
      for (const c of node.children || []) yield* walk(c);
    }
    for (const n of walk(document.documentElement)) {
      try {
        if (n.tagName && n.tagName.toLowerCase() === 'iframe' && n.src && n.src.toLowerCase().includes('mtcaptcha')) {
          return n.src;
        }
      } catch(e){}
    }
    return null;
  });
}

async function createTaskSandbox(sitekey) {
  const payload = {
    clientKey: API_KEY,
    task: {
      type: "MtCaptchaTaskProxyless",
      websiteURL: TARGET_URL,
      websiteKey: sitekey
    }
  };
console.log("📤 createTask (sandbox) payload:", JSON.stringify(payload, null, 2));
  const res = await axios.post("https://api.2captcha.com/createTask", payload);
  console.log("📥 createTask response:", JSON.stringify(res.data, null, 2));
  return res.data;
}

async function pollTaskResult(taskId, maxPolls = 60, delayMs = 2000) {
  const pollUrl = "https://api.2captcha.com/getTaskResult";
  for (let i = 0; i < maxPolls; i++) {
    await delay(delayMs);
    try {
      const res = await axios.post(pollUrl, { clientKey: API_KEY, taskId });
      console.log(`📡 Poll #${i+1} status:`, res.data.status || res.data);
      if (res.data.errorId && res.data.errorId !== 0) {
        console.log("❌ Poll error:", JSON.stringify(res.data, null, 2));
        return res.data;
      }
      if (res.data.status === "ready") {
        return res.data;
      }
    } catch (err) {
      console.log(`❌ Poll #${i+1} failed:`, err.message);
    }
  }
  return null;
}

(async () => {
  const browser = await puppeteer.launch({ headless: false, args: ["--no-sandbox","--disable-setuid-sandbox"] });
  const page = await browser.newPage();

  // optional request/response logging for mtcaptcha URLs
  page.on('request', r => { const u = r.url(); if (u.includes('mtcaptcha') || u.includes('service.mtcaptcha.com')) console.log('➡️ request', u); });
  page.on('response', async r => { const u = r.url(); if (u.includes('mtcaptcha') || u.includes('service.mtcaptcha.com')) console.log('⬅️ response', u, r.status()); });

  try {
    await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });

    const clicked = await findAndClickGenRamen(page);
    if (!clicked) {
      console.log("❌ Could not click Gen Ramen. Exiting.");
      await browser.close();
      return;
    }

    // try to find the iframe src and sitekey
    await delay(1500);
    const iframeSrc = await extractMTCaptchaIframeSrc(page);
    let liveSitekey = null;
    if (iframeSrc) {
      console.log("🔍 Detected mtcaptcha iframe src:", iframeSrc);
      try { liveSitekey = (new URL(iframeSrc)).searchParams.get('sitekey'); } catch(e){}
      console.log("🔑 Extracted live sitekey:", liveSitekey);
    } else {
      console.log("⚠️ No mtcaptcha iframe src detected; falling back to KNOWN_SITEKEY");
    }

    const sitekeyToUse = liveSitekey || KNOWN_SITEKEY;
    // create sandbox task
    const createResp = await createTaskSandbox(sitekeyToUse);
    if (!createResp || createResp.errorId !== 0) {
      console.log("❌ createTask returned error. Inspect the createTask response above.");
      await browser.close();
      return;
    }

    const taskId = createResp.taskId;
    console.log("🧩 Created sandbox taskId:", taskId);

    // poll for result
    const pollResp = await pollTaskResult(taskId, 100, 2000);
    if (!pollResp) {
      console.log("❌ Poll timeout or no response from sandbox workers.");
      await browser.close();
      return;
    }

    if (pollResp.errorId && pollResp.errorId !== 0) {
      console.log("❌ Poll returned error:", JSON.stringify(pollResp, null, 2));
      await browser.close();
      return;
    }

    if (pollResp.status === "ready") {
      const token = pollResp.solution && (pollResp.solution.token || pollResp.solution.gRecaptchaResponse || pollResp.solution);
      console.log("✅ Sandbox returned token:", token);

      // inject token into page (try common names)
      await page.evaluate(t => {
        const names = ["mtcaptcha-verifiedtoken","mtcaptcha-verifiedToken","mtcaptcha-token","mtcaptcha-response"];
        for (const n of names) {
          const el = document.querySelector(`[name="${n}"]`) || document.getElementById(n);
          if (el) { try { el.value = t; } catch(_){} }
        }
        window.postMessage({ mtcaptcha_token: t }, "*");
      }, token);

      console.log("🔧 Token injected into page context (if matching fields existed).");
    } else {
      console.log("⚠️ Poll response not 'ready':", JSON.stringify(pollResp, null, 2));
    }

    await delay(2000);
    await browser.close();
  } catch (err) {
    console.error("❌ Fatal:", err.message || err);
    try { await browser.close(); } catch(_) {}
  }
})();
