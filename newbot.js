/*************************************************************
 *  automation.js  (Stealth Enhanced)
 *  ----------------------------------------------------------
 *  1) Full original bot logic (search, concurrency, etc.)
 *  2) Stealth additions:
 *     - Random mouse & click movement
 *     - Puppeteer fingerprint overrides
 *     - headless: 'new'
 *     - Random network throttling
 *     - Extra human-like scrolling & input
 *************************************************************/

const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs');
const path = require('path');
const express = require('express');
const bodyParser = require('body-parser');
const AdblockerPlugin = require('puppeteer-extra-plugin-adblocker');
const app = express();
const PORT = 3000;

let globalStats = {
    totalViews: 0,
    totalWatchTime: 0,
    totalRefreshes: 0
};
// Plugins
puppeteer.use(AdblockerPlugin({ blockTrackers: true }));
puppeteer.use(StealthPlugin());

/************************************************
 * 1) Utility: Delay
 ************************************************/
function delayFunction(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/************************************************
 * 2) Utility: navigateWithRetry
 ************************************************/
async function navigateWithRetry(page, url, retries = 5, timeout = 60000) {
  for (let i = 0; i < retries; i++) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
      return;
    } catch (err) {
      if (i === retries - 1) throw err;
      await delayFunction(2000);
    }
  }
}

/************************************************
 * 3) Utility: findAndClickVideoByChannel
 ************************************************/
async function findAndClickVideoByChannel(page, channelName, maxScrollAttempts = 5) {
  let attempts = 0;

  while (attempts < maxScrollAttempts) {
    const videos = await page.$$('ytd-video-renderer');
    for (const video of videos) {
      const channelEl = await video.$('ytd-channel-name');
      if (!channelEl) continue;

      const channelText = await channelEl.evaluate(el => el.textContent.trim());
      if (channelText.toLowerCase().includes(channelName.toLowerCase())) {
        const titleEl = await video.$('#video-title');
        if (titleEl) {
          console.log(`Found channel match: "${channelText}" -> clicking video`);
          await humanMoveAndClick(page, titleEl);  // Stealth: human click
          return true;
        }
      }
    }

    console.log(`Channel "${channelName}" not found yet, scrolling further...`);
    await page.evaluate(() => window.scrollBy(0, 800));
    await delayFunction(1500);
    attempts++;
  }

  return false;
}

/************************************************
 * 4) Utility: waitForAdToFinish
 ************************************************/
async function waitForAdToFinish(page, timeout = 30000) {
  const startTime = Date.now();
  while (true) {
    const isSponsoredAdVisible = await page.evaluate(() => {
      const adBadge = document.querySelector('.ad-simple-attributed-string.ytp-ad-badge__text--clean-player');
      return adBadge && adBadge.style.display !== 'none';
    });
    if (!isSponsoredAdVisible) break;
    await delayFunction(3000);
    if (Date.now() - startTime > timeout) break;
  }
}

/************************************************
 * 5) Utility: safelyCloseBrowser
 ************************************************/
async function safelyCloseBrowser(browser, windowIndex) {
  if (browser) {
    try {
      await browser.close();
    } catch (err) {
      console.error(`Error closing browser (Window ${windowIndex + 1}): ${err.message}`);
    }
  }
}

/************************************************
 * 6) Utility: forceQuality144p
 ************************************************/
