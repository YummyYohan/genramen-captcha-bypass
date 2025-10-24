// testing.js
const axios = require('axios');

const CLIENT_KEY = 'c366faaaac949cca97f9333134246398'; // <-- replace
const WEBSITE_URL = 'https://2captcha.com/demo/mtcaptcha';
const WEBSITE_KEY = 'MTPublic-KzqLY1cKH'; // use the sitekey you found in console

// polling options
const POLL_INTERVAL_MS = 5000; // 5 seconds between checks
const MAX_WAIT_MS = 2 * 60 * 1000; // 2 minutes timeout

async function createTask() {
  const payload = {
    clientKey: CLIENT_KEY,
    task: {
      type: 'MtCaptchaTaskProxyless',
      websiteURL: WEBSITE_URL,
      websiteKey: WEBSITE_KEY
    }
  };

  const res = await axios.post('https://api.2captcha.com/createTask', payload, {
    headers: { 'Content-Type': 'application/json' }
  });

  if (res.data && res.data.errorId === 0 && res.data.taskId) {
    return res.data.taskId;
  } else {
    throw new Error('createTask error: ' + JSON.stringify(res.data));
  }
}

async function getTaskResult(taskId) {
  const payload = {
    clientKey: CLIENT_KEY,
    taskId: taskId
  };

  const res = await axios.post('https://api.2captcha.com/getTaskResult', payload, {
    headers: { 'Content-Type': 'application/json' }
  });

  return res.data;
}

async function solve() {
  console.log('Creating captcha task...');
  const taskId = await createTask();
  console.log('Task created:', taskId);

  const start = Date.now();
  while (true) {
    if (Date.now() - start > MAX_WAIT_MS) {
      throw new Error('Timeout waiting for captcha solution');
    }

    try {
      const result = await getTaskResult(taskId);
      // If errorId !== 0 -> API-level error
      if (result.errorId && result.errorId !== 0) {
        throw new Error('getTaskResult error: ' + JSON.stringify(result));
      }

      // status: 'processing' or 'ready'
      console.log('Status:', result.status);

      if (result.status === 'ready') {
        if (result.solution && result.solution.token) {
          console.log('Solved! token:', result.solution.token);
          console.log('Full response:', result);
          return result.solution.token;
        } else {
          throw new Error('Ready but no token in response: ' + JSON.stringify(result));
        }
      }

      // not ready -> wait and retry
      await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
    } catch (err) {
      // network or API errors — decide whether to continue or abort
      console.error('Polling error:', err.message || err);
      // short wait before retrying after transient error
      await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
    }
  }
}

(async () => {
  try {
    const token = await solve();
    // At this point `token` is the v1(...) string you can inject into the page.
    console.log('Done. Use token in the page input "mtcaptcha-verifiedtoken".');
  } catch (err) {
    console.error('Failed:', err.message || err);
    process.exit(1);
  }
})();
