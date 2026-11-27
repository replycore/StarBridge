const fs = require('fs');
const puppeteer = require('puppeteer-core');
const vars = {};
for (const line of fs.readFileSync('/home/hatch/workspace/StarBridge/.dev.vars','utf8').split('\n')) {
  const m = line.match(/^([A-Z_]+)=(.*)$/); if (m) vars[m[1]] = m[2].trim();
}
const ADMIN = vars.ADMIN_TOKEN;
const URL = 'http://127.0.0.1:8788/';
const SHOTS = '/home/hatch/workspace/StarBridge/test-shots';
let passed = 0, failed = 0;
function check(name, cond, extra='') { if (cond) { passed++; console.log('PASS', name); } else { failed++; console.log('FAIL', name, extra); } }
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  const browser = await puppeteer.launch({ executablePath: '/home/hatch/.cache/puppeteer/chrome/linux-157.0.8103.50/chrome-linux64/chrome', args: ['--no-sandbox','--disable-dev-shm-usage'] });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error' && !/401 \(Unauthorized\)/.test(m.text())) errors.push('console: ' + m.text()); }); // the deliberate wrong-token login logs one 401 resource error; that is expected
  await page.setViewport({ width: 1440, height: 900 });
  await page.goto(URL, { waitUntil: 'networkidle2', timeout: 30000 });
  await page.waitForSelector('#loginView', { visible: true, timeout: 10000 });
  check('login view visible', true);
  // wrong token first: UI should show an error and stay on login (this also
  // exercises the new throttle's 401 path; the success below clears it)
  await page.type('#loginToken', 'definitely-wrong-token');
  await page.click('#loginForm button[type="submit"]');
  await sleep(1200);
  const errText = await page.$eval('#loginErr', el => el.textContent.trim());
  const stillLogin = await page.$eval('#loginView', el => getComputedStyle(el).display !== 'none');
  check('wrong token shows login error and stays logged out', stillLogin && errText.length > 0, 'err="' + errText + '"');
  // correct login
  await page.$eval('#loginToken', el => { el.value = ''; });
  await page.type('#loginToken', ADMIN);
  await page.click('#loginForm button[type="submit"]');
  await page.waitForFunction(() => {
    const lv = document.querySelector('#loginView');
    return lv && getComputedStyle(lv).display === 'none';
  }, { timeout: 10000 });
  check('correct token logs in', true);
  await sleep(1500);
  const title = await page.$eval('#pageTitle', el => el.textContent.trim());
  check('lands on overview tab', title === '总览', 'title=' + title);
  const cardsText = await page.$eval('#cards', el => el.textContent);
  check('overview cards show local data (2 providers)', /服务商/.test(cardsText) && /2/.test(cardsText), cardsText.slice(0,120));
  await page.screenshot({ path: SHOTS + '/breaker-desktop-overview.png' });
  const tabs = [ ['access','调用接入'], ['providers','服务商'], ['groups','映射组'], ['models','模型目录'], ['usage','用量与记录'], ['overview','总览'] ];
  for (const [tab, expectTitle] of tabs) {
    await page.click(`#mainNav a[data-tab="${tab}"]`);
    await sleep(900);
    const t = await page.$eval('#pageTitle', el => el.textContent.trim());
    const hash = await page.evaluate(() => location.hash);
    const visible = await page.$eval('#page-' + tab, el => getComputedStyle(el).display !== 'none');
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
    check(`tab ${tab}: title/hash/visible/no-overflow`, t === expectTitle && hash === '#' + tab && visible && !overflow, `title=${t} hash=${hash} visible=${visible} overflow=${overflow}`);
    if (tab === 'providers') {
      const txt = await page.$eval('#page-providers', el => el.textContent);
      check('providers tab lists mock aaa and bbb', txt.includes('aaa') && txt.includes('bbb'));
      await page.screenshot({ path: SHOTS + '/breaker-desktop-providers.png' });
    }
    if (tab === 'models') {
      const txt = await page.$eval('#page-models', el => el.textContent);
      check('models tab lists mock-shared-1', txt.includes('mock-shared-1'));
    }
  }
  // mobile viewport
  await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
  await sleep(800);
  const tabbarVisible = await page.$eval('#tabbar', el => getComputedStyle(el).display === 'flex');
  check('mobile: bottom tab bar visible', tabbarVisible);
  await page.click('#tabbar a[data-tab="providers"]');
  await sleep(900);
  const mTitle = await page.$eval('#pageTitle', el => el.textContent.trim());
  const mOverflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  check('mobile: tap tab bar switches to providers, no overflow', mTitle === '服务商' && !mOverflow, `title=${mTitle} overflow=${mOverflow}`);
  await page.screenshot({ path: SHOTS + '/breaker-mobile-providers.png' });
  check('no JS errors during whole run', errors.length === 0, errors.join(' | ').slice(0, 400));
  await browser.close();
  console.log(`\nRESULT: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('ERROR', e); process.exit(2); });
