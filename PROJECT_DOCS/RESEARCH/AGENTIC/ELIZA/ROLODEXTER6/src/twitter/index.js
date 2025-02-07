import dotenv from 'dotenv';
import inquirer from 'inquirer';
import puppeteer from 'puppeteer';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import path from 'path';  // Add this import
import fs from 'fs/promises';  // Add this for mkdir
import { format } from 'date-fns';  // Add this for timestamp formatting
import DataOrganizer from './DataOrganizer.js';
import chalk from 'chalk';
import OpenRouterClient from './OpenRouterClient.js';
dotenv.config();

import TwitterPipeline from './TwitterPipeline.js';
import Logger from './Logger.js';
import { loginToTwitter } from './Login.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Add error directory path
const ERROR_DIR = path.join(process.cwd(), 'errors');

// Add function to ensure error directory exists
async function ensureErrorDir() {
  try {
    await fs.mkdir(ERROR_DIR, { recursive: true });
  } catch (error) {
    Logger.warn(`Could not create errors directory: ${error.message}`);
  }
}

async function saveErrorScreenshot(page, prefix = 'error') {
  try {
    await ensureErrorDir();
    const timestamp = format(new Date(), 'yyyyMMdd-HHmmss');
    const filename = path.join(ERROR_DIR, `${prefix}-${timestamp}.png`);
    await page.screenshot({ 
      path: filename,
      fullPage: true 
    });
    Logger.info(`Error screenshot saved to ${filename}`);
  } catch (error) {
    Logger.warn(`Could not save error screenshot: ${error.message}`);
  }
}

let currentMode = 'manual';
let browser = null;
let page = null;

process.on('unhandledRejection', (error) => {
  Logger.error(`❌ Unhandled promise rejection: ${error.message}`);
  process.exit(1);
});

process.on('uncaughtException', (error) => {
  Logger.error(`❌ Uncaught exception: ${error.message}`);
  process.exit(1);
});

// Use a dummy username since we're not filtering by user
const username = 'global_search';
const pipeline = new TwitterPipeline(username);

// Simplify the pipeline to use a single filtering pass
pipeline.filterTweets = (tweets) => {
  const LIMIT = 1000;
  return tweets
    .filter(tweet => {
      if (!tweet?.text) return false;
      const text = tweet.text.toLowerCase();
      return text.includes('rolodexter') || text.includes('rolodexterai');
    })
    .slice(0, LIMIT); // Ensure we never return more than limit
};

// Update cleanup function to only run on explicit termination
const cleanup = async () => {
  Logger.warn('\n🛑 Received termination signal. Cleaning up...');
  try {
    if (browser && browser.isConnected()) {
      await browser.close();
      Logger.success('🔒 Browser closed.');
    }
    process.exit(0);
  } catch (error) {
    Logger.error(`❌ Error during cleanup: ${error.message}`);
    process.exit(1);
  }
};

// Only attach cleanup to SIGINT (Ctrl+C) and SIGTERM
process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);

// Helper function for delays
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function extractTweets(page) {
  Logger.info('Extracting tweets from page...');
  
  const tweets = await page.evaluate(() => {
    const articles = Array.from(document.querySelectorAll('article[data-testid="tweet"]'));
    console.log(`Found ${articles.length} tweet articles`); // Debug log
    
    return articles.map(article => {
      const tweet = {
        text: article.querySelector('[data-testid="tweetText"]')?.innerText || '',
        username: article.querySelector('[data-testid="User-Name"]')?.innerText.split('\n')[0] || '',
        timestamp: article.querySelector('time')?.dateTime || null,
        likes: parseInt(article.querySelector('[data-testid="like"]')?.innerText || '0'),
        retweets: parseInt(article.querySelector('[data-testid="retweet"]')?.innerText || '0'),
        permanentUrl: article.querySelector('time')?.parentElement?.href || ''
      };
      
      // Debug log each tweet
      console.log('Tweet found:', tweet);
      return tweet;
    });
  });
  
  const validTweets = tweets.filter(t => t.text && t.username);
  Logger.info(`Found ${validTweets.length} valid tweets out of ${tweets.length} total`);
  return validTweets;
}

