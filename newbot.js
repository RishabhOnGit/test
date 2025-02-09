/*************************************************************
 * automation.js
 * (Your old code + #2, #3, #4 stealth additions + random window size)
 *************************************************************/

const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const AdblockerPlugin = require('puppeteer-extra-plugin-adblocker');
const inquirer = require('inquirer');
const fs = require('fs');
const path = require('path');

// 1) Use adblocker + stealth
puppeteer.use(AdblockerPlugin({ blockTrackers: true }));
puppeteer.use(StealthPlugin());

// ----------------------------------------------------------
// GLOBAL STATS (unchanged)
const globalStats = {
  activeWindows: 0,
  totalViews: 0,
  totalWatchTime: 0,   // if you track watch time
  totalRefreshes: 0
};

// ----------------------------------------------------------
// UTILITY: Delay
function delayFunction(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ----------------------------------------------------------
// UTILITY: navigateWithRetry
async function navigateWithRetry(page, url, retries = 5, timeout = 60000) {
  for (let i = 0; i < retries; i++) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
      return;
    } catch (err) {
      if (i === retries - 1) throw err;
      console.log(`Retrying navigation: ${err.message}`);
      await delayFunction(2000);
    }
  }
}

// ----------------------------------------------------------
// UTILITY: findAndClickVideoByChannel
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
          await humanMoveAndClick(page, titleEl); // #2 random mouse & click
          return true;
        }
      }
    }
    console.log(`Channel "${channelName}" not found, scrolling...`);
    await page.evaluate(() => window.scrollBy(0, 800));
    await delayFunction(1500);
    attempts++;
  }
  return false;
}

// ----------------------------------------------------------
// UTILITY: waitForAdToFinish
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

// ----------------------------------------------------------
// UTILITY: safelyCloseBrowser
async function safelyCloseBrowser(browser, windowIndex) {
  if (browser) {
    try {
      await browser.close();
      globalStats.activeWindows--;
    } catch (err) {
      console.error(`Error closing browser (Window ${windowIndex+1}): ${err.message}`);
    }
  }
}

// ----------------------------------------------------------
// UTILITY: forceQuality144p
async function forceQuality144p(page) {
  try {
    await delayFunction(1000);
    await page.waitForSelector('.ytp-settings-button', { visible: true, timeout: 60000 });
    await page.click('.ytp-settings-button');

    await page.waitForSelector('.ytp-settings-menu', { visible: true, timeout: 60000 });
    await page.evaluate(() => {
      const menu = document.querySelector('.ytp-settings-menu, .ytp-panel-menu');
      if (menu) menu.scrollTop = menu.scrollHeight;
    });
    await delayFunction(500);

    await page.evaluate(() => {
      const items = [...document.querySelectorAll('.ytp-menuitem')];
      const qualityItem = items.find(item => item.textContent.includes('Quality'));
      if (qualityItem) qualityItem.click();
    });
    await delayFunction(500);

    await page.evaluate(() => {
      const menu = document.querySelector('.ytp-settings-menu, .ytp-panel-menu');
      if (menu) menu.scrollTop = menu.scrollHeight;
    });
    await delayFunction(500);

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
      console.log('Resolution forced to 144p.');
    }
    await delayFunction(500);

  } catch (err) {
    console.error('Error forcing 144p:', err.message);
  }
}

// ----------------------------------------------------------
// UTILITY: randomlyLikeVideo
async function randomlyLikeVideo(page, totalDuration) {
  // same as old
}

// ----------------------------------------------------------
// UTILITY: subscribeToChannelDuringPlayback
async function subscribeToChannelDuringPlayback(page, totalDuration) {
  // same as old
}

