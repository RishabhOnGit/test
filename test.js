// File: automation.js

const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const inquirer = require('inquirer');
const fs = require('fs');
const path = require('path');
const AdblockerPlugin = require('puppeteer-extra-plugin-adblocker');

puppeteer.use(AdblockerPlugin({ blockTrackers: true }));
puppeteer.use(StealthPlugin());

// Delay utility
function delayFunction(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Navigate with retries
async function navigateWithRetry(page, url, retries = 5, timeout = 120000) {
  for (let i = 0; i < retries; i++) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
      return;
    } catch (err) {
      if (i === retries - 1) throw err;
      console.error(`Navigation failed (attempt ${i + 1}): ${err.message}`);
      await delayFunction(2000);
    }
  }
}

// Scroll and find a specific channel’s video
async function findAndClickVideoByChannel(page, channelName, maxScrollAttempts = 5) {
  let attempts = 0;
  while (attempts < maxScrollAttempts) {
    const videoHandles = await page.$$('ytd-video-renderer');
    for (const video of videoHandles) {
      const channelEl = await video.$('ytd-channel-name');
      if (!channelEl) continue;

      const channelText = await channelEl.evaluate(el => el.textContent.trim());
      if (channelText.toLowerCase().includes(channelName.toLowerCase())) {
        const titleEl = await video.$('#video-title');
        if (titleEl) {
          console.log(`Found channel match: "${channelText}" -> clicking video`);
          await titleEl.click();
          return true;
        }
      }
    }
    console.log(`Channel "${channelName}" not found yet, scrolling further...`);
    await page.evaluate(() => {
      window.scrollBy(0, 800);
    });
    await delayFunction(1500);
    attempts++;
  }
  return false;
}

// Wait for in-video ad to finish
async function waitForAdToFinish(page, timeout = 30000) {
  const startTime = Date.now();
  while (true) {
    const isSponsoredAdVisible = await page.evaluate(() => {
      const sponsoredBadge = document.querySelector('.ad-simple-attributed-string.ytp-ad-badge__text--clean-player');
      return sponsoredBadge && sponsoredBadge.style.display !== 'none';
    });
    if (!isSponsoredAdVisible) break;

    await delayFunction(3000);
    if (Date.now() - startTime > timeout) break;
  }
}

// Close browser safely
async function safelyCloseBrowser(browser, windowIndex) {
  if (browser) {
    try {
      await browser.close();
    } catch (err) {
      console.error(`Error while closing browser (Window ${windowIndex + 1}): ${err.message}`);
    }
  }
}