async function forceQuality144p(page) {
  try {
    await delayFunction(1000);
    await page.waitForSelector('.ytp-settings-button', { visible: true, timeout: 60000 });
    await page.click('.ytp-settings-button');

    await page.waitForSelector('.ytp-settings-menu', { visible: true, timeout: 60000 });
    // Scroll the settings menu to ensure "Quality" is visible
    await page.evaluate(() => {
      const menu = document.querySelector('.ytp-settings-menu, .ytp-panel-menu');
      if (menu) menu.scrollTop = menu.scrollHeight;
    });
    await delayFunction(500);

    // Click "Quality"
    await page.evaluate(() => {
      const items = [...document.querySelectorAll('.ytp-menuitem')];
      const qualityItem = items.find(item => item.textContent.includes('Quality'));
      if (qualityItem) qualityItem.click();
    });
    await delayFunction(500);

    // Scroll again
    await page.evaluate(() => {
      const menu = document.querySelector('.ytp-settings-menu, .ytp-panel-menu');
      if (menu) menu.scrollTop = menu.scrollHeight;
    });
    await delayFunction(500);

    // Select 144p
    const resolutionSet = await page.evaluate(() => {
      const items = [...document.querySelectorAll('.ytp-menuitem')];
      const resItem = items.find(item => item.textContent.includes('144p'));
      if (resItem) {
        resItem.click();
        return true;
      }
      return false;
    });

    if (!resolutionSet) {
      console.error('Error: "144p" resolution not found in the menu.');
    } else {
      console.log('Resolution set to "144p".');
    }
    await delayFunction(500);

  } catch (err) {
    console.error('Error forcing 144p:', err.message);
  }
}

/************************************************
 * 7) Utility: randomlyLikeVideo
 ************************************************/
async function randomlyLikeVideo(page, totalDuration) {
  const triggerTime = totalDuration / 4;
  while (true) {
    const currentTime = await page.evaluate(() => {
      const vid = document.querySelector('video');
      return vid ? vid.currentTime : 0;
    });
    if (currentTime >= triggerTime) {
      const likeButton = await page.$('button[aria-label*="like this video"]');
      if (likeButton) {
        const isLiked = await page.evaluate(btn => btn.getAttribute('aria-pressed') === 'true', likeButton);
        if (!isLiked) {
          try {
            await humanMoveAndClick(page, likeButton); // Stealth: human click
          } catch (err) {
            console.error('Like click error:', err.message);
          }
        }
      }
      break;
    }
    await delayFunction(3000);
  }
}

/************************************************
 * 8) Utility: subscribeToChannelDuringPlayback
 ************************************************/
async function subscribeToChannelDuringPlayback(page, totalDuration) {
  const subSel = 'ytd-subscribe-button-renderer button';
  const triggerTime = totalDuration / 3;
  while (true) {
    const currentTime = await page.evaluate(() => {
      const vid = document.querySelector('video');
      return vid ? vid.currentTime : 0;
    });
    if (currentTime >= triggerTime) {
      const subBtn = await page.$(subSel);
      if (subBtn) {
        const isSubbed = await page.evaluate(
          btn => (btn.textContent || '').toLowerCase().includes('subscribed'),
          subBtn
        );
        if (!isSubbed) {
          try {
            await humanMoveAndClick(page, subBtn); // Stealth: human click
          } catch (err) {
            console.error('Subscribe click error:', err.message);
          }
        }
      }
      break;
    }
    await delayFunction(3000);
  }
}

/************************************************
 * 9) trackVideoPlayback
 ************************************************/
