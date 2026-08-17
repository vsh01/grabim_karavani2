import * as THREE from 'three';
import { Input } from './core/input';
import { clamp } from './core/math';
import { Terrain } from './world/terrain';
import { Forest } from './world/forest';
import { Sky } from './world/sky';
import { ZONES, zoneAt } from './world/zones';
import { RoadNetwork } from './world/roads';
import { Player } from './entities/player';
import { BodyPart, LIMBS, PART_NAMES } from './entities/body';
import { Actor } from './entities/actor';
import { CollisionWorld } from './systems/physics';
import { BloodEffects } from './systems/effects';
import { CombatSystem, type CombatEvent, type CombatTargets } from './systems/combat';
import { Population, populateWorld } from './systems/population';
import type { AiWorld } from './systems/ai';
import { Caravan } from './entities/caravan';
import { CaravanSystem } from './systems/caravans';
import { Economy, MARKETS, marketAt, stackValue, type Market } from './systems/economy';
import { Reputation } from './systems/reputation';
import { TradeScreen } from './ui/tradeScreen';
import { tryItem, type ItemDef } from './data/items';
import { Faction, FACTIONS } from './data/factions';
import { getSite } from './world/sites';
import { DebugHud } from './ui/debugHud';
import { Hud } from './ui/hud';
import { DamageOverlay } from './ui/damageOverlay';

export type ProgressReporter = (percent: number, message: string) => Promise<void>;

export interface GameOptions {
  seed: number;
  container: HTMLElement;
  progress: ProgressReporter;
}

/** Точка, с которой начинается игра, — опушка леса эльфов. */
const SPAWN = { x: -470, z: 40 };

/** На каком расстоянии можно обыскать труп или заговорить. */
const INTERACT_RANGE = 2.6;
/** Телега большая — до неё дотягиваемся дальше. */
const CARAVAN_RANGE = 4.5;
/** Сколько берёт лекарь за полное лечение. */
const HEAL_COST = 45;

/** Что сейчас под прицелом и что случится по нажатию E. */
type Interaction =
  | null
  | { kind: 'corpse'; actor: Actor }
  | { kind: 'caravan'; caravan: Caravan }
  | { kind: 'trade'; actor: Actor; market: Market };

/**
 * Игра целиком: сцена, мир, игрок, бой и главный цикл.
 * Дальше сюда добавятся корованы, торговля и фракционные кампании.
 */
export class Game {
  readonly scene = new THREE.Scene();
  readonly renderer: THREE.WebGLRenderer;
  readonly input: Input;
  readonly colliders = new CollisionWorld();
  readonly sky = new Sky();
  readonly debug = new DebugHud();
  readonly hud = new Hud();
  readonly overlay = new DamageOverlay();
  readonly blood = new BloodEffects();
  readonly trade = new TradeScreen();
  readonly economy = new Economy();

  terrain!: Terrain;
  forest!: Forest;
  roads!: RoadNetwork;
  player!: Player;
  population!: Population;
  combat!: CombatSystem;
  caravans!: CaravanSystem;
  reputation!: Reputation;

  private running = false;
  private lastTime = 0;
  private frameTimes: number[] = [];
  private fps = 0;
  private readonly lockOverlay: HTMLDivElement;
  private readonly tint = new THREE.Color();
  private targets!: CombatTargets;
  private aiWorld!: AiWorld;
  private interaction: Interaction = null;

  private constructor(private readonly options: GameOptions) {
    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      powerPreference: 'high-performance',
      stencil: false,
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.setClearColor(0x0a0d0b, 1);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    options.container.appendChild(this.renderer.domElement);

    this.input = new Input(this.renderer.domElement);
    this.lockOverlay = this.createLockOverlay();

    this.scene.fog = this.sky.fog;
    this.scene.add(this.sky.group);
    this.scene.add(this.blood.points);

    window.addEventListener('resize', this.handleResize);
  }

  static async create(options: GameOptions): Promise<Game> {
    const game = new Game(options);
    await game.buildWorld();
    return game;
  }

