const fetch = (...args) =>
  import("node-fetch").then(({ default: fetch }) => fetch(...args));
const puppeteer = require("puppeteer");

// ========== CONFIG ==========
const API_KEY = "c366faaaac949cca97f9333134246398"; // 2Captcha API key
const WEBSITE_URL =
  "https://www.newsobserver.com/living/food-drink/article312455820.html";
const WEBSITE_KEY_FALLBACK = "MTPublic-UJO5aa0iQ"; // fallback sitekey

// ========== HELPERS ==========
function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForFrame(page, predicate, timeout = 30000, interval = 500) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const frames = page.frames();
    for (const f of frames) {
      try {
        if (await predicate(f)) return f;
      } catch {}
    }
    await delay(interval);
  }
  return null;
}

// ========== 2CAPTCHA API HELPERS ==========
async function createTask(websiteURL, websiteKey) {
  console.log("Creating captcha task...");
  const response = await fetch("https://api.2captcha.com/createTask", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      clientKey: API_KEY,
      task: {
        type: "MtCaptchaTaskProxyless",
        websiteURL,
        websiteKey,
      },
    }),
  });

  const data = await response.json();
  if (data.errorId !== 0) throw new Error(`Create task error: ${data.errorCode}`);
  console.log("Task created:", data.taskId);
  return data.taskId;
}

async function getTaskResult(taskId) {
  const response = await fetch("https://api.2captcha.com/getTaskResult", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ clientKey: API_KEY, taskId }),
  });
  return await response.json();
}

async function waitForSolution(taskId) {
  console.log("Waiting for captcha result...");
  for (let i = 0; i < 30; i++) {
    await delay(5000);
    const data = await getTaskResult(taskId);
    if (data.status === "ready") {
      console.log("Captcha solved!");
      return data.solution.token;
    }
    console.log("Not ready yet...");
  }
  throw new Error("Captcha not solved in time.");
}

// ========== SHADOW DOM CLICK (robust) ==========
async function findAndClickGenRamen(page) {
  const MAX_RETRIES = 22;
  const RETRY_DELAY = 2000;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      await page.evaluate(() => window.scrollBy(0, 300));

      // find the shadow host
      const beopWidgetHandle = await page.$("beop-widget");
      if (!beopWidgetHandle) {
        console.log(`Attempt ${attempt}: <beop-widget> not found`);
        await delay(RETRY_DELAY);
        continue;
      }

      const shadowRootHandle = await beopWidgetHandle
        .evaluateHandle((el) => el.shadowRoot)
        .catch(() => null);
      if (!shadowRootHandle) {
        console.log(`Attempt ${attempt}: shadowRoot not ready`);
        await delay(RETRY_DELAY);
        continue;
      }

      // get choice elements inside shadow root
      const choicesHandle = await shadowRootHandle.evaluateHandle((root) =>
        Array.from(root.querySelectorAll(".BeOp__QuestionChoiceTextBlock > div"))
      );
      const props = await choicesHandle.getProperties();

      // click the first matching choice (you asked previously to target the one under the text block)
      for (const v of props.values()) {
        const txt = await (await v.getProperty("innerText")).jsonValue();
        if (txt && txt.trim().toLowerCase().includes("gen ramen")) {
          console.log(`✅ Found choice: "${txt.trim()}", clicking...`);
          // Use evaluate on the handle to click inside page context
          await v.evaluate((el) => el.click());
          await delay(7000); // give widget time to load
          return true;
        }
      }

      console.log(`Attempt ${attempt}: "Gen Ramen" not visible yet`);
      await delay(RETRY_DELAY);
    } catch (err) {
      console.log(`Attempt ${attempt} error: ${err.message}`);
      await delay(RETRY_DELAY);
    }
  }
  return false;
}

// ========== NESTED FRAME SITEKEY EXTRACTION ==========
async function findOuterAndInnerFrames(page) {
  // Wait for outer frame (widget.collectiveaudience.co/mtcaptcha) by polling frames
  const outerFrame = await waitForFrame(
    page,
    (f) => {
      const u = f.url() || "";
      return u.includes("widget.collectiveaudience.co/mtcaptcha") || u.includes("/mtcaptcha/?");
    },
    20000,
    300
  );

  if (!outerFrame) return { outerFrame: null, innerFrame: null };

  // inner frame may be a child frame of outerFrame or an iframe element inside outerFrame HTML
  // check childFrames first
  let innerFrame = outerFrame.childFrames().find((f) => (f.url() || "").includes("service.mtcaptcha.com"));
  if (innerFrame) return { outerFrame, innerFrame };

  // else poll for inner frame within outerFrame (search for iframe src containing service.mtcaptcha)
  const inner = await waitForFrame(
    page,
    (f) => {
      // locate frame that is a descendant of the outerFrame (compare by parent chain)
      let parent = f.parentFrame();
      while (parent) {
        if (parent === outerFrame) return (f.url() || "").includes("service.mtcaptcha.com");
        parent = parent.parentFrame();
      }
      return false;
    },
    20000,
    300
  );

  innerFrame = inner || null;
  return { outerFrame, innerFrame };
}

