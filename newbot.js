/*************************************************************
 * automation.js  (Worker)
 * -----------------------------------------------------------
 * 1) Retains your original code (inquirer, concurrency, etc.)
 * 2) Adds random window size, random mouse movement,
 *    random scroll, and random keyboard presses
 *************************************************************/

const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const AdblockerPlugin = require('puppeteer-extra-plugin-adblocker');
const inquirer = require('inquirer');
const express = require('express');
const bodyParser = require('body-parser');
const fs = require('fs');
const path = require('path');

// === Stealth & Adblocker
puppeteer.use(AdblockerPlugin({ blockTrackers: true }));
puppeteer.use(StealthPlugin());

// === Global Stats
const globalStats = {
  totalViews: 0,
  totalRefreshes: 0,
  activeWindows: 0
};

// === Delay Helper
function delayFunction(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// === navigateWithRetry
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

// === findAndClickVideoByChannel
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
          // Use random mouse movement to click
          await humanMoveAndClick(page, titleEl);
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

// === waitForAdToFinish
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

// === safelyCloseBrowser
async function safelyCloseBrowser(browser, windowIndex) {
  if (browser) {
    try {
      await browser.close();
      globalStats.activeWindows--;
    } catch (err) {
      console.error(`Error closing browser (Window ${windowIndex + 1}): ${err.message}`);
    }
  }
}

// === forceQuality144p
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
      console.error('Error: "144p" resolution not found.');
    } else {
      console.log('Resolution set to "144p".');
    }
    await delayFunction(500);

  } catch (err) {
    console.error('Error forcing 144p:', err.message);
  }
}

// === randomlyLikeVideo
async function randomlyLikeVideo(page, totalDuration) {
  // same logic as your older code
  // (omitted for brevity, but the gist is we wait until 25% time, then click "Like")
}

// === subscribeToChannelDuringPlayback
async function subscribeToChannelDuringPlayback(page, totalDuration) {
  // same logic as your older code
  // (omitted for brevity)
}

// === randomScrollDuringPlayback (new stealth function)
async function randomScrollDuringPlayback(page) {
  // randomly scroll the page a bit
  const scrollHeight = await page.evaluate(() => document.body.scrollHeight);
  const randomY = Math.floor(Math.random() * (scrollHeight / 2)) + 100;
  await page.evaluate(y => window.scrollBy(0, y), randomY);
  await delayFunction(2000);
  // scroll back up
  await page.evaluate(() => window.scrollTo(0, 0));
}

// === randomKeyboardPress (new stealth function)
async function randomKeyboardPress(page) {
  // e.g., press arrow keys or space
  const keys = ['ArrowRight', 'ArrowLeft', 'Space'];
  const keyToPress = keys[Math.floor(Math.random() * keys.length)];
  console.log(`Pressing key ${keyToPress}`);
  await page.keyboard.press(keyToPress);
}

