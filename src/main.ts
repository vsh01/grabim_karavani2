import { Game } from './game';
import { ZONES, Zone, zoneAt } from './world/zones';
import { Faction } from './data/factions';
import type { BodyPart } from './entities/body';
import { StartMenu } from './ui/startMenu';

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

  // Выбор судьбы до постройки мира: от него зависит и место старта, и справа.
  // Автотесты и ссылка с ?faction=… проходят меню насквозь.
  const requested = new URLSearchParams(location.search).get('faction');
  const skipMenu = requested !== null;

  let choice = { faction: (requested as Faction) ?? Faction.Elves, name: '' };
  if (!skipMenu) {
    if (bootStatus) bootStatus.textContent = 'Кем будете?';
    const menu = new StartMenu();
    boot?.classList.add('hidden');
    choice = await menu.choose();
    boot?.classList.remove('hidden');
  }

  const game = await Game.create({
    seed: WORLD_SEED,
    container,
    progress: report,
    faction: choice.faction,
    characterName: choice.name || undefined,
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
      lookAt(x: number, z: number, pitch?: number): void {
        game.debugLookAt(x, z, pitch);
      },
      setTimeOfDay(time: number): void {
        game.sky.time = time;
        game.sky.update(0);
      },
      spawnEnemy(distance: number, faction: Faction = Faction.Palace, weapon = 'sword'): number {
        return game.spawnEnemyAhead(distance, faction, weapon).id;
      },
      attack(): void {
        game.debugAttack();
      },
      aimAt(actorId: number, part: BodyPart): boolean {
        return game.debugAimAt(actorId, part);
      },
      aimAtNearest(part: BodyPart, radius?: number): number | null {
        return game.debugAimAtNearest(part, radius);
      },
      approachNearest(part: BodyPart, radius?: number): number | null {
        return game.debugApproachNearest(part, radius);
      },
      healPlayer(): void {
        game.debugHealPlayer();
      },
      bandage(): void {
        game.debugBandage();
      },
      loot(): void {
        game.debugInteract();
      },
      give(id: string, count = 1, equip = false): void {
        game.debugGive(id, count, equip);
      },
      hurt(part: BodyPart, amount: number, type: 'cut' | 'blunt' | 'pierce' = 'cut'): void {
        game.debugHurtPlayer(part, amount, type);
      },
      player() {
        return game.playerReport();
      },
      population() {
        return game.populationReport();
      },
      economy() {
        return game.economyReport();
      },
      spawnCaravan(routeId?: string) {
        return game.debugSpawnCaravan(routeId);
      },
      goToCaravan() {
        return game.debugGoToCaravan();
      },
      nearestCaravan() {
        return game.debugNearestCaravan();
      },
      hint(): string | null {
        return game.debugInteractionHint();
      },
      messages(): string[] {
        return game.debugMessages();
      },
      openTrade(siteId: string): boolean {
        return game.debugOpenTrade(siteId);
      },
      closeTrade(): void {
        game.closeTrade();
      },
      takeOrder(): void {
        game.takeOrder();
      },
      squadOrder(order: 'follow' | 'hold' | 'attack'): void {
        game.setSquadOrder(order);
      },
      launchRaid(planId?: string) {
        return game.debugLaunchRaid(planId);
      },
      factions() {
        return game.factionReport();
      },
      save(slot = 1): boolean {
        return game.saveToSlot(slot);
      },
      load(slot = 1): boolean {
        return game.loadFromSlot(slot);
      },
      slots() {
        return game.saveSlots();
      },
      openMap(): void {
        game.openMap();
      },
      closeMap(): void {
        game.closeMap();
      },
      onRoad(): boolean {
        const position = game.player.position;
        return game.roads.isOnRoad(position.x, position.z);
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
