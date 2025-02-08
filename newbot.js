/*************************************************************
 * newbot.js - Stealth YouTube Bot (Worker)
 * -----------------------------------------------------------
 * 1) Listens on port 3000
 * 2) Maintains global stats:
 *    - totalWindowsOpened
 *    - totalRefreshes
 *    - totalViews
 *    - totalWatchTimeSec
 *    - totalCrashes
 * 3) Provides "/start-bot" to begin automation
 * 4) Provides "/stats" to fetch current stats
 *************************************************************/

const puppeteer = require('puppeteer-extra');
const express = require('express');
const bodyParser = require('body-parser');
const fs = require('fs');
const path = require('path');

const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const AdblockerPlugin = require('puppeteer-extra-plugin-adblocker');

// PLUGINS
puppeteer.use(StealthPlugin());
puppeteer.use(AdblockerPlugin({ blockTrackers: true }));

// =======================================================
// Global Stats
// =======================================================
const globalStats = {
  totalWindowsOpened: 0,
  totalRefreshes: 0,       // number of times a window reloaded
  totalViews: 0,           // total videos completed
  totalWatchTimeSec: 0,    // cumulative watch time (in seconds)
  totalCrashes: 0          // windows that failed all retries
};

// =======================================================
// Express Setup
// =======================================================
const app = express();
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// GET /stats -> Return the global stats as JSON
app.get('/stats', (req, res) => {
  res.json(globalStats);
});

// POST /start-bot -> Trigger the automation
app.post('/start-bot', async (req, res) => {
  try {
    // Extract parameters
    const {
      query = '',
      channelName = '',
      applyCookies = false,
      likeVideo = false,
      subscribeChannel = false,
      totalWindows = 2,
      maxConcurrent = 1,
      filter = 'none',
      headless = true,
      videoPlaySeconds = 60
    } = req.body;

    // Convert numeric fields
    const totalW = parseInt(totalWindows);
    const maxC = parseInt(maxConcurrent);
    const vidSecs = parseInt(videoPlaySeconds);
    const isHeadless = (headless === true || headless === 'true');

    // CLEAR or reset stats if you want fresh numbers each time
    // (Remove if you want cumulative stats across runs)
    globalStats.totalWindowsOpened = 0;
    globalStats.totalRefreshes = 0;
    globalStats.totalViews = 0;
    globalStats.totalWatchTimeSec = 0;
    globalStats.totalCrashes = 0;

    // read proxies & userAgents from files
    const proxyFilePath = path.join(__dirname, 'proxies.txt');
    const userAgentFilePath = path.join(__dirname, 'useragent.txt');
    const proxies = readProxiesFromFile(proxyFilePath);
    const userAgents = readUserAgentsFromFile(userAgentFilePath);

    // Start concurrency
    await startDynamicAutomation(
      query,
      channelName,
      applyCookies,
      likeVideo,
      subscribeChannel,
      totalW,
      maxC,
      proxies,
      userAgents,
      filter,
      isHeadless,
      vidSecs
    );

    res.json({ success: true, message: 'Stealth Bot run completed.' });
  } catch (err) {
    console.error('Error in /start-bot:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Start the Worker server on port 3000
const PORT = 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`YouTube Bot API (Stealth) running on port ${PORT}`);
});

// =======================================================
// Utility & Core Logic (Same from your stealth code,
// but with added globalStats updates)
// =======================================================
const puppeteerExtra = require('puppeteer-extra'); // For clarity
const StealthPlug = require('puppeteer-extra-plugin-stealth');

// Use your existing concurrency & watchers code:
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

// A simplified concurrency approach
async function startDynamicAutomation(
  query, channelName,
  applyCookies, likeVideo, subscribeChannel,
  totalWindows, maxConcurrent,
  proxies, userAgents,
  filter, headless, videoPlaySeconds
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
    // Launch new windows if under concurrency
    while (activeWindows.size < maxConcurrent && nextWindowIndex < totalWindows) {
      const currIndex = nextWindowIndex++;
      const proxy = proxies[currIndex % proxies.length] || null;
      const userAgent = userAgents[currIndex % userAgents.length] || 'Mozilla/5.0';

      globalStats.totalWindowsOpened++; // increment each time we open a window

      const promise = openWindowWithRetry(
        currIndex,
        query, channelName,
        applyCookies, likeVideo, subscribeChannel,
        proxy, userAgent,
        filterParam,
        headless,
        videoPlaySeconds,
        3 // let's say 3 retries
      )
        .then(() => {
          activeWindows.delete(promise);
          completedCount++;
        })
        .catch(() => {
          activeWindows.delete(promise);
          completedCount++;
        });

      activeWindows.add(promise);
    }

    if (activeWindows.size > 0) {
      await Promise.race(activeWindows);
    }
  }
}

