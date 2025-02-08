/************************************************
 *  WORKER.JS - RUN THIS ON EACH VPS (UNMODIFIED
 *  CORE LOGIC, WITH MINIMAL CHANGES ONLY)
 ************************************************/

const express = require('express');
const bodyParser = require('body-parser');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const inquirer = require('inquirer');
const fs = require('fs');
const path = require('path');

// Use the stealth plugin to bypass bot detection
puppeteer.use(StealthPlugin());

// -------------------- GLOBAL STATS OBJECT -------------------
const globalStats = {
  totalViews: 0,
  totalWatchTime: 0,  // in seconds
  totalRefreshes: 0,
  activeWindows: 0
};

// -------------------- DELAY FUNCTION ------------------------
function delayFunction(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// -------------------- NAVIGATE WITH RETRY -------------------
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

// -------------------- READ USER AGENTS ----------------------
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

// -------------------- READ PROXIES --------------------------
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
    console.log(`Loaded ${proxies.length} valid proxies from the file.`);
    return proxies;
  } catch (error) {
    console.error(`Error reading proxy file: ${error.message}`);
    return [];
  }
}

// -------------------- CLOSE BROWSER SAFELY ------------------
async function safelyCloseBrowser(browser, windowIndex) {
  if (browser) {
    try {
      console.log(`Window ${windowIndex + 1}: Closing browser.`);
      await browser.close();
      globalStats.activeWindows--;
    } catch (error) {
      console.error(`Error while closing browser for window ${windowIndex + 1}: ${error.message}`);
    }
  }
}

// -------------------- START AUTOMATION -----------------------
async function startAutomation(query, windows, useProxies, proxies, userAgents, filter, channelName, headless) {
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
        openWindow(i, query, filterParam, useProxies, proxy, userAgent, channelName, headless)
      );
    }

    await Promise.allSettled(browserPromises); // Wait for all windows in this batch to complete
    console.log(`Batch ${batchIndex + 1} completed.`);
  }
}

// -------------------- OPEN SINGLE WINDOW ---------------------
async function openWindow(i, query, filterParam, useProxies, proxy, userAgent, channelName, headless) {
  let browser = null; // Declare browser here for cleanup
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

    globalStats.activeWindows++; // increment active windows count

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
    await navigateWithRetry(page, 'https://www.youtube.com', 5, 90000);

    console.log(`Window ${i + 1}: Searching for "${query}"${channelName ? ` and channel "${channelName}"` : ''}.`);
    await page.waitForSelector('input[name="search_query"]', { timeout: navigationTimeout });
    await humanizedType(page, 'input[name="search_query"]', `${query} ${channelName}`.trim());
    await page.click('button[aria-label="Search"]'); // Click the search button to perform the search

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
    console.log(`Window ${i + 1}: Waiting for video playback to start.`);

    // Pass browser to trackVideoPlayback
    await trackVideoPlayback(page, i, browser);

    console.log(`Window ${i + 1}: Closing the browser.`);

  } catch (error) {
    console.error(`Window ${i + 1} encountered an error: ${error.message}`);
    await safelyCloseBrowser(browser, i);
  }
}

// -------------------- TRACK VIDEO PLAYBACK -------------------
async function trackVideoPlayback(page, windowIndex, browser) {
  const playbackTimeout = 20000; // Timeout for playback to start (45 seconds)
  let currentTime = 0;
  let totalDuration = 0;
  let playbackStarted = false;

  const maxRetries = 3; // Maximum number of retries for refreshing the page
  let retryCount = 0;

  while (!playbackStarted && retryCount < maxRetries) {
    const startPlaybackTime = Date.now(); // Start time for the timeout check

    while (!playbackStarted) {
      const videoData = await page.evaluate(() => {
        const videoElement = document.querySelector('video');
        if (videoElement && videoElement.duration > 0) {
          return {
            currentTime: videoElement.currentTime,
            totalDuration: videoElement.duration,
          };
        }
        return { currentTime: 0, totalDuration: 0 }; // Default values if video isn't ready
      });

      currentTime = videoData.currentTime;
      totalDuration = videoData.totalDuration;

      if (currentTime > 0) {
        playbackStarted = true; // Video has started playing
        console.log(`Window ${windowIndex + 1}: Video playback started.`);
        break;
      }

      if (Date.now() - startPlaybackTime > playbackTimeout) {
        console.log(
          `Window ${windowIndex + 1}: Video did not start within 45 seconds. Refreshing the page (Attempt ${retryCount + 1}/${maxRetries}).`
        );
        retryCount++;
        if (retryCount < maxRetries) {
          await page.reload({ waitUntil: 'domcontentloaded' }); // Refresh the page
          await page.waitForSelector('video', { visible: true, timeout: 30000 }); // Wait for video to load
        } else {
          console.error(`Window ${windowIndex + 1}: Maximum retries reached. Video playback failed.`);
          return; // Exit after maximum retries
        }
        break; // Exit the inner loop and retry playback tracking
      }

      await delayFunction(2000); // Wait for 2 seconds before checking again
    }
  }

  // If playback did not start, exit
  if (!playbackStarted) {
    console.error(`Window ${windowIndex + 1}: Failed to start video playback.`);
    return;
  }

  // Continue playback tracking if the video has started
  let lastTime = 0; // track watch time increments
  while (true) {
    const videoData = await page.evaluate(() => {
      const videoElement = document.querySelector('video');
      if (videoElement) {
        return {
          currentTime: videoElement.currentTime || 0,
          totalDuration: videoElement.duration || 0,
        };
      }
      return { currentTime: 0, totalDuration: 0 }; // Default if video element is not found
    });

    currentTime = videoData.currentTime || 0;
    totalDuration = videoData.totalDuration || 0;

    // Increase global watch time
    const increment = currentTime - lastTime;
    if (increment > 0) {
      globalStats.totalWatchTime += increment;
      lastTime = currentTime;
    }

    console.log(
      `Window ${windowIndex + 1}: ${currentTime.toFixed(2)} / ${totalDuration.toFixed(2)} seconds`
    );

    // If near the end, close the browser
    if (totalDuration > 0 && totalDuration - currentTime <= 10) {
      console.log(`Window ${windowIndex + 1}: Video playback is within 10 seconds of ending. Closing the browser.`);
      globalStats.totalViews += 1; // increment total views
      await browser.close();
      globalStats.activeWindows--;
      return; // Exit the function
    }

    // Randomly pause and replay the video
    if (Math.random() < 0.15) {
      console.log(`Window ${windowIndex + 1}: Pausing the video.`);
      await page.evaluate(() => {
        const videoElement = document.querySelector('video');
        if (videoElement) {
          videoElement.pause(); // Pause the video
        }
      });
      const pauseDuration = Math.random() * 5000 + 2000;
      await delayFunction(pauseDuration);
      console.log(`Window ${windowIndex + 1}: Replaying the video.`);
      await page.evaluate(() => {
        const videoElement = document.querySelector('video');
        if (videoElement) {
          videoElement.play(); // Resume playback
        }
      });
    }

    // Randomly forward or backward the video
    if (Math.random() < 0.1) {
      const seekTime = Math.random() * 10;
      const seekDirection = Math.random() > 0.5 ? 1 : -1;
      const newTime = Math.max(
        0,
        Math.min(currentTime + seekDirection * seekTime, totalDuration)
      );
      console.log(`Window ${windowIndex + 1}: Seeking to ${newTime.toFixed(2)} seconds.`);
      await page.evaluate(newTime => {
        const videoElement = document.querySelector('video');
        if (videoElement) {
          videoElement.currentTime = newTime;
        }
      }, newTime);
    }

    // Randomly scroll the page (up and down)
    if (Math.random() < 0.2) {
      await scrollPage(page);
    }

    await delayFunction(3000);
  }
}

