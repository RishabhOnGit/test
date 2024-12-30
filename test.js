const puppeteer = require('puppeteer');
const inquirer = require('inquirer');

// Function to start browser automation
async function startAutomation(query, windows, useProxies, proxies, filter, channelName) {
  const filterMap = {
    'Last hour': '&sp=EgIIAQ%253D%253D',   // Last hour filter
    'Today': '&sp=EgIIAg%253D%253D',       // Today filter
    'This week': '&sp=EgIIAw%253D%253D'    // This week filter
  };

  const filterParam = filterMap[filter] || '';

  const browserPromises = [];

  for (let i = 0; i < windows; i++) {
    browserPromises.push(
      openWindow(i, query, filterParam, useProxies, proxies, channelName)
    );
  }

  await Promise.all(browserPromises);
}

// Function to open a single window
async function openWindow(i, query, filterParam, useProxies, proxies, channelName) {
  const browser = await puppeteer.launch({
    headless: false,
    executablePath: '/usr/bin/chromium-browser', // Correct Chromium path for Ubuntu
    args: [
      '--window-size=800,600',
      '--disable-infobars',
    ]
  });

  const windowWidth = 800;
  const windowHeight = 600;
  const windowX = 100 + i * (windowWidth + 20);
  const windowY = 100;

  const page = await browser.newPage();
  await page.setViewport({ width: windowWidth, height: windowHeight });

  await page.evaluateOnNewDocument((x, y) => {
    window.moveTo(x, y);
    window.resizeTo(window.innerWidth, window.innerHeight);
  }, windowX, windowY);

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
    matchedVideo = videos.find((video) => {
      return video.channel && video.channel.toLowerCase().includes(channelName.toLowerCase());
    });

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
    await page.goto(matchedVideo.link);
    await page.waitForSelector('video');
    console.log(`Window ${i + 1} is playing: ${matchedVideo.title} by ${matchedVideo.channel}`);

    // Expose a function to log live video playback updates
    await page.exposeFunction('logPlaybackTime', (currentTime) => {
      console.log(`Window ${i + 1}: Video playback time: ${Math.floor(currentTime)} seconds.`);
    });

    // Inject a script to track the video playback time
    await page.evaluate(() => {
      const video = document.querySelector('video');
      if (video) {
        video.addEventListener('timeupdate', () => {
          window.logPlaybackTime(video.currentTime);
        });
      }
    });
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
  ]);

  let proxies = [];
  if (answers.proxies) {
    proxies = answers.proxies.split(',').map((proxy) => {
      const [username, password] = proxy.split(':');
      return { username, password };
    });
  }

  await startAutomation(answers.query, answers.windows, answers.useProxies, proxies, answers.filter, answers.channelName);
})();
