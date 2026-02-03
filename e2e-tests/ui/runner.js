const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const htmlPath = path.join(__dirname, 'ui-test.html');
const html = fs.readFileSync(htmlPath, 'utf8');

const dom = new JSDOM(html, {
  runScripts: 'dangerously',
  resources: 'usable',
  url: 'http://localhost/',
});

const { window } = dom;

// Wait for tests to finish
const checkInterval = setInterval(() => {
  if (window.__TEST_RESULTS__) {
    clearInterval(checkInterval);
    const results = window.__TEST_RESULTS__;
    console.log('UI Test Results:');
    console.log(`Passed: ${results.passed}, Failed: ${results.failed}`);

    if (results.failed > 0) {
      process.exit(1);
    } else {
      process.exit(0);
    }
  }
}, 100);

// Timeout
setTimeout(() => {
  console.error('Timeout waiting for UI tests');
  process.exit(1);
}, 5000);