async function trackVideoPlayback(
  page,
  windowIndex,
  browser,
  applyCookies,
  likeVideo,
  subscribeChannel,
  videoPlaySeconds
) {
  const startTimeout = 50000; // Time to wait for video to start
  const startTime = Date.now();

  let playbackStarted = false;
  let totalDuration = 0;
  let reloadCount = 0;

  let lastCurrentTime = 0;
  let stuckTime = 0; // If currentTime doesn't change

  // 1) Wait for playback to start
  while (!playbackStarted) {
    if (Date.now() - startTime > startTimeout) {
      if (reloadCount === 0) {
        console.error(`Window ${windowIndex + 1}: Playback didn't start -> Reloading once.`);
        await page.reload({ waitUntil: 'domcontentloaded' });
        reloadCount++;
      } else {
        console.error(`Window ${windowIndex + 1}: Playback never started after reload -> closing.`);
        await browser.close();
        return;
      }
    }

    const vidData = await page.evaluate(() => {
      const v = document.querySelector('video');
      return v ? { currentTime: v.currentTime, totalDuration: v.duration } : null;
    });

    if (vidData && vidData.totalDuration > 0) {
      totalDuration = vidData.totalDuration;
      playbackStarted = true;
      console.log(`Window ${windowIndex + 1}: Playback started, duration=${totalDuration.toFixed(2)}s`);
    } else {
      await delayFunction(5000);
    }
  }

  // 2) Force 144p
  await forceQuality144p(page);

  // 3) Possibly Like / Subscribe
  if (applyCookies) {
    if (likeVideo) {
      await randomlyLikeVideo(page, totalDuration);
    }
    if (subscribeChannel) {
      await subscribeToChannelDuringPlayback(page, totalDuration);
    }
  }

  let reloadDoneForStuck = false;

  // 4) Main playback loop
  while (true) {
    const vidData = await page.evaluate(() => {
      const v = document.querySelector('video');
      return v
        ? { currentTime: v.currentTime || 0, totalDuration: v.duration || 0 }
        : { currentTime: 0, totalDuration: 0 };
    });

    const currTime = vidData.currentTime;
    const dur = vidData.totalDuration;

    console.log(`Window ${windowIndex + 1}: currentTime=${currTime.toFixed(2)} / ${dur.toFixed(2)} sec`);

    // (1) If currentTime >= videoPlaySeconds => close
    if (currTime >= videoPlaySeconds) {
      console.log(`Window ${windowIndex + 1}: currentTime >= ${videoPlaySeconds} => closing.`);
      await browser.close();
      break;
    }

    // (2) If near the end
    if (dur > 0 && dur - currTime <= 12) {
      console.log(`Window ${windowIndex + 1}: Near the end => closing.`);
      await browser.close();
      break;
    }

    // (3) Stuck detection
    if (currTime === lastCurrentTime) {
      stuckTime += 5;
      if (stuckTime >= 15) {
        if (!reloadDoneForStuck) {
          console.warn(`Window ${windowIndex + 1}: Stuck for 10s => Reloading once.`);
          await page.reload({ waitUntil: 'domcontentloaded' });
          reloadDoneForStuck = true;
          stuckTime = 0;
          lastCurrentTime = 0;
          continue;
        } else {
          console.error(`Window ${windowIndex + 1}: Already reloaded once, still stuck => closing.`);
          await browser.close();
          break;
        }
      }
    } else {
      stuckTime = 0;
    }
    lastCurrentTime = currTime;

    // Random pause/resume
    if (Math.random() < 0.15) {
      await page.evaluate(() => {
        const v = document.querySelector('video');
        if (v) v.pause();
      });
      await delayFunction(Math.random() * 5000 + 2000);
      await page.evaluate(() => {
        const v = document.querySelector('video');
        if (v) v.play();
      });
    }

    // Random seek
    if (Math.random() < 0.1) {
      const seekTime = Math.random() * 10;
      const direction = Math.random() > 0.5 ? 1 : -1;
      const newTime = Math.max(0, Math.min(currTime + direction * seekTime, dur));
      await page.evaluate(t => {
        const v = document.querySelector('video');
        if (v) v.currentTime = t;
      }, newTime);
    }

    await delayFunction(5000);
  }
}

/************************************************
 * 10) openWindowWithRetry
 ************************************************/
async function openWindowWithRetry(
  i,
  query,
  channelName,
  applyCookies,
  likeVideo,
  subscribeChannel,
  proxy,
  userAgent,
  filterParam,
  headless,
  videoPlaySeconds,
  retries = 5
) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await openWindow(
        i,
        query,
        channelName,
        applyCookies,
        likeVideo,
        subscribeChannel,
        proxy,
        userAgent,
        filterParam,
        headless,
        videoPlaySeconds
      );
      console.log(`Window ${i + 1}: Succeeded on attempt ${attempt}`);
      return;
    } catch (error) {
      console.error(`Window ${i + 1}: Attempt ${attempt} failed -> ${error.message}`);
      if (attempt < retries) {
        console.log(`Window ${i + 1}: Retrying in 3 seconds...`);
        await delayFunction(3000);
      } else {
        console.error(`Window ${i + 1}: All attempts failed. Skipping.`);
      }
    }
  }
}

/************************************************
 * 11) openWindow
 ************************************************/
