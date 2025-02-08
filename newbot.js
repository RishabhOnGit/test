/*******************************************************
 * worker.js - STEALTH YOUTUBE BOT with cookies + like + subscribe
 *
 * 1) Exposes:
 *    - GET /stats -> returns { totalViews, totalWatchTime, totalRefreshes, activeWindows }
 *    - POST /start-bot -> receives { query, windows, useProxies, proxyFilePath, userAgentFilePath, filter, channelName, headless, applyCookies, likeVideo, subscribeChannel }
 * 2) Uses Puppeteer with stealth + concurrency
 * 3) If applyCookies = true, loads cookies for each window
 * 4) If likeVideo = true or subscribeChannel = true, tries them mid-playback
 *******************************************************/

const express = require('express');
const bodyParser = require('body-parser');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs');
const path = require('path');

// Add stealth plugin
puppeteer.use(StealthPlugin());

// Global stats
const globalStats = {
  totalViews: 0,
  totalWatchTime: 0,  // in seconds
  totalRefreshes: 0,
  activeWindows: 0
};

const app = express();
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Route: GET /stats -> returns globalStats
app.get('/stats', (req, res) => {
  res.json(globalStats);
});

// Route: simple welcome
app.get('/', (req, res) => {
  res.send(`
    <h1>Worker Bot is Running (Stealth + Cookies + Like/Subscribe)</h1>
    <p>POST /start-bot with JSON to run the automation.</p>
    <p>GET /stats to see globalStats as JSON.</p>
  `);
});

