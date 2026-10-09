// usage: node render.js stills 1.2 3.5 ...   |   node render.js video out.mp4 [fps]
const { chromium } = require('playwright-core');
const { spawn } = require('child_process');
const path = require('path');
const os = require('os');

const EXE = path.join(os.homedir(), 'Library/Caches/ms-playwright/chromium-1134/chrome-mac/Chromium.app/Contents/MacOS/Chromium');

(async () => {
  const [mode, ...rest] = process.argv.slice(2);
  const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: false, args: ['--headless=new', '--force-color-profile=srgb', '--font-render-hinting=none'] });
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  page.on('console', m => console.log('[page]', m.text()));
  page.on('pageerror', e => console.log('[pageerror]', e.message));
  await page.goto('file://' + path.join(__dirname, 'index.html'));
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 30000 });

  if (mode === 'stills') {
    for (const ts of rest) {
      await page.evaluate(t => window.render(t), +ts);
      await page.screenshot({ path: path.join(__dirname, 'stills', `t${(+ts).toFixed(2)}.png`) });
    }
  } else {
    const out = rest[0] || 'out.mp4', fps = +(rest[1] || 60), N = Math.round(30 * fps);
    const ff = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(fps), '-c:v', 'mjpeg', '-i', '-',
      '-c:v', 'libx264', '-preset', 'slow', '-crf', process.env.CRF || '15', '-pix_fmt', 'yuv420p', '-tune', 'animation', '-movflags', '+faststart', out], { stdio: ['pipe', 'inherit', 'inherit'] });
    const t0 = Date.now();
    for (let i = 0; i < N; i++) {
      await page.evaluate(t => window.render(t), i / fps);
      const buf = await page.screenshot({ type: 'jpeg', quality: 96 });
      if (!ff.stdin.write(buf)) await new Promise(r => ff.stdin.once('drain', r));
      if (i % 120 === 0) console.log(`frame ${i}/${N}  ${((Date.now() - t0) / 1000).toFixed(0)}s`);
    }
    ff.stdin.end();
    await new Promise(r => ff.on('close', r));
    console.log('done', out);
  }
  await browser.close();
})();