  private async buildWorld(): Promise<void> {
    const { progress, seed } = this.options;

    await progress(8, 'Поднимаем горы и роем долины…');
    this.terrain = new Terrain();

    await progress(20, 'Прокладываем тракты…');
    // Дороги режут рельеф под себя, поэтому строятся до того, как земля
    // превращается в геометрию, и до того, как высажен лес.
    this.roads = new RoadNetwork(this.terrain);
    this.roads.carveInto(this.terrain);
    this.terrain.roadMask = (x, z) => this.roads.maskAt(x, z);

    await progress(30, 'Режем землю на куски…');
    this.scene.add(this.terrain.build());

    await progress(44, 'Сажаем лес…');
    this.forest = new Forest(this.terrain, seed, this.roads);

    await progress(66, 'Фотографируем деревья для дальнего плана…');
    this.forest.build(this.renderer);
    this.scene.add(this.forest.group);

    await progress(80, 'Расселяем эльфов, стражу и разбойников…');
    this.population = new Population(this.terrain);
    populateWorld(this.population, this.terrain, this.forest, seed);
    this.spawnMerchants();
    this.scene.add(this.population.group);

    await progress(92, 'Точим оружие…');
    this.player = new Player(SPAWN.x, SPAWN.z, this.terrain);
    this.player.yaw = Math.PI * 0.15;
    this.player.faction = Faction.Elves;
    this.player.characterName = 'Безымянный';
    this.reputation = new Reputation(this.player.faction);
    this.giveStartingKit();

    this.combat = new CombatSystem(this.terrain, this.blood, this.handleCombatEvent);
    this.scene.add(this.combat.group);

    await progress(97, 'Выпускаем корованы на тракт…');
    this.caravans = new CaravanSystem(this.roads, this.terrain, this.population, seed);
    this.scene.add(this.caravans.group);
    // Первый обоз выходит сразу, чтобы дорога не была пустой на старте.
    this.caravans.spawnCaravan();

    this.targets = { actors: this.population.actors, player: this.player };
    this.aiWorld = {
      terrain: this.terrain,
      forest: this.forest,
      actors: this.population.actors,
      player: this.player,
      combat: this.combat,
      targets: this.targets,
      playerHostility: (faction) => this.reputation.hostilityTowardsPlayer(faction, this.player.faction),
    };

    this.forest.update(this.player.position, true);
    await progress(100, 'Готово');
  }

  /** Поставить по торговцу на каждый прилавок. */
  private spawnMerchants(): void {
    for (const market of MARKETS) {
      const site = getSite(market.siteId);
      const merchant = this.population.spawn({
        faction: market.owner,
        x: site.x + 6,
        z: site.z + 6,
        role: 'merchant',
        name: market.healer ? 'торговец и лекарь' : 'скупщик',
        weapon: 'dagger',
        gold: 400,
        shopSiteId: market.siteId,
      });
      merchant.homeRadius = 4;
    }
  }

  private giveStartingKit(): void {
    const inventory = this.player.inventory;
    inventory.add('sword');
    inventory.add('bow');
    inventory.add('leather');
    inventory.add('bandage', 4);
    inventory.add('salve', 1);
    inventory.add('arrow', 24);
    inventory.equippedWeapon = 'sword';
    inventory.equippedArmor = 'leather';
    inventory.gold = 65;
  }

  private createLockOverlay(): HTMLDivElement {
    const overlay = document.createElement('div');
    overlay.id = 'lock-overlay';
    overlay.style.cssText = [
      'position:fixed',
      'inset:0',
      'display:flex',
      'flex-direction:column',
      'align-items:center',
      'justify-content:center',
      'gap:10px',
      'background:rgba(6,10,8,0.55)',
      'backdrop-filter:blur(2px)',
      'color:#e8e2d0',
      'font:16px/1.6 "Trebuchet MS",system-ui,sans-serif',
      'cursor:pointer',
      'z-index:20',
      'text-align:center',
    ].join(';');
    overlay.innerHTML = `
      <div style="font-size:24px;letter-spacing:0.05em;color:#d9b45a">Нажмите, чтобы играть</div>
      <div style="opacity:0.8">WASD — идти · Shift — бежать · Пробел — прыжок · мышь — смотреть</div>
      <div style="opacity:0.8">ЛКМ — удар · R — перевязать · E — обыскать и торговать · Tab — мешок</div>
      <div style="opacity:0.5;font-size:13px">Esc — освободить курсор · F3 — служебная панель</div>
    `;
    overlay.addEventListener('click', () => this.input.requestPointerLock());
    document.body.appendChild(overlay);

    this.input.onPointerLockChange((locked) => {
      // Пока открыт прилавок, заставка «нажмите, чтобы играть» только мешает.
      overlay.style.display = locked || this.trade.isOpen ? 'none' : 'flex';
      this.input.enabled = locked;
    });

    return overlay;
  }