// ========== INJECT TOKEN (try multiple places) ==========
async function injectTokenAnywhere(page, outerFrame, token) {
  // 1) Try main page hidden input
  const injectedMain = await page.evaluate((t) => {
    const input =
      document.querySelector('input[name="mtcaptcha-verifiedtoken"]') ||
      document.querySelector('input.mtcaptcha-verifiedtoken') ||
      document.querySelector('input[id^="68f922d"][name="mtcaptcha-verifiedtoken"]');
    if (input) {
      input.value = t;
      input.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    }
    return false;
  }, token);

  if (injectedMain) {
    console.log("Injected token into main page input.");
    return true;
  }

  // 2) Try injecting into outer frame DOM (if accessible)
  if (outerFrame) {
    try {
      const injectedOuter = await outerFrame.evaluate((t) => {
        const input =
          document.querySelector('input[name="mtcaptcha-verifiedtoken"]') ||
          document.querySelector('input.mtcaptcha-verifiedtoken');
        if (input) {
          input.value = t;
          input.dispatchEvent(new Event("change", { bubbles: true }));
          return true;
        }
        return false;
      }, token);
      if (injectedOuter) {
        console.log("Injected token into outer frame input.");
        return true;
      }
    } catch (e) {
      // likely cross-origin or inaccessible, ignore
    }
  }

  // 3) Last resort: postMessage to parent — many widgets listen to messages in a specific format.
  // We can attempt to send a postMessage that matches widget.collectiveaudience's format:
  try {
    await page.evaluate((t) => {
      // channel prefix is unknown here; attempt to send a generic message similar to widget protocol:
      window.postMessage(JSON.stringify({ mtEvent: "verified", token: t }), "*");
    }, token);
    console.log("Posted generic message to window (may or may not be received).");
  } catch (e) {}

  return false;
}

// ========== MAIN ==========
(async function main() {
  const browser = await puppeteer.launch({
    headless: false,
    defaultViewport: null,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  const page = await browser.newPage();
  console.log("Navigating to target page...");
  await page.goto(WEBSITE_URL, { waitUntil: "domcontentloaded" });

  // click Gen Ramen inside shadow DOM
  const clicked = await findAndClickGenRamen(page);
  if (!clicked) {
    console.error("Could not find/click 'Gen Ramen'. Exiting.");
    await browser.close();
    return;
  }
  console.log("'Gen Ramen' clicked.");

  // Listen to frames attaching (debug)
  page.on("frameattached", (f) => {
    try {
      const u = f.url();
      if (u) console.log("Frame attached:", u);
    } catch {}
  });

  // Find outer and inner frames (polling)
  console.log("Looking for outer and inner captcha frames...");
  const { outerFrame, innerFrame } = await findOuterAndInnerFrames(page);

  if (!outerFrame) {
    console.error("Outer captcha iframe not found after waiting.");
    await browser.close();
    return;
  }
  console.log("Outer frame found:", outerFrame.url());

  if (!innerFrame) {
    console.log("Inner service.mtcaptcha frame not found as a frame object — trying to detect inner iframe SRC inside outer frame DOM.");
    // Try to get nested iframe src from outerFrame.evaluate
    try {
      const nestedSrc = await outerFrame.evaluate(() => {
        const ifr = document.querySelector('iframe[src*="service.mtcaptcha.com"]');
        return ifr ? ifr.src : null;
      });
      if (nestedSrc) {
        console.log("Nested iframe src found in outer frame DOM:", nestedSrc);
      } else {
        console.log("No nested iframe src found inside outer frame DOM.");
      }
    } catch (e) {
      console.log("Cannot inspect outer frame DOM (cross-origin).");
    }
  } else {
    console.log("Inner frame found:", innerFrame.url());
  }

  // Determine sitekey: prefer innerFrame.url() if available, else check nested iframe src in outerFrame DOM, else fallback
  let sitekey = null;
  if (innerFrame) {
    try {
      const u = innerFrame.url();
      sitekey = new URL(u).searchParams.get("sitekey");
    } catch {}
  }
  if (!sitekey && outerFrame) {
    // try to read nested iframe src in outerFrame if accessible
    try {
      const nestedSrc = await outerFrame.evaluate(() => {
        const ifr = document.querySelector('iframe[src*="service.mtcaptcha.com"]');
        return ifr ? ifr.src : null;
      });
      if (nestedSrc) {
        try {
          sitekey = new URL(nestedSrc).searchParams.get("sitekey");
        } catch {}
      }
    } catch {}
  }
  if (!sitekey) {
    console.log("Sitekey not found in nested frames; using fallback.");
    sitekey = WEBSITE_KEY_FALLBACK;
  }
  console.log("Using sitekey:", sitekey);

  // Create 2Captcha task
  const taskId = await createTask(WEBSITE_URL, sitekey);
  const token = await waitForSolution(taskId);
  console.log("Token from 2Captcha:", token);

  // Try to inject token into main page / outer frame
  await injectTokenAnywhere(page, outerFrame, token);

  // Poll for hidden input or other indications that site accepted token
  console.log("Polling main page for 'mtcaptcha-verifiedtoken' input value...");
  const start = Date.now();
  const timeout = 60000;
  let verifiedToken = null;
  while (Date.now() - start < timeout) {
    verifiedToken = await page.evaluate(() => {
      const i = document.querySelector('input[name="mtcaptcha-verifiedtoken"], input.mtcaptcha-verifiedtoken');
      return i ? i.value : null;
    });
    if (verifiedToken) break;
    await delay(1000);
  }

  if (verifiedToken) {
    console.log("Verified token now present in page:", verifiedToken);
  } else {
    console.warn("Timed out waiting for the verified token to appear in main page inputs.");
  }

  // keep browser open a bit so you can observe
  await delay(5000);
  await browser.close();
})().catch((err) => {
  console.error("Fatal error:", err);
});