// Retry logic
async function openWindowWithRetry(
  i,
  query, channelName,
  applyCookies, likeVideo, subscribeChannel,
  proxy, userAgent, filterParam,
  headless, videoPlaySeconds,
  retries
) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await openWindow(
        i,
        query, channelName,
        applyCookies, likeVideo, subscribeChannel,
        proxy, userAgent, filterParam,
        headless, videoPlaySeconds
      );
      return;
    } catch (err) {
      console.error(`Window ${i+1} attempt ${attempt} failed: ${err.message}`);
      if (attempt < retries) {
        await delayFunction(3000);
      } else {
        // All attempts failed => "crash"
        globalStats.totalCrashes++;
      }
    }
  }
}

// The main function that opens a single window
async function openWindow(
  i,
  query, channelName,
  applyCookies, likeVideo, subscribeChannel,
  proxy, userAgent, filterParam,
  headless, videoPlaySeconds
) {
  let browser;
  try {
    browser = await launchBrowser(headless, proxy);
    const page = await browser.newPage();

    if (proxy && proxy.username && proxy.password) {
      await page.authenticate({ username: proxy.username, password: proxy.password });
    }

    await page.setUserAgent(userAgent);
    await page.setDefaultNavigationTimeout(60000);

    // Navigate to YT
    await page.goto('https://www.youtube.com', { waitUntil: 'domcontentloaded' });

    // Search
    await page.waitForSelector('input[name="search_query"]', { timeout: 60000 });
    await humanizedType(page, 'input[name="search_query"]', query);
    await page.click('button[aria-label="Search"]');

    await page.waitForSelector('ytd-video-renderer', { visible: true, timeout: 60000 });
    await delayFunction(2000);

    // Filter
    if (filterParam) {
      await page.click('button[aria-label="Search filters"]');
      await delayFunction(2000);
      const newUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}${filterParam}`;
      await page.goto(newUrl, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('ytd-video-renderer', { visible: true, timeout: 60000 });
    }

    await delayFunction(1500);

    // If channelName => find that channel
    if (channelName) {
      const found = await findAndClickVideoByChannel(page, channelName);
      if (!found) {
        throw new Error(`No video found from channel "${channelName}"`);
      }
    } else {
      // click first video
      const sel = 'ytd-video-renderer #video-title';
      await page.waitForSelector(sel, { visible: true, timeout: 60000 });
      const firstVideo = await page.$(sel);
      if (!firstVideo) {
        throw new Error('No videos in results');
      }
      await firstVideo.click();
    }

    // wait for video
    await page.waitForSelector('video', { visible: true, timeout: 60000 });

    // track video
    await trackVideoPlayback(page, browser, i, videoPlaySeconds, likeVideo, subscribeChannel);

  } catch (err) {
    if (browser) await browser.close();
    throw err; // let the caller handle
  }
}

// ========== LAUNCH BROWSER (stealth) ==========
async function launchBrowser(headless, proxy) {
  const args = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--window-size=1024,600',
    '--disable-blink-features=AutomationControlled'
  ];
  if (proxy && proxy.ip && proxy.port) {
    args.push(`--proxy-server=http://${proxy.ip}:${proxy.port}`);
  }
  return puppeteer.launch({
    headless: headless ? 'new' : false, // "new" to reduce detection
    executablePath: '/usr/bin/chromium-browser', // adjust if needed
    args
  });
}

