/**
 * Прогон собранной игры в настоящем браузере.
 *
 * Поднимает статический сервер над dist/, открывает игру в Chromium, обходит все
 * четыре зоны, снимает скриншоты и ловит ошибки в консоли. Запускать после
 * `npm run build`:
 *
 *   node tools/smoke.mjs [--headed] [--out screenshots]
 *
 * Учтите: в headless-режиме на этой машине WebGL считается программно
 * (SwiftShader), поэтому частота кадров здесь ни о чём не говорит — проверяются
 * корректность и картинка, а не скорость.
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('..', import.meta.url));
const dist = join(root, 'dist');

const args = process.argv.slice(2);
const headed = args.includes('--headed');
const outIndex = args.indexOf('--out');
const outDir = join(root, outIndex >= 0 ? args[outIndex + 1] : 'screenshots');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function startServer() {
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', 'http://localhost');
      let path = decodeURIComponent(url.pathname);
      if (path === '/' || path.endsWith('/')) path += 'index.html';
      const filePath = join(dist, normalize(path).replace(/^(\.\.[/\\])+/, ''));
      const body = await readFile(filePath);
      response.writeHead(200, { 'content-type': MIME[extname(filePath)] ?? 'application/octet-stream' });
      response.end(body);
    } catch {
      response.writeHead(404).end('not found');
    }
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

/**
 * Точки съёмки выбраны не в центрах зон: центры — это расчищенные площадки под
 * поселения, деревьев там нет по построению. Стоим там, где видно и лес вблизи,
 * и характер зоны.
 */
const ZONES = [
  { key: 'elf', title: 'Лес эльфов', x: -470, z: 40, minNearTrees: 20 },
  { key: 'imperial', title: 'Земли императора', x: 505, z: -175, minNearTrees: 0 },
  { key: 'human', title: 'Земли людей', x: 175, z: 395, minNearTrees: 0 },
  { key: 'villain', title: 'Горы злодея', x: 205, z: -645, minNearTrees: 0 },
];

