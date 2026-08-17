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

/**
 * Снимок без заставки.
 *
 * Заставка «Нажмите, чтобы играть» возвращается каждый раз, когда закрывается
 * окно торговли или карты, — и все снимки после первой торговли выходили
 * закрытыми ею. Проверять по такому снимку нечего, поэтому прячем её прямо
 * перед съёмкой.
 */
async function shot(page, file) {
  await page.evaluate(() => {
    const overlay = document.getElementById('lock-overlay');
    if (overlay) overlay.style.display = 'none';
  });
  await page.screenshot({ path: file });
}

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
  const url = `http://127.0.0.1:${port}/?faction=elves`;

  // Готовый Chromium можно указать снаружи: на машинах, где браузер уже лежит
  // рядом, качать второй такой же незачем.
  //   SMOKE_CHROMIUM=/путь/к/chrome node tools/smoke.mjs
  const executablePath = process.env.SMOKE_CHROMIUM || undefined;
  if (executablePath) console.log(`→ браузер взят по указанию: ${executablePath}`);

  const browser = await chromium.launch({
    headless: !headed,
    executablePath,
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
    await shot(page, file);

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

  // ── Поселения ─────────────────────────────────────────────────────────────
  // Смотрим на каждое строение снаружи: дворец, форт, деревню и домики эльфов.
  const PLACES = [
    { key: 'palace', title: 'Дворец императора', x: 610, z: -320, at: [610, -230], pitch: 0.1 },
    { key: 'fort', title: 'Старый форт', x: 90, z: -690, at: [90, -760], pitch: 0.06 },
    { key: 'village', title: 'Деревня Тихий Брод', x: 40, z: 550, at: [40, 470], pitch: 0.03 },
    { key: 'glade', title: 'Поляна эльфов', x: -510, z: 20, at: [-580, -40], pitch: 0.06 },
  ];

  for (const spot of PLACES) {
    await page.evaluate(({ x, z, at, pitch }) => {
      window.__game.teleport(x, z);
      window.__game.lookAt(at[0], at[1], pitch);
    }, spot);
    await page.waitForTimeout(2200);
    await shot(page, join(outDir, `place-${spot.key}.png`));
    const stats = await page.evaluate(() => window.__game.stats());
    console.log(`→ ${spot.title.padEnd(22)} вызовов ${stats.drawCalls}, треугольников ${Math.round(stats.triangles / 1000)}k`);
  }

  // Панорама: смотрим на лес эльфов издалека. Тут видно ровно то, ради чего
  // затевались импосторы, — дальние деревья должны читаться как деревья.
  await page.evaluate(() => {
    window.__game.teleport(-120, 120);
    window.__game.look(-2.3, -0.06);
  });
  await page.waitForTimeout(2500);
  await shot(page, join(outDir, 'panorama-forest.png'));
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
  await shot(page, join(outDir, 'combat-before.png'));

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
  await shot(page, join(outDir, 'combat-severed.png'));

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
  await shot(page, join(outDir, 'combat-after.png'));

  if (battle.severedLimbs === 0 && battle.corpses === 0) {
    failures.push('после двух десятков ударов топором никто не пострадал — бой не работает');
  }

  // ── Увечья игрока ─────────────────────────────────────────────────────────
  // Выбиваем глаз: половина экрана должна погаснуть.
  await page.evaluate(() => {
    window.__game.hurt('leftEye', 40, 'pierce');
  });
  await page.waitForTimeout(900);
  await shot(page, join(outDir, 'injury-eye.png'));

  const oneEyed = await page.evaluate(() => window.__game.player());
  console.log(`→ после удара в глаз: обзор «${oneEyed.visionLoss}», раны — ${oneEyed.injuries.join(', ')}`);
  if (oneEyed.visionLoss !== 'left') failures.push('выбитый левый глаз не погасил левую половину обзора');

  // Отрубаем ногу: игрок должен перейти на ползание и начать истекать кровью.
  await page.evaluate(() => {
    window.__game.hurt('rightLeg', 200, 'cut');
  });
  await page.waitForTimeout(1400);
  await shot(page, join(outDir, 'injury-crawl.png'));

  const crippled = await page.evaluate(() => window.__game.player());
  console.log(
    `→ без ноги: передвижение «${crippled.movementMode}», кровотечение ${crippled.bleeding ? 'есть' : 'нет'}, ` +
      `до потери сознания ${Math.round(crippled.secondsUntilBleedOut)} с`,
  );
  if (crippled.movementMode !== 'crawl') failures.push('после потери ноги игрок не перешёл на ползание');
  if (!crippled.bleeding) failures.push('отрубленная нога не кровоточит');

  // Перевязка должна спасти. Одна повязка закрывает одну рану, поэтому
  // перевязываемся, пока кровь не остановится совсем. Бинты выдаём отдельно:
  // проверяем механику перевязки, а не запасы в мешке.
  await page.evaluate(() => window.__game.give('bandage', 6));
  for (let i = 0; i < 5; i++) {
    await page.evaluate(() => window.__game.bandage());
    await page.waitForTimeout(200);
  }
  const bandaged = await page.evaluate(() => window.__game.player());
  if (bandaged.bleeding) failures.push('перевязка не остановила кровь');
  console.log(
    `→ после перевязки кровотечение ${bandaged.bleeding ? 'осталось' : 'остановлено'}, ` +
      `бинтов в мешке ${bandaged.bandages}`,
  );

  // ── Грабим корован ────────────────────────────────────────────────────────
  await page.evaluate(() => window.__game.healPlayer());

  const caravan = await page.evaluate(() => {
    window.__game.spawnCaravan('palace-village');
    return window.__game.goToCaravan();
  });
  await page.waitForTimeout(2600);
  await shot(page, join(outDir, 'caravan.png'));

  console.log(
    `→ корован ${caravan.from} → ${caravan.to}: ${caravan.cargo}, ` +
      `золота ${caravan.gold}, охраны ${caravan.guards}, на добро ${caravan.cargoValue} зол.`,
  );
  if (!caravan || caravan.guards === 0) failures.push('корован вышел без сопровождения');
  if (!caravan.cargo || caravan.cargo === 'телега пуста') failures.push('корован вышел порожняком');

  const onRoad = await page.evaluate(() => window.__game.onRoad());
  console.log(`→ телега стоит ${onRoad ? 'на тракте' : 'в стороне от тракта'}`);

  const goldBefore = await page.evaluate(() => window.__game.player().gold);

  // Прямая проверка жалобы «грабить корованы нельзя»: подходим к охраняемому
  // обозу и смотрим, отвечает ли игра хоть что-нибудь. Подходим заново — телега
  // на ходу и за время предыдущих проверок успела отъехать.
  const guardedHint = await page.evaluate(() => {
    window.__game.goToCaravan();
    return window.__game.hint();
  });
  console.log(`→ подсказка у охраняемого обоза: ${guardedHint ? `«${guardedHint}»` : 'нет'}`);
  if (!guardedHint) {
    failures.push('у охраняемого обоза нет подсказки — игрок не понимает, что перед ним корован');
  } else if (!guardedHint.includes('охрана')) {
    failures.push(`подсказка «${guardedHint}» не говорит, что телегу стерегут`);
  }

  const guardedReply = await page.evaluate(() => {
    window.__game.goToCaravan();
    window.__game.loot();
    return window.__game.messages();
  });
  console.log(`→ ответ на E у охраняемого обоза: ${guardedReply.at(-1) ?? 'тишина'}`);
  if (!guardedReply.some((line) => line.includes('стерег'))) {
    failures.push('E у охраняемого обоза не даёт никакого ответа');
  }
  await shot(page, join(outDir, 'caravan-guarded.png'));

  // Засада: подходим вплотную, рубим сопровождение, подлечиваясь между заходами.
  for (let i = 0; i < 70; i++) {
    const done = await page.evaluate(() => {
      window.__game.healPlayer();
      const id = window.__game.approachNearest('torso', 45);
      if (id === null) return true;
      window.__game.attack();
      return false;
    });
    if (done) break;
    await page.waitForTimeout(180);
  }
  await page.waitForTimeout(600);

  // Возвращаемся к телеге: во время драки мы гонялись за охраной по тракту.
  await page.evaluate(() => window.__game.goToCaravan());
  await page.waitForTimeout(700);

  const afterFight = await page.evaluate(() => window.__game.nearestCaravan());
  console.log(
    `→ после засады: состояние «${afterFight.state}», охраны рядом ${afterFight.defenders ? 'есть' : 'нет'}, ` +
      `живых сопровождающих ${afterFight.guards}`,
  );

  // Грабим ровно так же, как человек: подсказка плюс E. Никаких обходных путей —
  // именно из-за них прошлая проверка не заметила, что E не работает.
  const readyHint = await page.evaluate(() => {
    window.__game.goToCaravan();
    return window.__game.hint();
  });
  console.log(`→ подсказка после разгрома охраны: ${readyHint ? `«${readyHint}»` : 'нет'}`);
  if (!readyHint || !readyHint.startsWith('E —')) {
    failures.push(`после разгрома охраны подсказка не зовёт грабить: «${readyHint ?? 'нет'}»`);
  }

  await page.evaluate(() => window.__game.loot());
  await page.waitForTimeout(500);
  await shot(page, join(outDir, 'caravan-plundered.png'));

  const emptyHint = await page.evaluate(() => window.__game.hint());
  if (emptyHint && emptyHint.startsWith('E —')) {
    failures.push('обчищенный обоз всё ещё предлагает себя ограбить');
  }

  const afterRobbery = await page.evaluate(() => window.__game.economy());
  const goldAfter = afterRobbery.gold;
  console.log(`→ после грабежа золота ${goldBefore} → ${goldAfter}`);
  if (goldAfter <= goldBefore) failures.push('грабёж корована не принёс золота');

  // Груз не доехал — в городе назначения на него подскочила цена.
  const shortage = afterRobbery.shortages?.village ?? {};
  const spiked = Object.entries(shortage).filter(([, value]) => value > 0);
  console.log(
    spiked.length > 0
      ? `→ в Тихом Броде подорожало: ${spiked.map(([id, value]) => `${id} +${Math.round(value * 100)}%`).join(', ')}`
      : '→ дефицита в городе назначения не возникло',
  );
  if (spiked.length === 0) failures.push('недоехавший груз не поднял цены в городе назначения');

  const reputationAfter = afterRobbery.reputation ?? {};
  console.log(`→ репутация после грабежа: ${JSON.stringify(reputationAfter)}`);
  if (!Object.values(reputationAfter).some((value) => value < 0)) {
    failures.push('после грабежа ни с кем не испортились отношения');
  }

  // ── Награда за голову ─────────────────────────────────────────────────────
  // Ограбление уже случилось выше — значит, за голову должны были назначить.
  const bountyAfterRobbery = await page.evaluate(() => window.__game.bounty());
  const palaceBounty = bountyAfterRobbery.find((entry) => entry.faction === 'palace');
  console.log(
    palaceBounty
      ? `→ за голову назначено: ${palaceBounty.bounty} зол. (${palaceBounty.faction})`
      : '→ награду за голову не назначили',
  );
  if (!palaceBounty || palaceBounty.bounty <= 0) {
    failures.push('после грабежа корована за голову никто ничего не назначил');
  }

  // Охотники выходят и идут именно к игроку, а не бродят по своим делам.
  const huntersSent = await page.evaluate(() => window.__game.sendHunters('palace'));
  console.log(`→ вышло охотников: ${huntersSent}`);
  if (huntersSent <= 0) failures.push('охотники за головой не вышли');

  // Ждём подолгу намеренно. Шаг времени в игре ограничен 0.05 с, а здесь всего
  // пара кадров в секунду, поэтому за секунду наблюдения мир проживает около
  // одной десятой секунды. Сближение идёт правильно, просто вдесятеро медленнее
  // наблюдателя — на настоящей видеокарте этих пауз не потребовалось бы.
  const firstSighting = await page.evaluate(() => window.__game.nearestHunter());
  await page.waitForTimeout(15000);
  const secondSighting = await page.evaluate(() => window.__game.nearestHunter());
  console.log(
    firstSighting && secondSighting
      ? `→ ближайший охотник: ${Math.round(firstSighting.distance)} м → ${Math.round(secondSighting.distance)} м`
      : '→ охотников на карте нет',
  );
  if (!secondSighting) {
    failures.push('охотники исчезли, не дойдя до игрока');
  } else if (secondSighting.distance >= firstSighting.distance) {
    failures.push('охотники не приближаются к игроку — погони нет');
  }

  // Награда видна игроку в строке состояния, а не только в служебных данных.
  const bountyOnScreen = await page.evaluate(() => document.getElementById('hud')?.textContent ?? '');
  console.log(`→ строка состояния: «${bountyOnScreen}»`);
  if (!bountyOnScreen.includes('голов') && !bountyOnScreen.includes('след')) {
    failures.push('про награду за голову на экране ничего не написано');
  }
  await shot(page, join(outDir, 'hunters.png'));

  // Вира: второй выход из-под охоты, кроме резни.
  const payoff = await page.evaluate(() => {
    const before = window.__game.bounty().find((entry) => entry.faction === 'palace')?.bounty ?? 0;
    // Насыпаем золота: проверяем сам откуп, а не умение накопить.
    window.__game.giveGold(before * 2 + 100);
    // Виру берёт та сторона, что держит прилавок, — значит, идём во дворец.
    const paid = window.__game.payBounty('palace');
    return { before, paid, after: window.__game.bounty().find((entry) => entry.faction === 'palace')?.bounty ?? 0 };
  });
  console.log(`→ вира: платили за ${payoff.before} зол., приняли ${payoff.paid ? 'да' : 'нет'}, стало ${payoff.after}`);
  if (!payoff.paid) failures.push('виру заплатить не удалось');
  if (payoff.after !== 0) failures.push('после уплаты виры награда за голову не снялась');

  // ── Прилавок ──────────────────────────────────────────────────────────────
  await page.evaluate(() => window.__game.openTrade('village'));
  await page.waitForTimeout(700);
  await shot(page, join(outDir, 'trade.png'));

  const tradeVisible = await page.evaluate(() => {
    const screen = document.getElementById('trade-screen');
    return screen ? getComputedStyle(screen).display !== 'none' : false;
  });
  if (!tradeVisible) failures.push('экран торговли не открылся');
  console.log(`→ прилавок ${tradeVisible ? 'открыт' : 'не открылся'}`);

  await page.evaluate(() => window.__game.closeTrade());
  await page.waitForTimeout(300);

  // ── Дорожные встречи ──────────────────────────────────────────────────────
  // Встаём на тракт: сцены ставятся по дорогам, а не по чистому полю.
  await page.evaluate(() => {
    window.__game.healPlayer();
    window.__game.teleport(40, 470);
  });
  await page.waitForTimeout(1200);

  // Раненый на обочине. Перевязываем ровно так, как человек: смотрим подсказку
  // и жмём E. Никаких обходных путей — на этом уже обжигались с корованами.
  const woundedSpawned = await page.evaluate(() => window.__game.spawnEncounter('wounded'));
  console.log(`→ встреча поставлена: ${woundedSpawned ?? 'не удалось'}`);
  if (woundedSpawned !== 'wounded') failures.push('раненый на дороге не появился');

  const woundedHint = await page.evaluate(() => {
    window.__game.give('bandage', 3);
    window.__game.goToEncounter('wounded');
    return window.__game.hint();
  });
  console.log(`→ подсказка у раненого: ${woundedHint ? `«${woundedHint}»` : 'нет'}`);
  if (!woundedHint || !woundedHint.startsWith('E —')) {
    failures.push(`у раненого нет зова к действию: «${woundedHint ?? 'нет'}»`);
  }
  await shot(page, join(outDir, 'encounter-wounded.png'));

  const healed = await page.evaluate(() => {
    const goldBefore = window.__game.player().gold;
    window.__game.loot();
    return { goldBefore, goldAfter: window.__game.player().gold, log: window.__game.messages() };
  });
  console.log(`→ после перевязки: ${healed.log.at(-1) ?? 'тишина'} (золото ${healed.goldBefore} → ${healed.goldAfter})`);
  if (!healed.log.some((line) => line.includes('перевяз'))) {
    failures.push('E у раненого ничего не сделал');
  }

  // Беглец с краденым: сделка тоже через подсказку и E.
  const pedlarSpawned = await page.evaluate(() => window.__game.spawnEncounter('pedlar'));
  if (pedlarSpawned !== 'pedlar') failures.push('беглец с краденым не появился');

  const deal = await page.evaluate(() => {
    window.__game.giveGold(400);
    window.__game.goToEncounter('pedlar');
    const hint = window.__game.hint();
    const goldBefore = window.__game.player().gold;
    window.__game.loot();
    return { hint, goldBefore, goldAfter: window.__game.player().gold, log: window.__game.messages() };
  });
  console.log(`→ беглец: «${deal.hint ?? 'нет подсказки'}», золото ${deal.goldBefore} → ${deal.goldAfter}`);
  if (!deal.hint || !deal.hint.startsWith('E —')) failures.push('беглец не предлагает сделку по E');
  if (deal.goldAfter >= deal.goldBefore) failures.push('покупка с рук не списала золото');
  await shot(page, join(outDir, 'encounter-pedlar.png'));

  // Засада: разбойники должны сами дойти до игрока и напасть.
  const ambushSpawned = await page.evaluate(() => window.__game.spawnEncounter('ambush'));
  if (ambushSpawned !== 'ambush') failures.push('засада на дороге не выставилась');

  // Проверяем намерение, а не только расстояние.
  //
  // Расстояние здесь плохой одиночный признак по двум причинам. Первая: игра
  // ограничивает шаг времени 0.05 с, а кадров тут пара в секунду, поэтому за
  // минуту наблюдения мир проживает секунд шесть — разбойники успевают сделать
  // десяток шагов. Вторая: к этому моменту за игроком уже идут охотники других
  // сторон, а разбойникам они враги, и драка по дороге — правильное поведение,
  // а не поломка. Поэтому смотрим на то, что решает разум: куда поставлен
  // якорь и чем человек занят.
  const track = [];
  for (let i = 0; i < 8; i++) {
    const rows = await page.evaluate(() =>
      window.__game.actorsNear(600).filter((actor) => actor.name.includes('разбойник')),
    );
    if (rows.length > 0) track.push(rows);
    await page.waitForTimeout(5000);
  }

  if (track.length === 0) {
    failures.push('засада пропала, не дойдя до игрока');
  } else {
    const first = track[0];
    const last = track[track.length - 1];
    const playerAt = await page.evaluate(() => window.__game.stats().position);

    const distances = track.map((rows) => Math.min(...rows.map((actor) => actor.distance)));
    console.log(`→ засада идёт: ${distances.join(' → ')} м`);
    console.log(`→ занятие разбойников: ${last.map((actor) => `${actor.state}${actor.targetName ? ` (${actor.targetName})` : ''}`).join(', ')}`);

    // Якорь должен указывать на игрока: именно это значит «засада на вас».
    const anchoredAtPlayer = last.every(
      (actor) => actor.anchored && Math.hypot(actor.anchorX - playerAt.x, actor.anchorZ - playerAt.z) < 60,
    );
    if (!anchoredAtPlayer) failures.push('разбойники из засады идут не к игроку');

    // И они должны что-то делать: идти, догонять или драться, но не стоять.
    const busy = last.every((actor) => actor.state !== 'idle');
    if (!busy) failures.push('разбойники из засады стоят на месте');

    const closed = Math.min(...distances) < distances[0];
    console.log(
      closed
        ? `→ подобрались на ${Math.round(distances[0] - Math.min(...distances))} м`
        : '→ сблизиться не успели (в пути ввязались в чужую драку)',
    );
    void first;
  }
  await shot(page, join(outDir, 'encounter-ambush.png'));

  // Конвой с пленным: сцена должна встать целиком — стража плюс пленный.
  const prisoner = await page.evaluate(() => {
    window.__game.spawnEncounter('prisoner');
    window.__game.goToEncounter('prisoner');
    return window.__game.encounters().find((entry) => entry.kind === 'prisoner');
  });
  await page.waitForTimeout(1200);
  console.log(prisoner ? `→ конвой с пленным: ${prisoner.alive} чел.` : '→ конвой с пленным не вышел');
  if (!prisoner || prisoner.alive < 3) failures.push('конвой с пленным вышел неполным');
  await shot(page, join(outDir, 'encounter-prisoner.png'));

  // ── Три судьбы ────────────────────────────────────────────────────────────
  // Играем за эльфов: приказ берём у старшего партизана в лагере.
  await page.evaluate(() => {
    window.__game.healPlayer();
    window.__game.teleport(-330, -290);
  });
  await page.waitForTimeout(1800);

  // Подходим к командиру вплотную и берём приказ.
  const orderTaken = await page.evaluate(() => {
    window.__game.takeOrder();
    return window.__game.factions();
  });
  console.log(
    orderTaken.order
      ? `→ приказ получен: «${orderTaken.order.title}» (нужно ${orderTaken.order.need})`
      : '→ приказ получить не удалось',
  );
  if (!orderTaken.order) failures.push('приказ не выдался');

  await shot(page, join(outDir, 'orders.png'));

  // Набег: стороны воюют между собой и без участия игрока.
  const raid = await page.evaluate(() => window.__game.launchRaid('palace-on-elves'));
  await page.waitForTimeout(1500);
  console.log(`→ набеги в пути: ${raid.map((entry) => `${entry.plan} (${entry.alive})`).join(', ') || 'нет'}`);
  if (raid.length === 0) failures.push('набег не вышел');

  // Отряд злодея: проверяем в отдельной вкладке, играя за злодея.
  const villainPage = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  villainPage.on('pageerror', (error) => errors.push('злодей: ' + String(error)));
  // Вторая вкладка поднимается медленно: первая продолжает считать мир, а
  // видеокарты здесь нет вовсе — обе картинки рисует процессор.
  await villainPage.goto(`http://127.0.0.1:${port}/?faction=villain`, {
    waitUntil: 'domcontentloaded',
    timeout: 180000,
  });
  await villainPage.waitForFunction(() => window.__game?.ready === true, null, { timeout: 180000 });
  await villainPage.evaluate(() => {
    const overlay = document.getElementById('lock-overlay');
    if (overlay) overlay.style.display = 'none';
  });
  await villainPage.waitForTimeout(1500);

  const villain = await villainPage.evaluate(() => {
    // Сам себе командир: приказ берётся без всякого начальства.
    window.__game.takeOrder();
    // Золото на наём: проверяем сбор отряда, а не накопления.
    window.__game.give('bandage', 1);
    // Нанимаем всех, до кого дотягиваемся в форте.
    for (let i = 0; i < 6; i++) {
      window.__game.approachNearest('torso', 60);
      window.__game.loot();
    }
    window.__game.squadOrder('follow');
    return window.__game.factions();
  });
  await villainPage.waitForTimeout(1200);
  await shot(villainPage, join(outDir, 'villain-squad.png'));

  // Приказ «собрать людей» злодей закрывает сам, как только отряд набран, —
  // поэтому в сводке он может быть уже не в активных, а в выполненных.
  const villainOrder = villain.order?.title ?? (villain.completed.length > 0 ? villain.completed[0] : null);
  console.log(
    `→ за злодея: приказ «${villainOrder ?? 'нет'}», отряд ${villain.squad}, ` +
      `выполнено приказов ${villain.completed.length}, репутация в горах ${villain.reputation.villain}`,
  );
  if (!villainOrder) failures.push('злодей не смог взять приказ сам себе');
  if (villain.squad === 0) failures.push('злодей никого не нанял');

  await villainPage.close();

  // ── Сохранения и карта ────────────────────────────────────────────────────
  // Записываем игру, портим состояние и проверяем, что загрузка его вернула.
  const before = await page.evaluate(() => {
    window.__game.teleport(-330, -290);
    window.__game.save(2);
    return { player: window.__game.player(), factions: window.__game.factions() };
  });
  await page.waitForTimeout(700);

  await page.evaluate(() => {
    window.__game.teleport(400, 300);
    window.__game.give('silk', 40);
    window.__game.hurt('rightArm', 300, 'cut');
  });
  await page.waitForTimeout(900);

  const loaded = await page.evaluate(() => {
    window.__game.load(2);
    return {
      player: window.__game.player(),
      factions: window.__game.factions(),
      position: window.__game.stats().position,
    };
  });
  await page.waitForTimeout(900);

  console.log(
    `→ сохранение: золото ${before.player.gold} → загружено ${loaded.player.gold}, ` +
      `раны «${loaded.player.injuries.join(', ') || 'нет'}»`,
  );
  if (loaded.player.gold !== before.player.gold) {
    failures.push(`после загрузки золото ${loaded.player.gold}, а было ${before.player.gold}`);
  }
  if (loaded.player.injuries.some((line) => line.includes('правая рука'))) {
    failures.push('загрузка не отменила рану, полученную после сохранения');
  }
  if (Math.abs(loaded.position.x - (-330)) > 12 || Math.abs(loaded.position.z - (-290)) > 12) {
    failures.push('после загрузки игрок оказался не там, где сохранялся');
  }
  if (loaded.factions.order?.id !== before.factions.order?.id) {
    failures.push('после загрузки потерялся приказ');
  }

  const slots = await page.evaluate(() => window.__game.slots());
  console.log(`→ слоты: ${slots.map((slot) => `${slot.slot}: ${slot.label}`).join(' | ')}`);
  if (!slots.some((slot) => slot.used)) failures.push('сохранение не попало в слот');

  // Карта мира. Перед съёмкой выпускаем охоту: от охотников можно уйти, но для
  // этого их надо видеть, — значит, на карте они обязаны быть.
  const huntersOnMap = await page.evaluate(() => {
    window.__game.sendHunters('villain');
    return window.__game.nearestHunter();
  });
  console.log(`→ на карту выпущены охотники: ${huntersOnMap ? `${Math.round(huntersOnMap.distance)} м` : 'нет'}`);
  if (!huntersOnMap) failures.push('охотников не видно на карте — уходить не от кого');

  await page.evaluate(() => window.__game.openMap());
  await page.waitForTimeout(900);
  await shot(page, join(outDir, 'map.png'));
  const mapVisible = await page.evaluate(() => {
    const screen = document.getElementById('map-screen');
    return screen ? getComputedStyle(screen).display !== 'none' : false;
  });
  if (!mapVisible) failures.push('карта не открылась');
  console.log(`→ карта ${mapVisible ? 'открыта' : 'не открылась'}`);
  await page.evaluate(() => window.__game.closeMap());
  await page.waitForTimeout(400);

  // Ночной кадр — заодно проверяем, что смена суток не роняет шейдеры.
  await page.evaluate(() => {
    window.__game.teleport(-470, 40);
    window.__game.look(0.47, 0);
    window.__game.setTimeOfDay(0.02);
  });
  await page.waitForTimeout(2000);
  await shot(page, join(outDir, 'night-elf.png'));
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