// ========== trackVideoPlayback ===============
async function trackVideoPlayback(page, browser, windowIndex, videoPlaySeconds, likeVideo, subscribeChannel) {
  let startTime = Date.now();
  let playbackStarted = false;
  let totalDuration = 0;
  let reloadCount = 0;
  let lastTime = 0; // track watch time increments

  // Wait for playback to start
  while (!playbackStarted) {
    if (Date.now() - startTime > 45000) {
      // reload once if not started
      if (reloadCount < 1) {
        globalStats.totalRefreshes++;
        await page.reload({ waitUntil: 'domcontentloaded' });
        reloadCount++;
        startTime = Date.now();
      } else {
        // cannot start
        await browser.close();
        return;
      }
    }

    const data = await page.evaluate(() => {
      const v = document.querySelector('video');
      if (!v) return { currentTime: 0, totalDuration: 0 };
      return { currentTime: v.currentTime, totalDuration: v.duration };
    });
    if (data.totalDuration > 0) {
      playbackStarted = true;
      totalDuration = data.totalDuration;
    } else {
      await delayFunction(3000);
    }
  }

  // Possibly like / subscribe mid-playback
  if (likeVideo) {
    // do it after 25% of the video
    randomlyLikeVideo(page, totalDuration).catch(() => {});
  }
  if (subscribeChannel) {
    subscribeToChannelDuringPlayback(page, totalDuration).catch(() => {});
  }

  let stuckTime = 0;
  let reloadedForStuck = false;
  startTime = Date.now();

  while (true) {
    const data = await page.evaluate(() => {
      const v = document.querySelector('video');
      if (!v) return { currentTime: 0, totalDuration: 0 };
      return { currentTime: v.currentTime, totalDuration: v.duration };
    });
    const currTime = data.currentTime;
    const dur = data.totalDuration;

    // accumulate watch time
    if (currTime >= lastTime) {
      // add difference
      const diff = currTime - lastTime;
      if (diff > 0) globalStats.totalWatchTimeSec += diff;
      lastTime = currTime;
    }

    // (1) if currentTime >= videoPlaySeconds => done
    if (currTime >= videoPlaySeconds) {
      // consider it a full view
      globalStats.totalViews++;
      await browser.close();
      return;
    }

    // (2) if near end
    if (dur > 0 && dur - currTime <= 10) {
      globalStats.totalViews++;
      await browser.close();
      return;
    }

    // (3) stuck detection
    if (currTime === lastTime) {
      stuckTime += 3;
      if (stuckTime > 15) {
        if (!reloadedForStuck) {
          globalStats.totalRefreshes++;
          await page.reload({ waitUntil: 'domcontentloaded' });
          reloadedForStuck = true;
          stuckTime = 0;
          lastTime = 0;
          continue;
        } else {
          // fail
          await browser.close();
          return;
        }
      }
    } else {
      stuckTime = 0;
    }

    // random pause/resume, random seek if you want, etc.
    await delayFunction(3000);
  }
}

// ========== Minor Utility Functions ==========

function delayFunction(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function findAndClickVideoByChannel(page, channelName) {
  for (let scrollCount = 0; scrollCount < 5; scrollCount++) {
    const videos = await page.$$('ytd-video-renderer');
    for (const vid of videos) {
      const channelEl = await vid.$('ytd-channel-name');
      if (!channelEl) continue;
      const channelText = (await channelEl.evaluate(el => el.textContent.trim())).toLowerCase();
      if (channelText.includes(channelName.toLowerCase())) {
        const title = await vid.$('#video-title');
        if (title) {
          await title.click();
          return true;
        }
      }
    }
    await page.evaluate(() => window.scrollBy(0, 1000));
    await delayFunction(2000);
  }
  return false;
}

// You already have randomlyLikeVideo, subscribeToChannelDuringPlayback, etc. in code above
async function randomlyLikeVideo(page, totalDuration) { /* ... omitted for brevity ... */ }
async function subscribeToChannelDuringPlayback(page, totalDuration) { /* ... omitted ... */ }

async function humanizedType(page, selector, text) {
  const el = await page.$(selector);
  if (!el) return;
  for (let i = 0; i < text.length; i++) {
    await el.type(text.charAt(i));
    const delayMs = Math.floor(Math.random() * 50) + 50; // 50-100ms
    await delayFunction(delayMs);
  }
}
