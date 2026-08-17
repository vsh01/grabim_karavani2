import { ALL_BODY_PARTS, BodyPart, PART_NAMES, type Body } from '../entities/body';
import { MOVEMENT_PARAMS, type MovementMode } from '../entities/movement';
import type { Inventory } from '../data/items';
import { clamp01 } from '../core/math';

/**
 * Основной интерфейс: состояние тела, кровь, снаряжение и журнал событий.
 *
 * Схема тела — главный экран этой игры. По ней сразу видно, что именно с вами
 * не так: где рана, что кровит, чего уже нет и где стоит протез.
 */

const COLOR_HEALTHY = '#7f9a5e';
const COLOR_WOUNDED = '#c9a227';
const COLOR_CRITICAL = '#c2622c';
const COLOR_BLEEDING = '#b23030';
const COLOR_LOST = '#241618';
const COLOR_PROSTHETIC = '#8d949c';

/** Части тела и соответствующие им фигуры на схеме. */
const DIAGRAM_SHAPES: Record<string, string> = {
  [BodyPart.Head]: '<circle id="p-head" cx="50" cy="15" r="10" />',
  [BodyPart.LeftEye]: '<circle id="p-leftEye" cx="45.5" cy="13" r="2.4" />',
  [BodyPart.RightEye]: '<circle id="p-rightEye" cx="54.5" cy="13" r="2.4" />',
  [BodyPart.Torso]: '<rect id="p-torso" x="39" y="27" width="22" height="32" rx="4" />',
  [BodyPart.LeftArm]: '<rect id="p-leftArm" x="26" y="28" width="9" height="30" rx="4" />',
  [BodyPart.RightArm]: '<rect id="p-rightArm" x="65" y="28" width="9" height="30" rx="4" />',
  [BodyPart.LeftLeg]: '<rect id="p-leftLeg" x="40" y="62" width="9" height="32" rx="4" />',
  [BodyPart.RightLeg]: '<rect id="p-rightLeg" x="51" y="62" width="9" height="32" rx="4" />',
};

interface LogEntry {
  element: HTMLDivElement;
  ttl: number;
}

export interface HudState {
  wounds: Body;
  inventory: Inventory;
  mode: MovementMode;
  /** Подсказка о том, что рядом (труп, торговец, дверь). */
  interactionHint: string | null;
  zoneName: string;
  clock: string;
  /** Текущий приказ, если он есть. */
  order: string | null;
  /** За кого играем. */
  factionName: string;
  /** Сколько бойцов идёт следом. */
  squadSize: number;
}

export class Hud {
  private readonly root: HTMLDivElement;
  private readonly diagramParts = new Map<BodyPart, SVGElement>();
  private readonly vitalityBar: HTMLElement;
  private readonly bloodBar: HTMLElement;
  private readonly bleedWarning: HTMLElement;
  private readonly statusLine: HTMLElement;
  private readonly gearLine: HTMLElement;
  private readonly placeLine: HTMLElement;
  private readonly orderLine: HTMLElement;
  private readonly hintLine: HTMLElement;
  private readonly logBox: HTMLDivElement;
  private readonly entries: LogEntry[] = [];

  constructor(parent: HTMLElement = document.body) {
    this.root = document.createElement('div');
    this.root.id = 'hud';
    this.root.innerHTML = TEMPLATE;
    this.root.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:15;';
    parent.appendChild(this.root);

    const style = document.createElement('style');
    style.textContent = STYLES;
    document.head.appendChild(style);

    for (const part of ALL_BODY_PARTS) {
      const element = this.root.querySelector<SVGElement>(`#p-${part}`);
      if (element) this.diagramParts.set(part, element);
    }

    this.vitalityBar = this.require('#hud-vitality');
    this.bloodBar = this.require('#hud-blood');
    this.bleedWarning = this.require('#hud-bleed');
    this.statusLine = this.require('#hud-status');
    this.gearLine = this.require('#hud-gear');
    this.placeLine = this.require('#hud-place');
    this.orderLine = this.require('#hud-order');
    this.hintLine = this.require('#hud-hint');
    this.logBox = this.require('#hud-log') as HTMLDivElement;
  }

  private require(selector: string): HTMLElement {
    const element = this.root.querySelector<HTMLElement>(selector);
    if (!element) throw new Error(`В интерфейсе нет элемента ${selector}`);
    return element;
  }

  setVisible(visible: boolean): void {
    this.root.style.display = visible ? 'block' : 'none';
  }

