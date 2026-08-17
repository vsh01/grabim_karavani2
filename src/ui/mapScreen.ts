import { WORLD_HALF, WORLD_SIZE, ZONES, Zone, zoneWeights } from '../world/zones';
import { WATER_LEVEL, type Terrain } from '../world/terrain';
import { SITES } from '../world/sites';
import type { RoadNetwork } from '../world/roads';
import { FACTIONS, type Faction } from '../data/factions';
import type { SlotInfo } from '../systems/save';

/**
 * Карта мира и сохранения на одном экране.
 *
 * Карта рисуется по той же высотной карте, что и земля под ногами, поэтому это
 * не декоративная картинка, а настоящий план местности: видно горы, воду,
 * тракты и то, где сейчас идут обозы.
 */

export interface MapMarker {
  x: number;
  z: number;
  owner: Faction;
  label: string;
  /** Обоз рисуется кружком, охотник за головой — красным ромбом. */
  kind?: 'caravan' | 'hunter';
}

export interface MapContext {
  terrain: Terrain;
  roads: RoadNetwork;
  player: { x: number; z: number; yaw: number };
  markers: MapMarker[];
  slots: SlotInfo[];
  onSave: (slot: number) => void;
  onLoad: (slot: number) => void;
  onClose: () => void;
}

/** Сторона картинки карты в точках. */
const MAP_SIZE = 460;

export class MapScreen {
  private readonly root: HTMLDivElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly slotBox: HTMLElement;
  private readonly legend: HTMLElement;
  private base: HTMLCanvasElement | null = null;
  private context: MapContext | null = null;

  constructor(parent: HTMLElement = document.body) {
    this.root = document.createElement('div');
    this.root.id = 'map-screen';
    this.root.innerHTML = TEMPLATE;
    parent.appendChild(this.root);

    const style = document.createElement('style');
    style.textContent = STYLES;
    document.head.appendChild(style);

    this.canvas = this.root.querySelector('#map-canvas') as HTMLCanvasElement;
    this.canvas.width = MAP_SIZE;
    this.canvas.height = MAP_SIZE;
    this.slotBox = this.root.querySelector('#map-slots') as HTMLElement;
    this.legend = this.root.querySelector('#map-legend') as HTMLElement;

    (this.root.querySelector('#map-close') as HTMLButtonElement).addEventListener('click', () =>
      this.context?.onClose(),
    );

    this.root.style.display = 'none';
  }

  get isOpen(): boolean {
    return this.context !== null;
  }

  open(context: MapContext): void {
    this.context = context;
    this.root.style.display = 'flex';
    if (!this.base) this.base = renderTerrainMap(context.terrain, context.roads);
    this.refresh();
  }

  close(): void {
    this.context = null;
    this.root.style.display = 'none';
  }

  refresh(): void {
    const context = this.context;
    if (!context || !this.base) return;

    const ctx = this.canvas.getContext('2d');
    if (!ctx) return;

    ctx.clearRect(0, 0, MAP_SIZE, MAP_SIZE);
    ctx.drawImage(this.base, 0, 0);

    // Обозы в пути и те, кто идёт по вашу душу.
    for (const marker of context.markers) {
      const [x, y] = toMap(marker.x, marker.z);
      ctx.strokeStyle = 'rgba(0,0,0,0.7)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();

      if (marker.kind === 'hunter') {
        // Ромб и красный цвет: от охотников можно уйти, но для этого надо
        // видеть, где они. Обводка светлая — тёмная терялась на горах, которые
        // на карте и без того красные.
        ctx.fillStyle = '#e8402a';
        ctx.strokeStyle = 'rgba(255,255,255,0.9)';
        ctx.moveTo(x, y - 6);
        ctx.lineTo(x + 5, y);
        ctx.lineTo(x, y + 6);
        ctx.lineTo(x - 5, y);
        ctx.closePath();
      } else {
        ctx.fillStyle = `#${FACTIONS[marker.owner].accent.toString(16).padStart(6, '0')}`;
        ctx.arc(x, y, 4, 0, Math.PI * 2);
      }

      ctx.fill();
      ctx.stroke();
    }

    // Игрок — стрелка по направлению взгляда.
    const [px, py] = toMap(context.player.x, context.player.z);
    // На карте ось Y растёт вниз, поэтому направление взгляда переворачивается.
    const angle = -context.player.yaw + Math.PI;
    ctx.save();
    ctx.translate(px, py);
    ctx.rotate(angle);
    ctx.fillStyle = '#f2e4b8';
    ctx.strokeStyle = '#1a1a12';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(0, -8);
    ctx.lineTo(5.5, 6);
    ctx.lineTo(0, 3);
    ctx.lineTo(-5.5, 6);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();

    this.renderSlots(context);
    this.renderLegend();
  }