  private handleResize = (): void => {
    const width = window.innerWidth;
    const height = window.innerHeight;
    this.renderer.setSize(width, height);
    this.blood.setViewportHeight(this.renderer.domElement.height);
    if (this.player) {
      this.player.camera.aspect = width / height;
      this.player.camera.updateProjectionMatrix();
    }
  };

  start(): void {
    if (this.running) return;
    this.running = true;
    this.handleResize();
    this.lastTime = performance.now();
    this.hud.log('Лес эльфов. Осмотритесь.', 'plain');
    requestAnimationFrame(this.frame);
  }

  stop(): void {
    this.running = false;
  }

  private frame = (now: number): void => {
    if (!this.running) return;
    requestAnimationFrame(this.frame);

    const rawDelta = (now - this.lastTime) / 1000;
    this.lastTime = now;
    // Вкладка была свёрнута — не даём миру прыгнуть на секунду вперёд.
    const dt = clamp(rawDelta, 0.0005, 0.05);

    this.trackFps(rawDelta);
    this.update(dt);
    this.render();
    this.input.endFrame();
  };

  private trackFps(delta: number): void {
    this.frameTimes.push(delta);
    if (this.frameTimes.length > 45) this.frameTimes.shift();
    let sum = 0;
    for (const value of this.frameTimes) sum += value;
    this.fps = sum > 0 ? this.frameTimes.length / sum : 0;
  }

  private update(dt: number): void {
    if (this.input.justPressedRaw('F3')) this.debug.toggle();

    this.combat.beginFrame();
    this.sky.update(dt);

    this.handlePlayerActions();

    this.player.update(dt, this.input, {
      terrain: this.terrain,
      forest: this.forest,
      colliders: this.colliders,
      roads: this.roads,
    });

    this.population.update(dt, this.aiWorld, this.player.position);
    this.caravans.update(dt);
    this.economy.update(dt);
    this.combat.update(dt, this.targets);
    this.blood.update(dt, (x, z) => this.terrain.heightAt(x, z));

    this.sky.follow(this.player.camera);
    this.forest.update(this.player.position);

    // Дальний лес красим тем же светом, что и всё остальное.
    this.tint.setScalar(1).lerp(new THREE.Color(0x2c3a55), 1 - this.sky.daylight);
    this.forest.syncAtmosphere(this.sky.fog.color, this.sky.fog.near, this.sky.fog.far, this.tint);

    this.updateInterface(dt);
  }

  /** Обработка того, что игрок нажал: удар, перевязка, обыск, смена оружия. */
  private handlePlayerActions(): void {
    // Пока открыт мешок или прилавок, мир ждёт: бить и ходить нельзя.
    if (this.trade.isOpen) {
      if (this.input.justPressedRaw('Escape') || this.input.justPressedRaw('Tab')) this.closeTrade();
      return;
    }

    if (!this.player.wounds.alive) {
      if (this.input.justPressedRaw('Space')) this.respawn();
      return;
    }

    if (this.input.justPressed('Tab')) this.openBag();
    if (this.input.mouseJustPressed(0)) this.attack();
    if (this.input.justPressed('KeyR')) this.bandage();
    if (this.input.justPressed('KeyE')) this.interact();

    for (let i = 0; i < 4; i++) {
      if (this.input.justPressed(`Digit${i + 1}`)) this.selectWeapon(i);
    }
  }

  private attack(): void {
    const weapon = this.player.inventory.weapon;

    if (weapon.weapon?.ranged) {
      if (!this.player.wounds.canUseTwoHanded) {
        this.hud.log('Одной рукой лук не натянуть', 'bad');
        return;
      }
      if (!this.combat.playerShoot(this.player)) this.hud.log('Стрелы кончились', 'bad');
      return;
    }

    if (!this.player.wounds.canFight) {
      this.hud.log('Драться нечем — рук не осталось', 'alarm');
      return;
    }
    this.combat.playerMelee(this.player, this.targets);
  }

  private bandage(): void {
    if (!this.player.wounds.isBleeding) {
      this.hud.log('Кровотечения нет', 'plain');
      return;
    }
    if (!this.player.inventory.remove('bandage', 1)) {
      this.hud.log('Бинтов не осталось!', 'alarm');
      return;
    }
    const part = this.player.wounds.bandage();
    this.hud.log(part ? `Перевязано: ${PART_NAMES[part]}` : 'Перевязано', 'good');
  }

  /** Нажали E: обыскать труп, ограбить корован или заговорить с торговцем. */
  private interact(): void {
    const target = this.interaction;
    if (!target) return;

    if (target.kind === 'corpse') {
      this.lootCorpse(target.actor);
      return;
    }
    if (target.kind === 'caravan') {
      this.plunderCaravan(target.caravan);
      return;
    }
    this.openTrade(target.market);
  }

