const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');

async function takeScreenshot() {
  console.log('Launching browser...');
  const browser = await puppeteer.launch({
    headless: 'new',
    defaultViewport: {
      width: 1280,
      height: 800,
    },
  });

  try {
    console.log('Opening page...');
    const page = await browser.newPage();
    
    // Navigate to the local development server
    console.log('Navigating to gallery...');
    await page.goto('http://localhost:3000', { waitUntil: 'networkidle2' });
    
    // Wait for the gallery to load
    console.log('Waiting for gallery to load...');
    await page.waitForSelector('.gallery-container', { timeout: 5000 });
    
    // Wait a bit more for images to load
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    // Take screenshot
    console.log('Taking screenshot...');
    const screenshotPath = path.join(process.cwd(), 'public', 'screenshot.png');
    await page.screenshot({ path: screenshotPath });
    
    // Copy to root for README
    fs.copyFileSync(screenshotPath, path.join(process.cwd(), 'screenshot.png'));
    
    console.log(`Screenshot saved to ${screenshotPath} and copied to project root`);
  } catch (error) {
    console.error('Error taking screenshot:', error);
  } finally {
    await browser.close();
    console.log('Browser closed');
  }
}

takeScreenshot(); 