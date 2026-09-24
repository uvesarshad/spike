/* v160 — E5: Slack/Discord webhook payload shapes. Fetch is stubbed. */
import { ciStatusChange, notifyIfFlipped, webhookKind, webhookPayload, type StatusChange } from '../src/schedule/notify.js';

let bad = 0;
const check = (label: string, ok: boolean) => { if (!ok) bad++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`); };

const c: StatusChange = { job: 'watch', verdict: 'fail', url: 'http://x', summary: 'button missing', runId: 'r1' };
const slack = 'https://hooks.slack.com/services/T/B/X';
const discord = 'https://discord.com/api/webhooks/1/abc';

check('slack kind', webhookKind(slack) === 'slack');
check('discord kind', webhookKind(discord) === 'discord' && webhookKind('https://discordapp.com/api/webhooks/1/a') === 'discord');
check('other is generic', webhookKind('https://example.com/hook') === 'generic' && webhookKind('nonsense') === 'generic');

const sp = webhookPayload(slack, c) as { text: string; attachments: { color: string; text: string }[] };
check('slack has text + red attachment', sp.text.includes('watch') && sp.attachments[0].color === '#d93025' && sp.attachments[0].text.includes('button missing'));
const dp = webhookPayload(discord, { ...c, verdict: 'pass' }) as { content: string; embeds: { color: number; description: string }[] };
check('discord embed green on pass', dp.embeds[0].color === 0x188038 && dp.embeds[0].description.includes('http://x') && dp.content.length > 0);
check('generic keeps the raw object', webhookPayload('https://example.com/h', c) === c);
check('long summary is capped for discord', ((webhookPayload(discord, { ...c, summary: 'x'.repeat(9000) }) as { embeds: { description: string }[] }).embeds[0].description.length) <= 3900);

const ci = ciStatusChange({ url: 'u', verdict: 'fail', suite: { summary: '1/2 passed.' }, check: { summary: '3 pages' } });
check('ci change joins summaries', ci.job === 'ci' && ci.summary === '1/2 passed. 3 pages');
check('ci error wins', ciStatusChange({ url: 'u', verdict: 'uncertain', error: 'never came up' }).summary === 'never came up');

(async () => {
  const sent: { url: string; body: string }[] = [];
  const fetchFn = async (url: string, init: { body: string }) => { sent.push({ url, body: init.body }); };
  const fired = await notifyIfFlipped('pass', c, slack, { desktop: false, fetchFn });
  check('flip posts slack-shaped body', fired && sent.length === 1 && JSON.parse(sent[0].body).attachments);
  await notifyIfFlipped('fail', { ...c, verdict: 'fail' }, slack, { desktop: false, fetchFn });
  check('no flip, no post', sent.length === 1);
  await notifyIfFlipped('pass', c, slack, { desktop: false, fetchFn: async () => { throw new Error('dead'); } });
  check('dead webhook does not throw', true);
  process.exit(bad ? 1 : 0);
})();