  private lootCorpse(target: Actor): void {
    const loot = target.lootTable();
    this.player.inventory.gold += loot.gold;
    for (const id of loot.items) this.player.inventory.add(id);

    target.inventory.gold = 0;
    target.inventory.stacks.length = 0;

    this.hud.log(
      loot.gold > 0 || loot.items.length > 0
        ? `Обыскали: ${loot.gold} золота${loot.items.length > 0 ? `, вещей — ${loot.items.length}` : ''}`
        : 'Ничего ценного',
      'good',
    );
  }

  /**
   * Ограбить корован.
   *
   * Это не только мешки в карман. Хозяин обоза запомнит, маршрут станет опаснее,
   * а в городе, куда груз не доехал, на него подскочит цена — и продать его там
   * будет выгоднее всего, но и искать вас будут именно там.
   */
  private plunderCaravan(caravan: Caravan): void {
    const loot = caravan.plunder();
    const value = stackValue(loot.cargo);

    this.player.inventory.gold += loot.gold;
    for (const entry of loot.cargo) this.player.inventory.add(entry.id, entry.count);

    this.economy.registerLostCargo(caravan.toSite, loot.cargo);
    this.caravans.registerRobbery(caravan);

    // Обиделся хозяин груза; те, кто с ним враждует, наоборот, довольны.
    this.reputation.change(caravan.owner, -22);
    if (caravan.owner !== Faction.Neutral) this.reputation.change(Faction.Neutral, -6);

    const goods = loot.cargo.map((entry) => `${tryItem(entry.id)?.name ?? entry.id} ×${entry.count}`).join(', ');
    this.hud.log(`Корован ограблен: ${loot.gold} золота${goods ? `, ${goods}` : ''}`, 'good');
    this.hud.log(
      `${FACTIONS[caravan.owner].name}: отношение ухудшилось (${this.reputation.describe(caravan.owner)})`,
      'bad',
    );

    const best = this.economy.bestMarketFor(loot.cargo[0]?.id ?? 'grain', this.reputation);
    if (best && value > 0) {
      this.hud.log(`Сбыть добычу дороже всего в: ${best.market.name}`, 'plain');
    }
  }

  private selectWeapon(index: number): void {
    const weapons = this.player.inventory.availableWeapons();
    const chosen = weapons[index];
    if (!chosen) return;
    if (chosen.weapon?.twoHanded && !this.player.wounds.canUseTwoHanded) {
      this.hud.log(`${chosen.name}: нужны обе руки`, 'bad');
      return;
    }
    this.player.inventory.equippedWeapon = chosen.id;
    this.hud.log(`В руках: ${chosen.name}`, 'plain');
  }

  /** Событие боя: журнал, брызги, отрубленные конечности на земле. */
  private handleCombatEvent = (event: CombatEvent): void => {
    if (event.victimIsPlayer) {
      this.overlay.hit(0.12 + event.damage * 0.006);
      if (event.severed) {
        this.hud.log(`${event.attackerName}: ${event.message}`, 'alarm');
        this.hud.log('Перевяжитесь, иначе истечёте кровью — R', 'alarm');
      } else if (event.killed) {
        this.hud.log(event.message, 'alarm');
      } else if (event.damage > 0) {
        this.hud.log(`${event.attackerName} бьёт: ${PART_NAMES[event.part]}`, 'bad');
      }
      return;
    }

    const victim = event.victim;
    if (!victim) return;

    if (event.severed && LIMBS.includes(event.part)) {
      this.population.dropLimb(victim, event.part, event.position.x, event.position.y, event.position.z);
    }

    if (event.killed) {
      this.hud.log(`${victim.name} убит`, 'good');
    } else if (event.severed) {
      this.hud.log(`${victim.name}: ${event.message}`, 'good');
    } else if (event.damage > 0 && event.attackerName === this.player.characterName) {
      this.hud.log(`Попадание: ${PART_NAMES[event.part]} (${Math.round(event.damage)})`, 'plain');
    }
  };

  private respawn(): void {
    this.player.wounds.heal(200);
    for (const part of [...LIMBS, BodyPart.LeftEye, BodyPart.RightEye]) {
      const status = this.player.wounds.get(part);
      status.severed = false;
      status.prosthetic = false;
      status.hp = status.maxHp;
      status.bleeding = 0;
    }
    this.player.wounds.blood = 100;
    this.player.wounds.alive = true;
    this.player.wounds.deathCause = null;
    this.player.syncWithWounds();
    this.player.teleport(SPAWN.x, SPAWN.z, this.terrain);
    this.player.inventory.add('bandage', 2);
    this.hud.log('Вы очнулись на опушке. Кто-то вас перевязал.', 'good');
  }