async function displayTweets(tweets, topic) {
  // Force console output
  console.log('\n\n');  // Add extra spacing for visibility
  console.log('='.repeat(100));
  console.log(`SEARCH RESULTS: ${topic}`);
  console.log('='.repeat(100));
  
  // Log tweet count immediately
  console.log(`\nFound ${tweets.length} tweets at ${new Date().toLocaleTimeString()}`);
  
  if (tweets.length === 0) {
    console.log('\nNo tweets found');
    return;
  }

  // Log first 10 tweets with clear separation
  const displayTweets = tweets.slice(0, 10);
  
  displayTweets.forEach((tweet, i) => {
    console.log('\n' + '-'.repeat(50));
    console.log(`\nTWEET ${i + 1} of 10:`);
    console.log(`From: @${tweet.username}`);
    console.log(`\nContent: ${tweet.text}`);
    console.log(`\nStats: ❤️ ${tweet.likes || 0} · 🔄 ${tweet.retweets || 0}`);
    console.log(`URL: ${tweet.permanentUrl}`);
    console.log('\n' + '-'.repeat(50));
  });

  // Show next step
  console.log('\nPausing for 10 seconds to read...\n');
  
  // Force immediate console flush
  await new Promise(resolve => setTimeout(resolve, 100));
}

async function performSearch(page, searchUrl) {
  try {
    Logger.info(`🔍 Navigating to Twitter search URL: ${searchUrl}`);
    
    // First try with domcontentloaded
    await page.goto(searchUrl, { 
      waitUntil: 'domcontentloaded',
      timeout: 120000 
    });

    // Wait and check for tweets with extended timeout
    Logger.info('Waiting for tweets to load...');
    await page.waitForSelector('article[data-testid="tweet"]', {
      visible: true,
      timeout: 60000
    });

    // Scroll to load more tweets
    Logger.info('Scrolling to load more tweets...');
    for (let i = 0; i < 5; i++) {
      await page.evaluate(() => {
        window.scrollBy(0, 1000);
        return document.body.scrollHeight;
      });
      await delay(2000);
    }

    // Extract tweets
    const tweets = await extractTweets(page);
    
    if (tweets.length > 0) {
      Logger.success(`Found ${tweets.length} tweets`);
      // Log each tweet for debugging
      tweets.forEach((tweet, i) => {
        Logger.debug(`Tweet ${i + 1}: ${tweet.text.slice(0, 100)}...`);
      });
      return tweets;
    } else {
      Logger.warn('No tweets found after scrolling');
      throw new Error('No tweets found');
    }

  } catch (error) {
    Logger.error(`Search failed: ${error.message}`);
    await saveErrorScreenshot(page, 'search-error');
    throw error;
  }
}

async function displaySearchResults(tweets, topic, url) {
  // Add visual separation without clearing
  console.log('\n' + '='.repeat(100));
  console.log(chalk.bgBlue.white(` 🔍 SEARCH RESULTS: ${topic} `));
  console.log('='.repeat(100) + '\n');
  
  Logger.info(`Search URL: ${url}`);
  Logger.info(`Time: ${new Date().toLocaleTimeString()}`);
  Logger.success(`Found ${tweets.length} tweets\n`);

  if (tweets.length === 0) {
    Logger.warn('No tweets found in this search');
    return;
  }

  // Display top 10 tweets with better formatting
  tweets.slice(0, 10).forEach((tweet, i) => {
    console.log(chalk.black.bgYellow(` Tweet ${i + 1}/10 `));
    console.log(chalk.cyan(`@${tweet.username}`));
    console.log(chalk.white(`\n${tweet.text.trim()}\n`));
    
    // Stats line
    const stats = [];
    if (tweet.likes) stats.push(`❤️  ${tweet.likes}`);
    if (tweet.retweets) stats.push(`🔄 ${tweet.retweets}`);
    if (stats.length > 0) {
      console.log(chalk.gray(stats.join('  ')));
    }
    
    // URL
    if (tweet.permanentUrl) {
      console.log(chalk.blue(`🔗 ${tweet.permanentUrl}`));
    }
    
    console.log('\n' + '-'.repeat(80) + '\n');
  });

  console.log('End of search results for ' + chalk.yellow(topic) + '\n');
}

