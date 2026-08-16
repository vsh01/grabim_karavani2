import * as THREE from 'three';

/**
 * Брызги крови и пыль.
 *
 * Один буфер точек на весь мир: частицы берутся по кругу, поэтому ни выделений
 * памяти в бою, ни лишних объектов в сцене. Без этой мелочи попадания читаются
 * плохо — особенно когда отрубает руку.
 */
const CAPACITY = 480;
const GRAVITY = 11;

export class BloodEffects {
  readonly points: THREE.Points;

  private readonly positions: Float32Array;
  private readonly velocities: Float32Array;
  private readonly lives: Float32Array;
  private readonly geometry: THREE.BufferGeometry;
  private readonly material: THREE.ShaderMaterial;
  private cursor = 0;

  constructor() {
    this.positions = new Float32Array(CAPACITY * 3);
    this.velocities = new Float32Array(CAPACITY * 3);
    this.lives = new Float32Array(CAPACITY);

    // Пока частица не живёт, прячем её глубоко под землю.
    for (let i = 0; i < CAPACITY; i++) this.positions[i * 3 + 1] = -10000;

    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    this.geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), Infinity);

    // Своя точечная материя вместо PointsMaterial: нужен потолок экранного
    // размера. С обычным затуханием по расстоянию капля в полуметре от лица
    // разрастается в пол-экрана — на скриншотах это выглядело как красные плиты.
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uColor: { value: new THREE.Color(0x7e1414) },
        uSize: { value: 0.075 },
        uScale: { value: 360 },
      },
      vertexShader: /* glsl */ `
        uniform float uSize;
        uniform float uScale;
        void main() {
          vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mvPosition;
          gl_PointSize = clamp(uSize * uScale / max(0.25, -mvPosition.z), 1.5, 7.0);
        }
      `,
      fragmentShader: /* glsl */ `
        precision mediump float;
        uniform vec3 uColor;
        void main() {
          // Круглая капля, а не квадрат: точки по умолчанию квадратные.
          vec2 offset = gl_PointCoord - 0.5;
          if (dot(offset, offset) > 0.25) discard;
          gl_FragColor = vec4(uColor, 1.0);
        }
      `,
      depthWrite: false,
      transparent: false,
      fog: false,
    });

    this.points = new THREE.Points(this.geometry, this.material);
    this.points.name = 'blood';
    this.points.frustumCulled = false;
  }

  /**
   * Пересчитать масштаб точек при смене размера окна.
   * Тот же множитель, что использует three для своих точек: половина высоты
   * буфера кадра.
   */
  setViewportHeight(height: number): void {
    this.material.uniforms.uScale.value = height * 0.5;
  }

  /**
   * Выбросить брызги из точки.
   * @param force сила разлёта: у отрубленной конечности она заметно больше
   */
  spawn(x: number, y: number, z: number, count: number, force = 3): void {
    for (let i = 0; i < count; i++) {
      const index = this.cursor;
      this.cursor = (this.cursor + 1) % CAPACITY;

      this.positions[index * 3] = x;
      this.positions[index * 3 + 1] = y;
      this.positions[index * 3 + 2] = z;

      const theta = Math.random() * Math.PI * 2;
      const spread = Math.random();
      this.velocities[index * 3] = Math.cos(theta) * spread * force;
      this.velocities[index * 3 + 1] = (0.4 + Math.random()) * force * 0.75;
      this.velocities[index * 3 + 2] = Math.sin(theta) * spread * force;

      this.lives[index] = 0.9 + Math.random() * 0.8;
    }
  }

  update(dt: number, groundHeightAt: (x: number, z: number) => number): void {
    let anyAlive = false;

    for (let i = 0; i < CAPACITY; i++) {
      if (this.lives[i] <= 0) continue;
      anyAlive = true;

      this.lives[i] -= dt;
      if (this.lives[i] <= 0) {
        this.positions[i * 3 + 1] = -10000;
        continue;
      }

      this.velocities[i * 3 + 1] -= GRAVITY * dt;
      this.positions[i * 3] += this.velocities[i * 3] * dt;
      this.positions[i * 3 + 1] += this.velocities[i * 3 + 1] * dt;
      this.positions[i * 3 + 2] += this.velocities[i * 3 + 2] * dt;

      // Долетела до земли — гасим скорость, капля остаётся лежать.
      const ground = groundHeightAt(this.positions[i * 3], this.positions[i * 3 + 2]);
      if (this.positions[i * 3 + 1] <= ground + 0.02) {
        this.positions[i * 3 + 1] = ground + 0.02;
        this.velocities[i * 3] = 0;
        this.velocities[i * 3 + 1] = 0;
        this.velocities[i * 3 + 2] = 0;
      }
    }

    if (anyAlive) this.geometry.getAttribute('position').needsUpdate = true;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}