async function main() {
  mkdirSync(outDir, { recursive: true });

  const { chromium } = require('playwright');
  const { server, port } = await startServer();
  const url = `http://127.0.0.1:${port}/`;

  const browser = await chromium.launch({
    headless: !headed,
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage', '--no-sandbox'],
  });

  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });

  const errors = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(String(error)));

  console.log(`→ открываю ${url}`);
  await page.goto(url, { waitUntil: 'domcontentloaded' });

  await page.waitForFunction(() => window.__game?.ready === true, null, { timeout: 180000 });
  console.log('→ мир поднялся');

  await page.evaluate(() => {
    const overlay = document.getElementById('lock-overlay');
    if (overlay) overlay.style.display = 'none';
  });

  const results = [];

  const failures = [];

  for (const zone of ZONES) {
    await page.evaluate(({ x, z }) => window.__game.teleport(x, z), { x: zone.x, z: zone.z });
    // Даём миру пересобрать лес и прогреть шейдеры.
    await page.waitForTimeout(2500);

    const stats = await page.evaluate(() => window.__game.stats());
    const file = join(outDir, `zone-${zone.key}.png`);
    await page.screenshot({ path: file });

    results.push({ zone: zone.title, ...stats });
    console.log(
      `→ ${zone.title.padEnd(22)} деревья: ${String(stats.forest.lod0).padStart(4)} вблизи / ` +
        `${String(stats.forest.lod1).padStart(4)} поодаль / ${String(stats.forest.impostors).padStart(5)} картинками · ` +
        `вызовов ${stats.drawCalls}`,
    );

    if (stats.forest.lod0 < zone.minNearTrees) {
      failures.push(
        `${zone.title}: рядом только ${stats.forest.lod0} трёхмерных деревьев, ожидалось не меньше ${zone.minNearTrees}`,
      );
    }
    if (zone.title !== stats.zone) {
      failures.push(`точка съёмки ${zone.x},${zone.z} оказалась в зоне «${stats.zone}», а не «${zone.title}»`);
    }
  }

  // Панорама: смотрим на лес эльфов издалека. Тут видно ровно то, ради чего
  // затевались импосторы, — дальние деревья должны читаться как деревья.
  await page.evaluate(() => {
    window.__game.teleport(-120, 120);
    window.__game.look(-2.3, -0.06);
  });
  await page.waitForTimeout(2500);
  await page.screenshot({ path: join(outDir, 'panorama-forest.png') });
  const panorama = await page.evaluate(() => window.__game.stats());
  console.log(
    `→ панорама леса: ${panorama.forest.impostors} деревьев картинками, ${panorama.forest.lod1} моделями поодаль`,
  );

  // ── Бой и увечья ──────────────────────────────────────────────────────────
  // Ставим противников перед игроком, рубим их топором и смотрим, что руки и
  // ноги действительно отлетают, а трупы остаются лежать.
  await page.evaluate(() => {
    window.__game.teleport(-455, 92);
    window.__game.look(0.6, -0.04);
    window.__game.give('axe', 1, true);
  });
  await page.waitForTimeout(900);

  const enemyIds = await page.evaluate(() => [
    window.__game.spawnEnemy(2.3, 'palace', 'sword'),
    window.__game.spawnEnemy(3.4, 'palace', 'mace'),
  ]);
  await page.waitForTimeout(700);
  await page.screenshot({ path: join(outDir, 'combat-before.png') });

  // Целимся в руку и рубим именно её: это и есть обещанное «отрубить руку».
  for (let i = 0; i < 14; i++) {
    await page.evaluate((id) => {
      window.__game.aimAt(id, 'rightArm');
      window.__game.attack();
    }, enemyIds[0]);
    await page.waitForTimeout(230);
  }

  const afterArm = await page.evaluate(() => window.__game.population());
  console.log(`→ после ударов по руке отрублено конечностей: ${afterArm.severedLimbs}`);
  if (afterArm.severedLimbs === 0) {
    failures.push('прицельные удары топором по руке не отрубили её');
  }
  await page.screenshot({ path: join(outDir, 'combat-severed.png') });

  // Теперь добиваем: бьём куда придётся.
  for (let i = 0; i < 18; i++) {
    await page.evaluate((ids) => {
      window.__game.aimAt(ids[Math.floor(Date.now() / 500) % ids.length], 'torso');
      window.__game.attack();
    }, enemyIds);
    await page.waitForTimeout(230);
  }
  await page.waitForTimeout(900);

  const battle = await page.evaluate(() => window.__game.population());
  console.log(
    `→ бой: живых ${battle.alive}, трупов ${battle.corpses}, отрублено конечностей ${battle.severedLimbs}`,
  );
  await page.screenshot({ path: join(outDir, 'combat-after.png') });

  if (battle.severedLimbs === 0 && battle.corpses === 0) {
    failures.push('после двух десятков ударов топором никто не пострадал — бой не работает');
  }

  // ── Увечья игрока ─────────────────────────────────────────────────────────
  // Выбиваем глаз: половина экрана должна погаснуть.
  await page.evaluate(() => {
    window.__game.hurt('leftEye', 40, 'pierce');
  });
  await page.waitForTimeout(900);
  await page.screenshot({ path: join(outDir, 'injury-eye.png') });

  const oneEyed = await page.evaluate(() => window.__game.player());
  console.log(`→ после удара в глаз: обзор «${oneEyed.visionLoss}», раны — ${oneEyed.injuries.join(', ')}`);
  if (oneEyed.visionLoss !== 'left') failures.push('выбитый левый глаз не погасил левую половину обзора');

  // Отрубаем ногу: игрок должен перейти на ползание и начать истекать кровью.
  await page.evaluate(() => {
    window.__game.hurt('rightLeg', 200, 'cut');
  });
  await page.waitForTimeout(1400);
  await page.screenshot({ path: join(outDir, 'injury-crawl.png') });

  const crippled = await page.evaluate(() => window.__game.player());
  console.log(
    `→ без ноги: передвижение «${crippled.movementMode}», кровотечение ${crippled.bleeding ? 'есть' : 'нет'}, ` +
      `до потери сознания ${Math.round(crippled.secondsUntilBleedOut)} с`,
  );
  if (crippled.movementMode !== 'crawl') failures.push('после потери ноги игрок не перешёл на ползание');
  if (!crippled.bleeding) failures.push('отрубленная нога не кровоточит');

  // Перевязка должна спасти. Одна повязка закрывает одну рану, поэтому
  // перевязываемся, пока кровь не остановится совсем.
  for (let i = 0; i < 4; i++) {
    await page.evaluate(() => window.__game.bandage());
    await page.waitForTimeout(200);
  }
  const bandaged = await page.evaluate(() => window.__game.player());
  if (bandaged.bleeding) failures.push('перевязка не остановила кровь');
  console.log(
    `→ после перевязки кровотечение ${bandaged.bleeding ? 'осталось' : 'остановлено'}, ` +
      `бинтов в мешке ${bandaged.bandages}`,
  );

  // Ночной кадр — заодно проверяем, что смена суток не роняет шейдеры.
  await page.evaluate(() => {
    window.__game.teleport(-470, 40);
    window.__game.look(0.47, 0);
    window.__game.setTimeOfDay(0.02);
  });
  await page.waitForTimeout(2000);
  await page.screenshot({ path: join(outDir, 'night-elf.png') });
  console.log('→ ночной кадр снят');

  await browser.close();
  server.close();

  console.log(`\nвсего деревьев в мире: ${results[0]?.forest.total ?? '—'}`);
  console.log(`скриншоты: ${outDir}`);

  if (errors.length > 0) {
    console.error('\nОШИБКИ В КОНСОЛИ:');
    for (const error of errors) console.error('  ' + error);
  }
  if (failures.length > 0) {
    console.error('\nПРОВЕРКИ НЕ ПРОШЛИ:');
    for (const failure of failures) console.error('  ' + failure);
  }
  if (errors.length > 0 || failures.length > 0) process.exit(1);
  console.log('ошибок в консоли нет, проверки пройдены');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
