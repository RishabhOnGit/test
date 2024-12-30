const puppeteer = require('puppeteer');
const inquirer = require('inquirer');
const fs = require('fs');

// Function to start browser automation
async function startAutomation(query, windows, useProxies, proxies, filter, channelName, headless) {
  const filterMap = {
    'Last hour': '&sp=EgIIAQ%253D%253D', // Last hour filter
    'Today': '&sp=EgIIAg%253D%253D', // Today filter
    'This week': '&sp=EgIIAw%253D%253D', // This week filter
  };

  const filterParam = filterMap[filter] || ''; // Default to no filter if invalid filter
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
    const { username, password, ip, port } = proxies[i];
    // Use HTTP proxy with authentication
    const proxyUrl = `http://${username}:${password}@${ip}:${port}`;
    await page.authenticate({
      username: username,
      password: password,
    });
    await page.setRequestInterception(true);
    page.on('request', (request) => {
      request.continue({
        headers: {
          ...request.headers(),
          'Proxy-Authorization': `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`,
        },
      });
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

// Function to load proxies from a file
function loadProxiesFromFile(filePath) {
  const proxyList = [];
  const data = fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean); // Read and split by line

  data.forEach((line) => {
    const [userPass, ipPort] = line.split('@');
    const [username, password] = userPass.split(':');
    const [ip, port] = ipPort.split(':');

    if (username && password && ip && port) {
      proxyList.push({ username, password, ip, port });
    }
  });

  return proxyList;
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
      name: 'proxyFile',
      message: 'Enter the path to the proxy file (e.g., proxies.txt):',
      when: (answers) => answers.useProxies,
      default: 'proxies.txt', // Default to 'proxies.txt'
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
  if (answers.useProxies) {
    proxies = loadProxiesFromFile(answers.proxyFile);
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
