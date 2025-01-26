// File: automation.js

const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const inquirer = require('inquirer');
const fs = require('fs');
const path = require('path');
const AdblockerPlugin = require('puppeteer-extra-plugin-adblocker');

puppeteer.use(AdblockerPlugin({ blockTrackers: true }));
puppeteer.use(StealthPlugin());

// ----------------------------------------------------------
// Utility: Delay
function delayFunction(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ----------------------------------------------------------
// Utility: navigateWithRetry
async function navigateWithRetry(page, url, retries = 5, timeout = 120000) {
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

// ----------------------------------------------------------
// Utility: findAndClickVideoByChannel
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
          await titleEl.click();
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

// ----------------------------------------------------------
// Utility: waitForAdToFinish
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
// Utility: safelyCloseBrowser
async function safelyCloseBrowser(browser, windowIndex) {
  if (browser) {
    try {
      await browser.close();
    } catch (err) {
      console.error(`Error closing browser (Window ${windowIndex + 1}): ${err.message}`);
    }
  }
}

// ----------------------------------------------------------
// Utility: forceQuality144p
async function forceQuality144p(page) {
  try {
    await delayFunction(1000);
    await page.waitForSelector('.ytp-settings-button', { visible: true, timeout: 120000 });
    await page.click('.ytp-settings-button');

    await page.waitForSelector('.ytp-settings-menu', { visible: true, timeout: 120000 });
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

// ----------------------------------------------------------
// Utility: randomlyLikeVideo
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

// ----------------------------------------------------------
// Utility: subscribeToChannelDuringPlayback
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
            await subBtn.click();
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

// ----------------------------------------------------------
// trackVideoPlayback
// Only closes when currentTime >= userPlaySeconds (NOT real time).
// If stuck at 0/0 for 10 seconds, reload once; if still stuck => close.
async function trackVideoPlayback(
  page,
  windowIndex,
  browser,
  applyCookies,
  likeVideo,
  subscribeChannel,
  videoPlaySeconds
) {
  const startTimeout = 50000;  // Time to wait for video to start
  const startTime = Date.now();

  let playbackStarted = false;
  let totalDuration = 0;
  let reloadCount = 0;

  let lastCurrentTime = 0;
  let stuckTime = 0;       // If currentTime doesn't change

  // Wait for playback to start
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

  let reloadDoneForStuck = false;

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

    // (1) If currentTime >= userPlaySeconds => close
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
    const navigationTimeout = 120000;
    browser = await puppeteer.launch({
      headless,
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
        ...(proxy ? [`--proxy-server=http://${proxy.ip}:${proxy.port}`] : []),
      ],
      timeout: navigationTimeout,
    });

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
      await page.authenticate({
        username: proxy.username,
        password: proxy.password,
      });
    }

    await page.setDefaultNavigationTimeout(navigationTimeout);

    console.log(`Window ${i+1}: Navigating to YouTube...`);
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

    await page.waitForSelector('ytd-video-renderer', { visible: true, timeout: navigationTimeout });
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
      await firstVideo.click();
    }

    console.log(`Window ${i+1}: Waiting for video element...`);
    await page.waitForSelector('video', { visible: true, timeout: navigationTimeout });

    // wait for ad
    await waitForAdToFinish(page, 30000);

    // track video
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
  const inputField = await page.$(selector);
  for (let i = 0; i < text.length; i++) {
    await inputField.type(text.charAt(i));
    const randDelay = Math.floor(Math.random() * (100 - 50 + 1)) + 50; // 50-100ms
    await delayFunction(randDelay);
  }
}

// ----------------------------------------------------------
// Readers
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

// Cookies
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
  // Convert filter
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
          // Already handled logs in openWindowWithRetry
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

// ----------------------------------------------------------
// Main user prompts
(async () => {
  const prompt = inquirer.createPromptModule();

  const proxyFilePath = path.join(__dirname, 'proxies.txt');
  const userAgentFilePath = path.join(__dirname, 'useragent.txt');

  const answers1 = await prompt([
    {
      type: 'input',
      name: 'query',
      message: 'Enter YouTube search query (video title or keywords):'
    },
    {
      type: 'input',
      name: 'channelName',
      message: 'Enter the channel name (leave blank to skip):'
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
        message: 'Like the video?',
        default: false
      },
      {
        type: 'confirm',
        name: 'subscribeChannel',
        message: 'Subscribe to the channel?',
        default: false
      },
    ]);
  }

  const answers2 = await prompt([
    {
      type: 'number',
      name: 'totalWindows',
      message: 'How many total windows to open?',
      default: 10
    },
    {
      type: 'number',
      name: 'maxConcurrent',
      message: 'Max concurrency?',
      default: 5
    },
    {
      type: 'list',
      name: 'filter',
      message: 'Select a filter for search results:',
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
      message: 'Video playback time (seconds, based on currentTime)?',
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

  // Start dynamic concurrency
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