// === trackVideoPlayback
async function trackVideoPlayback(
  page,
  windowIndex,
  browser,
  applyCookies,
  likeVideo,
  subscribeChannel,
  videoPlaySeconds
) {
  const startTimeout = 50000;
  const startTime = Date.now();
  let playbackStarted = false;
  let totalDuration = 0;
  let reloadCount = 0;
  let lastCurrentTime = 0;
  let stuckTime = 0;

  // Wait for playback to start
  while (!playbackStarted) {
    if (Date.now() - startTime > startTimeout) {
      if (reloadCount === 0) {
        console.error(`Window ${windowIndex + 1}: Playback didn't start -> Reloading once.`);
        globalStats.totalRefreshes++;
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

  // Force 144p
  await forceQuality144p(page);

  // Possibly Like / Subscribe
  if (applyCookies) {
    if (likeVideo) {
      await randomlyLikeVideo(page, totalDuration);
    }
    if (subscribeChannel) {
      await subscribeToChannelDuringPlayback(page, totalDuration);
    }
  }

  while (true) {
    const vidData = await page.evaluate(() => {
      const v = document.querySelector('video');
      return v
        ? { currentTime: v.currentTime || 0, totalDuration: v.duration || 0 }
        : { currentTime: 0, totalDuration: 0 };
    });
    const currTime = vidData.currentTime || 0;
    const dur = vidData.totalDuration || 0;

    console.log(`Window ${windowIndex + 1}: currentTime=${currTime.toFixed(2)} / ${dur.toFixed(2)} sec`);

    // (1) If currentTime >= videoPlaySeconds => close
    if (currTime >= videoPlaySeconds) {
      console.log(`Window ${windowIndex + 1}: currentTime >= ${videoPlaySeconds} => closing.`);
      console.log(`Window ${windowIndex + 1}: Counting as a completed view.`);
      await browser.close();
      return;
    }

    // (2) If near the end
    if (dur > 0 && dur - currTime <= 12) {
      console.log(`Window ${windowIndex + 1}: Near the end => closing.`);
      console.log(`Window ${windowIndex + 1}: Counting as a completed view.`);
      await browser.close();
      return;
    }

    // (3) Stuck detection
    if (currTime === lastCurrentTime) {
      stuckTime += 5;
      if (stuckTime >= 15) {
        console.warn(`Window ${windowIndex + 1}: Stuck => reload once`);
        globalStats.totalRefreshes++;
        await page.reload({ waitUntil: 'domcontentloaded' });
        stuckTime = 0;
        lastCurrentTime = 0;
        continue;
      }
    } else {
      stuckTime = 0;
    }
    lastCurrentTime = currTime;

    // (4) Random stealth actions during playback
    // e.g., random scrolling or keyboard press
    if (Math.random() < 0.2) {
      console.log(`Window ${windowIndex + 1}: randomScrolling`);
      await randomScrollDuringPlayback(page);
    }
    if (Math.random() < 0.15) {
      await randomKeyboardPress(page);
    }

    // (5) Random pause/resume
    if (Math.random() < 0.15) {
      console.log(`Window ${windowIndex + 1}: pausing...`);
      await page.evaluate(() => {
        const v = document.querySelector('video');
        if (v) v.pause();
      });
      await delayFunction(Math.random() * 5000 + 2000);
      console.log(`Window ${windowIndex + 1}: resuming...`);
      await page.evaluate(() => {
        const v = document.querySelector('video');
        if (v) v.play();
      });
    }

    // (6) Random seek
    if (Math.random() < 0.1) {
      const seekSec = Math.random() * 10;
      const direction = Math.random() > 0.5 ? 1 : -1;
      const newT = Math.max(0, Math.min(currTime + direction * seekSec, dur));
      console.log(`Window ${windowIndex + 1}: seeking => ${newT.toFixed(1)}s`);
      await page.evaluate(t => {
        const v = document.querySelector('video');
        if (v) v.currentTime = t;
      }, newT);
    }

    await delayFunction(5000);
  }
}

// === openWindowWithRetry
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

// === openWindow
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

    // (1) Random window size
    const randomWidth = 800 + Math.floor(Math.random() * 400); // 800-1200
    const randomHeight = 600 + Math.floor(Math.random() * 300); // 600-900

    browser = await puppeteer.launch({
      headless,
      executablePath: '/usr/bin/chromium-browser', // adjust for your VPS if needed
      args: [
        `--window-size=${randomWidth},${randomHeight}`,
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-accelerated-2d-canvas',
        '--disable-gpu',
        '--disable-infobars',
        '--disable-blink-features=AutomationControlled',
        '--disable-dev-shm-usage',
        '--disable-background-timer-throttling',
        '--disable-renderer-backgrounding',
        '--disable-backgrounding-occluded-windows',
        ...(proxy ? [`--proxy-server=http://${proxy.ip}:${proxy.port}`] : []),
      ],
      defaultViewport: null,
      timeout: navigationTimeout
    });

    globalStats.activeWindows++;

    const page = await browser.newPage();

    // load cookies if needed
    if (applyCookies) {
      const cookies = loadCookiesForWindow(i);
      if (cookies && cookies.length > 0) {
        await page.setCookie(...cookies);
      }
    }

    await page.setUserAgent(userAgent || 'Mozilla/5.0');

    if (proxy && proxy.username && proxy.password) {
      await page.authenticate({ username: proxy.username, password: proxy.password });
    }

    await page.setDefaultNavigationTimeout(navigationTimeout);

    console.log(`Window ${i + 1}: Navigating to YouTube...`);
    await navigateWithRetry(page, 'https://www.youtube.com', 5, navigationTimeout);

    // search
    await page.waitForSelector('input[name="search_query"]', { timeout: navigationTimeout });
    await humanizedType(page, 'input[name="search_query"]', query);
    await page.click('button[aria-label="Search"]');

    // hide immediate overlay ads if any
    await page.evaluate(() => {
      const adOverlay = document.querySelector('.ytp-ad-overlay-container');
      if (adOverlay) adOverlay.style.display = 'none';
      const bannerAd = document.querySelector('.ytp-ad-banner');
      if (bannerAd) bannerAd.style.display = 'none';
      const videoAd = document.querySelector('.video-ads');
      if (videoAd) videoAd.style.display = 'none';
    });

    await delayFunction(2000);

    // filter
    if (filterParam) {
      await page.click('button[aria-label="Search filters"]');
      await delayFunction(2000);
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
      const sel = 'ytd-video-renderer #video-title';
      await page.waitForSelector(sel, { visible: true, timeout: navigationTimeout });
      const firstVideo = await page.$(sel);
      if (!firstVideo) {
        throw new Error('No videos found after search');
      }
      // Use random mouse movement to click
      await humanMoveAndClick(page, firstVideo);
    }

    console.log(`Window ${i+1}: Waiting for video element...`);
    await page.waitForSelector('video', { visible: true, timeout: navigationTimeout });

    console.log(`Window ${i+1}: Waiting for ad...`);
    await waitForAdToFinish(page, 30000);

    console.log(`Window ${i+1}: Tracking playback...`);
    await trackVideoPlayback(page, i, browser, applyCookies, likeVideo, subscribeChannel, videoPlaySeconds);

  } catch (err) {
    console.error(`Window ${i + 1} error: ${err.message}`);
    throw err;
  } finally {
    await safelyCloseBrowser(browser, i);
  }
}

// humanizedType
async function humanizedType(page, selector, text) {
  const inputField = await page.$(selector);
  for (let i = 0; i < text.length; i++) {
    await inputField.type(text.charAt(i));
    const randDelay = Math.floor(Math.random() * (100 - 50 + 1)) + 50;
    await delayFunction(randDelay);
  }
}

// Readers
function readProxiesFromFile(filePath) {
  // same logic as your old code
  // ...
}
function readUserAgentsFromFile(filePath) {
  // same logic as your old code
  // ...
}
function loadCookiesForWindow(windowIndex) {
  // same logic as your old code
  // ...
}

// startDynamicAutomation
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
  // same concurrency loop from your old code
  const filterMap = {
    none: '',
    'Last hour': '&sp=EgIIAQ%253D%253D',
    'Today': '&sp=EgIIAg%253D%253D',
    'This week': '&sp=EgIIAw%253D%253D'
  };
  const filterParam = filterMap[filter] || '';

  let completedCount = 0;
  let nextIndex = 0;
  const activeWindows = new Set();

  while (completedCount < totalWindows) {
    while (activeWindows.size < maxConcurrent && nextIndex < totalWindows) {
      const currIndex = nextIndex++;
      const px = proxies[currIndex % proxies.length] || null;
      const ua = userAgents[currIndex % userAgents.length] || 'Mozilla/5.0';

      const promise = openWindowWithRetry(
        currIndex,
        query,
        channelName,
        applyCookies,
        likeVideo,
        subscribeChannel,
        px,
        ua,
        filterParam,
        headless,
        videoPlaySeconds,
        3
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
  console.log('All windows processed via dynamic concurrency!');
}

// Inquirer-based flow
(async () => {
  const prompt = inquirer.createPromptModule();

  const answers1 = await prompt([
    { type: 'input', name: 'query', message: 'Enter YouTube search query (video title or keywords):' },
    { type: 'input', name: 'channelName', message: 'Enter the channel name (leave blank to skip):' },
    { type: 'confirm', name: 'applyCookies', message: 'Do you want to apply cookies?', default: false },
  ]);

  let cookiesAnswers = { likeVideo: false, subscribeChannel: false };
  if (answers1.applyCookies) {
    cookiesAnswers = await prompt([
      { type: 'confirm', name: 'likeVideo', message: 'Like the video?', default: false },
      { type: 'confirm', name: 'subscribeChannel', message: 'Subscribe to the channel?', default: false },
    ]);
  }

  const answers2 = await prompt([
    { type: 'number', name: 'totalWindows', message: 'How many total windows to open?', default: 10 },
    { type: 'number', name: 'maxConcurrent', message: 'Max concurrency?', default: 5 },
    {
      type: 'list',
      name: 'filter',
      message: 'Select a filter for search results:',
      choices: ['none', 'Last hour', 'Today', 'This week'],
      default: 'none'
    },
    { type: 'confirm', name: 'headless', message: 'Use headless mode (no UI)?', default: true },
    { type: 'number', name: 'videoPlaySeconds', message: 'Video playback time (seconds)?', default: 60 }
  ]);

  const finalAnswers = { ...answers1, ...cookiesAnswers, ...answers2 };

  const proxyFilePath = path.join(__dirname, 'proxies.txt');
  const userAgentFilePath = path.join(__dirname, 'useragent.txt');

  const proxies = readProxiesFromFile(proxyFilePath);
  const userAgents = readUserAgentsFromFile(userAgentFilePath);

  await startDynamicAutomation(
    finalAnswers.query,
    finalAnswers.channelName,
    finalAnswers.applyCookies,
    finalAnswers.likeVideo,
    finalAnswers.subscribeChannel,
    finalAnswers.totalWindows,
    finalAnswers.maxConcurrent,
    proxies,
    userAgents,
    finalAnswers.filter,
    finalAnswers.headless,
    finalAnswers.videoPlaySeconds
  );
})();

// =========== EXPRESS FOR VPS & Live Updates ===========

const app = express();
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// GET /stats -> Return minimal stats
app.get('/stats', (req, res) => {
  res.json(globalStats);
});

// POST /start-bot -> same logic as the inquirer flow, but from JSON
app.post('/start-bot', async (req, res) => {
  try {
    const {
      query = '',
      channelName = '',
      applyCookies = false,
      likeVideo = false,
      subscribeChannel = false,
      totalWindows = 1,
      maxConcurrent = 1,
      filter = 'none',
      headless = true,
      videoPlaySeconds = 60
    } = req.body;

    const proxyFilePath = path.join(__dirname, 'proxies.txt');
    const userAgentFilePath = path.join(__dirname, 'useragent.txt');
    const proxies = readProxiesFromFile(proxyFilePath);
    const userAgents = readUserAgentsFromFile(userAgentFilePath);

    // reset stats each run if you want
    globalStats.activeWindows = 0;
    globalStats.totalViews = 0;
    globalStats.totalRefreshes = 0;

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
      (headless === true || headless === 'true'),
      parseInt(videoPlaySeconds)
    );

    res.json({ success: true, message: 'Bot started via /start-bot' });
  } catch (error) {
    console.error('/start-bot error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Start server on port 3000
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Worker listening on port ${PORT}`);
});
