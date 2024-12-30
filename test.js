const puppeteer = require('puppeteer');
const inquirer = require('inquirer');

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

    // Continuously update playback time in terminal
    await trackVideoPlayback(page);
  }
}

// Function to track video playback and log in the terminal
async function trackVideoPlayback(page) {
  const intervalId = setInterval(async () => {
    const playbackTime = await page.evaluate(() => {
      const video = document.querySelector('video');
      if (!video) return null;

      const formatTime = (time) => {
        const minutes = Math.floor(time / 60);
        const seconds = Math.floor(time % 60).toString().padStart(2, '0');
        return `${minutes}:${seconds}`;
      };

      return {
        currentTime: formatTime(video.currentTime),
        duration: formatTime(video.duration),
      };
    });

    if (playbackTime) {
      console.clear(); // Clear the terminal for live updates
      console.log(`Playback Time: ${playbackTime.currentTime} / ${playbackTime.duration}`);
    } else {
      console.log('Video not found or not playing.');
    }
  }, 1000); // Update every second

  // Stop tracking when video ends
  page.on('close', () => {
    clearInterval(intervalId);
  });
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
    {
      type: 'confirm',
      name: 'headless',
      message: 'Do you want to run the browser in headless mode?',
      default: false,
    },
  ]);

  let proxies = [];
  if (answers.proxies) {
    proxies = answers.proxies.split(',').map((proxy) => {
      const [username, password] = proxy.split(':');
      return { username, password };
    });
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