// Force 144p
async function forceQuality144p(page) {
  try {
    await delayFunction(1000);
    // Open settings
    await page.waitForSelector('.ytp-settings-button', { visible: true, timeout: 120000 });
    await page.click('.ytp-settings-button');

    // Open the settings menu
    await page.waitForSelector('.ytp-settings-menu', { visible: true, timeout: 120000 });
    await page.evaluate(() => {
      const menu = document.querySelector('.ytp-settings-menu') || document.querySelector('.ytp-panel-menu');
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
      const menu = document.querySelector('.ytp-settings-menu') || document.querySelector('.ytp-panel-menu');
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

// Like video partway
async function randomlyLikeVideo(page, totalDuration) {
  const triggerTime = totalDuration / 4;
  while (true) {
    const currentTime = await page.evaluate(() => {
      const video = document.querySelector('video');
      return video ? video.currentTime : 0;
    });
    if (currentTime >= triggerTime) {
      const likeButton = await page.$('button[aria-label*="like this video"]');
      if (likeButton) {
        const isLiked = await page.evaluate(btn => btn.getAttribute('aria-pressed') === 'true', likeButton);
        if (!isLiked) {
          try {
            await likeButton.click();
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

// Subscribe partway
async function subscribeToChannelDuringPlayback(page, totalDuration) {
  const subscribeButtonSelector = 'ytd-subscribe-button-renderer button';
  const triggerTime = totalDuration / 3;
  while (true) {
    const currentTime = await page.evaluate(() => {
      const video = document.querySelector('video');
      return video ? video.currentTime : 0;
    });
    if (currentTime >= triggerTime) {
      const subscribeButton = await page.$(subscribeButtonSelector);
      if (subscribeButton) {
        const isSubscribed = await page.evaluate(
          btn => (btn.textContent || '').toLowerCase().includes('subscribed'),
          subscribeButton
        );
        if (!isSubscribed) {
          try {
            await subscribeButton.click();
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

// trackVideoPlayback - closes the video once currentTime >= videoPlaySeconds
async function trackVideoPlayback(
  page,
  windowIndex,
  browser,
  applyCookies,
  likeVideo,
  subscribeChannel,
  videoPlaySeconds
) {
  // We'll give up if video not started after 50s
  const playbackTimeout = 50000;
  const startTime = Date.now();

  let playbackStarted = false;
  let totalDuration = 0;

  const maxRetries = 5;
  let retryCount = 0;

  // Wait for playback to show a real totalDuration
  while (!playbackStarted && retryCount < maxRetries) {
    if (Date.now() - startTime > playbackTimeout) {
      console.error(`Window ${windowIndex + 1}: No playback after ${playbackTimeout} ms. Reloading...`);
      await page.reload({ waitUntil: 'domcontentloaded' });
      break;
    }
    const videoData = await page.evaluate(() => {
      const v = document.querySelector('video');
      return v ? { currentTime: v.currentTime, totalDuration: v.duration } : null;
    });
    if (videoData && videoData.totalDuration > 0) {
      totalDuration = videoData.totalDuration;
      playbackStarted = true;
      console.log(
        `Window ${windowIndex + 1}: Playback started. Duration: ${totalDuration.toFixed(2)} sec.`
      );
    } else {
      retryCount++;
      if (retryCount < maxRetries) {
        console.log(`Window ${windowIndex + 1}: Checking playback again...`);
        await delayFunction(5000);
      } else {
        console.error(`Window ${windowIndex + 1}: Playback never started. Exiting...`);
        return;
      }
    }
  }

  if (!playbackStarted) {
    console.error(`Window ${windowIndex + 1}: No playback, skipping...`);
    return;
  }

  // Attempt 144p
  await forceQuality144p(page);

  // Like / subscribe if cookies are applied
  if (applyCookies) {
    if (likeVideo) {
      await randomlyLikeVideo(page, totalDuration);
    }
    if (subscribeChannel) {
      await subscribeToChannelDuringPlayback(page, totalDuration);
    }
  }

  while (true) {
    const videoData = await page.evaluate(() => {
      const v = document.querySelector('video');
      if (!v) return { currentTime: 0, totalDuration: 0 };
      return { currentTime: v.currentTime, totalDuration: v.duration };
    });

    const currTime = videoData.currentTime || 0;
    const dur = videoData.totalDuration || 0;

    console.log(
      `Window ${windowIndex + 1}: currentTime=${currTime.toFixed(2)} / ${dur.toFixed(2)} sec`
    );

    // 1) If currentTime >= user-specified time -> close
    if (currTime >= videoPlaySeconds) {
      console.log(`Window ${windowIndex + 1}: currentTime >= ${videoPlaySeconds} -> closing.`);
      await browser.close();
      break;
    }

    // 2) If near end
    if (dur > 0 && dur - currTime <= 12) {
      console.log(`Window ${windowIndex + 1}: Near end -> closing.`);
      await browser.close();
      break;
    }

    // Random pause/resume (15%)
    if (Math.random() < 0.15) {
      await page.evaluate(() => {
        const vid = document.querySelector('video');
        if (vid) vid.pause();
      });
      await delayFunction(Math.random() * 5000 + 2000);
      await page.evaluate(() => {
        const vid = document.querySelector('video');
        if (vid) vid.play();
      });
    }

    // Random seek (10%)
    if (Math.random() < 0.1) {
      const seekTime = Math.random() * 10;
      const seekDirection = Math.random() > 0.5 ? 1 : -1;
      const newTime = Math.max(0, Math.min(currTime + seekDirection * seekTime, dur));
      await page.evaluate(t => {
        const vid = document.querySelector('video');
        if (vid) vid.currentTime = t;
      }, newTime);
    }

    await delayFunction(5000);
  }
}

// openWindow logic with retries
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
      console.error(`Window ${i + 1}: Attempt ${attempt} failed: ${error.message}`);
      if (attempt < retries) {
        console.log(`Window ${i + 1}: Retrying in 3 seconds...`);
        await delayFunction(3000);
      } else {
        console.error(`Window ${i + 1}: All attempts failed. Skipping this window.`);
      }
    }
  }
}

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
    const navigationTimeout = 120000;
    browser = await puppeteer.launch({
      headless,
      executablePath: '/usr/bin/chromium-browser', // Adjust if needed
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
        ...(proxy ? [`--proxy-server=http://${proxy.ip}:${proxy.port}`] : []),
      ],
      timeout: 120000,
    });

    const page = await browser.newPage();

    // Load cookies
    if (applyCookies) {
      const cookies = loadCookiesForWindow(i);
      if (cookies && cookies.length > 0) {
        await page.setCookie(...cookies);
      }
    }

    await page.setUserAgent(userAgent || 'Mozilla/5.0');

    if (proxy) {
      // If proxy has user/pass
      await page.authenticate({
        username: proxy.username,
        password: proxy.password,
      });
    }

    await page.setDefaultNavigationTimeout(navigationTimeout);

    console.log(`Window ${i + 1}: Navigating to YouTube...`);
    await navigateWithRetry(page, 'https://www.youtube.com', 5, navigationTimeout);

    // Search
    await page.waitForSelector('input[name="search_query"]', { timeout: navigationTimeout });
    await humanizedType(page, 'input[name="search_query"]', query);
    await page.click('button[aria-label="Search"]');

    // Ad overlays
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

    // Filter if any
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
      // Click first video
      const sel = 'ytd-video-renderer #video-title';
      await page.waitForSelector(sel, { visible: true, timeout: navigationTimeout });
      const firstVideo = await page.$(sel);
      if (!firstVideo) {
        throw new Error('No videos found after search');
      }
      await firstVideo.click();
    }

    // Wait for video
    console.log(`Window ${i + 1}: Waiting for video element...`);
    await page.waitForSelector('video', { visible: true, timeout: navigationTimeout });

    // Wait for ad
    await waitForAdToFinish(page, 30000);

    // track video playback
    await trackVideoPlayback(page, i, browser, applyCookies, likeVideo, subscribeChannel, videoPlaySeconds);
  } catch (err) {
    console.error(`Window ${i + 1} error: ${err.message}`);
    throw err;
  } finally {
    await safelyCloseBrowser(browser, i);
  }
}

// Humanized typing
async function humanizedType(page, selector, text) {
  const inputField = await page.$(selector);
  for (let i = 0; i < text.length; i++) {
    await inputField.type(text.charAt(i));
    const randDelay = Math.floor(Math.random() * (100 - 50 + 1)) + 50; // 50-100ms
    await delayFunction(randDelay);
  }
}

// Read proxies
function readProxiesFromFile(filePath) {
  try {
    if (!fs.existsSync(filePath)) return [];
    const proxyData = fs.readFileSync(filePath, 'utf8');
    return proxyData.split('\n').map(line => {
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

// Read user agents
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

// Load cookies
function loadCookiesForWindow(windowIndex) {
  const cookiesPath = path.join(__dirname, 'cookies', `profile${windowIndex + 1}_cookies.json`);
  if (!fs.existsSync(cookiesPath)) {
    return [];
  }
  try {
    const fileData = fs.readFileSync(cookiesPath, 'utf8');
    const cookies = JSON.parse(fileData);
    return cookies;
  } catch (error) {
    console.error(`Error parsing cookies (Window ${windowIndex + 1}): ${error.message}`);
    return [];
  }
}

// Inject cookies
async function injectCookies(page, cookies) {
  if (cookies && cookies.length > 0) {
    await page.setCookie(...cookies);
  }
}

// Main user prompts
(async () => {
  const prompt = inquirer.createPromptModule();

  // File paths
  const proxyFilePath = path.join(__dirname, 'proxies.txt');
  const userAgentFilePath = path.join(__dirname, 'useragent.txt');

  // 1) query
  // 2) channelName
  // 3) applyCookies? -> if yes, ask about likeVideo, subscribeChannel
  // 4) windows
  // 5) batchSize
  // 6) filter
  // 7) headless?
  // 8) videoPlaySeconds

  const answers1 = await prompt([
    {
      type: 'input',
      name: 'query',
      message: 'Enter YouTube search query (video title or keywords):'
    },
    {
      type: 'input',
      name: 'channelName',
      message: 'Enter the channel name you want to match (leave blank to skip):'
    },
    {
      type: 'confirm',
      name: 'applyCookies',
      message: 'Do you want to apply cookies?',
      default: false
    },
  ]);

  let cookiesAnswers = { likeVideo: false, subscribeChannel: false };
  if (answers1.applyCookies) {
    cookiesAnswers = await prompt([
      {
        type: 'confirm',
        name: 'likeVideo',
        message: 'Do you want to like the video?',
        default: false
      },
      {
        type: 'confirm',
        name: 'subscribeChannel',
        message: 'Do you want to subscribe to the channel?',
        default: false
      },
    ]);
  }

  const answers2 = await prompt([
    {
      type: 'number',
      name: 'windows',
      message: 'Enter the number of browser windows to open:',
      default: 1
    },
    {
      type: 'number',
      name: 'batchSize',
      message: 'How many windows in parallel batch?',
      default: 200
    },
    {
      type: 'list',
      name: 'filter',
      message: 'Select the filter to apply to the search results:',
      choices: ['none', 'Last hour', 'Today', 'This week'],
      default: 'none'
    },
    {
      type: 'confirm',
      name: 'headless',
      message: 'Use headless mode (no UI)?',
      default: true
    },
    {
      type: 'number',
      name: 'videoPlaySeconds',
      message: 'Video playback time (in seconds) based on actual currentTime:',
      default: 60
    }
  ]);

  const finalAnswers = {
    ...answers1,
    ...cookiesAnswers,
    ...answers2
  };

  // read proxies and useragents
  const proxies = readProxiesFromFile(proxyFilePath);
  const userAgents = readUserAgentsFromFile(userAgentFilePath);

  await startAutomation(
    finalAnswers.query,
    finalAnswers.channelName,
    finalAnswers.applyCookies,
    finalAnswers.likeVideo,
    finalAnswers.subscribeChannel,
    finalAnswers.windows,
    finalAnswers.batchSize,
    proxies,
    userAgents,
    finalAnswers.filter,
    finalAnswers.headless,
    finalAnswers.videoPlaySeconds
  );
})();

// Batching logic
async function startAutomation(
  query,
  channelName,
  applyCookies,
  likeVideo,
  subscribeChannel,
  windows,
  batchSize,
  proxies,
  userAgents,
  filter,
  headless,
  videoPlaySeconds
) {
  // map filters
  const filterMap = {
    none: '',
    'Last hour': '&sp=EgIIAQ%253D%253D',
    'Today': '&sp=EgIIAg%253D%253D',
    'This week': '&sp=EgIIAw%253D%253D'
  };
  const filterParam = filterMap[filter] || '';

  const totalBatches = Math.ceil(windows / batchSize);

  for (let batchIndex = 0; batchIndex < totalBatches; batchIndex++) {
    const startWindow = batchIndex * batchSize;
    const endWindow = Math.min(startWindow + batchSize, windows);

    console.log(`Starting batch ${batchIndex + 1}/${totalBatches} (Windows ${startWindow + 1}-${endWindow})`);
    const browserPromises = [];

    for (let i = startWindow; i < endWindow; i++) {
      const proxy = proxies[i % proxies.length] || null;
      const userAgent = userAgents[i % userAgents.length] || 'Mozilla/5.0';

      browserPromises.push(
        openWindowWithRetry(
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
          5
        )
      );
    }

    // Wait for all in this batch
    await Promise.allSettled(browserPromises);
    console.log(`Batch ${batchIndex + 1} completed.`);
  }
  console.log('All batches completed!');
}
