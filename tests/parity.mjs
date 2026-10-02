// Сверка разбора еды: устройство (app/static/foodparse.js в браузере) и сервер (app/food.py) на одних фразах.
// Нужен запущенный сервер на тестовых данных и puppeteer-core:
//   TRAINER_DATA=<папка> TRAINER_PORT=8890 uv run run.py
//   cd tests && npm i && TRAINER_DATA=<папка> node parity.mjs     (BASE, LOGIN, PASSWORD, CHROME - при необходимости)
import puppeteer from 'puppeteer-core';
import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';

const BASE = process.env.BASE || 'http://localhost:8891';
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const cases = JSON.parse(readFileSync(new URL('./parity_cases.json', import.meta.url), 'utf8'));
const server = JSON.parse(execFileSync('uv', ['run', 'python', 'tests/parity_server.py'], { cwd: fileURLToPath(new URL('..', import.meta.url)), encoding: 'utf8' }));

const b = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox'] });
const p = await b.newPage();
await p.goto(BASE, { waitUntil: 'networkidle2' });
if (await p.$('input[name=login]')) {
  await p.type('input[name=login]', process.env.LOGIN || 'ivan');
  await p.type('input[name=password]', process.env.PASSWORD || '1234');
  await p.keyboard.press('Enter');
}
await p.waitForFunction(() => !document.querySelector('input[name=login]'), { timeout: 20000 });
const client = await p.evaluate(async cases => {
  const FP = await import('/foodparse.js'), foods = await import('/foods.js');
  await foods.refresh();
  for (let i = 0; i < 50 && !FP.ready(); i++) await new Promise(r => setTimeout(r, 200));
  const out = {};
  for (const t of cases) {
    const { items, rest } = FP.parse(t);
    out[t] = { items: items.map(i => [i.name, Math.round(i.grams), !!i.choice]), rest };
  }
  return out;
}, cases);
await b.close();

let bad = 0;
for (const t of cases) {
  const a = JSON.stringify(server[t]), c = JSON.stringify(client[t]);
  if (a !== c) { bad++; console.log(`РАЗНИЦА «${t}»\n  сервер:     ${a}\n  устройство: ${c}`); }
}
console.log(bad ? `не совпало: ${bad} из ${cases.length}` : `совпало: ${cases.length} из ${cases.length}`);
process.exit(bad ? 1 : 0);