  private renderSlots(context: MapContext): void {
    this.slotBox.innerHTML = '';

    for (const slot of context.slots) {
      const row = document.createElement('div');
      row.className = 'map-slot';

      const label = document.createElement('div');
      label.className = 'map-slot-label';
      label.innerHTML = slot.used
        ? `<b>Слот ${slot.slot}</b><span>${slot.label}</span><span class="map-slot-date">${slot.savedAt}</span>`
        : `<b>Слот ${slot.slot}</b><span class="map-slot-empty">пусто</span>`;

      const buttons = document.createElement('div');
      buttons.className = 'map-slot-buttons';

      const save = document.createElement('button');
      save.className = 'map-btn';
      save.textContent = 'записать';
      save.addEventListener('click', () => {
        context.onSave(slot.slot);
        this.refresh();
      });

      const load = document.createElement('button');
      load.className = 'map-btn';
      load.textContent = 'загрузить';
      if (!slot.used) load.classList.add('map-disabled');
      load.addEventListener('click', () => context.onLoad(slot.slot));

      buttons.append(save, load);
      row.append(label, buttons);
      this.slotBox.appendChild(row);
    }
  }

  private renderLegend(): void {
    if (this.legend.childElementCount > 0) return;

    for (const zone of [Zone.Human, Zone.Imperial, Zone.Elf, Zone.Villain]) {
      const info = ZONES[zone];
      const item = document.createElement('span');
      item.className = 'map-legend-item';
      item.innerHTML = `<i style="background:#${info.color.toString(16).padStart(6, '0')}"></i>${info.name}`;
      this.legend.appendChild(item);
    }
  }

  dispose(): void {
    this.root.remove();
  }
}

/** Мировые координаты в точки карты. */
function toMap(x: number, z: number): [number, number] {
  return [((x + WORLD_HALF) / WORLD_SIZE) * MAP_SIZE, ((z + WORLD_HALF) / WORLD_SIZE) * MAP_SIZE];
}

/**
 * Нарисовать основу карты один раз: рельеф, воду, зоны, тракты и поселения.
 * Дальше поверх неё каждый раз кладутся только подвижные метки.
 */
function renderTerrainMap(terrain: Terrain, roads: RoadNetwork): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = MAP_SIZE;
  canvas.height = MAP_SIZE;
  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;

  const image = ctx.createImageData(MAP_SIZE, MAP_SIZE);
  const data = image.data;
  const step = WORLD_SIZE / MAP_SIZE;

  for (let py = 0; py < MAP_SIZE; py++) {
    const z = py * step - WORLD_HALF;
    for (let px = 0; px < MAP_SIZE; px++) {
      const x = px * step - WORLD_HALF;
      const height = terrain.heightAt(x, z);

      let r: number;
      let g: number;
      let b: number;

      if (height < WATER_LEVEL) {
        r = 42;
        g = 68;
        b = 84;
      } else {
        // Цвет зоны, притемнённый по высоте, — получается рельефная карта.
        const weights = zoneWeights(x, z);
        r = 0;
        g = 0;
        b = 0;
        for (const zone of [Zone.Human, Zone.Imperial, Zone.Elf, Zone.Villain]) {
          const color = ZONES[zone].color;
          r += ((color >> 16) & 0xff) * weights[zone];
          g += ((color >> 8) & 0xff) * weights[zone];
          b += (color & 0xff) * weights[zone];
        }

        // Свет с северо-запада: склоны читаются как объём.
        const shade = (terrain.heightAt(x - step, z - step) - height) * 0.06;
        const tone = Math.max(0.35, Math.min(1.25, 0.72 + height / 260 - shade));
        r *= tone;
        g *= tone;
        b *= tone;
      }

      const index = (py * MAP_SIZE + px) * 4;
      data[index] = Math.min(255, r);
      data[index + 1] = Math.min(255, g);
      data[index + 2] = Math.min(255, b);
      data[index + 3] = 255;
    }
  }

  ctx.putImageData(image, 0, 0);

  // Тракты.
  ctx.strokeStyle = 'rgba(224,201,150,0.85)';
  ctx.lineWidth = 2;
  ctx.lineJoin = 'round';
  for (const road of roads.roads) {
    ctx.beginPath();
    road.points.forEach((point, index) => {
      const [x, y] = toMap(point.x, point.z);
      if (index === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
  }

  // Поселения и подписи.
  ctx.font = '11px "Trebuchet MS", system-ui, sans-serif';
  ctx.textAlign = 'center';
  for (const site of SITES) {
    if (site.kind === 'waypoint') continue;
    const [x, y] = toMap(site.x, site.z);

    ctx.fillStyle = '#f2e4b8';
    ctx.strokeStyle = 'rgba(0,0,0,0.75)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(x, y, site.kind === 'camp' ? 3 : 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    if (site.kind !== 'camp') {
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(0,0,0,0.8)';
      ctx.strokeText(site.name, x, y - 9);
      ctx.fillStyle = '#f6ecd2';
      ctx.fillText(site.name, x, y - 9);
    }
  }

  return canvas;
}

const TEMPLATE = `
  <div id="map-window">
    <header>
      <div>
        <div id="map-title">Карта мира</div>
        <div id="map-legend"></div>
      </div>
      <button id="map-close" class="map-btn">закрыть</button>
    </header>
    <div id="map-body">
      <canvas id="map-canvas"></canvas>
      <section id="map-side">
        <h3>Сохранения</h3>
        <div id="map-slots"></div>
        <p class="map-hint">F5 — быстрое сохранение, F9 — быстрая загрузка.<br />M — закрыть карту.</p>
      </section>
    </div>
  </div>
`;

const STYLES = `
  #map-screen {
    position: fixed; inset: 0; z-index: 26; display: none; align-items: center; justify-content: center;
    background: rgba(4,7,5,0.75); backdrop-filter: blur(3px);
    font: 14px/1.5 "Trebuchet MS", system-ui, sans-serif; color: #e4dcc6;
  }
  #map-window {
    display: flex; flex-direction: column; gap: 14px; padding: 18px 20px; border-radius: 8px;
    background: linear-gradient(180deg, rgba(26,32,26,0.97), rgba(14,18,14,0.98));
    border: 1px solid rgba(217,180,90,0.35); box-shadow: 0 24px 70px rgba(0,0,0,0.65);
    max-width: 94vw; max-height: 92vh;
  }
  #map-window header { display: flex; align-items: flex-start; justify-content: space-between; gap: 20px; }
  #map-title { font-size: 21px; color: #d9b45a; letter-spacing: 0.03em; }
  #map-legend { display: flex; gap: 12px; flex-wrap: wrap; margin-top: 5px; font-size: 12px; opacity: 0.75; }
  .map-legend-item { display: inline-flex; align-items: center; gap: 5px; }
  .map-legend-item i { width: 10px; height: 10px; border-radius: 2px; display: inline-block; }
  #map-body { display: flex; gap: 18px; align-items: flex-start; }
  #map-canvas {
    border-radius: 5px; border: 1px solid rgba(255,255,255,0.14); image-rendering: auto;
    max-width: min(460px, 52vw); height: auto;
  }
  #map-side { width: 290px; display: flex; flex-direction: column; gap: 10px; }
  #map-side h3 {
    margin: 0; font-size: 12px; text-transform: uppercase; letter-spacing: 0.1em; font-weight: normal;
    color: rgba(232,226,208,0.55);
  }
  #map-slots { display: flex; flex-direction: column; gap: 7px; }
  .map-slot {
    display: flex; align-items: center; justify-content: space-between; gap: 10px;
    padding: 8px 10px; border-radius: 5px; background: rgba(255,255,255,0.045);
    border: 1px solid rgba(255,255,255,0.09);
  }
  .map-slot-label { display: flex; flex-direction: column; gap: 1px; font-size: 12px; min-width: 0; }
  .map-slot-label b { font-weight: normal; color: #e8e2d0; font-size: 13px; }
  .map-slot-label span { opacity: 0.7; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .map-slot-date { opacity: 0.4 !important; }
  .map-slot-empty { opacity: 0.35 !important; font-style: italic; }
  .map-slot-buttons { display: flex; gap: 5px; flex-shrink: 0; }
  .map-btn {
    font: 12px/1 "Trebuchet MS", system-ui, sans-serif; color: #e8e2d0; cursor: pointer;
    background: rgba(217,180,90,0.14); border: 1px solid rgba(217,180,90,0.4);
    padding: 6px 9px; border-radius: 4px; white-space: nowrap;
  }
  .map-btn:hover { background: rgba(217,180,90,0.28); }
  .map-disabled { opacity: 0.32; pointer-events: none; }
  .map-hint { margin: auto 0 0; font-size: 12px; opacity: 0.45; }
`;