// ----------------------------------------------------------
// trackVideoPlayback
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

  while (!playbackStarted) {
    if (Date.now() - startTime > startTimeout) {
      if (reloadCount === 0) {
        console.error(`Window ${windowIndex+1}: Playback not starting, reloading...`);
        globalStats.totalRefreshes++;
        await page.reload({ waitUntil: 'domcontentloaded' });
        reloadCount++;
      } else {
        console.error(`Window ${windowIndex+1}: Playback never started => closing`);
        await browser.close();
        return;
      }
    }

    const vidData = await page.evaluate(() => {
      const v = document.querySelector('video');
      if (!v) return null;
      return { currentTime: v.currentTime, totalDuration: v.duration };
    });
    if (vidData && vidData.totalDuration > 0) {
      totalDuration = vidData.totalDuration;
      playbackStarted = true;
      console.log(`Window ${windowIndex+1}: Playback started, duration=${totalDuration}`);
    } else {
      await delayFunction(5000);
    }
  }

  await forceQuality144p(page);

  if (applyCookies) {
    if (likeVideo) await randomlyLikeVideo(page, totalDuration);
    if (subscribeChannel) await subscribeToChannelDuringPlayback(page, totalDuration);
  }

  while (true) {
    const data = await page.evaluate(() => {
      const v = document.querySelector('video');
      return v
        ? { currentTime: v.currentTime || 0, totalDuration: v.duration || 0 }
        : { currentTime: 0, totalDuration: 0 };
    });
    const currTime = data.currentTime;
    const dur = data.totalDuration;

    console.log(`Window ${windowIndex+1}: ${currTime.toFixed(2)}/${dur.toFixed(2)} sec`);

    if (currTime >= videoPlaySeconds) {
      console.log(`Window ${windowIndex+1}: Reached ${videoPlaySeconds}s => close`);
      await browser.close();
      globalStats.activeWindows--;
      return;
    }
    if (dur > 0 && dur - currTime <= 10) {
      console.log(`Window ${windowIndex+1}: near end => close`);
      await browser.close();
      globalStats.activeWindows--;
      return;
    }

    if (currTime === lastCurrentTime) {
      stuckTime += 5;
      if (stuckTime >= 15) {
        console.warn(`Window ${windowIndex+1}: stuck => reload once`);
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

    // random pause/resume, random seek, etc. (unchanged)
    await delayFunction(5000);
  }
}

// ----------------------------------------------------------
// openWindowWithRetry
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
  // same concurrency retry logic as old
}

// ----------------------------------------------------------
// #2 (Random Mouse & Click) - helper
async function humanMoveAndClick(page, elementHandle) {
  const box = await elementHandle.boundingBox();
  if (!box) return;

  // Move in small increments
  const steps = 5 + Math.floor(Math.random() * 5);
  const startPos = await page.mouse.position() || { x: 0, y: 0 };
  const deltaX = box.x + box.width/2 - startPos.x;
  const deltaY = box.y + box.height/2 - startPos.y;

  for (let i = 1; i <= steps; i++) {
    const nx = startPos.x + (deltaX * i/steps);
    const ny = startPos.y + (deltaY * i/steps);
    await page.mouse.move(nx, ny);
    await delayFunction(Math.floor(Math.random()*30+30));
  }
  await page.mouse.down();
  await delayFunction(Math.random()*100+50);
  await page.mouse.up();
  await delayFunction(Math.random()*100+50);
}

// ----------------------------------------------------------
// #3 (Puppeteer Fingerprint Solution) => override at doc start
async function overrideFingerprint(page) {
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
    Object.defineProperty(navigator, 'plugins', { get: () => [1,2,3,4,5] });
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US','en'] });
  });
}

