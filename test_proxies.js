// test_socks4_proxies.js
// npm install axios socks-proxy-agent
// node test_socks4_proxies.js

const axios = require('axios');
const { SocksProxyAgent } = require('socks-proxy-agent');

const PROXY_TYPE = 'socks4';
const PROXY_API = `https://api.proxyscrape.com/v4/free-proxy-list/get?request=display_proxies&protocol=socks4&proxy_format=ipport&format=text&timeout=20000&limit=50`;

// Fetch proxies from ProxyScrape
async function fetchProxies() {
    try {
        const res = await axios.get(PROXY_API, { timeout: 10000 });
        const proxies = res.data
            .split(/\r?\n/)
            .filter(Boolean)
            .map(p => p.trim());
        console.log(`Fetched ${proxies.length} ${PROXY_TYPE.toUpperCase()} proxies from ProxyScrape.`);
        return proxies;
    } catch (e) {
        console.error('Failed to fetch proxies:', e.message);
        return [];
    }
}

// Test a single SOCKS4 proxy
async function testProxy(proxy) {
    try {
        const agent = new SocksProxyAgent(`${PROXY_TYPE}://${proxy}`, { rejectUnauthorized: false });

        const res = await axios.get('https://api.ipify.org?format=text', {
            httpAgent: agent,
            httpsAgent: agent,
            timeout: 7000,
            validateStatus: () => true, // accept any HTTP status
        });

        if (res.data && res.data.trim()) {
            console.log(`[✅] Working proxy: ${proxy}`);
            return proxy;
        }
    } catch (e) {
        console.log(`[❌] Failed proxy: ${proxy} -> ${e.message}`);
    }

    return null;
}

// Run tests in parallel with limited concurrency
async function getWorkingProxies(concurrency = 20) {
    const proxies = await fetchProxies();
    const workingProxies = [];
    let index = 0;

    async function worker() {
        while (index < proxies.length) {
            const proxy = proxies[index++];
            const ok = await testProxy(proxy);
            if (ok) workingProxies.push(ok);
        }
    }

    const workers = Array.from({ length: concurrency }, worker);
    await Promise.all(workers);

    console.log(`\nTotal working proxies: ${workingProxies.length}`);
    return workingProxies;
}

// Run standalone
if (require.main === module) {
    (async () => {
        const workingProxies = await getWorkingProxies();
        console.log('\nAll done! Working proxies:');
        console.log(workingProxies.join('\n'));
    })();
}

module.exports = { getWorkingProxies };
