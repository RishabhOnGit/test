const puppeteer = require('puppeteer');
const inquirer = require('inquirer');

// Function to start browser automation
async function startAutomation(query, windows, useProxies, proxies, filter, channelName, headless) {
  // Map filters to the appropriate YouTube query parameter
  const filterMap = {
    'Last hour': '&sp=EgIIAQ%253D%253D',   // Last hour filter
    'Today': '&sp=EgIIAg%253D%253D',       // Today filter
    'This week': '&sp=EgIIAw%253D%253D'    // This week filter
  };

  // Add the selected filter to the query string
  const filterParam = filterMap[filter] || ''; // Default to no filter if invalid filter

  const browserPromises = [];

  for (let i = 0; i < windows; i++) {
    browserPromises.push(
      openWindow(i, query, filterParam, useProxies, proxies, channelName, headless)
    );
  }

  // Wait for all windows to open concurrently
  await Promise.all(browserPromises);
}

// Function to open a single window
async function openWindow(i, query, filterParam, useProxies, proxies, channelName, headless) {
  const browser = await puppeteer.launch({
    headless: headless, // Run in headless mode if true
    executablePath: '/usr/bin/chromium-browser', // Explicitly use the chromium-browser path
    args: [
      '--window-size=800,600',
      '--disable-infobars',
      '--no-sandbox', // Useful for VPS environments
      '--disable-setuid-sandbox',
    ]
  });

  const windowWidth = 800;
  const windowHeight = 600;
  const windowX = 100 + i * (windowWidth + 20);
  const windowY = 100;

  const page = await browser.newPage();
  await page.setViewport({ width: windowWidth, height: windowHeight });

  if (useProxies && proxies[i]) {
    const proxy = proxies[i];
    await page.authenticate({
      username: proxy.username,
      password: proxy.password,
    });
    await page.setRequestInterception(true);
    page.on('request', (request) => {
      if (request.resourceType() === 'document') {
        request.continue({
          headers: {
            ...request.headers(),
            'Proxy-Authorization': `Basic ${Buffer.from(`${proxy.username}:${proxy.password}`).toString('base64')}`,
          },
        });
      } else {
        request.continue();
      }
    });
  }

  // Go to YouTube and search for the query with the filter in the URL
  const searchUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}${filterParam}`;
  console.log(`Navigating to: ${searchUrl}`);
  await page.goto(searchUrl);

  // Wait for the video results to load
  await page.waitForSelector('ytd-video-renderer');

  // Find all video titles and channel names
  const videos = await page.$$eval('ytd-video-renderer', (videoElements) => {
    return videoElements.map((video) => {
      const title = video.querySelector('#video-title')?.textContent?.trim();
      const channel = video.querySelector('#channel-name')?.textContent?.trim();
      const link = video.querySelector('a')?.href;
      return { title, channel, link };
    });
  });

  let matchedVideo = null;

  // If channelName is provided, find the video matching the channel name
  if (channelName) {
    matchedVideo = videos.find((video) => {
      return video.channel && video.channel.toLowerCase().includes(channelName.toLowerCase());
    });

    if (matchedVideo) {
      console.log(`Found video: ${matchedVideo.title} by ${matchedVideo.channel}`);
    }
  }

  // If no match is found and channelName is provided, close the browser window
  if (!matchedVideo && channelName) {
    console.log(`No video found from channel "${channelName}". Closing the window.`);
    await browser.close();
    return; // Skip to the next window
  }

  // If no matched video is found and no channel name was provided, select the first video
  if (!matchedVideo && !channelName) {
    console.log('No matching video found. Selecting the first video.');
    matchedVideo = videos[0];
  }

  // Go to the selected video link
  if (matchedVideo) {
    await page.goto(matchedVideo.link); // Go to the video link
    await page.waitForSelector('video'); // Wait for the video to start
    console.log(`Window ${i + 1} is playing: ${matchedVideo.title} by ${matchedVideo.channel}`);
  }
}

// Main function to gather user input
(async () => {
  const prompt = inquirer.createPromptModule();

  // Ask user for input
  const answers = await prompt([
    {
      type: 'input',
      name: 'query',
      message: 'Enter the YouTube search query (video title or keywords):',
    },
    {
      type: 'input',
      name: 'channelName',
      message: 'Enter the channel name you want to match (leave blank to skip):',
      default: '', // Default empty string if not provided
    },
    {
      type: 'number',
      name: 'windows',
      message: 'Enter the number of browser windows to open:',
    },
    {
      type: 'confirm',
      name: 'useProxies',
      message: 'Do you want to use proxies?',
      default: false,
    },
    {
      type: 'input',
      name: 'proxies',
      message: 'Enter the list of proxies (comma separated) if you want to use them:',
      when: (answers) => answers.useProxies,
    },
    {
      type: 'list',
      name: 'filter',
      message: 'Select the filter to apply to the search results:',
      choices: ['Last hour', 'Today', 'This week'],
      default: 'Last hour',
    },
    {
      type: 'confirm',
      name: 'headless',
      message: 'Do you want to run the browser in headless mode?',
      default: false, // Default to showing the browser window
    },
  ]);

  // Process the proxy list if provided
  let proxies = [];
  if (answers.proxies) {
    proxies = answers.proxies.split(',').map((proxy) => {
      const [username, password] = proxy.split(':');
      return { username, password };
    });
  }

  // Start the automation with the user's input and filter
  await startAutomation(answers.query, answers.windows, answers.useProxies, proxies, answers.filter, answers.channelName, answers.headless);
})();
