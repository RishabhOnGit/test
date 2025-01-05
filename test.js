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

// Function to navigate with retries
async function navigateWithRetry(page, url, retries = 5, timeout = 90000) {
  for (let i = 0; i < retries; i++) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeout });
      return;
    } catch (error) {
      if (i === retries - 1) throw error; // If this is the last retry, throw the error
      console.log(`Retrying navigation due to error: ${error.message}`);
      await delayFunction(2000); // Wait for 2 seconds before retrying
    }
  }
}


async function waitForAdToFinish(page, timeout = 30000) {
  console.log("Waiting for sponsored ad to finish...");

  const startTime = Date.now();

  while (true) {
    const isSponsoredAdVisible = await page.evaluate(() => {
      const sponsoredBadge = document.querySelector(
        '.ad-simple-attributed-string.ytp-ad-badge__text--clean-player'
      );
      return sponsoredBadge && sponsoredBadge.style.display !== 'none';
    });

    if (!isSponsoredAdVisible) {
      console.log("Sponsored ad not found. Moving to the next task...");
      break;
    }

    console.log("Sponsored ad is still visible. Checking again...");
    await delayFunction(3000); // Wait for 3 seconds before checking again

    if (Date.now() - startTime > timeout) {
      console.log("Sponsored ad timeout reached. Moving to the next task...");
      break;
    }
  }
}


function loadCookiesForWindow(windowIndex) {
  const cookiesPath = path.join(__dirname, 'cookies', `profile${windowIndex + 1}_cookies.json`);
  if (fs.existsSync(cookiesPath)) {
    const cookies = JSON.parse(fs.readFileSync(cookiesPath));
    console.log(`Window ${windowIndex + 1}: Loaded cookies from ${cookiesPath}`);
    return cookies;
  }
  console.log(`Window ${windowIndex + 1}: No cookies found at ${cookiesPath}`);
  return [];
}

async function injectCookies(page, cookies) {
  if (cookies.length > 0) {
    await page.setCookie(...cookies); // Inject cookies into the page
    console.log('Cookies injected for login.');
  }
}


// Function to read user agents from a file
function readUserAgentsFromFile(filePath) {
  try {
    const userAgentData = fs.readFileSync(filePath, 'utf8');
    const userAgents = userAgentData.split('\n').map(line => line.trim()).filter(Boolean);
    console.log(`Loaded ${userAgents.length} user agents from the file.`);
    return userAgents;
  } catch (error) {
    console.error(`Error reading user agent file: ${error.message}`);
    return [];
  }
}

// Function to read proxies from a file
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

    console.log(`Loaded ${proxies.length} valid proxies from the file.`);
    return proxies;
  } catch (error) {
    console.error(`Error reading proxy file: ${error.message}`);
    return [];
  }
}

// Function to safely close the browser
async function safelyCloseBrowser(browser, windowIndex) {
  if (browser) {
    try {
      console.log(`Window ${windowIndex + 1}: Closing browser.`);
      await browser.close();
    } catch (error) {
      console.error(`Error while closing browser for window ${windowIndex + 1}: ${error.message}`);
    }
  }
}



async function subscribeToChannelDuringPlayback(page, totalDuration) {
  const subscribeButtonSelector = 'ytd-subscribe-button-renderer button';
  const triggerTime = totalDuration / 3; // Trigger at or after 1/3 of the total duration
  console.log(`Scheduled to subscribe at or after ${triggerTime.toFixed(2)} seconds.`);

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
          console.log('Subscribing to the channel...');
          await subscribeButton.click();
          console.log('Successfully subscribed.');
        } else {
          console.log('Already subscribed.');
        }
      } else {
        console.log('Subscribe button not found.');
      }
      break;
    }

    console.log(`Current time: ${currentTime.toFixed(2)} seconds. Waiting to subscribe.`);
    await delayFunction(3000);
  }
}


