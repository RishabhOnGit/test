// File: automation.js

const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const inquirer = require('inquirer');
const fs = require('fs');
const path = require('path');
const AdblockerPlugin = require('puppeteer-extra-plugin-adblocker');
const readline = require('readline');

puppeteer.use(AdblockerPlugin({ blockTrackers: true }));
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
      await delayFunction(2000);
    }
  }
}

async function findAndClickVideoByChannel(page, channelName, maxScrollAttempts = 5) {
  let attempts = 0;
  while (attempts < maxScrollAttempts) {
    // Grab all ytd-video-renderer elements
    const videoHandles = await page.$$('ytd-video-renderer');
    
    for (const video of videoHandles) {
      const channelEl = await video.$('ytd-channel-name');
      if (!channelEl) continue;  // Skip if missing channel section

      const channelText = await channelEl.evaluate(el => el.textContent.trim());
      if (channelText.toLowerCase().includes(channelName.toLowerCase())) {
        // Found a match
        const titleEl = await video.$('#video-title');
        if (titleEl) {
          console.log(`Found channel match: "${channelText}" -> clicking video`);
          await titleEl.click();
          return true; // success
        }
      }
    }

    console.log(`Channel "${channelName}" not found yet, scrolling further...`);
    // Scroll down ~800px
    await page.evaluate(() => {
      window.scrollBy(0, 800);
    });
    await delayFunction(1500);
    attempts++;
  }
  return false; // Not found after maxScrollAttempts
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
    const proxies = proxyData.split('\n').map((line) => {
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
    // Wait for the settings button and click it (70 seconds timeout)
    await delayFunction(3000);
    await page.waitForSelector('.ytp-settings-button', { visible: true, timeout: 90000 });
    await page.click('.ytp-settings-button');

    // Wait for the settings menu to appear and scroll to the bottom
    await page.waitForSelector('.ytp-settings-menu', { visible: true, timeout: 90000 });
    await page.evaluate(() => {
      const menu = document.querySelector('.ytp-settings-menu') || document.querySelector('.ytp-panel-menu');
      if (menu) menu.scrollTop = menu.scrollHeight;
    });
    await delayFunction(500);

    // Find and click the "Quality" menu item
    await page.evaluate(() => {
      const items = [...document.querySelectorAll('.ytp-menuitem')];
      const qualityItem = items.find(item => item.textContent.includes('Quality'));
      if (qualityItem) qualityItem.click();
    });
    await delayFunction(500);

    // Scroll to the bottom of the quality menu
    await page.evaluate(() => {
      const menu = document.querySelector('.ytp-settings-menu') || document.querySelector('.ytp-panel-menu');
      if (menu) menu.scrollTop = menu.scrollHeight;
    });
    await delayFunction(500);

    // Select the "144p" resolution
    const resolutionSet = await page.evaluate(() => {
      const items = [...document.querySelectorAll('.ytp-menuitem')];
      const resItem = items.find(item => item.textContent.includes('144p'));
      if (resItem) {
        resItem.click();
        return true; // Successfully clicked
      }
      return false; // Failed to find "144p"
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

// *** NEW ***
// A wrapper function to retry opening a single window if any error occurs.
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
  retries = 3
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
        headless
      );
      // If successful, break out of the retry loop
      console.log(`Window ${i+1}: Succeeded on attempt ${attempt}`);
      return;
    } catch (error) {
      console.error(`Window ${i+1}: Attempt ${attempt} failed with error: ${error.message}`);

      if (attempt < retries) {
        // Wait before retrying
        console.log(`Window ${i+1}: Retrying in 3 seconds...`);
        await delayFunction(4000);
      } else {
        console.error(`Window ${i+1}: All ${retries} attempts failed. Skipping...`);
      }
    }
  }
}

// *** IMPORTANT ***
// Modified openWindow so it throws the error if something fails
// so that openWindowWithRetry can catch it.
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
  headless
) {
  let browser;
  try {
    // Use a reasonable navigation timeout
    const navigationTimeout = 90000;

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
        '--disable-dev-shm-usage',
        '--disable-background-timer-throttling',
        '--disable-renderer-backgrounding',
        '--disable-backgrounding-occluded-windows',
        ...(proxy ? [`--proxy-server=http://${proxy.ip}:${proxy.port}`] : []),
      ],
      defaultViewport: { width: 1024, height: 600 },
      timeout: 90000,
    });

    const page = await browser.newPage();

    if (applyCookies) {
      const cookies = loadCookiesForWindow(i); // Load cookies for this window
      await injectCookies(page, cookies); // Inject the cookies
    }
    
    await page.setUserAgent(userAgent);

    if (proxy) {
      await page.authenticate({
        username: proxy.username,
        password: proxy.password,
      });
    }

    await page.setDefaultNavigationTimeout(navigationTimeout);

    console.log(`Window ${i + 1}: Navigating to YouTube homepage.`);
    await navigateWithRetry(page, 'https://www.youtube.com', 5, 90000);
    await delayFunction(2398);

    await page.waitForSelector('input[name="search_query"]', { timeout: navigationTimeout });
    await humanizedType(page, 'input[name="search_query"]', query);
    await page.click('button[aria-label="Search"]');

    // Hide possible ads right after searching
    await page.evaluate(() => {
      const adOverlay = document.querySelector('.ytp-ad-overlay-container');
      if (adOverlay) adOverlay.style.display = 'none';

      const bannerAd = document.querySelector('.ytp-ad-banner');
      if (bannerAd) bannerAd.style.display = 'none';

      const videoAd = document.querySelector('.video-ads');
      if (videoAd) videoAd.style.display = 'none';
    });

    await page.waitForSelector('ytd-video-renderer', { visible: true, timeout: navigationTimeout });

    await delayFunction(1987);

    // If filterParam is not empty, we apply it
    if (filterParam) {
      await page.click('button[aria-label="Search filters"]');
      await delayFunction(2398);
      console.log(`Window ${i + 1}: Applying filter "${filterParam}".`);
      const newUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}${filterParam}`;
      await page.goto(newUrl, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('ytd-video-renderer', { visible: true, timeout: navigationTimeout });
    } else {
    }
    
    await delayFunction(1324);

    // If channel name was provided, find that channel's video; otherwise first video
    if (channelName) {
      console.log(`Window ${i + 1}: Searching for channel "${channelName}"...`);
      const found = await findAndClickVideoByChannel(page, channelName);
      if (!found) {
        throw new Error(`Could not find any video from channel "${channelName}"`);
      }
    } else {
      const videoSelector = 'ytd-video-renderer #video-title';
      await page.waitForSelector(videoSelector, { visible: true, timeout: navigationTimeout });
      const firstVideo = await page.$(videoSelector);
      if (!firstVideo) {
        throw new Error('No videos found after search');
      }
      await firstVideo.click();
    }

    console.log(`Window ${i + 1}: Waiting for video to load.`);
    await page.waitForSelector('video', { visible: true, timeout: navigationTimeout });

    await waitForAdToFinish(page, 30000);

    // Track video playback
    await trackVideoPlayback(page, i, browser, applyCookies, likeVideo, subscribeChannel);
    
  } catch (error) {
    console.error(`Window ${i + 1} encountered an error: ${error.message}`);
    // Re-throw so openWindowWithRetry can catch it
    throw error;
  } finally {
    await safelyCloseBrowser(browser, i); // Ensure browser is closed
  }
}

async function trackVideoPlayback(page, windowIndex, browser, applyCookies, likeVideo, subscribeChannel) {
  // Playback timeout in milliseconds (20 seconds)
  const playbackTimeout = 30000;
  const startTime = Date.now(); 

  let currentTime = 0;
  let totalDuration = 0;
  let playbackStarted = false;

  // Attempt to start video playback
  const maxRetries = 3;
  let retryCount = 0;

  while (!playbackStarted && retryCount < maxRetries) {
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

  // Only like/subscribe if cookies were applied
  if (applyCookies) {
    // Step 1: Execute like task
    if (likeVideo) {
      await randomlyLikeVideo(page, totalDuration);
    }

    // Step 2: Execute subscribe task
    if (subscribeChannel) {
      await subscribeToChannelDuringPlayback(page, totalDuration);
    }
  }

  // Step 3: Monitor video playback and randomly pause/seek
  while (true) {
    const videoData = await page.evaluate(() => {
      const videoElement = document.querySelector('video');
      return videoElement
        ? { currentTime: videoElement.currentTime || 0, totalDuration: videoElement.duration || 0 }
        : { currentTime: 0, totalDuration: 0 };
    });

    const currentTime = videoData.currentTime;
    const totalDuration = videoData.totalDuration;

    console.log(
      `Window ${windowIndex + 1}: ${currentTime.toFixed(2)} / ${totalDuration.toFixed(2)} seconds`
    );

    // End monitoring if the video is within 12 seconds of completion
    if (totalDuration > 0 && totalDuration - currentTime <= 18) {
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

    await delayFunction(5000); // Check playback every 3 seconds
  }
}

// Humanized typing delay (Random delay between 50ms and 90ms per character)
async function humanizedType(page, selector, text) {
  const inputField = await page.$(selector);
  for (let i = 0; i < text.length; i++) {
    await inputField.type(text.charAt(i));
    const randDelay = Math.floor(Math.random() * (100 - 50 + 1)) + 50; // 50-100ms
    await delayFunction(randDelay);
  }
}

// Main function to gather user input
(async () => {
  const prompt = inquirer.createPromptModule();

  // Default paths for proxy & user-agent files (no user prompt):
  const proxyFilePath = path.join(__dirname, 'proxies.txt');
  const userAgentFilePath = path.join(__dirname, 'useragent.txt');

  // 1) Title (query)
  // 2) Channel name
  // 3) Apply cookies? -> If yes, ask about like & subscribe
  // 4) Number of windows
  // 5) Batch size
  // 6) Filter (including 'none')
  // 7) Headless mode

  const initialAnswers = await prompt([
    {
      type: 'input',
      name: 'query',
      message: 'Enter the YouTube search query (video title or keywords):'
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
  if (initialAnswers.applyCookies) {
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

  const remainingAnswers = await prompt([
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
      message: 'Do you want to use headless mode? (No UI)',
      default: true
    },
  ]);

  // Combine all user responses
  const answers = {
    ...initialAnswers,
    ...cookiesAnswers,
    ...remainingAnswers
  };

  // Read proxies from file
  const proxies = readProxiesFromFile(proxyFilePath);
  // Read user agents from file
  const userAgents = readUserAgentsFromFile(userAgentFilePath);

  await startAutomation(
    answers.query,
    answers.channelName,
    answers.applyCookies,
    answers.likeVideo,
    answers.subscribeChannel,
    answers.windows,
    answers.batchSize,
    proxies,
    userAgents,
    answers.filter,
    answers.headless
  );
})();

// Start automation with retry-based openWindow calls
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
  headless
) {
  // Map filters, including 'none'
  const filterMap = {
    none: '',
    'Last hour': '&sp=EgIIAQ%253D%253D',
    'Today': '&sp=EgIIAg%253D%253D',
    'This week': '&sp=EgIIAw%253D%253D',
  };

  const filterParam = filterMap[filter] || '';
  const totalBatches = Math.ceil(windows / batchSize);

  for (let batchIndex = 0; batchIndex < totalBatches; batchIndex++) {
    const startWindow = batchIndex * batchSize;
    const endWindow = Math.min(startWindow + batchSize, windows);

    console.log(`Starting batch ${batchIndex + 1}/${totalBatches} (Windows ${startWindow + 1}-${endWindow})`);
    const browserPromises = [];

    for (let i = startWindow; i < endWindow; i++) {
      // Rotate proxies and user agents
      const proxy = proxies[i % proxies.length];
      const userAgent = userAgents[i % userAgents.length];

      // Instead of openWindow(), we call openWindowWithRetry
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
          3 // Retries
        )
      );
    }

    await Promise.allSettled(browserPromises); // Wait for all windows in this batch to complete
    console.log(`Batch ${batchIndex + 1} completed.`);
  }
}
