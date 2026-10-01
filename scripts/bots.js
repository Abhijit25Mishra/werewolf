'use strict';
// Fills a room with bot players for local testing. They ready up and play by themselves.
// Usage: node scripts/bots.js <ROOM-CODE> [count=4] [server-url=http://localhost:3000]
const { Bot, mulberry32 } = require('../test/helpers/bot');

const [code, countArg = '4', url = 'http://localhost:3000'] = process.argv.slice(2);
if (!code) {
  console.error('Usage: node scripts/bots.js <ROOM-CODE> [count] [server-url]');
  process.exit(1);
}
const NAMES = ['Asha', 'Ben', 'Chen', 'Dara', 'Eli', 'Farah', 'Gus', 'Hana', 'Ivo', 'Jai', 'Kira', 'Leo', 'Mira', 'Nate', 'Omar', 'Pia', 'Quin', 'Ravi', 'Sana'];

(async () => {
  const bots = [];
  for (let i = 0; i < Number(countArg); i++) {
    const bot = new Bot(url, `${NAMES[i % NAMES.length]} (bot)`, mulberry32(Date.now() + i), { flaky: 0, hold: false });
    const res = await bot.join(code.toUpperCase());
    if (!res.ok) {
      console.error(`Bot ${i + 1} couldn't join: ${res.error}`);
      bot.close();
      continue;
    }
    bots.push(bot);
  }
  console.log(`${bots.length} bots joined ${code.toUpperCase()}. They ready up and play by themselves. Press Ctrl+C to remove them.`);
  process.on('SIGINT', () => {
    bots.forEach((b) => b.close());
    process.exit(0);
  });
})();
