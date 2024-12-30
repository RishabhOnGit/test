const puppeteer = require('puppeteer');
const inquirer = require('inquirer');
const fs = require('fs');

// Function to read proxies from a file
function readProxiesFromFile(filePath) {
  try {
    const proxyData = fs.readFileSync(filePath, 'utf8');
    const proxies = proxyData.split('\n').map((line, index) => {
      if (!line.trim()) return null;

      const [credentials, ipPort] = line.split('@');
      if (!credentials || !ipPort) {
        console.error(`Invalid proxy format at line ${index + 1}: ${line}`);
        return null;
      }

      const [username, password] = credentials.split(':');
      const [ip, port] = ipPort.split(':');

      if (!username || !password || !ip || !port) {
        console.error(`Invalid proxy format at line ${index + 1}: ${line}`);
        return null;
      }

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
async function startAutomation(query, windows, useProxies, proxies, filter, channelName, headless) {
  const filterMap = {
    'Last hour': '&sp=EgIIAQ%253D%253D',
    'Today': '&sp=EgIIAg%253D%253D',
    'This week': '&sp=EgIIAw%253D%253D'
  };

  const filterParam = filterMap[filter] || '';
  const browserPromises = [];
  const usableProxies = useProxies ? proxies.slice(0, windows) : proxies;

  for (let i = 0; i < windows; i++) {
    const proxy = useProxies ? usableProxies[i % usableProxies.length] : null;
    browserPromises.push(
      openWindow(i, query, filterParam, useProxies, proxy, channelName, headless)
    );
  }

  await Promise.allSettled(browserPromises);
}

// Function to open a single browser window
async function openWindow(i, query, filterParam, useProxies, proxy, channelName, headless) {
  try {
    const browser = await puppeteer.launch({
      executablePath: '/usr/bin/chromium-browser', // Custom Chromium path for Ubuntu
      headless: headless,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-accelerated-2d-canvas',
        '--disable-gpu',
        '--disable-infobars',
        '--window-size=800,600',
        ...(proxy ? [`--proxy-server=http://${proxy.ip}:${proxy.port}`] : []),
      ],
    });

    const page = await browser.newPage();

    if (useProxies && proxy) {
      await page.authenticate({
        username: proxy.username,
        password: proxy.password,
      });
    }

    const searchUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}${filterParam}`;
    console.log(`Window ${i + 1}: Navigating to: ${searchUrl}`);
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
        console.log(`Window ${i + 1}: Found video: ${matchedVideo.title} by ${matchedVideo.channel}`);
      }
    }

    if (!matchedVideo && channelName) {
      console.log(`Window ${i + 1}: No video found from channel "${channelName}". Closing the window.`);
      await browser.close();
      return;
    }

    if (!matchedVideo && !channelName) {
      matchedVideo = videos[0];
      console.log(`Window ${i + 1}: No channel filter provided. Selecting the first video.`);
    }

    if (matchedVideo) {
      await page.goto(matchedVideo.link);
      await page.waitForSelector('video');
      console.log(`Window ${i + 1} is playing: ${matchedVideo.title} by ${matchedVideo.channel}`);
    }

    showPlayingTime(page, i + 1);
  } catch (error) {
    console.error(`Window ${i + 1} encountered an error: ${error.message}`);
  }
}

// Function to show the playing time of the video
async function showPlayingTime(page, windowNumber, interval = 2000) {
  await ensureVideoIsPlaying(page);

  console.log(`Playing time updates for Window ${windowNumber}:`);
  let isPlaying = true;

  while (isPlaying) {
    const playbackStatus = await page.evaluate(() => {
      const video = document.querySelector('video');
      if (video) {
        return {
          currentTime: video.currentTime,
          duration: video.duration,
          paused: video.paused,
          readyState: video.readyState,
        };
      }
      return null;
    });

    if (playbackStatus) {
      const { currentTime, duration, paused, readyState } = playbackStatus;

      if (readyState < 3) {
        console.log(`Window ${windowNumber}: Video is buffering or not ready yet...`);
      } else {
        console.log(
          `Window ${windowNumber}: Current Time: ${currentTime.toFixed(2)}s / ${duration.toFixed(
            2
          )}s ${paused ? '(Paused)' : '(Playing)'}`
        );
      }

      if (currentTime >= duration) {
        isPlaying = false;
        console.log(`Window ${windowNumber}: Playback has ended.`);
      }
    } else {
      console.log(`Window ${windowNumber}: Video element not found.`);
      isPlaying = false;
    }

    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}

// Function to ensure the video is playing and resumes if paused
async function ensureVideoIsPlaying(page) {
  await page.evaluate(() => {
    const video = document.querySelector('video');
    if (video) {
      setInterval(() => {
        if (video.paused) {
          console.log('Video is paused. Resuming playback...');
          video.play();
        }
      }, 1000);
    }
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
      name: 'proxyFilePath',
      message: 'Enter the path of the proxy file (e.g., ./proxies.txt):',
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
      message: 'Do you want to use headless mode? (No UI)',
      default: true,
    },
  ]);

  let proxies = [];
  if (answers.useProxies && answers.proxyFilePath) {
    proxies = readProxiesFromFile(answers.proxyFilePath);
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