async function randomlyLikeVideo(page, totalDuration) {
  const likeButtonSelector = 'button[aria-label*="like this video"]'; // Updated selector
  const triggerTime = totalDuration / 4; // Trigger at or after 1/4 of the total duration
  console.log(`Scheduled to like video at or after ${triggerTime.toFixed(2)} seconds.`);

  while (true) {
    const currentTime = await page.evaluate(() => {
      const video = document.querySelector('video');
      return video ? video.currentTime : 0;
    });

    if (currentTime >= triggerTime) {
      const likeButton = await page.$(likeButtonSelector);
      if (likeButton) {
        const isLiked = await page.evaluate((btn) => btn.getAttribute('aria-pressed') === 'true', likeButton);
        if (!isLiked) {
          console.log('Liking the video...');
          await likeButton.click();
          console.log('Video liked successfully.');
        } else {
          console.log('Video is already liked.');
        }
      } else {
        console.log('Like button not found.');
      }
      break;
    }

    console.log(`Current time: ${currentTime.toFixed(2)} seconds. Waiting to like.`);
    await delayFunction(3000);
  }
}


// Function to start browser automation with batching
async function startAutomation(query, windows, useProxies, proxies, userAgents, filter, channelName, headless, likeVideo, subscribeChannel) {
  const filterMap = {
    'Last hour': '&sp=EgIIAQ%253D%253D',
    'Today': '&sp=EgIIAg%253D%253D',
    'This week': '&sp=EgIIAw%253D%253D',
  };

  const filterParam = filterMap[filter] || '';
  const batchSize = 10; // Number of browser windows to open in parallel
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
        openWindow(i, query, filterParam, useProxies, proxy, userAgent, channelName, headless, likeVideo, subscribeChannel)
      );
    }

    await Promise.allSettled(browserPromises); // Wait for all windows in this batch to complete
    console.log(`Batch ${batchIndex + 1} completed.`);
  }
}

