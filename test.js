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
    // Set the navigation timeout based on the proxy usage
    const navigationTimeout = useProxies ? 900000 : 90000; // Timeout for navigation

    const browser = await puppeteer.launch({
      headless: headless,
      executablePath: '/usr/bin/chromium-browser',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-accelerated-2d-canvas',
        '--disable-gpu',
        '--disable-infobars',
        '--window-size=1024,600', // Set window size to 1024x600 (smaller window)
        ...(proxy ? [`--proxy-server=http://${proxy.ip}:${proxy.port}`] : []),
      ],
      defaultViewport: { width: 1024, height: 600 }, // Set the viewport size smaller (1024x600)
    });

    const page = await browser.newPage();
    await page.setUserAgent(userAgent);

    // Apply proxy authentication if needed
    if (useProxies && proxy) {
      await page.authenticate({
        username: proxy.username,
        password: proxy.password,
      });
    }

    // Set the navigation timeout for the page
    await page.setDefaultNavigationTimeout(navigationTimeout);  // Explicitly set the default navigation timeout

    // Navigate to YouTube
    console.log(`Window ${i + 1}: Navigating to YouTube homepage.`);
    await page.goto('https://www.youtube.com', { waitUntil: 'domcontentloaded' });

    // Search for the query
    console.log(`Window ${i + 1}: Searching for "${query}".`);
    await page.waitForSelector('input[name="search_query"]', { timeout: navigationTimeout });
    await humanizedType(page, 'input[name="search_query"]', query); // Humanized typing
    await page.click('button[aria-label="Search"]'); // Click the search button

    // Wait for search results to load
    console.log(`Window ${i + 1}: Waiting for search results to load.`);
    await page.waitForSelector('ytd-video-renderer', { visible: true, timeout: navigationTimeout });

    // Add a delay before applying the filter
    console.log(`Window ${i + 1}: Adding delay before applying the filter.`);
    await delayFunction(2000);
    await page.click('button[aria-label="Search filters"]');
    await delayFunction(3000); // Using setTimeout for delay (5 seconds)

    // Apply filter by modifying the URL
    console.log(`Window ${i + 1}: Applying filter "${filterParam}".`);
    const newUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}${filterParam}`;
    await page.goto(newUrl, { waitUntil: 'domcontentloaded' });

    // Wait for filtered results
    await page.waitForSelector('ytd-video-renderer', { visible: true, timeout: navigationTimeout });

    // Scroll randomly after applying the filter
    

    // Click on the first video
    console.log(`Window ${i + 1}: Clicking on the first video.`);
    const videoSelector = 'ytd-video-renderer #video-title';
    await page.waitForSelector(videoSelector, { visible: true });
    const firstVideo = await page.$(videoSelector);
    await firstVideo.click();

    // Wait for the video page to load
    console.log(`Window ${i + 1}: Waiting for video to load.`);
    await page.waitForSelector('video', { visible: true });

    // Wait for video playback to actually start and then track video
    console.log(`Window ${i + 1}: Waiting for video playback to start.`);
    await trackVideoPlayback(page, i); // Track video playback time

    // Close the browser after playback
    console.log(`Window ${i + 1}: Closing the browser.`);
    await browser.close();
  } catch (error) {
    console.error(`Window ${i + 1} encountered an error: ${error.message}`);
  }
}

// Function to track video playback and update both current time and total duration every 3 seconds
async function trackVideoPlayback(page, windowIndex) {
  let currentTime = 0;
  let totalDuration = 0;  // Variable to store total video duration

  // Wait for video to start playing and get the total duration
  let videoStarted = false;
  while (!videoStarted) {
    currentTime = await page.evaluate(() => {
      const videoElement = document.querySelector('video');
      if (videoElement && videoElement.duration > 0) {
        return videoElement.currentTime; // Get current time if video has a valid duration
      }
      return 0; // Return 0 if video isn't ready yet
    });

    if (currentTime > 0) {
      totalDuration = await page.evaluate(() => {
        const videoElement = document.querySelector('video');
        return videoElement ? videoElement.duration : 0; // Get total duration of the video
      });
      videoStarted = true; // Video has started playing
    } else {
      await delayFunction(2000); // Wait for 2 seconds before checking again
    }
  }

  // Loop to fetch both current time and total duration every 3 seconds
  while (true) {
    // Fetch current playback time and total video duration
    const videoData = await page.evaluate(() => {
      const videoElement = document.querySelector('video');
      if (videoElement) {
        const currentTime = videoElement.currentTime;
        const totalDuration = videoElement.duration;
        // If video reaches the end, reset the time to 0 to loop it
        if (currentTime >= totalDuration - 1) {
          videoElement.currentTime = 0; // Reset to the start of the video
        }
        return { currentTime, totalDuration };
      }
      return { currentTime: 0, totalDuration: 0 }; // If video element is not found, return default values
    });

    currentTime = videoData.currentTime;
    totalDuration = videoData.totalDuration;

    // Print current time and total duration in the format {currentTime}/{totalDuration}
    console.log(`Window ${windowIndex + 1}: ${currentTime.toFixed(2)} / ${totalDuration.toFixed(2)} seconds`);

    // Randomly forward or backward the video
    if (Math.random() < 0.1) {  // 10% chance to forward/backward
      const seekTime = Math.random() * 10; // Seek within the next 10 seconds
      const seekDirection = Math.random() > 0.5 ? 1 : -1; // Randomly choose forward or backward
      const newTime = Math.max(0, Math.min(currentTime + seekDirection * seekTime, 9999)); // Avoid negative time
      console.log(`Window ${windowIndex + 1}: Seeking to ${newTime.toFixed(2)} seconds.`);
      await page.evaluate(newTime => {
        const videoElement = document.querySelector('video');
        if (videoElement) {
          videoElement.currentTime = newTime; // Seek to new time
        }
      }, newTime);
    }

    // Randomly scroll the page (up and down)
  

    // Wait for 3 seconds before updating again
    await delayFunction(3000); // Delay 3 seconds
  }
}

// Function to randomly scroll the page (up and down)


// Function to create a delay using Promise-based setTimeout
function delayFunction(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
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

// Function to randomly scroll the page (up and down)



// Main function to gather user input
(async () => {
  const prompt = inquirer.createPromptModule();

  const answers = await prompt([  
    { type: 'input', name: 'query', message: 'Enter the YouTube search query (video title or keywords):' },
    { type: 'input', name: 'channelName', message: 'Enter the channel name you want to match (leave blank to skip):', default: '' },
    { type: 'number', name: 'windows', message: 'Enter the number of browser windows to open:', default: 1 },
    { type: 'confirm', name: 'useProxies', message: 'Do you want to use proxies?', default: false },
    { type: 'input', name: 'proxyFilePath', message: 'Enter the path of the proxy file:', default: path.join(__dirname, 'proxies.txt'), when: answers => answers.useProxies },
    { type: 'input', name: 'userAgentFilePath', message: 'Enter the path of the user agent file:', default: path.join(__dirname, 'useragent.txt') },
    { type: 'list', name: 'filter', message: 'Select the filter to apply to the search results:', choices: ['Last hour', 'Today', 'This week'], default: 'Last hour' },
    { type: 'confirm', name: 'headless', message: 'Do you want to use headless mode? (No UI)', default: false },
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