async function openWindow(
  i,
  query,
  channelName,
  applyCookies,
  likeVideo,
  subscribeChannel,
  proxy,
  userAgent,
  filterParam,
  headless,
  videoPlaySeconds
) {
  let browser;
  try {
    const navigationTimeout = 60000;

    // *** STEALTH: new headless mode & remove automation flags
    browser = await puppeteer.launch({
      headless: 'new', // "new" headless mode to reduce detection
      executablePath: '/usr/bin/chromium-browser', // adjust if needed
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-accelerated-2d-canvas',
        '--disable-gpu',
        '--disable-infobars',
        '--window-size=1024,600',
        '--disable-blink-features=AutomationControlled',
        '--disable-dev-shm-usage',
        '--disable-background-timer-throttling',
        '--disable-renderer-backgrounding',
        '--disable-backgrounding-occluded-windows',
        ...(proxy ? [`--proxy-server=http://${proxy.ip}:${proxy.port}`] : [])
      ],
      timeout: navigationTimeout
    });

    const page = await browser.newPage();

    // *** STEALTH: Override navigator fingerprints
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
      Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
      Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
      // Add more overrides as needed
    });

    // *** STEALTH: Simulate random network throttling
    try {
      const latency = Math.random() * 50 + 20; // 20-70ms
      const download = Math.random() * 1_000_000 + 500_000; // random throughput
      const upload = Math.random() * 500_000 + 250_000;
      await page.emulateNetworkConditions({
        offline: false,
        downloadThroughput: download,
        uploadThroughput: upload,
        latency
      });
      console.log(`Network throttled: latency=${latency.toFixed(2)}ms, dl=${download}, ul=${upload}`);
    } catch (err) {
      console.warn('Failed to emulate network conditions. Puppeteer version may not support it:', err.message);
    }

    // load cookies if needed
    if (applyCookies) {
      const cookies = loadCookiesForWindow(i);
      if (cookies && cookies.length > 0) {
        await page.setCookie(...cookies);
      }
    }

    // set userAgent
    await page.setUserAgent(userAgent || 'Mozilla/5.0');

    // proxy auth if needed
    if (proxy && proxy.username && proxy.password) {
      await page.authenticate({
        username: proxy.username,
        password: proxy.password
      });
    }

    await page.setDefaultNavigationTimeout(navigationTimeout);

    console.log(`Window ${i + 1}: Navigating to YouTube...`);
    await navigateWithRetry(page, 'https://www.youtube.com', 5, navigationTimeout);

    // *** STEALTH: random scroll on homepage
    await randomScroll(page);

    // Search
    await page.waitForSelector('input[name="search_query"]', { timeout: navigationTimeout });
    await humanizedType(page, 'input[name="search_query"]', query);
    // human move/click to "Search"
    const searchBtn = await page.$('button[aria-label="Search"]');
    if (searchBtn) {
      await humanMoveAndClick(page, searchBtn);
    }

    // Hide immediate overlay ads if any
    await page.evaluate(() => {
      const adOverlay = document.querySelector('.ytp-ad-overlay-container');
      if (adOverlay) adOverlay.style.display = 'none';
      const bannerAd = document.querySelector('.ytp-ad-banner');
      if (bannerAd) bannerAd.style.display = 'none';
      const videoAd = document.querySelector('.video-ads');
      if (videoAd) videoAd.style.display = 'none';
    });

    await page.waitForSelector('ytd-video-renderer', { visible: true, timeout: navigationTimeout });
    await delayFunction(2000);

    // Apply filter if any
    if (filterParam) {
      const filterButton = await page.$('button[aria-label="Search filters"]');
      if (filterButton) {
        await humanMoveAndClick(page, filterButton); // stealth
        await delayFunction(2000);
      }
      const newUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}${filterParam}`;
      await navigateWithRetry(page, newUrl, 3, navigationTimeout);
      await page.waitForSelector('ytd-video-renderer', { visible: true, timeout: navigationTimeout });
    }

    await delayFunction(1500);

    if (channelName) {
      console.log(`Window ${i + 1}: Searching for channel "${channelName}"...`);
      const found = await findAndClickVideoByChannel(page, channelName);
      if (!found) {
        throw new Error(`Could not find any video from channel "${channelName}"`);
      }
    } else {
      // Else, just click the first video
      const sel = 'ytd-video-renderer #video-title';
      await page.waitForSelector(sel, { visible: true, timeout: navigationTimeout });
      const firstVideo = await page.$(sel);
      if (!firstVideo) {
        throw new Error('No videos found after search');
      }
      await humanMoveAndClick(page, firstVideo); // stealth
    }

    console.log(`Window ${i + 1}: Waiting for video element...`);
    await page.waitForSelector('video', { visible: true, timeout: navigationTimeout });

    // wait for ad
    await waitForAdToFinish(page, 30000);

    // track video
    await trackVideoPlayback(page, i, browser, applyCookies, likeVideo, subscribeChannel, videoPlaySeconds);

  } catch (err) {
    console.error(`Window ${i + 1} error: ${err.message}`);
    throw err;
  } finally {
    await safelyCloseBrowser(browser, i);
  }
}

/************************************************
 * 12) "Humanized" typing
 ************************************************/
async function humanizedType(page, selector, text) {
  const inputField = await page.$(selector);
  if (!inputField) return;
  for (let i = 0; i < text.length; i++) {
    await inputField.type(text.charAt(i));
    await delayFunction(Math.floor(Math.random() * (100 - 50 + 1)) + 50);
  }
}

/************************************************
 * 12.5) Human-like Mouse Movements & Click
 ************************************************/
async function humanMoveAndClick(page, elementHandle) {
  const box = await elementHandle.boundingBox();
  if (!box) return;
  // Random offset within the element
  const x = box.x + box.width * Math.random();
  const y = box.y + box.height * Math.random();

  // Move mouse in small steps
  const steps = 5 + Math.floor(Math.random() * 5);
  const start = await page.mouse.position() || { x: 0, y: 0 };
  const deltaX = x - start.x;
  const deltaY = y - start.y;

  for (let i = 1; i <= steps; i++) {
    const curX = start.x + (deltaX * i) / steps;
    const curY = start.y + (deltaY * i) / steps;
    await page.mouse.move(curX, curY);
    await delayFunction(Math.random() * 50 + 50);
  }
  await page.mouse.down();
  await delayFunction(Math.random() * 150 + 50);
  await page.mouse.up();
  await delayFunction(Math.random() * 100 + 50);
}

/************************************************
 * 13) Readers for Proxies & User Agents
 ************************************************/
function readProxiesFromFile(filePath) {
  try {
    if (!fs.existsSync(filePath)) return [];
    const proxyData = fs.readFileSync(filePath, 'utf8');
    return proxyData
      .split('\n')
      .map(line => {
        if (!line.trim()) return null;
        const [credentials, ipPort] = line.split('@');
        if (!credentials || !ipPort) return null;
        const [username, password] = credentials.split(':');
        const [ip, port] = ipPort.split(':');
        return { username, password, ip, port };
      })
      .filter(Boolean);
  } catch (err) {
    console.error(`Error reading proxy file: ${err.message}`);
    return [];
  }
}

function readUserAgentsFromFile(filePath) {
  try {
    if (!fs.existsSync(filePath)) return [];
    const data = fs.readFileSync(filePath, 'utf8');
    return data.split('\n').map(line => line.trim()).filter(Boolean);
  } catch (err) {
    console.error(`Error reading useragent file: ${err.message}`);
    return [];
  }
}

/************************************************
 * 14) Cookies: loadCookiesForWindow
 ************************************************/
function loadCookiesForWindow(windowIndex) {
  const cookiesPath = path.join(__dirname, 'cookies', `profile${windowIndex + 1}_cookies.json`);
  if (!fs.existsSync(cookiesPath)) {
    return [];
  }
  try {
    const fileData = fs.readFileSync(cookiesPath, 'utf8');
    return JSON.parse(fileData);
  } catch (error) {
    console.error(`Error parsing cookies (Window ${windowIndex + 1}): ${error.message}`);
    return [];
  }
}

/************************************************
 * 15) Additional Human-like Scroll
 ************************************************/
async function randomScroll(page) {
  // Scroll the page multiple times, simulating user reading
  const scrollCount = 3 + Math.floor(Math.random() * 3); // 3-5 times
  for (let i = 0; i < scrollCount; i++) {
    await page.evaluate(() => {
      window.scrollBy(0, Math.random() * 300 + 200);
    });
    await delayFunction(Math.random() * 1000 + 500);
  }
}

/************************************************
 * 16) startDynamicAutomation
 ************************************************/
async function startDynamicAutomation(
  query,
  channelName,
  applyCookies,
  likeVideo,
  subscribeChannel,
  totalWindows,
  maxConcurrent,
  proxies,
  userAgents,
  filter,
  headless,
  videoPlaySeconds
) {
  const filterMap = {
    none: '',
    'Last hour': '&sp=EgIIAQ%253D%253D',
    'Today': '&sp=EgIIAg%253D%253D',
    'This week': '&sp=EgIIAw%253D%253D'
  };
  const filterParam = filterMap[filter] || '';

  let completedCount = 0;
  let nextWindowIndex = 0;
  const activeWindows = new Set();

  while (completedCount < totalWindows) {
    // Start new windows if below concurrency
    while (activeWindows.size < maxConcurrent && nextWindowIndex < totalWindows) {
      const currIndex = nextWindowIndex++;
      const proxy = proxies[currIndex % proxies.length] || null;
      const userAgent = userAgents[currIndex % userAgents.length] || 'Mozilla/5.0';

      const promise = openWindowWithRetry(
        currIndex,
        query,
        channelName,
        applyCookies,
        likeVideo,
        subscribeChannel,
        proxy,
        userAgent,
        filterParam,
        headless,
        videoPlaySeconds,
        5
      )
        .then(() => {
          console.log(`Window ${currIndex + 1} finished.`);
          activeWindows.delete(promise);
          completedCount++;
        })
        .catch(() => {
          activeWindows.delete(promise);
          completedCount++;
        });

      activeWindows.add(promise);
    }

    // Wait for at least one window to finish if any are running
    if (activeWindows.size > 0) {
      await Promise.race(activeWindows);
    }
  }

  console.log('All windows processed via dynamic concurrency!');
}

/************************************************
 * 17) Express Server: Expose an API
 ************************************************/
const app = express();
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

app.get('/', (req, res) => {
  res.send(`
    <h1>YouTube Bot Running (Stealth Mode)</h1>
    <p>Use POST /start-bot with JSON to launch automation.</p>
  `);
});

// POST /start-bot -> Runs the automation
app.post('/start-bot', async (req, res) => {
  try {
    const {
      query = '',
      channelName = '',
      applyCookies = false,
      likeVideo = false,
      subscribeChannel = false,
      totalWindows = 10,
      maxConcurrent = 5,
      filter = 'none',
      headless = true,
      videoPlaySeconds = 60
    } = req.body;

    // read proxies & userAgents
    const proxyFilePath = path.join(__dirname, 'proxies.txt');
    const userAgentFilePath = path.join(__dirname, 'useragent.txt');
    const proxies = readProxiesFromFile(proxyFilePath);
    const userAgents = readUserAgentsFromFile(userAgentFilePath);

    await startDynamicAutomation(
      query,
      channelName,
      applyCookies,
      likeVideo,
      subscribeChannel,
      parseInt(totalWindows),
      parseInt(maxConcurrent),
      proxies,
      userAgents,
      filter,
      headless === true || headless === 'true',
      parseInt(videoPlaySeconds)
    );

    res.json({ success: true, message: 'Bot automation completed (stealth mode)!' });
  } catch (error) {
    console.error('Error in /start-bot:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});
app.get('/stats', (req, res) => {
    res.json(globalStats);
});

// Listen on port 3000 (adjust as needed)
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`YouTube Bot API (Stealth) running on port ${PORT}`);
});
