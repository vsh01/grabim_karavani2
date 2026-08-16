import * as THREE from 'three';
import { Input } from './core/input';
import { clamp } from './core/math';
import { Terrain } from './world/terrain';
import { Forest } from './world/forest';
import { Sky } from './world/sky';
import { ZONES, zoneAt } from './world/zones';
import { Player } from './entities/player';
import { BodyPart, LIMBS, PART_NAMES } from './entities/body';
import { Actor } from './entities/actor';
import { CollisionWorld } from './systems/physics';
import { BloodEffects } from './systems/effects';
import { CombatSystem, type CombatEvent, type CombatTargets } from './systems/combat';
import { Population, populateWorld } from './systems/population';
import type { AiWorld } from './systems/ai';
import { Faction, baseHostility } from './data/factions';
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

  terrain!: Terrain;
  forest!: Forest;
  player!: Player;
  population!: Population;
  combat!: CombatSystem;

  private running = false;
  private lastTime = 0;
  private frameTimes: number[] = [];
  private fps = 0;
  private readonly lockOverlay: HTMLDivElement;
  private readonly tint = new THREE.Color();
  private targets!: CombatTargets;
  private aiWorld!: AiWorld;
  private interactionTarget: Actor | null = null;

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

    await progress(26, 'Режем землю на куски…');
    this.scene.add(this.terrain.build());

    await progress(44, 'Сажаем лес…');
    this.forest = new Forest(this.terrain, seed);

    await progress(66, 'Фотографируем деревья для дальнего плана…');
    this.forest.build(this.renderer);
    this.scene.add(this.forest.group);

    await progress(82, 'Расселяем эльфов, стражу и разбойников…');
    this.population = new Population(this.terrain);
    populateWorld(this.population, this.terrain, this.forest, seed);
    this.scene.add(this.population.group);

    await progress(94, 'Точим оружие…');
    this.player = new Player(SPAWN.x, SPAWN.z, this.terrain);
    this.player.yaw = Math.PI * 0.15;
    this.player.faction = Faction.Elves;
    this.player.characterName = 'Безымянный';
    this.giveStartingKit();

    this.combat = new CombatSystem(this.terrain, this.blood, this.handleCombatEvent);
    this.scene.add(this.combat.group);

    this.targets = { actors: this.population.actors, player: this.player };
    this.aiWorld = {
      terrain: this.terrain,
      forest: this.forest,
      actors: this.population.actors,
      player: this.player,
      combat: this.combat,
      targets: this.targets,
      playerHostility: (faction) => baseHostility(faction, this.player.faction),
    };

    this.forest.update(this.player.position, true);
    await progress(100, 'Готово');
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
      <div style="opacity:0.8">ЛКМ — удар · R — перевязать · E — обыскать · 1…4 — оружие</div>
      <div style="opacity:0.5;font-size:13px">Esc — освободить курсор · F3 — служебная панель</div>
    `;
    overlay.addEventListener('click', () => this.input.requestPointerLock());
    document.body.appendChild(overlay);

    this.input.onPointerLockChange((locked) => {
      overlay.style.display = locked ? 'none' : 'flex';
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
    });

    this.population.update(dt, this.aiWorld, this.player.position);
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
    if (!this.player.wounds.alive) {
      if (this.input.justPressedRaw('Space')) this.respawn();
      return;
    }

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

  private interact(): void {
    const target = this.interactionTarget;
    if (!target) return;

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
      interactionHint: this.interactionTarget ? `E — обыскать (${this.interactionTarget.name})` : null,
      zoneName: ZONES[zoneAt(position.x, position.z)].name,
      clock: this.sky.clockLabel,
    });

    this.overlay.update(dt, this.player.wounds);
    this.updateDebug();
  }

  private findInteractionTarget(): void {
    this.interactionTarget = this.population.nearest(
      this.player.position.x,
      this.player.position.z,
      INTERACT_RANGE,
      (actor) => !actor.alive,
    );
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
