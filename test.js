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

// Function to start browser automation with step-by-step tasks
async function startAutomation(query, windows, useProxies, proxies, userAgents, filter, channelName, headless) {
  const filterMap = {
    'Last hour': '&sp=EgIIAQ%253D%253D',
    'Today': '&sp=EgIIAg%253D%253D',
    'This week': '&sp=EgIIAw%253D%253D',
  };

  const filterParam = filterMap[filter] || '';
  const browserInstances = [];

  // Open all tabs/windows first
  for (let i = 0; i < windows; i++) {
    const proxy = useProxies ? proxies[i % proxies.length] : null; // Rotate proxies
    const userAgent = userAgents[i % userAgents.length]; // Rotate user agents
    const browserPromise = openWindow(i, useProxies, proxy, userAgent, headless);
    browserInstances.push(browserPromise);
  }

  // Wait for all windows to open
  console.log("Opening all windows...");
  const openedBrowsers = await Promise.allSettled(browserInstances);

  // Filter out successfully opened browser instances
  const successfulBrowsers = openedBrowsers
    .filter(result => result.status === 'fulfilled')
    .map(result => result.value);

  if (successfulBrowsers.length === 0) {
    console.error('No browser windows could be opened. Exiting...');
    return;
  }

  // Perform tasks step-by-step in all tabs/windows
  console.log("Performing tasks in all windows...");
  await performTasksStepByStep(successfulBrowsers, query, filterParam, channelName);

  // Close all browsers after tasks are done
  console.log("Closing all browsers...");
  await Promise.allSettled(successfulBrowsers.map(({ browser }) => browser.close()));
  console.log("All tasks completed!");
}

// Function to open a single browser window
async function openWindow(index, useProxies, proxy, userAgent, headless) {
  const browser = await puppeteer.launch({
    headless: headless,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-accelerated-2d-canvas',
      '--disable-gpu',
      ...(proxy ? [`--proxy-server=http://${proxy.ip}:${proxy.port}`] : []),
    ],
  });

  const page = await browser.newPage();
  await page.setUserAgent(userAgent);

  if (useProxies && proxy) {
    await page.authenticate({
      username: proxy.username,
      password: proxy.password,
    });
  }

  console.log(`Window ${index + 1}: Opened successfully.`);
  return { browser, page, index };
}

// Function to perform step-by-step tasks in all windows
async function performTasksStepByStep(browsers, query, filterParam, channelName) {
  // Step 1: Open YouTube
  console.log("Step 1: Opening YouTube in all tabs...");
  await Promise.allSettled(
    browsers.map(({ page }, index) =>
      page.goto('https://www.youtube.com', { waitUntil: 'domcontentloaded' })
        .then(() => console.log(`Tab ${index + 1}: YouTube opened successfully.`))
        .catch(err => console.error(`Tab ${index + 1}: Failed to open YouTube. ${err.message}`))
    )
  );

  // Step 2: Perform the search
  console.log("Step 2: Performing search in all tabs...");
  await Promise.allSettled(
    browsers.map(async ({ page }, index) => {
      try {
        await page.waitForSelector('input[name="search_query"]', { timeout: 15000 });
        await page.type('input[name="search_query"]', query, { delay: 100 });
        await page.click('button[aria-label="Search"]');
        await page.waitForNavigation({ waitUntil: 'domcontentloaded' });
        console.log(`Tab ${index + 1}: Search completed.`);
      } catch (err) {
        console.error(`Tab ${index + 1}: Failed to perform search. ${err.message}`);
      }
    })
  );

  // Step 3: Apply the filter
  console.log("Step 3: Applying filters...");
  if (filterParam) {
    await Promise.allSettled(
      browsers.map(async ({ page }, index) => {
        try {
          const newUrl = `${page.url()}${filterParam}`;
          await page.goto(newUrl, { waitUntil: 'domcontentloaded' });
          console.log(`Tab ${index + 1}: Filter applied.`);
        } catch (err) {
          console.error(`Tab ${index + 1}: Failed to apply filter. ${err.message}`);
        }
      })
    );
  }

  // Step 4: Click and play the first video
  console.log("Step 4: Playing the first video in all tabs...");
  await Promise.allSettled(
    browsers.map(async ({ page }, index) => {
      try {
        const videoSelector = 'ytd-video-renderer #video-title';
        await page.waitForSelector(videoSelector, { timeout: 15000 });
        await page.click(videoSelector);
        await page.waitForSelector('video', { visible: true });
        console.log(`Tab ${index + 1}: Video is playing.`);
      } catch (err) {
        console.error(`Tab ${index + 1}: Failed to play the video. ${err.message}`);
      }
    })
  );
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

  const proxies = answers.useProxies ? readProxiesFromFile(answers.proxyFilePath) : [];
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
