const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const inquirer = require('inquirer');
const fs = require('fs');
const path = require('path');

// Use the stealth plugin to bypass bot detection
puppeteer.use(StealthPlugin());

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

// Function to start browser automation with batch processing
async function startAutomation(query, windows, useProxies, proxies, userAgents, filter, channelName, headless) {
  const filterMap = {
    'Last hour': '&sp=EgIIAQ%253D%253D',
    'Today': '&sp=EgIIAg%253D%253D',
    'This week': '&sp=EgIIAw%253D%253D',
  };

  const filterParam = filterMap[filter] || '';
  const batchSize = 10; // Number of windows to open per batch
  const browserPromises = [];

  // Open all windows first
  for (let i = 0; i < windows; i++) {
    const proxy = useProxies ? proxies[i % proxies.length] : null; // Rotate proxies
    const userAgent = userAgents[i % userAgents.length]; // Rotate user agents

    browserPromises.push(openWindow(i, query, filterParam, useProxies, proxy, userAgent, channelName, headless));
  }

  // Wait for all windows to be open
  console.log("Waiting for all windows to open.");
  await Promise.allSettled(browserPromises);

  // Now start the tasks after all windows are open
  console.log("Starting tasks in all windows.");
  for (let i = 0; i < windows; i++) {
    // Perform the tasks step by step in each window
    await performTasksInWindow(i, query, filterParam, useProxies, proxies[i % proxies.length], userAgents[i % userAgents.length], channelName, headless);
  }
}

// Function to open a single browser window
async function openWindow(i, query, filterParam, useProxies, proxy, userAgent, channelName, headless) {
  try {
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
        '--disable-software-rasterizer',
        ...(proxy ? [`--proxy-server=http://${proxy.ip}:${proxy.port}`] : []),
      ],
      defaultViewport: { width: 1024, height: 600 },
    });

    const page = await browser.newPage();
    await page.setUserAgent(userAgent);

    if (useProxies && proxy) {
      await page.authenticate({
        username: proxy.username,
        password: proxy.password,
      });
    }

    await page.setDefaultNavigationTimeout(90000);  // Set navigation timeout

    console.log(`Window ${i + 1}: Opening YouTube.`);
    await page.goto('https://www.youtube.com', { waitUntil: 'domcontentloaded' });

    // Open window without performing tasks
    console.log(`Window ${i + 1}: Window opened without performing tasks.`);
    await browser.close();
  } catch (error) {
    console.error(`Window ${i + 1} encountered an error: ${error.message}`);
  }
}

