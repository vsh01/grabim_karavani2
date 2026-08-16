/**
 * Служебная панель: где мы, сколько кадров, сколько деревьев на каком уровне
 * детализации. Переключается на F3 и очень помогает ловить провалы частоты
 * кадров именно в густом лесу.
 */
export interface DebugStats {
  fps: number;
  zone: string;
  x: number;
  y: number;
  z: number;
  clock: string;
  lod0: number;
  lod1: number;
  impostors: number;
  totalTrees: number;
  drawCalls: number;
  triangles: number;
  actors: number;
  corpses: number;
}

export class DebugHud {
  private readonly root: HTMLDivElement;
  private visible = false;

  constructor(parent: HTMLElement = document.body) {
    this.root = document.createElement('div');
    this.root.id = 'debug-hud';
    this.root.style.cssText = [
      'position:fixed',
      'top:10px',
      'left:10px',
      'padding:10px 12px',
      'font:12px/1.55 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace',
      'color:#d7e4c9',
      'background:rgba(8,14,10,0.72)',
      'border:1px solid rgba(217,180,90,0.25)',
      'border-radius:6px',
      'white-space:pre',
      'pointer-events:none',
      'z-index:30',
      'display:none',
    ].join(';');
    parent.appendChild(this.root);
  }

  toggle(): void {
    this.visible = !this.visible;
    this.root.style.display = this.visible ? 'block' : 'none';
  }

  get isVisible(): boolean {
    return this.visible;
  }

  update(stats: DebugStats): void {
    if (!this.visible) return;
    this.root.textContent = [
      `кадров/с    ${stats.fps.toFixed(0)}`,
      `зона        ${stats.zone}`,
      `позиция     ${stats.x.toFixed(0)}, ${stats.y.toFixed(1)}, ${stats.z.toFixed(0)}`,
      `время       ${stats.clock}`,
      '',
      `деревья 3D  ${stats.lod0} вблизи / ${stats.lod1} поодаль`,
      `картинками  ${stats.impostors}`,
      `всего в мире ${stats.totalTrees}`,
      '',
      `живых       ${stats.actors}`,
      `трупов      ${stats.corpses}`,
      '',
      `вызовов     ${stats.drawCalls}`,
      `треугольников ${(stats.triangles / 1000).toFixed(0)}k`,
      '',
      'F3 — убрать панель',
    ].join('\n');
  }
}