async function handleTweetResponse(tweets, topic) {
  if (tweets.length === 0) {
    Logger.warn('No tweets to respond to');
    return;
  }

  try {
    // Pick a random tweet that isn't from our own account
    const validTweets = tweets.filter(t => 
      !t.username.toLowerCase().includes('rolodexter') && 
      !t.text.toLowerCase().includes('@rolodexter')
    );

    if (validTweets.length === 0) {
      Logger.warn('No suitable tweets found for response');
      return;
    }

    const randomTweet = validTweets[Math.floor(Math.random() * validTweets.length)];
    Logger.info(`Selected tweet from @${randomTweet.username} for response`);
    
    // Generate response
    const openRouter = new OpenRouterClient();
    const response = await openRouter.generateResponse(randomTweet);
    
    if (!response || response.startsWith('🤖')) {
      Logger.error('Failed to generate valid response - skipping tweet');
      return; // Don't post if we got an error response
    }

    // Only proceed with posting if we got a valid response
    Logger.success(`Generated response: ${response}`);
    await postReplyToBrowser(page, randomTweet.permanentUrl, response);

  } catch (error) {
    Logger.error(`Failed to handle tweet response: ${error.message}`);
  }
}

async function postReplyToBrowser(page, tweetUrl, replyText) {
  try {
    Logger.info(`Navigating to tweet: ${tweetUrl}`);
    
    // Try multiple times to load the tweet page with different strategies
    let retryCount = 0;
    const maxRetries = 3;
    let pageLoaded = false;
    
    while (retryCount < maxRetries && !pageLoaded) {
      try {
        // Try different wait strategies on each attempt
        if (retryCount === 0) {
          await page.goto(tweetUrl, { 
            waitUntil: 'domcontentloaded',
            timeout: 20000
          });
        } else if (retryCount === 1) {
          await page.goto(tweetUrl, { 
            waitUntil: 'networkidle0',
            timeout: 30000
          });
        } else {
          // Final attempt: reload the page
          await page.reload({ 
            waitUntil: 'networkidle2',
            timeout: 40000
          });
        }
        
        // Wait for either reply button or error state
        const result = await Promise.race([
          page.waitForSelector('[data-testid="reply"]', { visible: true, timeout: 10000 }),
          page.waitForSelector('[data-testid="error-detail"]', { visible: true, timeout: 10000 })
        ]);

        // Check if we got an error page
        const isErrorPage = await page.$('[data-testid="error-detail"]');
        if (isErrorPage) {
          throw new Error('Tweet not found or inaccessible');
        }

        pageLoaded = true;
        Logger.info('Tweet page loaded successfully');
        
      } catch (error) {
        retryCount++;
        if (retryCount >= maxRetries) throw error;
        Logger.warn(`Navigation attempt ${retryCount} failed: ${error.message}`);
        await delay(5000 * retryCount);
      }
    }

    // Type reply text directly with increased initial delay
    Logger.info(`Typing reply: ${replyText}`);
    await delay(2000);
    await page.keyboard.type(replyText, { delay: 100 });
    await delay(2000);

    // Post reply
    Logger.info('Posting reply...');
    await page.keyboard.down('Control');
    await page.keyboard.press('Enter');
    await page.keyboard.up('Control');
    await delay(5000);

    // Rest of verification code...
    const postedText = await page.evaluate(() => {
      const tweets = document.querySelectorAll('[data-testid="tweet"]');
      return Array.from(tweets).map(t => t.textContent).join('\n');
    });

    if (postedText.includes(replyText)) {
      Logger.success('Reply posted successfully');
      return true;
    }
    Logger.warn('Reply verification failed');
    return false;

  } catch (error) {
    Logger.error(`Reply failed: ${error.message}`);
    await saveErrorScreenshot(page, 'reply-error');
    return false;
  }
}