// Function to perform tasks after opening all windows
async function performTasksInWindow(i, query, filterParam, useProxies, proxy, userAgent, channelName, headless) {
  try {
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
        '--disable-software-rasterizer',
        ...(proxy ? [`--proxy-server=http://${proxy.ip}:${proxy.port}`] : []),
      ],
      defaultViewport: { width: 1024, height: 600 },
    });

    const page = await browser.newPage();
    await page.setUserAgent(userAgent);

    if (useProxies && proxy) {
      await page.authenticate({
        username: proxy.username,
        password: proxy.password,
      });
    }

    await page.setDefaultNavigationTimeout(90000);  // Set navigation timeout

    console.log(`Window ${i + 1}: Performing task - Searching for "${query}".`);
    await page.goto('https://www.youtube.com', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('input[name="search_query"]');
    await humanizedType(page, 'input[name="search_query"]', query);
    await page.click('button[aria-label="Search"]');

    console.log(`Window ${i + 1}: Applying filter "${filterParam}".`);
    const newUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}${filterParam}`;
    await page.goto(newUrl, { waitUntil: 'domcontentloaded' });

    await page.waitForSelector('ytd-video-renderer', { visible: true });

    console.log(`Window ${i + 1}: Clicking the first video.`);
    const videoSelector = 'ytd-video-renderer #video-title';
    await page.waitForSelector(videoSelector, { visible: true });
    const firstVideo = await page.$(videoSelector);
    await firstVideo.click();

    console.log(`Window ${i + 1}: Waiting for video to play.`);
    await page.waitForSelector('video', { visible: true });

    await trackVideoPlayback(page, i);

    console.log(`Window ${i + 1}: Closing the browser.`);
    await browser.close();
  } catch (error) {
    console.error(`Error in Window ${i + 1}: ${error.message}`);
  }
}

// Function to track video playback
async function trackVideoPlayback(page, windowIndex) {
  let currentTime = 0;
  let totalDuration = 0;

  while (true) {
    const videoData = await page.evaluate(() => {
      const videoElement = document.querySelector('video');
      if (videoElement) {
        const currentTime = videoElement.currentTime;
        const totalDuration = videoElement.duration;
        if (currentTime >= totalDuration - 1) {
          videoElement.currentTime = 0;
        }
        return { currentTime, totalDuration };
      }
      return { currentTime: 0, totalDuration: 0 };
    });

    currentTime = videoData.currentTime;
    totalDuration = videoData.totalDuration;

    console.log(`Window ${windowIndex + 1}: ${currentTime.toFixed(2)} / ${totalDuration.toFixed(2)} seconds`);

    if (Math.random() < 0.1) {
      const seekTime = Math.random() * 10;
      const seekDirection = Math.random() > 0.5 ? 1 : -1;
      const newTime = Math.max(0, Math.min(currentTime + seekDirection * seekTime, 9999));
      console.log(`Window ${windowIndex + 1}: Seeking to ${newTime.toFixed(2)} seconds.`);
      await page.evaluate(newTime => {
        const videoElement = document.querySelector('video');
        if (videoElement) {
          videoElement.currentTime = newTime;
        }
      }, newTime);
    }

    if (Math.random() < 0.2) {
      await scrollPage(page);
    }

    await delayFunction(3000);
  }
}

// Function to randomly scroll the page
async function scrollPage(page) {
  console.log('Scrolling randomly.');
  await delayFunction(3000);

  const scrollHeight = await page.evaluate(() => document.body.scrollHeight);
  const randomScrollDown = Math.floor(Math.random() * (scrollHeight / 2)) + 100;
  console.log(`Scrolling down by ${randomScrollDown}px`);
  await page.evaluate(scrollPos => window.scrollTo(0, scrollPos), randomScrollDown);

  await delayFunction(4000);
  console.log('Forcing scroll to the top');
  await page.evaluate(() => window.scrollTo(0, 0));
  await delayFunction(4000);
}

// Function to create a delay using Promise-based setTimeout
function delayFunction(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Humanized typing delay
async function humanizedType(page, selector, text) {
  const inputField = await page.$(selector);
  for (let i = 0; i < text.length; i++) {
    await inputField.type(text.charAt(i));
    const delay = Math.floor(Math.random() * (100 - 50 + 1)) + 50;
    await delayFunction(delay);
  }
}

// Main function to gather user input
(async () => {
  const prompt = inquirer.createPromptModule();

  const answers = await prompt([  
    { type: 'input', name: 'query', message: 'Enter the YouTube search query:' },
    { type: 'input', name: 'channelName', message: 'Enter the channel name you want to match (leave blank to skip):', default: '' },
    { type: 'number', name: 'windows', message: 'Enter the number of browser windows to open:', default: 1 },
    { type: 'confirm', name: 'useProxies', message: 'Do you want to use proxies?', default: true },
    { type: 'input', name: 'proxyFilePath', message: 'Enter the path of the proxy file:', default: path.join(__dirname, 'proxies.txt'), when: answers => answers.useProxies },
    { type: 'input', name: 'userAgentFilePath', message: 'Enter the path of the user agent file:', default: path.join(__dirname, 'useragent.txt') },
    { type: 'list', name: 'filter', message: 'Select the filter to apply:', choices: ['Last hour', 'Today', 'This week'], default: 'Last hour' },
    { type: 'confirm', name: 'headless', message: 'Use headless mode?', default: true },
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
    answers.headless
  );
})();