  /** Добавить строку в журнал. Она сама исчезнет через несколько секунд. */
  log(message: string, tone: 'plain' | 'good' | 'bad' | 'alarm' = 'plain'): void {
    const element = document.createElement('div');
    element.className = `hud-log-entry hud-${tone}`;
    element.textContent = message;
    this.logBox.appendChild(element);
    this.entries.push({ element, ttl: tone === 'alarm' ? 7 : 4.5 });

    while (this.entries.length > 7) {
      const oldest = this.entries.shift();
      oldest?.element.remove();
    }
  }

  /** Что сейчас висит в журнале. Нужно автотестам, чтобы видеть ответ игры. */
  recentMessages(): string[] {
    return this.entries.map((entry) => entry.element.textContent ?? '');
  }

  update(dt: number, state: HudState): void {
    this.updateDiagram(state.wounds);
    this.updateBars(state.wounds);
    this.updateLines(state);
    this.updateLog(dt);
  }

  private updateDiagram(wounds: Body): void {
    for (const part of ALL_BODY_PARTS) {
      const element = this.diagramParts.get(part);
      if (!element) continue;

      const status = wounds.get(part);
      let fill = COLOR_HEALTHY;
      let opacity = '1';

      if (status.prosthetic) {
        fill = COLOR_PROSTHETIC;
      } else if (status.severed) {
        fill = COLOR_LOST;
        opacity = '0.55';
      } else {
        const health = status.maxHp > 0 ? status.hp / status.maxHp : 1;
        if (status.bleeding > 0) fill = COLOR_BLEEDING;
        else if (health < 0.35) fill = COLOR_CRITICAL;
        else if (health < 0.8) fill = COLOR_WOUNDED;
      }

      element.setAttribute('fill', fill);
      element.setAttribute('opacity', opacity);
    }
  }

  private updateBars(wounds: Body): void {
    this.vitalityBar.style.width = `${clamp01(wounds.vitality) * 100}%`;
    this.bloodBar.style.width = `${clamp01(wounds.bloodFraction) * 100}%`;

    if (wounds.isBleeding && wounds.alive) {
      const seconds = wounds.secondsUntilBleedOut;
      this.bleedWarning.style.display = 'block';
      this.bleedWarning.textContent =
        seconds < 900
          ? `КРОВОТЕЧЕНИЕ · до потери сознания ${Math.ceil(seconds)} с · R — перевязать`
          : 'КРОВОТЕЧЕНИЕ · R — перевязать';
    } else {
      this.bleedWarning.style.display = 'none';
    }
  }

  private updateLines(state: HudState): void {
    const { wounds, inventory } = state;

    const injuries = wounds.describeInjuries();
    this.statusLine.textContent = injuries.length > 0 ? injuries.join(' · ') : 'цел и невредим';
    this.statusLine.style.color = injuries.length > 0 ? '#d8b06a' : '#96a67e';

    const bandages = inventory.count('bandage');
    const arrows = inventory.count('arrow');
    const parts = [
      inventory.weapon.name,
      `бинтов ${bandages}`,
      inventory.weapon.weapon?.ranged ? `стрел ${arrows}` : null,
      `${inventory.gold} зол.`,
      MOVEMENT_PARAMS[state.mode].label,
    ].filter((value): value is string => value !== null);
    this.gearLine.textContent = parts.join('   ·   ');

    this.placeLine.textContent = `${state.factionName} · ${state.zoneName} · ${state.clock}`;

    if (state.order) {
      this.orderLine.style.display = 'block';
      const squad = state.squadSize > 0 ? ` · отряд ${state.squadSize}` : '';
      this.orderLine.textContent = `Приказ · ${state.order}${squad}`;
    } else if (state.squadSize > 0) {
      this.orderLine.style.display = 'block';
      this.orderLine.textContent = `Отряд: ${state.squadSize} · F за мной · H стоять · G в атаку`;
    } else {
      this.orderLine.style.display = 'none';
    }

    if (state.interactionHint) {
      this.hintLine.style.display = 'block';
      this.hintLine.textContent = state.interactionHint;
    } else {
      this.hintLine.style.display = 'none';
    }
  }

  private updateLog(dt: number): void {
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const entry = this.entries[i];
      entry.ttl -= dt;
      if (entry.ttl <= 0) {
        entry.element.remove();
        this.entries.splice(i, 1);
      } else if (entry.ttl < 1) {
        entry.element.style.opacity = String(entry.ttl);
      }
    }
  }

  /** Подпись части тела для сообщений. */
  static partName(part: BodyPart): string {
    return PART_NAMES[part];
  }

  dispose(): void {
    this.root.remove();
  }
}

