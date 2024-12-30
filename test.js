const puppeteer = require('puppeteer');
const inquirer = require('inquirer');
const fs = require('fs').promises; // For reading the proxies file

// Function to read proxies from a local file
async function readProxiesFromFile(filePath) {
  try {
    const data = await fs.readFile(filePath, 'utf-8');
    const proxyLines = data.split('\n').filter((line) => line.trim() !== ''); // Remove empty lines
    return proxyLines.map((proxy) => {
      const [username, password] = proxy.split(':');
      return { username, password };
    });
  } catch (error) {
    console.error(`Failed to read proxies from file (${filePath}):`, error.message);
    return [];
  }
}

// Function to start browser automation
async function startAutomation(query, windows, useProxies, proxies, filter, channelName, headless) {
  const filterMap = {
    'Last hour': '&sp=EgIIAQ%253D%253D',
    'Today': '&sp=EgIIAg%253D%253D',
    'This week': '&sp=EgIIAw%253D%253D',
  };

  const filterParam = filterMap[filter] || '';
  const browserPromises = [];

  for (let i = 0; i < windows; i++) {
    browserPromises.push(
      openWindow(i, query, filterParam, useProxies, proxies, channelName, headless)
    );
  }

  await Promise.all(browserPromises);
}

// Function to open a single window
async function openWindow(i, query, filterParam, useProxies, proxies, channelName, headless) {
  const browser = await puppeteer.launch({
    headless: headless,
    executablePath: '/usr/bin/chromium-browser',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-infobars'],
  });

  const page = await browser.newPage();

  if (useProxies && proxies[i]) {
    const proxy = proxies[i];
    await page.authenticate({
      username: proxy.username,
      password: proxy.password,
    });
  }

  const searchUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}${filterParam}`;
  console.log(`Navigating to: ${searchUrl}`);
  await page.goto(searchUrl);

  await page.waitForSelector('ytd-video-renderer');

  const videos = await page.$$eval('ytd-video-renderer', (videoElements) => {
    return videoElements.map((video) => {
      const title = video.querySelector('#video-title')?.textContent?.trim();
      const channel = video.querySelector('#channel-name')?.textContent?.trim();
      const link = video.querySelector('a')?.href;
      return { title, channel, link };
    });
  });

  let matchedVideo = null;

  if (channelName) {
    matchedVideo = videos.find((video) =>
      video.channel && video.channel.toLowerCase().includes(channelName.toLowerCase())
    );

    if (matchedVideo) {
      console.log(`Found video: ${matchedVideo.title} by ${matchedVideo.channel}`);
    }
  }

  if (!matchedVideo && channelName) {
    console.log(`No video found from channel "${channelName}". Closing the window.`);
    await browser.close();
    return;
  }

  if (!matchedVideo && !channelName) {
    console.log('No matching video found. Selecting the first video.');
    matchedVideo = videos[0];
  }

  if (matchedVideo) {
    await page.goto(matchedVideo.link); // Go to the video link
    console.log(`Window ${i + 1} is playing: ${matchedVideo.title} by ${matchedVideo.channel}`);
  }
}

// Main function to gather user input
(async () => {
  const prompt = inquirer.createPromptModule();

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
      default: '',
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
      name: 'proxiesFilePath',
      message: 'Enter the path to the proxies file (e.g., proxies.txt):',
      when: (answers) => answers.useProxies,
      default: 'proxies.txt', // Default file name
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
      default: false,
    },
  ]);

  let proxies = [];
  if (answers.useProxies && answers.proxiesFilePath) {
    proxies = await readProxiesFromFile(answers.proxiesFilePath);
  }

  await startAutomation(
    answers.query,
    answers.windows,
    answers.useProxies,
    proxies,
    answers.filter,
    answers.channelName,
    answers.headless
  );
})();