// ----------------------------------------------------------
// openWindow
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
    // #4 random window size
    const randomWidth = Math.floor(Math.random()*400+800);
    const randomHeight = Math.floor(Math.random()*300+600);

    browser = await puppeteer.launch({
      // #3 Use new headless mode
      headless: headless ? 'new' : false,
      // random window size
      args: [
        `--window-size=${randomWidth},${randomHeight}`,
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-gpu',
        '--disable-infobars',
        '--disable-blink-features=AutomationControlled',
        ...(proxy ? [`--proxy-server=http://${proxy.ip}:${proxy.port}`] : [])
      ],
      defaultViewport: null, // so it uses window-size
      timeout: 60000
    });

    globalStats.activeWindows++;

    const page = await browser.newPage();
    await overrideFingerprint(page); // #3 override
    if (proxy && proxy.username && proxy.password) {
      await page.authenticate({ username: proxy.username, password: proxy.password });
    }

    if (userAgent) {
      await page.setUserAgent(userAgent);
    }

    await page.setDefaultNavigationTimeout(90000);

    console.log(`Window ${i+1}: Goto YouTube`);
    await navigateWithRetry(page, 'https://www.youtube.com', 5, 90000);

    // search
    await page.waitForSelector('input[name="search_query"]');
    await humanizedType(page, 'input[name="search_query"]', query);
    await page.click('button[aria-label="Search"]');

    await delayFunction(2000);

    // filter
    if (filterParam) {
      await page.click('button[aria-label="Search filters"]');
      await delayFunction(2000);
      const newUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}${filterParam}`;
      await navigateWithRetry(page, newUrl, 3, 90000);
      await page.waitForSelector('ytd-video-renderer', { visible: true, timeout: 90000 });
    }

    await delayFunction(1500);

    if (channelName) {
      console.log(`Window ${i+1}: Searching channel ${channelName}`);
      const found = await findAndClickVideoByChannel(page, channelName);
      if (!found) throw new Error(`No video from channel "${channelName}"`);
    } else {
      const sel = 'ytd-video-renderer #video-title';
      await page.waitForSelector(sel, { visible: true, timeout: 90000 });
      const firstVideo = await page.$(sel);
      if (!firstVideo) throw new Error('No videos found');
      await humanMoveAndClick(page, firstVideo);
    }

    await page.waitForSelector('video', { visible: true, timeout: 90000 });
    await waitForAdToFinish(page, 30000);
    await trackVideoPlayback(page, i, browser, applyCookies, likeVideo, subscribeChannel, videoPlaySeconds);

  } catch (err) {
    console.error(`Window ${i+1} error: ${err.message}`);
    throw err;
  } finally {
    await safelyCloseBrowser(browser, i);
  }
}

// ----------------------------------------------------------
// "Humanized" typing
async function humanizedType(page, selector, text) {
  const input = await page.$(selector);
  if (!input) return;
  for (let i=0; i<text.length; i++) {
    await input.type(text.charAt(i));
    await delayFunction(Math.floor(Math.random()*50+50));
  }
}

// ----------------------------------------------------------
// Readers
function readProxiesFromFile(filePath) { /* same as old */ }
function readUserAgentsFromFile(filePath) { /* same as old */ }
function loadCookiesForWindow(windowIndex) { /* if you want cookies logic */ }

// ----------------------------------------------------------
// The dynamic concurrency approach
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
  // same concurrency loop as old code
}

// ----------------------------------------------------------
// Main user prompts (unchanged)
(async () => {
  // same inquirer flow...
})();

// ----------------------------------------------------------
// Express server for manager calls
const expressApp = express();
expressApp.use(bodyParser.json());
expressApp.use(bodyParser.urlencoded({ extended: true }));

expressApp.get('/', (req, res) => {
  res.send(`<h1>Stealth Worker Running</h1><p>POST /start-bot, GET /stats</p>`);
});

expressApp.post('/start-bot', async (req, res) => {
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

    // reset stats each run if you want
    globalStats.activeWindows = 0;
    globalStats.totalViews = 0;
    globalStats.totalRefreshes = 0;
    // globalStats.totalWatchTime = 0; // if you track watch time

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
      (headless === true || headless === 'true'),
      parseInt(videoPlaySeconds)
    );

    res.json({ success: true, message: 'Bot started with new stealth changes.' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

expressApp.get('/stats', (req, res) => {
  res.json(globalStats);
});

const PORT = 3000;
expressApp.listen(PORT, '0.0.0.0', () => {
  console.log(`Stealth Worker listening on port ${PORT}`);
});