// POST /start-bot
app.post('/start-bot', async (req, res) => {
  try {
    const {
      query = '',
      channelName = '',
      windows = 1,
      useProxies = false,
      proxyFilePath = './proxies.txt',
      userAgentFilePath = './useragent.txt',
      filter = 'Last hour',
      headless = true,

      // NEW fields
      applyCookies = false,
      likeVideo = false,
      subscribeChannel = false
    } = req.body;

    // Reset stats each run (or remove if you want cumulative)
    globalStats.totalViews = 0;
    globalStats.totalWatchTime = 0;
    globalStats.totalRefreshes = 0;
    globalStats.activeWindows = 0;

    let proxies = [];
    if (useProxies && proxyFilePath) {
      proxies = readProxiesFromFile(proxyFilePath);
    }
    const userAgents = readUserAgentsFromFile(userAgentFilePath);

    await startAutomation(
      query,
      parseInt(windows),
      useProxies,
      proxies,
      userAgents,
      filter,
      channelName,
      (headless === true || headless === 'true'),
      applyCookies,
      likeVideo,
      subscribeChannel
    );

    res.json({ success: true, message: 'Bot started with cookies/like/subscribe logic.' });
  } catch (err) {
    console.error('Error in /start-bot:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Start listening
const PORT = 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Stealth Worker Bot listening on port ${PORT}`);
});

/*******************************************************
 * ============= CORE BOT LOGIC BELOW ==================
 *******************************************************/

// Puppeteer logic with concurrency
const puppeteerExtra = require('puppeteer-extra');
const delayFunction = ms => new Promise(r => setTimeout(r, ms));

function readProxiesFromFile(filePath) {
  try {
    if (!fs.existsSync(filePath)) return [];
    const data = fs.readFileSync(filePath, 'utf8');
    return data.split('\n').map(line => {
      if (!line.trim()) return null;
      const [credentials, ipPort] = line.split('@');
      if (!credentials || !ipPort) return null;
      const [username, password] = credentials.split(':');
      const [ip, port] = ipPort.split(':');
      return { username, password, ip, port };
    }).filter(Boolean);
  } catch (err) {
    console.error('Error reading proxies:', err.message);
    return [];
  }
}

function readUserAgentsFromFile(filePath) {
  try {
    if (!fs.existsSync(filePath)) return [];
    const data = fs.readFileSync(filePath, 'utf8');
    return data.split('\n').map(line => line.trim()).filter(Boolean);
  } catch (err) {
    console.error('Error reading useragent:', err.message);
    return [];
  }
}

// Load cookies if applyCookies is true
function loadCookiesForWindow(index) {
  // Example: cookies/profile1_cookies.json, cookies/profile2_cookies.json, etc.
  const cookiesDir = path.join(__dirname, 'cookies');
  if (!fs.existsSync(cookiesDir)) {
    return [];
  }
  const cookieFile = path.join(cookiesDir, `profile${index+1}_cookies.json`);
  if (!fs.existsSync(cookieFile)) {
    return [];
  }
  try {
    const fileData = fs.readFileSync(cookieFile, 'utf8');
    return JSON.parse(fileData);
  } catch (error) {
    console.error('Error parsing cookies for window', index+1, error.message);
    return [];
  }
}

// Main concurrency
async function startAutomation(
  query, windows, useProxies, proxies, userAgents,
  filter, channelName, headless,
  applyCookies, likeVideo, subscribeChannel
) {
  const filterMap = {
    'Last hour': '&sp=EgIIAQ%253D%253D',
    'Today': '&sp=EgIIAg%253D%253D',
    'This week': '&sp=EgIIAw%253D%253D'
  };
  const filterParam = filterMap[filter] || '';

  const batchSize = 5; // how many parallel
  const totalBatches = Math.ceil(windows / batchSize);

  for (let b = 0; b < totalBatches; b++) {
    const start = b * batchSize;
    const end = Math.min(start+batchSize, windows);
    console.log(`Starting batch ${b+1}/${totalBatches} (windows ${start+1}-${end})`);
    const tasks = [];
    for (let i = start; i < end; i++) {
      const px = useProxies ? proxies[i % proxies.length] : null;
      const ua = userAgents[i % userAgents.length] || 'Mozilla/5.0';
      tasks.push(openWindow(
        i, query, filterParam, px, ua, channelName, headless,
        applyCookies, likeVideo, subscribeChannel
      ));
    }
    await Promise.allSettled(tasks);
  }
}

// Open a single window
async function openWindow(
  index, query, filterParam, proxy, userAgent, channelName, headless,
  applyCookies, likeVideo, subscribeChannel
) {
  let browser;
  try {
    browser = await puppeteer.launch({
      headless,
      args: [
        '--no-sandbox', '--disable-setuid-sandbox',
        '--disable-accelerated-2d-canvas', '--disable-gpu',
        '--disable-infobars', '--window-size=1024,600',
        '--disable-blink-features=AutomationControlled',
        ...(proxy ? [`--proxy-server=http://${proxy.ip}:${proxy.port}`] : [])
      ],
      defaultViewport: { width: 1024, height: 600 },
      timeout: 60000
    });

    globalStats.activeWindows++;

    const page = await browser.newPage();
    if (applyCookies) {
      const cookies = loadCookiesForWindow(index);
      if (cookies && cookies.length > 0) {
        await page.setCookie(...cookies);
      }
    }

    await page.setUserAgent(userAgent);
    await page.setDefaultNavigationTimeout(90000);

    // Navigate to YT
    console.log(`Window ${index+1}: Navigate to YT`);
    await page.goto('https://www.youtube.com', { waitUntil: 'domcontentloaded' });

    // Search
    await page.waitForSelector('input[name="search_query"]');
    await humanType(page, 'input[name="search_query"]', `${query} ${channelName}`.trim());
    await page.click('button[aria-label="Search"]');

    await page.waitForSelector('ytd-video-renderer', { visible: true, timeout: 90000 });
    await delayFunction(2000);

    // Filter if any
    if (filterParam) {
      console.log(`Window ${index+1}: Filter -> ${filterParam}`);
      await page.click('button[aria-label="Search filters"]');
      await delayFunction(2000);
      const newUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}${filterParam}`;
      await page.goto(newUrl, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('ytd-video-renderer', { visible: true, timeout: 90000 });
    }

    // scroll
    await scrollPage(page);

    // click first result
    const sel = 'ytd-video-renderer #video-title';
    await page.waitForSelector(sel, { visible: true, timeout: 90000 });
    const firstVid = await page.$(sel);
    await firstVid.click();

    // Wait video
    await page.waitForSelector('video', { visible: true, timeout: 90000 });

    // track playback with like/subscribe
    await trackVideoPlayback(page, index, browser, likeVideo, subscribeChannel);

  } catch (err) {
    console.error(`Window ${index+1} error: ${err.message}`);
    if (browser) {
      await browser.close();
      globalStats.activeWindows--;
    }
  }
}

// trackVideoPlayback + load cookies
async function trackVideoPlayback(page, index, browser, likeVideo, subscribeChannel) {
  // Similar to older code, plus random like/subscribe
  let playbackStarted = false;
  let retries = 0;
  let lastTime = 0;
  let currentTime = 0;
  let totalDuration = 0;

  const startTimeout = 30000;

  while (!playbackStarted && retries < 2) {
    const startT = Date.now();
    while (!playbackStarted) {
      const data = await page.evaluate(() => {
        const v = document.querySelector('video');
        if (v && v.duration > 0) {
          return { currentTime: v.currentTime, totalDuration: v.duration };
        }
        return { currentTime: 0, totalDuration: 0 };
      });
      currentTime = data.currentTime;
      totalDuration = data.totalDuration;

      if (currentTime > 0) {
        playbackStarted = true;
        console.log(`Window ${index+1}: video started, duration=${totalDuration}`);
        break;
      }

      if (Date.now() - startT > startTimeout) {
        console.log(`Window ${index+1}: no playback, reload #${retries+1}`);
        globalStats.totalRefreshes++;
        await page.reload({ waitUntil: 'domcontentloaded' });
        retries++;
        break;
      }
      await delayFunction(2000);
    }
  }

  if (!playbackStarted) {
    console.error(`Window ${index+1}: never started, closing...`);
    await browser.close();
    globalStats.activeWindows--;
    return;
  }

  // Possibly do like/subscribe after some random time
  if (likeVideo) {
    // do it around 25% of totalDuration
    randomLikeDuringPlayback(page, totalDuration).catch(() => {});
  }
  if (subscribeChannel) {
    // do it around 40% of totalDuration
    randomSubscribeDuringPlayback(page, totalDuration).catch(() => {});
  }

  let stuckTime = 0;
  while (true) {
    const data = await page.evaluate(() => {
      const v = document.querySelector('video');
      return v
        ? { currentTime: v.currentTime, totalDuration: v.duration }
        : { currentTime: 0, totalDuration: 0 };
    });
    currentTime = data.currentTime;
    totalDuration = data.totalDuration;

    // watch time
    const diff = currentTime - lastTime;
    if (diff > 0) {
      globalStats.totalWatchTime += diff;
      lastTime = currentTime;
    }

    console.log(`Window ${index+1}: ${currentTime.toFixed(1)}/${totalDuration.toFixed(1)}`);

    if (totalDuration > 0 && totalDuration - currentTime < 10) {
      globalStats.totalViews++;
      console.log(`Window ${index+1}: near end => close`);
      await browser.close();
      globalStats.activeWindows--;
      return;
    }

    // random pause
    if (Math.random() < 0.15) {
      console.log(`Window ${index+1}: pause`);
      await page.evaluate(() => {
        const v = document.querySelector('video');
        if (v) v.pause();
      });
      await delayFunction(Math.random()*3000+2000);
      console.log(`Window ${index+1}: resume`);
      await page.evaluate(() => {
        const v = document.querySelector('video');
        if (v) v.play();
      });
    }

    // random seek
    if (Math.random() < 0.1) {
      const sec = Math.random()*10;
      const direction = Math.random()>0.5 ? 1 : -1;
      const newT = Math.max(0, Math.min(currentTime+direction*sec, totalDuration));
      console.log(`Window ${index+1}: seeking => ${newT.toFixed(1)}`);
      await page.evaluate(t => {
        const v = document.querySelector('video');
        if (v) v.currentTime = t;
      }, newT);
    }

    // random scroll
    if (Math.random() < 0.2) {
      await scrollPage(page);
    }

    // stuck detection
    await delayFunction(3000);
  }
}

