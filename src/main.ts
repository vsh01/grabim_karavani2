import { Game } from './game';
import { ZONES, Zone, zoneAt } from './world/zones';

/** Сид мира. Одно число — и весь ландшафт, лес и постройки те же самые. */
const WORLD_SEED = 20260816;

const boot = document.getElementById('boot');
const bootBar = document.getElementById('boot-bar');
const bootStatus = document.getElementById('boot-status');
const bootError = document.getElementById('boot-err');

/** Отдать кадр браузеру, чтобы полоска загрузки успела перерисоваться. */
function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

async function report(percent: number, message: string): Promise<void> {
  if (bootBar) bootBar.style.width = `${percent}%`;
  if (bootStatus) bootStatus.textContent = message;
  await nextFrame();
  await nextFrame();
}

function fail(error: unknown): void {
  const text = error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error);
  if (bootStatus) bootStatus.textContent = 'Мир не поднялся';
  if (bootError) bootError.textContent = text;
  console.error('[грабим корованы] не удалось запустить игру', error);
}

async function main(): Promise<void> {
  const container = document.getElementById('app');
  if (!container) throw new Error('Не найден контейнер #app');

  const game = await Game.create({
    seed: WORLD_SEED,
    container,
    progress: report,
  });

  game.start();
  boot?.classList.add('hidden');
  window.setTimeout(() => boot?.remove(), 800);

  // Небольшой служебный интерфейс: им пользуются автотесты, которые обходят
  // все четыре зоны, снимают скриншоты и меряют частоту кадров.
  Object.defineProperty(window, '__game', {
    value: {
      ready: true,
      teleport(x: number, z: number): void {
        game.player.teleport(x, z, game.terrain);
        game.forest.update(game.player.position, true);
      },
      goToZone(zone: Zone): void {
        const info = ZONES[zone];
        game.player.teleport(info.center.x, info.center.z, game.terrain);
        game.forest.update(game.player.position, true);
      },
      /** Направить взгляд: рыскание и наклон в радианах. */
      look(yaw: number, pitch = 0): void {
        game.player.yaw = yaw;
        game.player.pitch = pitch;
      },
      setTimeOfDay(time: number): void {
        game.sky.time = time;
        game.sky.update(0);
      },
      stats() {
        const position = game.player.position;
        return {
          fps: game.currentFps,
          position: { x: position.x, y: position.y, z: position.z },
          zone: ZONES[zoneAt(position.x, position.z)].name,
          forest: game.forest.stats(),
          drawCalls: game.renderer.info.render.calls,
          triangles: game.renderer.info.render.triangles,
        };
      },
    },
    writable: false,
  });

  console.info('[грабим корованы] мир готов, деревьев посажено:', game.forest.totalTrees);
}

main().catch(fail);