  private updateInterface(dt: number): void {
    this.findInteractionTarget();

    const position = this.player.position;
    this.hud.update(dt, {
      wounds: this.player.wounds,
      inventory: this.player.inventory,
      mode: this.player.mode,
      interactionHint: this.interactionHint(),
      zoneName: ZONES[zoneAt(position.x, position.z)].name,
      clock: this.sky.clockLabel,
    });

    this.overlay.update(dt, this.player.wounds);
    this.updateDebug();
  }

  /**
   * Что сейчас в пределах вытянутой руки.
   * Порядок важен: телега перекрывает труп, а живой торговец — обоих.
   */
  private findInteractionTarget(): void {
    const { x, z } = this.player.position;

    const merchant = this.population.nearest(
      x,
      z,
      INTERACT_RANGE + 1.4,
      (actor) => actor.alive && actor.shopSiteId !== null,
    );
    if (merchant?.shopSiteId) {
      const market = marketAt(merchant.shopSiteId);
      if (market) {
        this.interaction = { kind: 'trade', actor: merchant, market };
        return;
      }
    }

    const caravan = this.caravans.nearestPlunderable(x, z, CARAVAN_RANGE);
    if (caravan) {
      this.interaction = { kind: 'caravan', caravan };
      return;
    }

    const corpse = this.population.nearest(x, z, INTERACT_RANGE, (actor) => !actor.alive);
    this.interaction = corpse ? { kind: 'corpse', actor: corpse } : null;
  }

  private interactionHint(): string | null {
    const target = this.interaction;
    if (!target) return null;

    if (target.kind === 'corpse') return `E — обыскать (${target.actor.name})`;
    if (target.kind === 'caravan') return `E — ограбить корован (${target.caravan.describeCargo()})`;
    if (!this.reputation.willTrade(target.market.owner)) return `${target.market.name}: с вами не торгуют`;
    return `E — торговать (${target.market.name})`;
  }

  // ── Торговля ───────────────────────────────────────────────────────────────

  /** Открыть просто мешок, без прилавка. */
  openBag(): void {
    this.showTradeScreen(undefined);
  }

  openTrade(market: Market): void {
    if (!this.reputation.willTrade(market.owner)) {
      this.hud.log(`${market.name}: с вами не желают иметь дела`, 'bad');
      return;
    }
    this.showTradeScreen(market);
  }

  private showTradeScreen(market: Market | undefined): void {
    this.player.controlEnabled = false;

    this.trade.open({
      inventory: this.player.inventory,
      wounds: this.player.wounds,
      economy: this.economy,
      reputation: this.reputation,
      market,
      healCost: HEAL_COST,
      actions: {
        buy: (def) => this.buyItem(def, market),
        sell: (def) => this.sellItem(def, market),
        use: (def) => this.useItem(def),
        equip: (def) => this.equipItem(def),
        heal: () => this.buyHealing(market),
        close: () => this.closeTrade(),
      },
    });

    // Указатель освобождаем после открытия: обработчик захвата смотрит на
    // trade.isOpen и не показывает заставку поверх прилавка.
    this.input.exitPointerLock();
    this.lockOverlay.style.display = 'none';
  }

  closeTrade(): void {
    this.trade.close();
    this.player.syncWithWounds();
    this.lockOverlay.style.display = 'flex';
  }

  private buyItem(def: ItemDef, market: Market | undefined): void {
    if (!market) return;
    const price = this.economy.buyPrice(def.id, market.siteId, this.reputation);
    if (this.player.inventory.gold < price) {
      this.hud.log('Не хватает золота', 'bad');
      return;
    }

    this.player.inventory.gold -= price;
    this.player.inventory.add(def.id);
    this.hud.log(`Куплено: ${def.name} за ${price}`, 'plain');

    // Протез покупают не в мешок, а сразу на себя.
    if (def.prostheticFor || def.wheelchair) this.useItem(def);
  }

