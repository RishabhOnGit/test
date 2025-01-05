const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

// Create a readline interface for user input
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

// Function to get user input for the number of profiles to open
function askForProfiles() {
  return new Promise((resolve) => {
    rl.question('How many profiles would you like to open? ', (numProfiles) => {
      resolve(parseInt(numProfiles));
      rl.close();
    });
  });
}

// Define the base path for Chrome profiles
const basePath = 'C://Users//risha//AppData//Local//Google//Chrome//User Data'; // Update the base path for Chrome

// Function to save cookies for a specific profile
async function saveCookies(profileNumber) {
  const profileName = `Profile ${profileNumber}`;
  const profilePath = `${basePath}\\${profileName}`;

  // Ensure the "cookies" directory exists
  const cookiesDir = path.join(__dirname, 'cookies');
  if (!fs.existsSync(cookiesDir)) {
    fs.mkdirSync(cookiesDir);
  }

  const cookieFile = path.join(cookiesDir, `profile${profileNumber}_cookies.json`);

  try {
    console.log(`Launching Chrome for: ${profileName}`);

    const browser = await puppeteer.launch({
      headless: false,
      executablePath: 'C://Program Files//Google//Chrome//Application//chrome.exe', // Path to Chrome executable
      args: [
        `--user-data-dir=${basePath}`,
        `--profile-directory=${profileName}`,
      ],
    });

    const page = await browser.newPage();
    await page.goto('https://www.youtube.com', { waitUntil: 'domcontentloaded' });

    console.log(`Fetching cookies for: ${profileName}`);
    const cookies = await page.cookies();

    // Save cookies to file in the "cookies" folder
    fs.writeFileSync(cookieFile, JSON.stringify(cookies, null, 2));
    console.log(`Cookies saved for: ${profileName} at ${cookieFile}`);

    await browser.close();
  } catch (error) {
    console.error(`Error saving cookies for ${profileName}:`, error.message);
  }
}

(async () => {
  const numProfiles = await askForProfiles(); // Ask how many profiles the user wants to open

  // Loop through the requested number of profiles and save cookies for each one
  for (let i = 1; i <= numProfiles; i++) {
    await saveCookies(i);
  }

  console.log('Cookies saved for all profiles.');
})();
