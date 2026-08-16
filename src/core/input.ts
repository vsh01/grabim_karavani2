/**
 * Клавиатура, мышь и захват указателя.
 *
 * Нажатия хранятся по физическому коду клавиши (`KeyW`, а не `w`), поэтому
 * управление одинаково работает и в русской, и в английской раскладке.
 */
export class Input {
  private readonly down = new Set<string>();
  private readonly pressed = new Set<string>();
  private readonly released = new Set<string>();

  mouseDeltaX = 0;
  mouseDeltaY = 0;
  wheelDelta = 0;

  private readonly mouseButtons = new Set<number>();
  private readonly mousePressed = new Set<number>();

  /** Ввод не читается, пока открыто меню. */
  enabled = true;

  private readonly element: HTMLElement;
  private locked = false;
  private onLockChange?: (locked: boolean) => void;

  constructor(element: HTMLElement) {
    this.element = element;

    window.addEventListener('keydown', this.handleKeyDown);
    window.addEventListener('keyup', this.handleKeyUp);
    window.addEventListener('blur', this.handleBlur);
    document.addEventListener('pointerlockchange', this.handlePointerLockChange);
    element.addEventListener('mousemove', this.handleMouseMove);
    element.addEventListener('mousedown', this.handleMouseDown);
    window.addEventListener('mouseup', this.handleMouseUp);
    element.addEventListener('wheel', this.handleWheel, { passive: true });
    element.addEventListener('contextmenu', this.handleContextMenu);
  }

  private handleKeyDown = (event: KeyboardEvent): void => {
    if (event.repeat) return;
    this.down.add(event.code);
    this.pressed.add(event.code);
    // Пробел и стрелки не должны прокручивать страницу под игрой.
    if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab'].includes(event.code)) {
      event.preventDefault();
    }
  };

  private handleKeyUp = (event: KeyboardEvent): void => {
    this.down.delete(event.code);
    this.released.add(event.code);
  };

  private handleBlur = (): void => {
    this.down.clear();
    this.mouseButtons.clear();
  };

  private handleMouseMove = (event: MouseEvent): void => {
    if (!this.locked) return;
    this.mouseDeltaX += event.movementX;
    this.mouseDeltaY += event.movementY;
  };

  private handleMouseDown = (event: MouseEvent): void => {
    this.mouseButtons.add(event.button);
    this.mousePressed.add(event.button);
  };

  private handleMouseUp = (event: MouseEvent): void => {
    this.mouseButtons.delete(event.button);
  };

  private handleWheel = (event: WheelEvent): void => {
    this.wheelDelta += event.deltaY;
  };

  private handleContextMenu = (event: Event): void => {
    event.preventDefault();
  };

  private handlePointerLockChange = (): void => {
    this.locked = document.pointerLockElement === this.element;
    this.mouseDeltaX = 0;
    this.mouseDeltaY = 0;
    this.onLockChange?.(this.locked);
  };

  requestPointerLock(): void {
    if (!this.locked) void this.element.requestPointerLock();
  }

  exitPointerLock(): void {
    if (this.locked) document.exitPointerLock();
  }

  get pointerLocked(): boolean {
    return this.locked;
  }

  onPointerLockChange(handler: (locked: boolean) => void): void {
    this.onLockChange = handler;
  }

  isDown(code: string): boolean {
    return this.enabled && this.down.has(code);
  }

  /** Нажата ли клавиша именно в этом кадре. */
  justPressed(code: string): boolean {
    return this.enabled && this.pressed.has(code);
  }

  /** Нажатие, которое читается даже при закрытом вводе (Esc, меню). */
  justPressedRaw(code: string): boolean {
    return this.pressed.has(code);
  }

  justReleased(code: string): boolean {
    return this.enabled && this.released.has(code);
  }

  isMouseDown(button = 0): boolean {
    return this.enabled && this.mouseButtons.has(button);
  }

  mouseJustPressed(button = 0): boolean {
    return this.enabled && this.mousePressed.has(button);
  }

  /** Ось движения: -1, 0 или 1 по каждой из осей. */
  moveAxis(out: { x: number; z: number }): { x: number; z: number } {
    out.x = 0;
    out.z = 0;
    if (this.isDown('KeyW') || this.isDown('ArrowUp')) out.z -= 1;
    if (this.isDown('KeyS') || this.isDown('ArrowDown')) out.z += 1;
    if (this.isDown('KeyA') || this.isDown('ArrowLeft')) out.x -= 1;
    if (this.isDown('KeyD') || this.isDown('ArrowRight')) out.x += 1;
    return out;
  }

  /** Сбросить накопленные за кадр события. Вызывается в конце кадра. */
  endFrame(): void {
    this.pressed.clear();
    this.released.clear();
    this.mousePressed.clear();
    this.mouseDeltaX = 0;
    this.mouseDeltaY = 0;
    this.wheelDelta = 0;
  }

  dispose(): void {
    window.removeEventListener('keydown', this.handleKeyDown);
    window.removeEventListener('keyup', this.handleKeyUp);
    window.removeEventListener('blur', this.handleBlur);
    document.removeEventListener('pointerlockchange', this.handlePointerLockChange);
    this.element.removeEventListener('mousemove', this.handleMouseMove);
    this.element.removeEventListener('mousedown', this.handleMouseDown);
    window.removeEventListener('mouseup', this.handleMouseUp);
    this.element.removeEventListener('wheel', this.handleWheel);
    this.element.removeEventListener('contextmenu', this.handleContextMenu);
  }
}
