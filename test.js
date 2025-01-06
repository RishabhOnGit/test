const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const inquirer = require('inquirer');
const fs = require('fs');
const path = require('path');
const AdblockerPlugin = require('puppeteer-extra-plugin-adblocker');
const readline = require('readline');
puppeteer.use(AdblockerPlugin({ blockTrackers: true }));


// Use the stealth plugin to bypass bot detection
puppeteer.use(StealthPlugin());

// Function to create a delay using Promise-based setTimeout
function delayFunction(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Navigate with retries
async function navigateWithRetry(page, url, retries = 5, timeout = 90000) {
  for (let i = 0; i < retries; i++) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeout });
      return;
    } catch (error) {
      if (i === retries - 1) throw error;
      // Minimal log: Show we’re retrying due to an error
      console.warn(`Navigation error, retrying (${i + 1}/${retries}): ${error.message}`);
      await delayFunction(2000);
    }
  }
}

// Wait for ad to finish (skip logs about each check)
async function waitForAdToFinish(page, timeout = 30000) {
  const startTime = Date.now();
  while (true) {
    const isSponsoredAdVisible = await page.evaluate(() => {
      const sponsoredBadge = document.querySelector(
        '.ad-simple-attributed-string.ytp-ad-badge__text--clean-player'
      );
      return sponsoredBadge && sponsoredBadge.style.display !== 'none';
    });
    if (!isSponsoredAdVisible) break;

    await delayFunction(3000);
    if (Date.now() - startTime > timeout) break;
  }
}

// Load cookies or return empty
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

// Inject cookies if available
async function injectCookies(page, cookies) {
  if (cookies.length > 0) {
    await page.setCookie(...cookies);
  }
}

// Read user agents
function readUserAgentsFromFile(filePath) {
  try {
    const userAgentData = fs.readFileSync(filePath, 'utf8');
    const userAgents = userAgentData.split('\n').map(line => line.trim()).filter(Boolean);
    return userAgents;
  } catch (error) {
    console.error(`Error reading user agent file: ${error.message}`);
    return [];
  }
}

// Read proxies
function readProxiesFromFile(filePath) {
  try {
    const proxyData = fs.readFileSync(filePath, 'utf8');
    const proxies = proxyData.split('\n').map((line, index) => {
      if (!line.trim()) return null;
      const [credentials, ipPort] = line.split('@');
      if (!credentials || !ipPort) return null;
      const [username, password] = credentials.split(':');
      const [ip, port] = ipPort.split(':');
      return { username, password, ip, port };
    }).filter(proxy => proxy !== null);
    return proxies;
  } catch (error) {
    console.error(`Error reading proxy file: ${error.message}`);
    return [];
  }
}

// Close browser safely
async function safelyCloseBrowser(browser, windowIndex) {
  if (browser) {
    try {
      await browser.close();
    } catch (error) {
      console.error(`Error while closing browser (Window ${windowIndex + 1}): ${error.message}`);
    }
  }
}

// Subscribe to channel
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
          (btn) => (btn.textContent || '').toLowerCase().includes('subscribed'),
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