// Function to open a single browser window and track video playback
async function openWindow(i, query, filterParam, useProxies, proxy, userAgent, headless) {
  try {

    const navigationTimeout = useProxies ? 900000 : 90000; // Timeout for navigation

    browser = await puppeteer.launch({
      headless: headless,
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

    console.log(`Window ${i + 1}: Searching for "${query}".`);
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

    console.log(`Window ${i + 1}: Waiting for search results to load.`);
    await page.waitForSelector('ytd-video-renderer', { visible: true, timeout: navigationTimeout });

    console.log(`Window ${i + 1}: Adding delay before applying the filter.`);
    await delayFunction(1987);
    await page.click('button[aria-label="Search filters"]');
    await delayFunction(2398);

    console.log(`Window ${i + 1}: Applying filter "${filterParam}".`);
    const newUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}${filterParam}`;
    await page.goto(newUrl, { waitUntil: 'domcontentloaded' });

    await page.waitForSelector('ytd-video-renderer', { visible: true, timeout: navigationTimeout });
    await scrollPage(page);

    console.log(`Window ${i + 1}: Clicking on the first video.`);
    const videoSelector = 'ytd-video-renderer #video-title';
    await page.waitForSelector(videoSelector, { visible: true, timeout: navigationTimeout });
    const firstVideo = await page.$(videoSelector);
    await firstVideo.click();

    console.log(`Window ${i + 1}: Waiting for video to load.`);
    await page.waitForSelector('video', { visible: true, timeout: navigationTimeout });

    await waitForAdToFinish(page, 30000);

    await trackVideoPlayback(page, i, browser);


  } catch (error) {
    console.error(`Window ${i + 1} encountered an error: ${error.message}`);
  } finally {
    await safelyCloseBrowser(browser, i); // Ensure browser is closed
  }
}

async function trackVideoPlayback(page, windowIndex, browser) {
  const playbackTimeout = 20000; // Timeout for playback to start
  let currentTime = 0;
  let totalDuration = 0;
  let playbackStarted = false;

  console.log(`Window ${windowIndex + 1}: Waiting for video playback to start...`);

  // Attempt to start video playback
  const maxRetries = 3;
  let retryCount = 0;

  while (!playbackStarted && retryCount < maxRetries) {
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
        `Window ${windowIndex + 1}: Video playback started. Total duration: ${totalDuration.toFixed(
          2
        )} seconds.`
      );
    } else {
      retryCount++;
      if (retryCount < maxRetries) {
        console.log(
          `Window ${windowIndex + 1}: Retrying video playback (${retryCount}/${maxRetries})...`
        );
        await delayFunction(5000); // Retry after 5 seconds
      } else {
        console.error(`Window ${windowIndex + 1}: Failed to start video playback.`);
        return;
      }
    }
  }

  if (!playbackStarted) {
    console.error(`Window ${windowIndex + 1}: Playback could not start. Exiting...`);
    return;
  }

  // Step 1: Execute like task
  console.log(`Window ${windowIndex + 1}: Triggering like task...`);
  await randomlyLikeVideo(page, totalDuration);

  // Step 2: Execute subscribe task
  console.log(`Window ${windowIndex + 1}: Triggering subscribe task...`);
  await subscribeToChannelDuringPlayback(page, totalDuration);


  // Step 4: Monitor video playback and randomly pause/seek
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
    if (totalDuration > 0 && totalDuration - currentTime <= 10) {
      console.log(
        `Window ${windowIndex + 1}: Video playback is within 10 seconds of ending. Closing the browser.`
      );
      await browser.close();
      break;
    }

    // Randomly pause and resume playback
    if (Math.random() < 0.15) { // 15% chance to pause
      console.log(`Window ${windowIndex + 1}: Pausing the video.`);
      await page.evaluate(() => {
        const videoElement = document.querySelector('video');
        if (videoElement) videoElement.pause();
      });
      await delayFunction(Math.random() * 5000 + 2000); // Pause for 2-7 seconds
      console.log(`Window ${windowIndex + 1}: Resuming the video.`);
      await page.evaluate(() => {
        const videoElement = document.querySelector('video');
        if (videoElement) videoElement.play();
      });
    }

    // Randomly seek forward or backward
    if (Math.random() < 0.1) { // 10% chance to seek
      const seekTime = Math.random() * 10; // Random seek duration (0-10 seconds)
      const seekDirection = Math.random() > 0.5 ? 1 : -1; // Randomly decide forward or backward
      const newTime = Math.max(0, Math.min(currentTime + seekDirection * seekTime, totalDuration));
      console.log(`Window ${windowIndex + 1}: Seeking to ${newTime.toFixed(2)} seconds.`);
      await page.evaluate(newTime => {
        const videoElement = document.querySelector('video');
        if (videoElement) videoElement.currentTime = newTime;
      }, newTime);
    }

    await delayFunction(3000); // Check playback every 3 seconds
  }
}


// Function to randomly scroll the page (up and down)
async function scrollPage(page) {
  console.log('Scrolling randomly.');

  // Wait for the page to load enough content (using delayFunction for timeout)
  await delayFunction(3000); // 3 seconds delay to wait for the page content

  // Get the scroll height of the page
  const scrollHeight = await page.evaluate(() => document.body.scrollHeight);

  // Randomly scroll down
  const randomScrollDown = Math.floor(Math.random() * (scrollHeight / 2)) + 100; // Random scroll down position (between 100 and half the scroll height)
  console.log(`Scrolling down by ${randomScrollDown}px`);
  await page.evaluate(scrollPos => window.scrollTo(0, scrollPos), randomScrollDown);

  // Wait for a moment before scrolling back to the top
  await delayFunction(3897); // 4 seconds delay after scrolling down

  // Force scroll to the top
  console.log('Forcing scroll to the top');
  await page.evaluate(() => window.scrollTo(0, 0));

  // Wait for a moment before finishing
  await delayFunction(3786); // 4 seconds delay after scrolling to the top
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
    { type: 'list', name: 'filter', message: 'Select the filter to apply to the search results:', choices: ['Last hour', 'Today', 'This week'], default: 'Last hour' },
    { type: 'confirm', name: 'headless', message: 'Do you want to use headless mode? (No UI)', default: true },
  ]);

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
    answers.headless,
    answers.likeVideo,
    answers.subscribeChannel,
  );  
})();
process.on('exit', (code) => {
  console.log(`Process exited with code: ${code}`);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection:', reason);
});

process.on('beforeExit', (code) => {
  console.log(`Node.js is about to exit with code: ${code}`);
});
