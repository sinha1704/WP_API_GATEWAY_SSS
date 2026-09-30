import { chromium } from 'playwright';

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 850 } });

  console.log('▶ [Step 1] Navigating to http://localhost:3000 ...');
  await page.goto('http://localhost:3000');
  await page.waitForTimeout(2000);

  console.log('▶ [Step 2] Using Quick Add on the left sidebar...');
  // Fill quick-new-session-id input
  await page.fill('#quick-new-session-id', 'session-2');
  console.log('   Filled #quick-new-session-id with "session-2"');
  
  // Click "+ Add & Scan"
  await page.click('button:has-text("+ Add & Scan")');
  console.log('   Clicked "+ Add & Scan" button');

  // Wait 4 seconds for backend to start session-2 and generate QR
  console.log('⏳ Waiting 4 seconds for session-2 QR Code to generate...');
  await page.waitForTimeout(4000);

  // Take screenshot of the QR Code generated on the screen
  await page.screenshot({ path: 'scratch_step_session2_success.png' });
  console.log('✔ Screenshot saved: scratch_step_session2_success.png');

  // Check the sidebar accounts and active session status
  const activeNode = await page.locator('#tbl-session-id').innerText();
  const activeStatus = await page.locator('#active-status-lbl').innerText();
  const sessionList = await page.locator('#session-list-box').innerText();

  console.log('\n========================================');
  console.log('ACTIVE NODE IN UI:', activeNode);
  console.log('ACTIVE STATUS:', activeStatus);
  console.log('ACCOUNTS LIST IN SIDEBAR:\n' + sessionList);
  console.log('========================================\n');

  await browser.close();
  console.log('🎉 PLAYWRIGHT MULTI-SESSION ADD TEST COMPLETED SUCCESSFULLY!');
})();