// randomLikeDuringPlayback
async function randomLikeDuringPlayback(page, totalDuration) {
  const triggerTime = totalDuration/4; // ~25%
  while (true) {
    const data = await page.evaluate(() => {
      const v = document.querySelector('video');
      if (v) return v.currentTime;
      return 0;
    });
    if (data >= triggerTime) {
      console.log(`Attempting like...`);
      await page.evaluate(() => {
        const likeBtn = document.querySelector('button[aria-label*="like this video"]');
        if (likeBtn && likeBtn.getAttribute('aria-pressed') !== 'true') {
          likeBtn.click();
        }
      });
      return;
    }
    await delayFunction(2000);
  }
}

// randomSubscribeDuringPlayback
async function randomSubscribeDuringPlayback(page, totalDuration) {
  const triggerTime = totalDuration * 0.4; // 40%
  while (true) {
    const data = await page.evaluate(() => {
      const v = document.querySelector('video');
      if (v) return v.currentTime;
      return 0;
    });
    if (data >= triggerTime) {
      console.log(`Attempting subscribe...`);
      await page.evaluate(() => {
        const subBtn = document.querySelector('ytd-subscribe-button-renderer button');
        if (subBtn) {
          // check if already subscribed
          if (!subBtn.textContent.toLowerCase().includes('subscribed')) {
            subBtn.click();
          }
        }
      });
      return;
    }
    await delayFunction(2000);
  }
}

// scroll
async function scrollPage(page) {
  await delayFunction(2000);
  const scrollHeight = await page.evaluate(() => document.body.scrollHeight);
  const randomY = Math.floor(Math.random()*(scrollHeight/2))+100;
  await page.evaluate(y => window.scrollTo(0,y), randomY);
  await delayFunction(2500);
  await page.evaluate(() => window.scrollTo(0,0));
  await delayFunction(2000);
}

// typed
async function humanType(page, selector, text) {
  const el = await page.$(selector);
  if (!el) return;
  for (let i=0; i<text.length; i++) {
    await el.type(text.charAt(i));
    await delayFunction(Math.random()*50+50);
  }
}