  private sellItem(def: ItemDef, market: Market | undefined): void {
    if (!market) return;
    if (!this.player.inventory.remove(def.id, 1)) return;

    const price = this.economy.sellPrice(def.id, market.siteId, this.reputation);
    this.player.inventory.gold += price;

    if (this.player.inventory.equippedWeapon === def.id && !this.player.inventory.has(def.id)) {
      this.player.inventory.equippedWeapon = 'fists';
    }
    if (this.player.inventory.equippedArmor === def.id && !this.player.inventory.has(def.id)) {
      this.player.inventory.equippedArmor = null;
    }

    this.hud.log(`Продано: ${def.name} за ${price}`, 'plain');
  }

  /** Применить предмет: перевязка, мазь, протез, коляска. */
  private useItem(def: ItemDef): void {
    const wounds = this.player.wounds;

    if (def.wheelchair) {
      if (!this.player.inventory.remove(def.id, 1)) return;
      wounds.hasWheelchair = true;
      this.player.syncWithWounds();
      this.hud.log('Коляска собрана. По тракту снова можно двигаться.', 'good');
      return;
    }

    if (def.prostheticFor) {
      const part = this.findPartForProsthetic(def.prostheticFor);
      if (!part) {
        this.hud.log(`${def.name}: ставить некуда`, 'bad');
        return;
      }
      if (!this.player.inventory.remove(def.id, 1)) return;
      wounds.attachProsthetic(part);
      this.player.syncWithWounds();
      this.hud.log(`${PART_NAMES[part]}: поставлен протез (${def.name})`, 'good');
      return;
    }

    if (def.bandage) {
      if (!wounds.isBleeding) {
        this.hud.log('Кровотечения нет', 'plain');
        return;
      }
      if (!this.player.inventory.remove(def.id, 1)) return;
      const part = wounds.bandage();
      this.hud.log(part ? `Перевязано: ${PART_NAMES[part]}` : 'Перевязано', 'good');
      return;
    }

    if (def.heal) {
      if (!this.player.inventory.remove(def.id, 1)) return;
      wounds.heal(def.heal);
      this.player.syncWithWounds();
      this.hud.log(`${def.name}: раны затянулись`, 'good');
    }
  }

  /** Куда поставить протез: ищем подходящую отрубленную часть. */
  private findPartForProsthetic(kind: 'arm' | 'leg' | 'eye'): BodyPart | null {
    const candidates =
      kind === 'arm'
        ? [BodyPart.RightArm, BodyPart.LeftArm]
        : kind === 'leg'
          ? [BodyPart.RightLeg, BodyPart.LeftLeg]
          : [BodyPart.RightEye, BodyPart.LeftEye];

    for (const part of candidates) {
      const status = this.player.wounds.get(part);
      if (status.severed && !status.prosthetic) return part;
    }
    return null;
  }

  private equipItem(def: ItemDef): void {
    if (def.kind === 'armor') {
      this.player.inventory.equippedArmor = def.id;
      this.hud.log(`Надето: ${def.name}`, 'plain');
      return;
    }
    if (def.weapon?.twoHanded && !this.player.wounds.canUseTwoHanded) {
      this.hud.log(`${def.name}: нужны обе руки`, 'bad');
      return;
    }
    this.player.inventory.equippedWeapon = def.id;
    this.hud.log(`В руках: ${def.name}`, 'plain');
  }

  private buyHealing(market: Market | undefined): void {
    if (!market?.healer) return;
    const wounds = this.player.wounds;
    if (wounds.vitality >= 0.999 && !wounds.isBleeding) return;
    if (this.player.inventory.gold < HEAL_COST) {
      this.hud.log('Не хватает золота на лекаря', 'bad');
      return;
    }

    this.player.inventory.gold -= HEAL_COST;
    wounds.heal(200);
    this.player.syncWithWounds();
    this.hud.log('Лекарь заштопал раны. Отрубленное он вернуть не может.', 'good');
  }

  private updateDebug(): void {
    if (!this.debug.isVisible) return;
    const stats = this.forest.stats();
    const position = this.player.position;
    this.debug.update({
      fps: this.fps,
      zone: ZONES[zoneAt(position.x, position.z)].name,
      x: position.x,
      y: position.y,
      z: position.z,
      clock: this.sky.clockLabel,
      lod0: stats.lod0,
      lod1: stats.lod1,
      impostors: stats.impostors,
      totalTrees: stats.total,
      drawCalls: this.renderer.info.render.calls,
      triangles: this.renderer.info.render.triangles,
      actors: this.population.aliveCount,
      corpses: this.population.corpseCount,
    });
  }

  private render(): void {
    this.renderer.render(this.scene, this.player.camera);
  }

  /** Средняя частота кадров за последние кадры — для автотестов. */
  get currentFps(): number {
    return this.fps;
  }

  // ── Служебный доступ для автотестов ────────────────────────────────────────
  // Игра проверяется в настоящем браузере, а без указателя мыши в захвате
  // обычный ввод не читается. Поэтому те же действия продублированы методами.

  /** Поставить противника прямо перед игроком. */
  spawnEnemyAhead(distance: number, faction: Faction, weapon = 'sword'): Actor {
    const forward = this.player.getForward(new THREE.Vector3());
    const x = this.player.position.x + forward.x * distance;
    const z = this.player.position.z + forward.z * distance;

    const enemy = this.population.spawn({ faction, x, z, weapon, armor: 'leather', role: 'patrol', gold: 25 });
    enemy.yaw = this.player.yaw + Math.PI;
    return enemy;
  }

  /** Нанести удар от лица игрока. */
  debugAttack(): void {
    this.attack();
  }

  /**
   * Навести прицел точно на часть тела указанного персонажа.
   * Так проверяется главное обещание боя: можно целиться в руку и отрубить
   * именно её.
   */
  debugAimAt(actorId: number, part: BodyPart): boolean {
    const actor = this.population.actors.find((candidate) => candidate.id === actorId);
    if (!actor) return false;

    const aim = new THREE.Vector3();
    if (!actor.getPartPosition(part, aim)) return false;

    const eye = this.player.getEyePosition(new THREE.Vector3());
    aim.sub(eye);
    const length = aim.length();
    if (length < 1e-4) return false;

    this.player.yaw = Math.atan2(-aim.x, -aim.z);
    this.player.pitch = Math.asin(aim.y / length);
    return true;
  }

  debugBandage(): void {
    this.bandage();
  }

  debugInteract(): void {
    this.findInteractionTarget();
    this.interact();
  }

  /** Выдать предмет и, если нужно, сразу взять его в руки. */
  debugGive(id: string, count = 1, equip = false): void {
    this.player.inventory.add(id, count);
    if (equip) this.player.inventory.equippedWeapon = id;
  }

  /** Ранить игрока в конкретную часть тела — для проверки увечий. */
  debugHurtPlayer(part: BodyPart, amount: number, type: 'cut' | 'blunt' | 'pierce' = 'cut'): void {
    const report = this.player.wounds.damage(part, amount, { type });
    this.player.syncWithWounds();
    this.overlay.hit(0.3);
    this.hud.log(report.message, report.severed ? 'alarm' : 'bad');
  }

  /** Сводка состояния игрока для проверок. */
  playerReport(): Record<string, unknown> {
    const wounds = this.player.wounds;
    return {
      alive: wounds.alive,
      blood: wounds.blood,
      vitality: wounds.vitality,
      bleeding: wounds.isBleeding,
      secondsUntilBleedOut: wounds.secondsUntilBleedOut,
      movementMode: wounds.movementMode,
      visionLoss: wounds.visionLoss,
      injuries: wounds.describeInjuries(),
      gold: this.player.inventory.gold,
      bandages: this.player.inventory.count('bandage'),
      weapon: this.player.inventory.weapon.name,
    };
  }

  /** Полностью вылечить игрока — чтобы автотест мог довести бой до конца. */
  debugHealPlayer(): void {
    this.player.wounds.heal(300);
    this.player.wounds.blood = 100;
    this.player.syncWithWounds();
  }

  /**
   * Навести прицел на ближайшего живого противника.
   * Возвращает его номер или null, если рядом никого нет.
   */
  debugAimAtNearest(part: BodyPart, radius = 14): number | null {
    const target = this.population.nearest(
      this.player.position.x,
      this.player.position.z,
      radius,
      (actor) => actor.alive && actor.shopSiteId === null,
    );
    if (!target) return null;
    return this.debugAimAt(target.id, part) ? target.id : null;
  }

  /**
   * Подойти вплотную к ближайшему противнику и прицелиться.
   *
   * В обычной игре к цели подходят ногами; автотесту негде нажимать W, а
   * ближний бой достаёт всего на два метра — поэтому сближение вынесено сюда.
   */
  debugApproachNearest(part: BodyPart, radius = 40): number | null {
    const target = this.population.nearest(
      this.player.position.x,
      this.player.position.z,
      radius,
      (actor) => actor.alive && actor.shopSiteId === null,
    );
    if (!target) return null;

    // Встаём в полутора метрах от цели, со стороны, откуда пришли.
    const dx = this.player.position.x - target.position.x;
    const dz = this.player.position.z - target.position.z;
    const length = Math.hypot(dx, dz) || 1;
    this.player.teleport(
      target.position.x + (dx / length) * 1.5,
      target.position.z + (dz / length) * 1.5,
      this.terrain,
    );

    return this.debugAimAt(target.id, part) ? target.id : null;
  }

