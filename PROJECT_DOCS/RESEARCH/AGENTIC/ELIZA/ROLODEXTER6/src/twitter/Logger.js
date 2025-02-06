import puppeteer from 'puppeteer';
import chalk from 'chalk';
import ora from 'ora';
import Table from 'cli-table3';
import { format } from 'date-fns';

class Logger {
  static spinner = null;
  static progressBar = null;
  static lastUpdate = Date.now();
  static collectionStats = {
    oldestTweet: null,
    newestTweet: null,
    rateLimitHits: 0,
    resets: 0,
    batchesWithNewTweets: 0,
    totalBatches: 0,
    startTime: Date.now(),
    tweetsPerMinute: 0,
    currentDelay: 0,
    lastResetTime: null
  };
  
  // Determine if debug logs should be shown based on an environment variable
  static isDebugEnabled = process.env.DEBUG === 'true';

  static startSpinner(text) {
    this.spinner = ora(text).start();
  }

  static stopSpinner(success = true) {
    if (this.spinner) {
      success ? this.spinner.succeed() : this.spinner.fail();
      this.spinner = null;
    }
  }

  static info(msg) {
    console.log(chalk.blue(`ℹ️  ${msg}`));
  }

  static success(msg) {
    console.log(chalk.green(`✅ ${msg}`));
  }

  static warn(msg) {
    console.log(chalk.yellow(`⚠️  ${msg}`));
  }

  static error(msg, error = null) {
    console.log(chalk.red(`❌ ${msg}`));
    if (error) {
      console.log(chalk.red('Error details:'));
      console.log(chalk.dim(error.stack || error.message || error));
    }
  }

  static logTwitterError(error, context = '') {
    const errorMap = {
      'Login failed': 'Twitter login failed. Check your credentials in .env file',
      'Rate limit': 'Hit Twitter rate limit - waiting before retry',
      'Network error': 'Network connection issue - check your internet connection',
      'Page load timeout': 'Page failed to load - Twitter may be blocking requests',
      'Element not found': 'Twitter page structure changed - update selectors'
    };

    const errorMessage = errorMap[error.message] || error.message || 'Unknown error occurred';
    this.error(`Twitter Error${context ? ` (${context})` : ''}: ${errorMessage}`, error);
    
    // Update stats
    this.collectionStats.lastError = {
      message: errorMessage,
      time: new Date(),
      context
    };
  }

  static displayErrorSummary() {
    if (this.collectionStats.lastError) {
      console.log(chalk.red('\n⚠️  Last Error:'));
      console.log(chalk.dim(`Time: ${format(this.collectionStats.lastError.time, 'HH:mm:ss')}`));
      console.log(chalk.dim(`Context: ${this.collectionStats.lastError.context}`));
      console.log(chalk.dim(`Message: ${this.collectionStats.lastError.message}`));
    }
  }

  // Add the debug method
  static debug(msg) {
    if (this.isDebugEnabled) {
      console.log(chalk.gray(`🔍 Debug: ${msg}`));
    }
  }

  static updateCollectionProgress({
    totalCollected,
    newInBatch = 0,
    batchSize = 0,
    oldestTweetDate = null,
    newestTweetDate = null,
    currentDelay = 0,
    isReset = false
  }) {
    const now = Date.now();
    
    // Update stats
    this.collectionStats.totalBatches++;
    if (newInBatch > 0) this.collectionStats.batchesWithNewTweets++;
    if (isReset) this.collectionStats.resets++;
    this.collectionStats.currentDelay = currentDelay;
    
    // Update date range
    if (oldestTweetDate) {
      this.collectionStats.oldestTweet = !this.collectionStats.oldestTweet ? 
        oldestTweetDate : 
        Math.min(this.collectionStats.oldestTweet, oldestTweetDate);
    }
    if (newestTweetDate) {
      this.collectionStats.newestTweet = !this.collectionStats.newestTweet ? 
        newestTweetDate : 
        Math.max(this.collectionStats.newestTweet, newestTweetDate);
    }

    // Calculate efficiency metrics
    const runningTime = (now - this.collectionStats.startTime) / 1000 / 60; // minutes
    this.collectionStats.tweetsPerMinute = (totalCollected / runningTime).toFixed(1);

    // Only update display every second to avoid spam
    if (now - this.lastUpdate > 1000) {
      this.displayCollectionStatus({
        totalCollected,
        newInBatch,
        batchSize,
        isReset
      });
      this.lastUpdate = now;
    }
  }

  static displayCollectionStatus({ totalCollected, newInBatch, batchSize, isReset }) {
    console.clear(); // Clear console for clean display
    
    // Display collection header
    console.log(chalk.bold.blue('\n🐦 Twitter Collection Status\n'));

    // Display current activity
    if (isReset) {
      console.log(chalk.yellow('↩️  Resetting collection position...\n'));
    }

    // Create status table
    const table = new Table({
      head: [chalk.white('Metric'), chalk.white('Value')],
      colWidths: [25, 50]
    });

    // Add current status
    table.push(
      ['Total Tweets Collected', chalk.green(totalCollected.toLocaleString())],
      ['Collection Rate', `${chalk.cyan(this.collectionStats.tweetsPerMinute)} tweets/minute`],
      ['Current Delay', `${chalk.yellow(this.collectionStats.currentDelay)}ms`],
      ['Batch Efficiency', `${chalk.cyan((this.collectionStats.batchesWithNewTweets / this.collectionStats.totalBatches * 100).toFixed(1))}%`],
      ['Position Resets', chalk.yellow(this.collectionStats.resets)],
      ['Rate Limit Hits', chalk.red(this.collectionStats.rateLimitHits)]
    );

    // Add date range if we have it
    if (this.collectionStats.oldestTweet) {
      const dateRange = `${format(this.collectionStats.oldestTweet, 'yyyy-MM-dd')} to ${format(this.collectionStats.newestTweet, 'yyyy-MM-dd')}`;
      table.push(['Date Range', chalk.cyan(dateRange)]);
    }

    // Add latest batch info
    table.push(
      ['Latest Batch', `${chalk.green(newInBatch)} new / ${chalk.blue(batchSize)} total`]
    );

    console.log(table.toString());

    // Add running time
    const runningTime = Math.floor((Date.now() - this.collectionStats.startTime) / 1000);
    console.log(chalk.dim(`\nRunning for ${Math.floor(runningTime / 60)}m ${runningTime % 60}s`));
  }

  static recordRateLimit() {
    this.collectionStats.rateLimitHits++;
    this.collectionStats.lastResetTime = Date.now();
  }

  static stats(title, data) {
    console.log(chalk.cyan(`\n📊 ${title}:`));
    const table = new Table({
      head: [chalk.white('Parameter'), chalk.white('Value')],
      colWidths: [25, 60],
    });
    Object.entries(data).forEach(([key, value]) => {
      table.push([chalk.white(key), value]);
    });
    console.log(table.toString());
  }

  static reset() {
    this.collectionStats = {
      oldestTweet: null,
      newestTweet: null,
      rateLimitHits: 0,
      resets: 0,
      batchesWithNewTweets: 0,
      totalBatches: 0,
      startTime: Date.now(),
      tweetsPerMinute: 0,
      currentDelay: 0,
      lastResetTime: null
    };
    this.lastUpdate = Date.now();
  }
}

export default Logger;

// Remove these functions as they're not needed and causing errors
// async function logError(page) {
//     await page.waitForTimeout(3000);
// }

// (async () => {
//     const browser = await puppeteer.launch();
//     const page = await browser.newPage();
//     await logError(page);
// })();
