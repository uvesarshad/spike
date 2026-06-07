/* Capture real screenshots of the spike's good/bad pages to PNG files (for rung-1 Gemini CLI test). */
const fs = require('fs');
const path = require('path');
const CDP = require('chrome-remote-interface');

const CDP_PORT = 9224;
const HTTP_PORT = 9334;
const OUT = path.join(__dirname, 'shots');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  for (const page of ['good', 'bad']) {
    const t = await CDP.New({ port: CDP_PORT, url: `http://localhost:${HTTP_PORT}/${page}.html` });
    await sleep(1500);
    const c = await CDP({ port: CDP_PORT, target: t.id });
    await c.Page.enable();
    await c.Page.bringToFront();
    await sleep(500);
    const shot = await c.Page.captureScreenshot({ format: 'png' });
    fs.writeFileSync(path.join(OUT, `${page}.png`), Buffer.from(shot.data, 'base64'));
    console.log(`saved shots/${page}.png (${Math.round(shot.data.length * 0.75 / 1024)} KB)`);
    await CDP.Close({ port: CDP_PORT, id: t.id });
    await c.close();
  }
  process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });
