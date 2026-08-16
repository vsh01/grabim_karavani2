import * as THREE from 'three';
import { Input } from './core/input';
import { clamp } from './core/math';
import { Terrain } from './world/terrain';
import { Forest } from './world/forest';
import { Sky } from './world/sky';
import { ZONES, zoneAt } from './world/zones';
import { Player } from './entities/player';
import { CollisionWorld } from './systems/physics';
import { DebugHud } from './ui/debugHud';

export type ProgressReporter = (percent: number, message: string) => Promise<void>;

export interface GameOptions {
  seed: number;
  container: HTMLElement;
  progress: ProgressReporter;
}

/** Точка, с которой начинается игра, — опушка леса эльфов. */
const SPAWN = { x: -470, z: 40 };

/**
 * Игра целиком: сцена, мир, игрок и главный цикл.
 * Дальше сюда добавятся бой, корованы и фракции — каркас рассчитан на рост.
 */
export class Game {
  readonly scene = new THREE.Scene();
  readonly renderer: THREE.WebGLRenderer;
  readonly input: Input;
  readonly colliders = new CollisionWorld();
  readonly sky = new Sky();
  readonly debug = new DebugHud();

  terrain!: Terrain;
  forest!: Forest;
  player!: Player;

  private running = false;
  private lastTime = 0;
  private frameTimes: number[] = [];
  private fps = 0;
  private readonly overlay: HTMLDivElement;
  private readonly tint = new THREE.Color();

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
    this.overlay = this.createOverlay();

    this.scene.fog = this.sky.fog;
    this.scene.add(this.sky.group);

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

    await progress(28, 'Режем землю на куски…');
    this.scene.add(this.terrain.build());

    await progress(48, 'Сажаем лес…');
    this.forest = new Forest(this.terrain, seed);

    await progress(72, 'Фотографируем деревья для дальнего плана…');
    this.forest.build(this.renderer);
    this.scene.add(this.forest.group);

    await progress(92, 'Будим игрока…');
    this.player = new Player(SPAWN.x, SPAWN.z, this.terrain);
    this.player.yaw = Math.PI * 0.15;
    this.forest.update(this.player.position, true);

    await progress(100, 'Готово');
  }

  private createOverlay(): HTMLDivElement {
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
      <div style="opacity:0.75">WASD — идти · Shift — бежать · Пробел — прыжок · мышь — смотреть</div>
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

    this.sky.update(dt);
    this.player.update(dt, this.input, {
      terrain: this.terrain,
      forest: this.forest,
      colliders: this.colliders,
    });

    this.sky.follow(this.player.camera);
    this.forest.update(this.player.position);

    // Дальний лес красим тем же светом, что и всё остальное.
    this.tint.setScalar(1).lerp(new THREE.Color(0x2c3a55), 1 - this.sky.daylight);
    this.forest.syncAtmosphere(this.sky.fog.color, this.sky.fog.near, this.sky.fog.far, this.tint);

    this.updateDebug();
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
    });
  }

  private render(): void {
    this.renderer.render(this.scene, this.player.camera);
  }

  /** Средняя частота кадров за последние кадры — для автотестов. */
  get currentFps(): number {
    return this.fps;
  }

  dispose(): void {
    this.stop();
    window.removeEventListener('resize', this.handleResize);
    this.input.dispose();
    this.forest?.dispose();
    this.terrain?.dispose();
    this.sky.dispose();
    this.renderer.dispose();
    this.overlay.remove();
  }
}