const TEMPLATE = `
  <div id="hud-crosshair"></div>

  <div id="hud-place"></div>
  <div id="hud-order"></div>
  <div id="hud-log"></div>
  <div id="hud-bleed"></div>
  <div id="hud-hint"></div>

  <div id="hud-body">
    <svg viewBox="0 0 100 100" width="112" height="112" aria-label="состояние тела">
      <g stroke="rgba(0,0,0,0.45)" stroke-width="1">
        ${Object.values(DIAGRAM_SHAPES).join('\n        ')}
      </g>
    </svg>
    <div id="hud-status"></div>
  </div>

  <div id="hud-bars">
    <div class="hud-bar"><span>тело</span><i><b id="hud-vitality"></b></i></div>
    <div class="hud-bar"><span>кровь</span><i><b id="hud-blood" class="blood"></b></i></div>
  </div>

  <div id="hud-gear"></div>
`;

const STYLES = `
  #hud, #hud * { box-sizing: border-box; }
  #hud-crosshair {
    position: absolute; left: 50%; top: 50%; width: 5px; height: 5px; margin: -2.5px 0 0 -2.5px;
    border-radius: 50%; background: rgba(255,255,255,0.75); box-shadow: 0 0 3px rgba(0,0,0,0.9);
  }
  #hud-place {
    position: absolute; top: 12px; right: 16px; font: 13px/1.4 "Trebuchet MS", system-ui, sans-serif;
    color: rgba(232,226,208,0.65); text-shadow: 0 1px 3px #000; letter-spacing: 0.04em;
  }
  #hud-order {
    display: none; position: absolute; top: 32px; right: 16px; max-width: 340px; text-align: right;
    font: 13px/1.45 "Trebuchet MS", system-ui, sans-serif; color: #d9b45a;
    text-shadow: 0 1px 3px #000; letter-spacing: 0.02em;
  }
  #hud-log {
    position: absolute; top: 54px; left: 50%; transform: translateX(-50%);
    display: flex; flex-direction: column; align-items: center; gap: 3px; width: min(620px, 80vw);
  }
  .hud-log-entry {
    font: 14px/1.45 "Trebuchet MS", system-ui, sans-serif; color: #ded6c2;
    text-shadow: 0 2px 5px #000; transition: opacity 0.3s linear; text-align: center;
  }
  .hud-good { color: #a8cc7e; }
  .hud-bad { color: #e2896b; }
  .hud-alarm { color: #ff7a6b; font-weight: bold; letter-spacing: 0.03em; }
  #hud-bleed {
    display: none; position: absolute; top: 18px; left: 50%; transform: translateX(-50%);
    font: bold 15px/1.5 "Trebuchet MS", system-ui, sans-serif; color: #ff6b6b;
    text-shadow: 0 0 12px rgba(180,20,20,0.9), 0 2px 4px #000; letter-spacing: 0.05em;
    animation: hud-pulse 1.1s ease-in-out infinite;
  }
  @keyframes hud-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.45; } }
  #hud-hint {
    display: none; position: absolute; bottom: 33%; left: 50%; transform: translateX(-50%);
    font: 14px/1.5 "Trebuchet MS", system-ui, sans-serif; color: #e8e2d0;
    background: rgba(8,12,9,0.6); padding: 5px 12px; border-radius: 4px;
    border: 1px solid rgba(217,180,90,0.3); text-shadow: 0 1px 2px #000;
  }
  #hud-body { position: absolute; left: 16px; bottom: 74px; text-align: center; }
  #hud-status {
    max-width: 190px; margin-top: 2px;
    font: 12px/1.45 "Trebuchet MS", system-ui, sans-serif; color: #d8b06a; text-shadow: 0 1px 3px #000;
  }
  #hud-bars { position: absolute; left: 16px; bottom: 14px; width: 210px; display: grid; gap: 5px; }
  .hud-bar { display: flex; align-items: center; gap: 8px; }
  .hud-bar span {
    width: 40px; font: 11px/1 "Trebuchet MS", system-ui, sans-serif;
    color: rgba(232,226,208,0.6); text-transform: uppercase; letter-spacing: 0.08em;
  }
  .hud-bar i {
    flex: 1; height: 7px; background: rgba(0,0,0,0.55); border: 1px solid rgba(255,255,255,0.14);
    border-radius: 3px; overflow: hidden;
  }
  .hud-bar b { display: block; height: 100%; width: 100%; background: #7f9a5e; transition: width 0.18s linear; }
  .hud-bar b.blood { background: #a32b2b; }
  #hud-gear {
    position: absolute; right: 16px; bottom: 16px;
    font: 13px/1.5 "Trebuchet MS", system-ui, sans-serif; color: rgba(232,226,208,0.8);
    text-shadow: 0 1px 3px #000; letter-spacing: 0.02em;
  }
`;