  /** Выпустить корован немедленно и вернуть его сводку. */
  debugSpawnCaravan(routeId?: string): Record<string, unknown> | null {
    const caravan = this.caravans.spawnCaravan(routeId);
    if (!caravan) return null;
    return this.describeCaravan(caravan);
  }

  /** Перенести игрока к ближайшему обозу. */
  debugGoToCaravan(): Record<string, unknown> | null {
    const caravan = this.caravans.nearest(this.player.position.x, this.player.position.z);
    if (!caravan) return null;

    this.player.teleport(caravan.position.x + 6, caravan.position.z + 6, this.terrain);
    this.debugLookAtCaravan(caravan);
    this.forest.update(this.player.position, true);
    return this.describeCaravan(caravan);
  }

  private debugLookAtCaravan(caravan: Caravan): void {
    const dx = caravan.position.x - this.player.position.x;
    const dz = caravan.position.z - this.player.position.z;
    this.player.yaw = Math.atan2(-dx, -dz);
    this.player.pitch = -0.05;
  }

  /** Сводка по ближайшему обозу, без перемещения игрока. */
  debugNearestCaravan(): Record<string, unknown> | null {
    const caravan = this.caravans.nearest(this.player.position.x, this.player.position.z);
    return caravan ? this.describeCaravan(caravan) : null;
  }

  /** Обыскать ближайшую телегу, до которой дотягиваемся. */
  debugPlunder(): boolean {
    const caravan = this.caravans.nearestPlunderable(
      this.player.position.x,
      this.player.position.z,
      CARAVAN_RANGE + 6,
    );
    if (!caravan) return false;
    this.plunderCaravan(caravan);
    return true;
  }

  /** Открыть прилавок указанного узла, где бы игрок ни стоял. */
  debugOpenTrade(siteId: string): boolean {
    const market = marketAt(siteId);
    if (!market) return false;
    this.openTrade(market);
    return true;
  }

  private describeCaravan(caravan: Caravan): Record<string, unknown> {
    return {
      id: caravan.id,
      owner: caravan.owner,
      from: caravan.fromSite,
      to: caravan.toSite,
      state: caravan.state,
      cargo: caravan.describeCargo(),
      cargoValue: stackValue(caravan.cargo),
      gold: caravan.gold,
      guards: caravan.members.filter((member) => member.alive).length,
      defenders: caravan.hasDefenders,
      plunderable: caravan.isPlunderable,
      position: { x: caravan.position.x, z: caravan.position.z },
    };
  }

  /** Состояние торговли и репутации. */
  economyReport(): Record<string, unknown> {
    return {
      reputation: Object.fromEntries(
        MARKETS.map((market) => [market.owner, this.reputation.get(market.owner)]),
      ),
      caravans: this.caravans.caravans.map((caravan) => this.describeCaravan(caravan)),
      prices: Object.fromEntries(
        MARKETS.map((market) => [
          market.siteId,
          {
            silk: this.economy.buyPrice('silk', market.siteId, this.reputation),
            furs: this.economy.sellPrice('furs', market.siteId, this.reputation),
          },
        ]),
      ),
      shortages: Object.fromEntries(
        MARKETS.map((market) => [
          market.siteId,
          Object.fromEntries(
            ['grain', 'salt', 'wine', 'silk', 'spices', 'furs', 'iron'].map((id) => [
              id,
              Number(this.economy.shortageOf(market.siteId, id).toFixed(3)),
            ]),
          ),
        ]),
      ),
      gold: this.player.inventory.gold,
    };
  }

  /** Сводка по населению мира. */
  populationReport(): Record<string, unknown> {
    const severedLimbs = this.population.actors.reduce((total, actor) => {
      let count = 0;
      for (const part of LIMBS) if (actor.wounds.isLost(part)) count++;
      return total + count;
    }, 0);

    return {
      alive: this.population.aliveCount,
      corpses: this.population.corpseCount,
      severedLimbs,
    };
  }

  dispose(): void {
    this.stop();
    window.removeEventListener('resize', this.handleResize);
    this.input.dispose();
    this.population?.dispose();
    this.forest?.dispose();
    this.terrain?.dispose();
    this.blood.dispose();
    this.sky.dispose();
    this.hud.dispose();
    this.overlay.dispose();
    this.renderer.dispose();
    this.lockOverlay.remove();
  }
}