async function runContinuousMonitoring(page) {
  Logger.info('📝 Starting continuous Twitter monitoring...');
  
  // Expanded search topics with new additions
  const searches = [
    { topic: 'BLOCKCHAIN', url: 'https://x.com/search?q=blockchain&src=typed_query&f=live' },
    { topic: 'AI', url: 'https://x.com/search?q=artificial%20intelligence&src=recent_search_click&f=live' },
    { topic: 'BRAND', url: 'https://x.com/search?q=rolodexter&src=typed_query&f=live' },
    { topic: 'MENTIONS', url: 'https://x.com/search?q=to%3A%40rolodexter6%20-joemaristela&src=typed_query&f=live' },
    { 
      topic: 'TRUMP', 
      url: 'https://x.com/search?q=Donald%20Trump&src=typed_query&f=live' 
    },
    { 
      topic: 'AI-COMPANIES', 
      url: 'https://x.com/search?q=Google%20or%20OpenAI%20or%20ChatGPT%20or%20Anthropic%20or%20DeepSeek&src=typed_query&f=live'
    },
    { topic: 'SOLANA', url: 'https://x.com/search?q=solana&src=typed_query&f=live' },
    { topic: 'BITCOIN', url: 'https://x.com/search?q=bitcoin&src=typed_query&f=live' },
    { topic: 'ELON', url: 'https://x.com/search?q=from%3Aelonmusk&src=typed_query&f=live' },
    { topic: 'LIST', url: 'https://x.com/i/lists/1748291281107992904' },
    { topic: 'AI-TRENDS', url: 'https://x.com/search?q=AI&src=typed_query&f=live' },
    { topic: 'WEB3', url: 'https://x.com/search?q=web3&src=typed_query&f=live' },
    { topic: 'CRYPTO', url: 'https://x.com/search?q=cryptocurrency&src=typed_query&f=live' },
    { topic: 'TECH', url: 'https://x.com/search?q=technology&src=typed_query&f=live' },
    { topic: 'FINTECH', url: 'https://x.com/search?q=fintech&src=typed_query&f=live' }
  ];

  // Start with a random topic
  let currentIndex = Math.floor(Math.random() * searches.length);
  Logger.info(`Starting random monitoring from: ${searches[currentIndex].topic}`);

  while (true) {
    try {
      // Instead of random selection, use rotating index
      const { topic, url } = searches[currentIndex];
      Logger.info(`\n🔍 Starting search for: ${topic}`);

      let retryCount = 0;
      let tweets = [];
      
      while (retryCount < 3) {
        try {
          tweets = await performSearch(page, url);
          if (tweets.length > 0) break;
          
          retryCount++;
          Logger.warn(`Attempt ${retryCount} failed, retrying...`);
          await delay(10000 * retryCount);
        } catch (searchError) {
          Logger.error(`Search attempt ${retryCount + 1} failed:`, searchError);
          if (retryCount >= 2) throw searchError;
          retryCount++;
          await delay(15000 * retryCount);
        }
      }

      if (tweets.length > 0) {
        await displayTweets(tweets, topic);
        
        // Handle automated response
        await handleTweetResponse(tweets, topic);
        
        // Save in background
        const dataOrganizer = new DataOrganizer('pipeline', 'global_search');
        await dataOrganizer.saveTweets(tweets);
      } else {
        console.log(`No tweets found for ${topic}`);
      }

      // Show next search info
      const nextIndex = (currentIndex + 1) % searches.length;
      const nextSearch = searches[nextIndex];
      console.log(`\nNext search will be: ${nextSearch.topic}`);
      
      // Update index for next iteration
      currentIndex = nextIndex;
      
      // Add delay
      const delayTime = 30000 + Math.floor(Math.random() * 60000);
      Logger.info(`Waiting ${Math.floor(delayTime/1000)}s before next search...`);
      await delay(delayTime);

    } catch (error) {
      Logger.error('Monitoring error:', error);
      await delay(60000);
    }
  }
}

async function main() {
  try {
    console.clear(); // Clear console at start
    console.log(chalk.blue.bold('\n🤖 Twitter Monitoring Tool\n'));
    
    const { runContinuous } = await inquirer.prompt([{
      type: 'confirm',
      name: 'runContinuous',
      message: 'Do you want to run in continuous monitoring mode?',
      default: false
    }]);

    Logger.info('Initializing browser session...');
    
    // Get browser and page from login with better error handling
    let result;
    try {
      result = await loginToTwitter();
      browser = result.browser;
      page = result.page;
    } catch (error) {
      Logger.error('Failed to initialize browser:', error);
      throw error;
    }

    if (!browser || !page) {
      throw new Error('Browser or page not initialized properly');
    }

    // Verify we're logged in
    try {
      await page.waitForSelector('div[data-testid="primaryColumn"]', { timeout: 10000 });
      Logger.success('Twitter login verified');
    } catch (error) {
      Logger.error('Login verification failed:', error);
      throw new Error('Could not verify login status');
    }

    if (runContinuous) {
      Logger.info('📝 Starting persistent Twitter monitoring session...');
      await runContinuousMonitoring(page);
    } else {
      // Handle single-run mode if needed
      Logger.info('Running in single-pass mode...');
      // Add your single-run logic here
    }

  } catch (error) {
    Logger.error('❌ Pipeline failed:', error);
    if (page) {
      await saveErrorScreenshot(page, 'pipeline-error');
    }
    if (error.message.includes('Could not verify successful login')) {
      Logger.warn('Please check the browser window and try again if needed.');
      return;
    }
    await cleanup();
  }
}

main().catch(error => {
  Logger.error('❌ Fatal error:', error);
  process.exit(1);
});
