const CDP = require('chrome-remote-interface');
(async () => {
  const t = await CDP.New({ port: 9224, url: 'https://example.com' });
  await new Promise((r) => setTimeout(r, 2500));
  const c = await CDP({ port: 9224, target: t.id });
  await c.Runtime.enable();
  const r = await c.Runtime.evaluate({
    expression: `({ LanguageModel: typeof LanguageModel, windowAi: typeof window.ai, secure: window.isSecureContext })`,
    returnByValue: true,
  });
  console.log('on https page:', JSON.stringify(r.result.value));
  await CDP.Close({ port: 9224, id: t.id });
  await c.close();
})().catch((e) => console.error(e.message));
