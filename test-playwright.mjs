import { chromium } from 'playwright';

async function runE2ETests() {
  console.log('====================================================');
  console.log('🚀 STARTING PLAYWRIGHT END-TO-END GATEWAY TESTS');
  console.log('====================================================\n');

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  const baseUrl = 'http://localhost:3000';
  const apiKey = 'master_secret_key_whatsapp_gateway_2026';

  try {
    // ----------------------------------------------------
    // TEST 1: Check Home Page
    // ----------------------------------------------------
    console.log('▶ [Step 1] Visiting Home Landing Page (http://localhost:3000)...');
    await page.goto(baseUrl);
    const homeTitle = await page.title();
    console.log(`   ✔ Page Title: "${homeTitle}"`);
    const statusText = await page.locator('.badge').innerText();
    console.log(`   ✔ Gateway Badge Status: "${statusText}"\n`);

    // ----------------------------------------------------
    // TEST 2: Check QR Scanner UI Page
    // ----------------------------------------------------
    console.log('▶ [Step 2] Testing /scan QR Scanner Dashboard...');
    await page.goto(`${baseUrl}/scan`);
    const scanHeader = await page.locator('h1').innerText();
    console.log(`   ✔ Scanner Page Loaded: "${scanHeader}"`);

    // Fill session details and test status
    await page.fill('#sessionId', 'session-1');
    await page.fill('#apiKey', apiKey);
    await page.click('button:has-text("Generate QR Code")');
    await page.waitForTimeout(3000);

    const connectionBadge = await page.locator('#statusBadge').innerText();
    console.log(`   ✔ Device Connection Status on Screen: "${connectionBadge}"\n`);

    // ----------------------------------------------------
    // TEST 3: Check Swagger Documentation Page
    // ----------------------------------------------------
    console.log('▶ [Step 3] Testing Swagger UI Documentation (/docs)...');
    await page.goto(`${baseUrl}/docs`);
    await page.waitForSelector('.swagger-ui');
    const apiTitle = await page.locator('.title').innerText();
    console.log(`   ✔ Swagger Loaded: "${apiTitle.trim()}"\n`);

    // ----------------------------------------------------
    // TEST 4: Live Message Dispatch via Gateway API
    // ----------------------------------------------------
    console.log('▶ [Step 4] Testing Live WhatsApp Message Dispatch...');
    const targetPhone = '917063644658'; // Your connected WhatsApp phone
    const testMessage = `🤖 Automated Playwright Verification Test! (${new Date().toLocaleTimeString()}) - Gateway Working 100%!`;

    console.log(`   Sending message to: ${targetPhone}`);
    console.log(`   Message content: "${testMessage}"`);

    const response = await context.request.post(`${baseUrl}/api/session-1/messages/text`, {
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': apiKey,
      },
      data: {
        to: targetPhone,
        message: testMessage,
        simulatePresence: true,
      },
    });

    const resJson = await response.json();
    console.log('   Response Status:', response.status());
    console.log('   Response Body:', JSON.stringify(resJson, null, 2));

    if (resJson.success && resJson.messageId) {
      console.log('\n====================================================');
      console.log(`🎉 TEST PASSED! Message ID: ${resJson.messageId}`);
      console.log(`📱 Message successfully delivered to ${targetPhone} on WhatsApp!`);
      console.log('====================================================\n');
    } else {
      console.error('❌ Failed to dispatch message:', resJson);
    }
  } catch (error) {
    console.error('❌ Error during Playwright test:', error);
  } finally {
    await browser.close();
    console.log('Browser session closed.');
  }
}

runE2ETests();
