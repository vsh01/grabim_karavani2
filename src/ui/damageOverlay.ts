import type { Body } from '../entities/body';
import { clamp01 } from '../core/math';

/**
 * То, что игрок видит своими (оставшимися) глазами.
 *
 * Потеря глаза здесь работает буквально: половина экрана уходит в темноту.
 * Зачарованный протез не возвращает зрение полностью — он лишь снимает черноту,
 * оставляя мутную пелену. Кровопотеря добавляет красную виньетку и сужает обзор,
 * а смерть гасит экран целиком.
 */
export class DamageOverlay {
  private readonly root: HTMLDivElement;
  private readonly leftEye: HTMLDivElement;
  private readonly rightEye: HTMLDivElement;
  private readonly vignette: HTMLDivElement;
  private readonly flash: HTMLDivElement;
  private readonly deathScreen: HTMLDivElement;
  private readonly deathText: HTMLDivElement;

  private flashStrength = 0;

  constructor(parent: HTMLElement = document.body) {
    this.root = document.createElement('div');
    this.root.id = 'damage-overlay';
    this.root.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:16;overflow:hidden;';

    this.leftEye = this.makeEyeMask('left');
    this.rightEye = this.makeEyeMask('right');

    this.vignette = document.createElement('div');
    this.vignette.style.cssText = [
      'position:absolute',
      'inset:0',
      'opacity:0',
      'background:radial-gradient(ellipse at 50% 50%, rgba(0,0,0,0) 32%, rgba(96,10,10,0.55) 74%, rgba(30,0,0,0.92) 100%)',
      'transition:opacity 0.35s linear',
    ].join(';');

    this.flash = document.createElement('div');
    this.flash.style.cssText = 'position:absolute;inset:0;background:#7d1414;opacity:0;';

    this.deathScreen = document.createElement('div');
    this.deathScreen.style.cssText = [
      'position:absolute',
      'inset:0',
      'display:none',
      'flex-direction:column',
      'align-items:center',
      'justify-content:center',
      'gap:14px',
      'background:radial-gradient(ellipse at 50% 45%, rgba(70,6,6,0.86), rgba(6,4,4,0.97))',
      'color:#e8ddc8',
      'font:16px/1.6 "Trebuchet MS",system-ui,sans-serif',
      'text-align:center',
    ].join(';');

    this.deathText = document.createElement('div');
    this.deathText.style.cssText = 'font-size:34px;letter-spacing:0.08em;color:#c94b4b;text-shadow:0 4px 22px #000';
    const hint = document.createElement('div');
    hint.style.cssText = 'opacity:0.75';
    hint.textContent = 'Пробел — начать заново';
    this.deathScreen.append(this.deathText, hint);

    this.root.append(this.vignette, this.leftEye, this.rightEye, this.flash, this.deathScreen);
    parent.appendChild(this.root);
  }

  /**
   * Маска на половину экрана.
   * Край размыт, потому что резкая граница читается как поломка изображения,
   * а не как потеря глаза.
   */
  private makeEyeMask(side: 'left' | 'right'): HTMLDivElement {
    const mask = document.createElement('div');
    const direction = side === 'left' ? 'to right' : 'to left';
    mask.style.cssText = [
      'position:absolute',
      'top:0',
      'bottom:0',
      side === 'left' ? 'left:0' : 'right:0',
      'width:58%',
      'opacity:0',
      `background:linear-gradient(${direction}, rgba(0,0,0,1) 0%, rgba(0,0,0,0.98) 52%, rgba(0,0,0,0.8) 74%, rgba(0,0,0,0) 100%)`,
      'transition:opacity 0.5s ease',
    ].join(';');
    return mask;
  }

  /** Короткая красная вспышка при получении урона. */
  hit(strength: number): void {
    this.flashStrength = Math.min(0.7, this.flashStrength + strength);
  }

  update(dt: number, wounds: Body): void {
    // Глаза.
    const loss = wounds.visionLoss;
    // Потерян левый глаз — темнеет левая половина обзора.
    const leftDark = loss === 'left' || loss === 'both';
    const rightDark = loss === 'right' || loss === 'both';

    // Протез не возвращает зрение целиком, но снимает черноту.
    const dimming = wounds.visionDimming;
    this.leftEye.style.opacity = String(leftDark ? 1 : dimming > 0 ? dimming * 0.5 : 0);
    this.rightEye.style.opacity = String(rightDark ? 1 : dimming > 0 ? dimming * 0.5 : 0);

    // Кровопотеря: чем меньше крови, тем уже и краснее обзор.
    const bloodLoss = 1 - clamp01(wounds.bloodFraction);
    this.vignette.style.opacity = String(clamp01((bloodLoss - 0.25) * 1.7));

    // Вспышка от удара.
    this.flashStrength = Math.max(0, this.flashStrength - dt * 1.6);
    this.flash.style.opacity = String(this.flashStrength);

    // Смерть.
    if (!wounds.alive) {
      this.deathScreen.style.display = 'flex';
      this.deathText.textContent = deathMessage(wounds);
    } else {
      this.deathScreen.style.display = 'none';
    }
  }

  dispose(): void {
    this.root.remove();
  }
}

function deathMessage(wounds: Body): string {
  switch (wounds.deathCause) {
    case 'bleeding':
      return 'Вы истекли кровью';
    case 'beheaded':
      return 'Удар в голову оказался последним';
    default:
      return 'Вы погибли';
  }
}