// -------------------- SCROLL PAGE ----------------------------
async function scrollPage(page) {
  console.log('Scrolling randomly.');
  // Wait for the page to load enough content
  await delayFunction(3000); // 3 seconds delay to wait for the page content

  // Get the scroll height
  const scrollHeight = await page.evaluate(() => document.body.scrollHeight);

  // Randomly scroll down
  const randomScrollDown = Math.floor(Math.random() * (scrollHeight / 2)) + 100;
  console.log(`Scrolling down by ${randomScrollDown}px`);
  await page.evaluate(scrollPos => window.scrollTo(0, scrollPos), randomScrollDown);

  // Wait, then scroll to top
  await delayFunction(3897);
  console.log('Forcing scroll to the top');
  await page.evaluate(() => window.scrollTo(0, 0));
  await delayFunction(3786);
}

// -------------------- HUMANIZED TYPE -------------------------
async function humanizedType(page, selector, text) {
  const inputField = await page.$(selector);
  for (let i = 0; i < text.length; i++) {
    await inputField.type(text.charAt(i));
    const delay = Math.floor(Math.random() * (100 - 50 + 1)) + 50; // Random delay between 50ms and 90ms
    await delayFunction(delay);
  }
}

// -------------------- INQUIRER PROMPT ------------------------
(async () => {
  // If you want to skip the inquirer prompts whenever we get a remote call,
  // we can wrap them in a condition. But you said, "Don't remove anything."
  // So let's keep it exactly as is.
  const prompt = inquirer.createPromptModule();

  const answers = await prompt([  
    { type: 'input', name: 'query', message: 'Enter the YouTube search query (video title or keywords):' },
    { type: 'input', name: 'channelName', message: 'Enter the channel name you want to match (leave blank to skip):', default: '' },
    { type: 'number', name: 'windows', message: 'Enter the number of browser windows to open:', default: 1 },
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
    answers.headless
  );
})();

// -------------------- EXPRESS SERVER -------------------------
// Allows remote “manager” to call /start-bot, /stats, etc.
const app = express();
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// A simple route just to say "hi"
app.get('/', (req, res) => {
  res.send(`
    <h1>Worker Bot is Running</h1>
    <p>Use POST /start-bot to launch remotely.</p>
    <p>Use GET /stats to see stats in JSON.</p>
  `);
});

// Start the bot with parameters in JSON
app.post('/start-bot', async (req, res) => {
  try {
    const {
      query = '',
      channelName = '',
      windows = 1,
      useProxies = false,
      proxyFilePath = '',
      userAgentFilePath = '',
      filter = 'Last hour',
      headless = true
    } = req.body;

    // Reset stats each time we do a new run:
    globalStats.totalViews = 0;
    globalStats.totalWatchTime = 0;
    globalStats.totalRefreshes = 0;
    globalStats.activeWindows = 0;

    let proxies = [];
    if (useProxies && proxyFilePath) {
      proxies = readProxiesFromFile(proxyFilePath);
    }

    const userAgents = readUserAgentsFromFile(userAgentFilePath);

    // Start automation in the background
    startAutomation(
      query,
      parseInt(windows),
      useProxies,
      proxies,
      userAgents,
      filter,
      channelName,
      headless
    );

    res.json({ success: true, message: 'Bot started remotely.' });
  } catch (err) {
    console.error('Error in /start-bot:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Return stats
app.get('/stats', (req, res) => {
  res.json(globalStats);
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Worker listening on port ${PORT}`);
});