// Randomly like video
async function randomlyLikeVideo(page, totalDuration) {
  const likeButtonSelector = 'button[aria-label*="like this video"]';
  const triggerTime = totalDuration / 4;
  while (true) {
    const currentTime = await page.evaluate(() => {
      const video = document.querySelector('video');
      return video ? video.currentTime : 0;
    });
    if (currentTime >= triggerTime) {
      const likeButton = await page.$(likeButtonSelector);
      if (likeButton) {
        const isLiked = await page.evaluate(
          (btn) => btn.getAttribute('aria-pressed') === 'true',
          likeButton
        );
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

// Force 144p
async function forceQuality144p(page) {
  try {
    await page.waitForSelector('.ytp-settings-button', { visible: true });
    await page.click('.ytp-settings-button');
    await delayFunction(500);

    await page.evaluate(() => {
      const menu = document.querySelector('.ytp-settings-menu') 
                || document.querySelector('.ytp-panel-menu');
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
      const menu = document.querySelector('.ytp-settings-menu') 
                || document.querySelector('.ytp-panel-menu');
      if (menu) menu.scrollTop = menu.scrollHeight;
    });
    await delayFunction(500);

    await page.evaluate(() => {
      const items = [...document.querySelectorAll('.ytp-menuitem')];
      const resItem = items.find(item => item.textContent.includes('144p'));
      if (resItem) resItem.click();
    });
    await delayFunction(500);
  } catch (err) {
    console.error('Error forcing 144p:', err.message);
  }
}


// Function to start browser automation with batching
async function startAutomation(query, windows, useProxies, proxies, userAgents, filter, channelName, likeVideo, subscribeChannel, headless) {
  const filterMap = {
    'Last hour': '&sp=EgIIAQ%253D%253D',
    'Today': '&sp=EgIIAg%253D%253D',
    'This week': '&sp=EgIIAw%253D%253D',
  };

  const filterParam = filterMap[filter] || '';
  const batchSize = 1; // Number of browser windows to open in parallel
  const totalBatches = Math.ceil(windows / batchSize);

  for (let batchIndex = 0; batchIndex < totalBatches; batchIndex++) {
    const startWindow = batchIndex * batchSize;
    const endWindow = Math.min(startWindow + batchSize, windows);

    console.log(`Starting batch ${batchIndex + 1}/${totalBatches} (Windows ${startWindow + 1}-${endWindow})`);
    const browserPromises = [];

    for (let i = startWindow; i < endWindow; i++) {
      const proxy = useProxies ? proxies[i % proxies.length] : null; // Rotate proxies
      const userAgent = userAgents[i % userAgents.length]; // Rotate user agents
    
      browserPromises.push(
        openWindow(i, query, filterParam, useProxies, proxy, userAgent, channelName, likeVideo, subscribeChannel, headless)
      );
    }

    await Promise.allSettled(browserPromises); // Wait for all windows in this batch to complete
    console.log(`Batch ${batchIndex + 1} completed.`);
  }
}

// Function to open a single browser window and track video playback
async function openWindow(i, query, filterParam, useProxies, proxy, userAgent, likeVideo,subscribeChannel,headless) {
  try {

    const navigationTimeout = useProxies ? 900000 : 90000; // Timeout for navigation

    browser = await puppeteer.launch({
      headless: headless,
      executablePath: '/usr/bin/chromium-browser',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-accelerated-2d-canvas',
        '--disable-gpu',
        '--disable-infobars',
        '--window-size=1024,600',
        '--disable-blink-features=AutomationControlled',
        '--disable-software-rasterizer',
        ...(proxy ? [`--proxy-server=http://${proxy.ip}:${proxy.port}`] : []),
      ],
      defaultViewport: { width: 1024, height: 600 },
      timeout: 70000,
    });

    const page = await browser.newPage();
    const cookies = loadCookiesForWindow(i); // Load cookies for this window
    await injectCookies(page, cookies); // Inject the cookies
    await page.setUserAgent(userAgent);

    if (useProxies && proxy) {
      await page.authenticate({
        username: proxy.username,
        password: proxy.password,
      });
    }

    await page.setDefaultNavigationTimeout(navigationTimeout);
    console.log(`Window ${i + 1}: Navigating to YouTube homepage.`);
    await navigateWithRetry(page, 'https://www.youtube.com', 5, 90000);

    await page.waitForSelector('input[name="search_query"]', { timeout: navigationTimeout });
    await humanizedType(page, 'input[name="search_query"]', query);
    await page.click('button[aria-label="Search"]');

    // Inject JavaScript to hide ad elements
  await page.evaluate(() => {
    // Hide the video ad overlay
    const adOverlay = document.querySelector('.ytp-ad-overlay-container');
    if (adOverlay) {
      adOverlay.style.display = 'none';
    }

    // Hide banner ads (if any)
    const bannerAd = document.querySelector('.ytp-ad-banner');
    if (bannerAd) {
      bannerAd.style.display = 'none';
    }

    // Hide the pre-roll video ad
    const videoAd = document.querySelector('.video-ads');
    if (videoAd) {
      videoAd.style.display = 'none';
    }
  });

    await page.waitForSelector('ytd-video-renderer', { visible: true, timeout: navigationTimeout });

    console.log(`Window ${i + 1}: Adding delay before applying the filter.`);
    await delayFunction(1987);
    await page.click('button[aria-label="Search filters"]');
    await delayFunction(2398);

    console.log(`Window ${i + 1}: Applying filter "${filterParam}".`);
    const newUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}${filterParam}`;
    await page.goto(newUrl, { waitUntil: 'domcontentloaded' });

    await page.waitForSelector('ytd-video-renderer', { visible: true, timeout: navigationTimeout });
    await delayFunction(1324);

    console.log(`Window ${i + 1}: Clicking on the first video.`);
    const videoSelector = 'ytd-video-renderer #video-title';
    await page.waitForSelector(videoSelector, { visible: true, timeout: navigationTimeout });
    const firstVideo = await page.$(videoSelector);
    await firstVideo.click();

    console.log(`Window ${i + 1}: Waiting for video to load.`);
    await page.waitForSelector('video', { visible: true, timeout: navigationTimeout });

    await waitForAdToFinish(page, 30000);

    await trackVideoPlayback(page, i, browser, likeVideo, subscribeChannel);


  } catch (error) {
    console.error(`Window ${i + 1} encountered an error: ${error.message}`);
  } finally {
    await safelyCloseBrowser(browser, i); // Ensure browser is closed
  }
}

async function trackVideoPlayback(page, windowIndex, browser, likeVideo, subscribeChannel) {
  // --- NEW: Playback timeout in milliseconds (20 seconds)
  const playbackTimeout = 20000;
  const startTime = Date.now(); 

  let currentTime = 0;
  let totalDuration = 0;
  let playbackStarted = false;

  // Attempt to start video playback
  const maxRetries = 3;
  let retryCount = 0;

  while (!playbackStarted && retryCount < maxRetries) {
    // --- NEW: If we exceed playbackTimeout, reload once and break
    if (Date.now() - startTime > playbackTimeout) {
      console.error(
        `Window ${windowIndex + 1}: Playback not started after ${playbackTimeout}ms. Reloading the page...`
      );
      await page.reload({ waitUntil: 'domcontentloaded' });
      break;
    }

    // Check if the video has a duration > 0 (i.e., playback started)
    const videoData = await page.evaluate(() => {
      const videoElement = document.querySelector('video');
      return videoElement
        ? { currentTime: videoElement.currentTime, totalDuration: videoElement.duration }
        : null;
    });

    if (videoData && videoData.totalDuration > 0) {
      totalDuration = videoData.totalDuration;
      playbackStarted = true;
      console.log(
        `Window ${windowIndex + 1}: Video playback started. Total duration: ${totalDuration.toFixed(2)} seconds.`
      );
    } else {
      retryCount++;
      if (retryCount < maxRetries) {
        console.log(
          `Window ${windowIndex + 1}: Retrying video playback (${retryCount}/${maxRetries})...`
        );
        await delayFunction(5000); // Wait 5 seconds before checking again
      } else {
        console.error(`Window ${windowIndex + 1}: Failed to start video playback after retries.`);
        return;
      }
    }
  }

  // If we still don’t have a started playback, exit
  if (!playbackStarted) {
    console.error(`Window ${windowIndex + 1}: Playback could not start. Exiting...`);
    return;
  }

  await forceQuality144p(page);

  // Step 1: Execute like task
  if (likeVideo) {
    await randomlyLikeVideo(page, totalDuration);
  } else {
  }

  // Step 2: Execute subscribe task
  if (subscribeChannel) {
    await subscribeToChannelDuringPlayback(page, totalDuration);
  } else {
  }

  // Step 3: Monitor video playback and randomly pause/seek
  while (true) {
    const videoData = await page.evaluate(() => {
      const videoElement = document.querySelector('video');
      return videoElement
        ? { currentTime: videoElement.currentTime || 0, totalDuration: videoElement.duration || 0 }
        : { currentTime: 0, totalDuration: 0 };
    });

    currentTime = videoData.currentTime;
    totalDuration = videoData.totalDuration;

    console.log(
      `Window ${windowIndex + 1}: ${currentTime.toFixed(2)} / ${totalDuration.toFixed(2)} seconds`
    );

    // End monitoring if the video is within 10 seconds of completion
    if (totalDuration > 0 && totalDuration - currentTime <= 12) {
      console.log(
        `Window ${windowIndex + 1}: Video playback is near the end. Closing the browser.`
      );
      await browser.close();
      break;
    }

    // Randomly pause and resume playback (15% chance)
    if (Math.random() < 0.15) {
      await page.evaluate(() => {
        const videoElement = document.querySelector('video');
        if (videoElement) videoElement.pause();
      });
      await delayFunction(Math.random() * 5000 + 2000); // Pause for 2-7 seconds
      await page.evaluate(() => {
        const videoElement = document.querySelector('video');
        if (videoElement) videoElement.play();
      });
    }

    // Randomly seek forward/backward (10% chance)
    if (Math.random() < 0.1) {
      const seekTime = Math.random() * 10; // 0-10 seconds
      const seekDirection = Math.random() > 0.5 ? 1 : -1;
      const newTime = Math.max(0, Math.min(currentTime + seekDirection * seekTime, totalDuration));
      await page.evaluate(newTime => {
        const videoElement = document.querySelector('video');
        if (videoElement) videoElement.currentTime = newTime;
      }, newTime);
    }

    await delayFunction(3000); // Check playback every 3 seconds
  }
}


// Humanized typing delay (Random delay between 50ms and 90ms per character)
async function humanizedType(page, selector, text) {
  const inputField = await page.$(selector);
  for (let i = 0; i < text.length; i++) {
    await inputField.type(text.charAt(i));
    const delay = Math.floor(Math.random() * (100 - 50 + 1)) + 50; // Random delay between 50ms and 90ms
    await delayFunction(delay);
  }
}


// Main function to gather user inpu

(async () => {
  const prompt = inquirer.createPromptModule();

  const answers = await prompt([  
    { type: 'input', name: 'query', message: 'Enter the YouTube search query (video title or keywords):' },
    { type: 'number', name: 'windows', message: 'Enter the number of browser windows to open:', default: 1 },
    { type: 'confirm', name: 'likeVideo', message: 'Do you want to like the video?', default: false },
    { type: 'confirm', name: 'subscribeChannel', message: 'Do you want to subscribe to the channel?', default: false },
    { type: 'confirm', name: 'useProxies', message: 'Do you want to use proxies?', default: true },
    { type: 'input', name: 'proxyFilePath', message: 'Enter the path of the proxy file:', default: path.join(__dirname, 'proxies.txt'), when: answers => answers.useProxies },
    { type: 'input', name: 'userAgentFilePath', message: 'Enter the path of the user agent file:', default: path.join(__dirname, 'useragent.txt') },
    { type: 'list', name: 'filter', message: 'Select the filter to apply to the search results:', choices: ['Last hour', 'Today', 'This week'], default: 'Today' },
    { type: 'confirm', name: 'headless', message: 'Do you want to use headless mode? (No UI)', default: true },
  ]);
  console.log('User chose headless =', answers.headless);

  let proxies = [];
  if (answers.useProxies && answers.proxyFilePath) {
    proxies = readProxiesFromFile(answers.proxyFilePath);
  }

  const userAgents = readUserAgentsFromFile(answers.userAgentFilePath);

  await startAutomation(
    answers.query,
    answers.windows,
    answers.useProxies,
    proxies,
    userAgents,
    answers.filter,
    answers.channelName,
    answers.likeVideo,
    answers.subscribeChannel,
    answers.headless,
  );  
})();
