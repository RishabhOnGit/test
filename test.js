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
async function navigateWithRetry(page, url, retries = 5, timeout = 90000) {
  for (let i = 0; i < retries; i++) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeout });
      return;
    } catch (error) {
      if (i === retries - 1) throw error;
      console.log(`Retrying navigation due to error: ${error.message}`);
      await delayFunction(2000);
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

// Function to start automation in batches
async function startAutomationInBatches(totalWindows, batchSize, query, useProxies, proxies, userAgents, filter, channelName, headless) {
  const totalBatches = Math.ceil(totalWindows / batchSize);

  for (let batchIndex = 0; batchIndex < totalBatches; batchIndex++) {
    console.log(`Starting batch ${batchIndex + 1} of ${totalBatches}`);

    const currentBatchSize = Math.min(batchSize, totalWindows - batchIndex * batchSize);
    const browserPromises = [];

    for (let i = 0; i < currentBatchSize; i++) {
      const proxy = useProxies ? proxies[(batchIndex * batchSize + i) % proxies.length] : null;
      const userAgent = userAgents[(batchIndex * batchSize + i) % userAgents.length];
      browserPromises.push(
        openWindow(batchIndex * batchSize + i, query, filter, useProxies, proxy, userAgent, channelName, headless)
      );
    }

    await Promise.allSettled(browserPromises);
    console.log(`Batch ${batchIndex + 1} completed. Waiting before starting the next batch.`);
    await delayFunction(5000); // Delay before starting the next batch
  }
}

// Function to open a single browser window and track video playback
async function openWindow(i, query, filter, useProxies, proxy, userAgent, channelName, headless) {
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
        '--disable-blink-features=AutomationControlled',
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

    console.log(`Window ${i + 1}: Navigating to YouTube homepage.`);
    await navigateWithRetry(page, 'https://www.youtube.com');

    console.log(`Window ${i + 1}: Searching for "${query}".`);
    await page.type('input[name="search_query"]', query);
    await page.click('button[aria-label="Search"]');
    await page.waitForSelector('ytd-video-renderer', { visible: true });

    console.log(`Window ${i + 1}: Applying filter "${filter}".`);
    const newUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}&sp=${filter}`;
    await page.goto(newUrl, { waitUntil: 'domcontentloaded' });

    console.log(`Window ${i + 1}: Clicking on the first video.`);
    const videoSelector = 'ytd-video-renderer #video-title';
    const firstVideo = await page.$(videoSelector);
    await firstVideo.click();

    console.log(`Window ${i + 1}: Waiting for video playback to finish.`);
    await trackVideoPlayback(page);

    console.log(`Window ${i + 1}: Closing the browser.`);
    await browser.close();
  } catch (error) {
    console.error(`Window ${i + 1} encountered an error: ${error.message}`);
  }
}

// Function to track video playback and close the browser when done
async function trackVideoPlayback(page) {
  while (true) {
    const { currentTime, totalDuration } = await page.evaluate(() => {
      const video = document.querySelector('video');
      if (video) {
        return { currentTime: video.currentTime, totalDuration: video.duration };
      }
      return { currentTime: 0, totalDuration: 0 };
    });

    if (currentTime >= totalDuration) {
      console.log('Video playback completed.');
      break;
    }

    await delayFunction(3000); // Check playback progress every 3 seconds
  }
}

// Main function to gather user input
(async () => {
  const prompt = inquirer.createPromptModule();

  const answers = await prompt([
    { type: 'input', name: 'query', message: 'Enter the YouTube search query (video title or keywords):' },
    { type: 'input', name: 'channelName', message: 'Enter the channel name you want to match (leave blank to skip):', default: '' },
    { type: 'number', name: 'windows', message: 'Enter the number of browser windows to open:', default: 1 },
    { type: 'number', name: 'batchSize', message: 'Enter the batch size:', default: 10 },
    { type: 'confirm', name: 'useProxies', message: 'Do you want to use proxies?', default: true },
    { type: 'input', name: 'proxyFilePath', message: 'Enter the path of the proxy file:', default: path.join(__dirname, 'proxies.txt'), when: answers => answers.useProxies },
    { type: 'input', name: 'userAgentFilePath', message: 'Enter the path of the user agent file:', default: path.join(__dirname, 'useragent.txt') },
    { type: 'list', name: 'filter', message: 'Select the filter to apply to the search results:', choices: ['Last hour', 'Today', 'This week'], default: 'Last hour' },
    { type: 'confirm', name: 'headless', message: 'Do you want to use headless mode? (No UI)', default: true },
  ]);

  const proxies = answers.useProxies ? readProxiesFromFile(answers.proxyFilePath) : [];
  const userAgents = readUserAgentsFromFile(answers.userAgentFilePath);

  await startAutomationInBatches(
    answers.windows,
    answers.batchSize,
    answers.query,
    answers.useProxies,
    proxies,
    userAgents,
    answers.filter,
    answers.channelName,
    answers.headless
  );
})();
