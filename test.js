const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const inquirer = require('inquirer');
const fs = require('fs');
const path = require('path');

// Use the stealth plugin to bypass bot detection
puppeteer.use(StealthPlugin());

// Function to create a delay using Promise-based setTimeout
function delayFunction(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Function to navigate with retries
async function navigateWithRetry(page, url, retries = 3, timeout = 60000) {
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

// Function to start browser automation
async function startAutomation(query, windows, useProxies, proxies, userAgents, filter, channelName, headless) {
  const filterMap = {
    'Last hour': '&sp=EgIIAQ%253D%253D',
    'Today': '&sp=EgIIAg%253D%253D',
    'This week': '&sp=EgIIAw%253D%253D',
  };

  const filterParam = filterMap[filter] || '';
  const browserPromises = [];

  for (let i = 0; i < windows; i++) {
    const proxy = useProxies ? proxies[i % proxies.length] : null; // Rotate proxies
    const userAgent = userAgents[i % userAgents.length]; // Rotate user agents
    browserPromises.push(
      openWindow(i, query, filterParam, useProxies, proxy, userAgent, channelName, headless)
    );
  }

  await Promise.allSettled(browserPromises);
}

// Function to open a single browser window and track video playback
async function openWindow(i, query, filterParam, useProxies, proxy, userAgent, channelName, headless) {
  try {
    const navigationTimeout = useProxies ? 900000 : 90000;

    const browser = await puppeteer.launch({
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
    await page.setUserAgent(userAgent);

    if (useProxies && proxy) {
      await page.authenticate({
        username: proxy.username,
        password: proxy.password,
      });
    }

    await page.setDefaultNavigationTimeout(navigationTimeout);

    console.log(`Window ${i + 1}: Navigating to YouTube homepage.`);
    await navigateWithRetry(page, 'https://www.youtube.com', 3, 60000);

    console.log(`Window ${i + 1}: Searching for "${query}".`);
    await page.waitForSelector('input[name="search_query"]', { timeout: navigationTimeout });
    await humanizedType(page, 'input[name="search_query"]', query);
    await page.click('button[aria-label="Search"]');

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
    await page.waitForSelector(videoSelector, { visible: true });
    const firstVideo = await page.$(videoSelector);
    await firstVideo.click();

    console.log(`Window ${i + 1}: Waiting for video to load.`);
    await page.waitForSelector('video', { visible: true });

    console.log(`Window ${i + 1}: Waiting for video playback to start.`);
    await trackVideoPlayback(page, i);

    console.log(`Window ${i + 1}: Closing the browser.`);
    await browser.close();
  } catch (error) {
    console.error(`Window ${i + 1} encountered an error: ${error.message}`);
  }
}

// Function to track video playback with random pauses and replay
async function trackVideoPlayback(page, windowIndex) {
  let currentTime = 0;
  let totalDuration = 0;

  let videoStarted = false;
  while (!videoStarted) {
    currentTime = await page.evaluate(() => {
      const videoElement = document.querySelector('video');
      if (videoElement && videoElement.duration > 0) {
        return videoElement.currentTime;
      }
      return 0;
    });

    if (currentTime > 0) {
      totalDuration = await page.evaluate(() => {
        const videoElement = document.querySelector('video');
        return videoElement ? videoElement.duration : 0;
      });
      videoStarted = true;
    } else {
      await delayFunction(2000);
    }
  }

  while (true) {
    const videoData = await page.evaluate(() => {
      const videoElement = document.querySelector('video');
      if (videoElement) {
        return { currentTime: videoElement.currentTime, totalDuration: videoElement.duration };
      }
      return { currentTime: 0, totalDuration: 0 };
    });

    currentTime = videoData.currentTime;
    totalDuration = videoData.totalDuration;

    console.log(`Window ${windowIndex + 1}: ${currentTime.toFixed(2)} / ${totalDuration.toFixed(2)} seconds`);

    if (Math.random() < 0.15) {
      const action = Math.random() > 0.5 ? 'pause' : 'replay';
      console.log(`Window ${windowIndex + 1}: Performing random action: ${action}`);
      if (action === 'pause') {
        await page.evaluate(() => document.querySelector('video').pause());
        await delayFunction(Math.random() * 5000 + 2000);
      } else {
        await page.evaluate(() => {
          const video = document.querySelector('video');
          video.currentTime = 0;
          video.play();
        });
      }
    }

    if (Math.random() < 0.1) {
      const seekTime = Math.random() * 10;
      const seekDirection = Math.random() > 0.5 ? 1 : -1;
      const newTime = Math.max(0, Math.min(currentTime + seekDirection * seekTime, totalDuration - 1));
      console.log(`Window ${windowIndex + 1}: Seeking to ${newTime.toFixed(2)} seconds.`);
      await page.evaluate(newTime => {
        const video = document.querySelector('video');
        video.currentTime = newTime;
      }, newTime);
    }

    if (Math.random() < 0.2) {
      await scrollPage(page);
    }

    await delayFunction(3000);
  }
}

// Function to type text like a human
async function humanizedType(page, selector, text) {
  for (const char of text) {
    await page.type(selector, char);
    await delayFunction(100 + Math.random() * 100);
  }
}

// Function to scroll the page
async function scrollPage(page) {
  await page.evaluate(() => window.scrollBy(0, window.innerHeight));
  await delayFunction(1000 + Math.random() * 2000);
}

// Entry point of the script
(async () => {
  const userAgentsPath = './useragent.txt';
  const proxiesPath = './proxies.txt';

  const userAgents = readUserAgentsFromFile(userAgentsPath);
  const proxies = readProxiesFromFile(proxiesPath);

  const { query, windows, useProxies, filter, channelName, headless } = await inquirer.prompt([
    { type: 'input', name: 'query', message: 'Enter search query:', default: 'test' },
    { type: 'number', name: 'windows', message: 'Enter number of windows:', default: 3 },
    { type: 'confirm', name: 'useProxies', message: 'Use proxies?', default: false },
    { type: 'list', name: 'filter', message: 'Choose filter:', choices: ['Last hour', 'Today', 'This week', 'None'] },
    { type: 'input', name: 'channelName', message: 'Enter channel name (optional):', default: '' },
    { type: 'confirm', name: 'headless', message: 'Run in headless mode?', default: true },
  ]);

  await startAutomation(query, windows, useProxies, proxies, userAgents, filter, channelName, headless);
})();
