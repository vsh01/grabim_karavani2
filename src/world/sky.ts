import * as THREE from 'three';
import { clamp01, lerp, smoothstep, TAU } from '../core/math';

/** Длительность полных суток в секундах реального времени. */
export const DAY_LENGTH = 1200;

const SKY_VERTEX = /* glsl */ `
  varying vec3 vDirection;
  void main() {
    vDirection = normalize(position);
    // Небо всегда вокруг камеры: переносим купол за камерой, вращение оставляем.
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_Position.z = gl_Position.w; // прижимаем к дальней плоскости
  }
`;

const SKY_FRAGMENT = /* glsl */ `
  varying vec3 vDirection;
  uniform vec3 uZenith;
  uniform vec3 uHorizon;
  uniform vec3 uGround;
  uniform vec3 uSunDirection;
  uniform vec3 uSunColor;
  uniform float uSunIntensity;

  void main() {
    vec3 dir = normalize(vDirection);
    float h = dir.y;

    vec3 sky = mix(uHorizon, uZenith, pow(clamp(h, 0.0, 1.0), 0.55));
    sky = mix(sky, uGround, smoothstep(0.0, -0.25, h));

    // Свечение вокруг солнца и сам диск.
    float cosAngle = dot(dir, uSunDirection);
    float glow = pow(clamp(cosAngle, 0.0, 1.0), 26.0);
    float disc = smoothstep(0.9986, 0.9993, cosAngle);
    sky += uSunColor * (glow * 0.55 + disc * 3.0) * uSunIntensity;

    gl_FragColor = vec4(sky, 1.0);
  }
`;

const DAY_ZENITH = new THREE.Color(0x2f6fb5);
const DAY_HORIZON = new THREE.Color(0xa8c4d4);
const DUSK_ZENITH = new THREE.Color(0x2a2b57);
const DUSK_HORIZON = new THREE.Color(0xc9713f);
const NIGHT_ZENITH = new THREE.Color(0x05070f);
const NIGHT_HORIZON = new THREE.Color(0x0e1524);
const GROUND_TINT = new THREE.Color(0x2a2a22);

const SUN_DAY = new THREE.Color(0xfff2d0);
const SUN_DUSK = new THREE.Color(0xff9c4a);
const MOON_COLOR = new THREE.Color(0x9fb6d8);

/**
 * Небо, солнце, луна и смена суток.
 *
 * Отсюда же берётся цвет тумана: и ландшафт, и деревья-картинки растворяются в
 * одной и той же дымке, поэтому переход между уровнями детализации не бросается
 * в глаза.
 */
export class Sky {
  readonly group = new THREE.Group();
  readonly sun = new THREE.DirectionalLight(0xffffff, 2.4);
  readonly hemisphere = new THREE.HemisphereLight(0x9fb6d8, 0x3a4028, 0.9);
  readonly fog = new THREE.Fog(0x9fb0bd, 240, 1150);

  /** Время суток: 0 — полночь, 0.25 — рассвет, 0.5 — полдень, 0.75 — закат. */
  time = 0.34;

  /** 0 — глубокая ночь, 1 — полный день. */
  daylight = 1;

  private readonly dome: THREE.Mesh;
  private readonly material: THREE.ShaderMaterial;
  private readonly stars: THREE.Points;
  private readonly starsMaterial: THREE.PointsMaterial;
  private readonly sunDirection = new THREE.Vector3(0, 1, 0);

  constructor() {
    this.group.name = 'sky';

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uZenith: { value: DAY_ZENITH.clone() },
        uHorizon: { value: DAY_HORIZON.clone() },
        uGround: { value: GROUND_TINT.clone() },
        uSunDirection: { value: new THREE.Vector3(0, 1, 0) },
        uSunColor: { value: SUN_DAY.clone() },
        uSunIntensity: { value: 1 },
      },
      vertexShader: SKY_VERTEX,
      fragmentShader: SKY_FRAGMENT,
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: false,
      fog: false,
    });

    this.dome = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 16), this.material);
    this.dome.name = 'sky-dome';
    this.dome.frustumCulled = false;
    this.dome.renderOrder = -1000;
    this.group.add(this.dome);

    this.stars = this.buildStars();
    this.starsMaterial = this.stars.material as THREE.PointsMaterial;
    this.group.add(this.stars);

    this.sun.name = 'sun';
    this.sun.position.set(120, 200, 80);
    this.group.add(this.sun);
    this.group.add(this.sun.target);
    this.group.add(this.hemisphere);

    this.update(0);
  }

  private buildStars(): THREE.Points {
    const count = 900;
    const positions = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      // Равномерно по верхней полусфере.
      const u = Math.random();
      const v = Math.random();
      const theta = u * TAU;
      const phi = Math.acos(v * 0.98);
      // Звёзды далеко, но внутри дальней плоскости — иначе кроны деревьев
      // перестают их загораживать и небо просвечивает сквозь лес.
      const r = 1800;
      positions[i * 3] = r * Math.sin(phi) * Math.cos(theta);
      positions[i * 3 + 1] = r * Math.cos(phi);
      positions[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));

    const material = new THREE.PointsMaterial({
      color: 0xffffff,
      size: 1.7,
      sizeAttenuation: false,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      depthTest: true,
      fog: false,
    });

    const points = new THREE.Points(geometry, material);
    points.frustumCulled = false;
    points.renderOrder = -999;
    return points;
  }

  /** Продвинуть время суток и пересчитать освещение. */
  update(dt: number): void {
    this.time = (this.time + dt / DAY_LENGTH) % 1;

    // Угол солнца над горизонтом: в полдень (time = 0.5) — зенит.
    const angle = (this.time - 0.25) * TAU;
    const elevation = Math.sin(angle);
    this.sunDirection.set(Math.cos(angle) * 0.55, elevation, Math.cos(angle) * 0.82).normalize();

    this.daylight = clamp01(smoothstep(-0.12, 0.22, elevation));
    const duskAmount = 1 - Math.abs(smoothstep(-0.25, 0.35, elevation) * 2 - 1);

    const zenith = this.material.uniforms.uZenith.value as THREE.Color;
    const horizon = this.material.uniforms.uHorizon.value as THREE.Color;

    zenith.copy(NIGHT_ZENITH).lerp(DAY_ZENITH, this.daylight).lerp(DUSK_ZENITH, duskAmount * 0.7);
    horizon.copy(NIGHT_HORIZON).lerp(DAY_HORIZON, this.daylight).lerp(DUSK_HORIZON, duskAmount * 0.85);

    const sunColor = this.material.uniforms.uSunColor.value as THREE.Color;
    sunColor.copy(SUN_DUSK).lerp(SUN_DAY, smoothstep(0.05, 0.4, elevation));

    (this.material.uniforms.uSunDirection.value as THREE.Vector3).copy(this.sunDirection);
    this.material.uniforms.uSunIntensity.value = clamp01(smoothstep(-0.2, 0.05, elevation));

    // Ночью светит луна — слабо и холодно, но ходить можно.
    const moonlight = 1 - this.daylight;
    this.sun.position.copy(this.sunDirection).multiplyScalar(400);
    if (elevation < 0) this.sun.position.y = Math.abs(this.sun.position.y) * 0.35;
    // Ночь тёмная, но не слепая: по лесу должно быть можно идти, не угадывая.
    this.sun.intensity = lerp(0.45, 2.5, this.daylight);
    this.sun.color.copy(sunColor).lerp(MOON_COLOR, moonlight);

    this.hemisphere.intensity = lerp(0.38, 0.95, this.daylight);
    this.hemisphere.color.copy(horizon).lerp(DAY_HORIZON, 0.3);
    this.hemisphere.groundColor.setHex(0x3a4028).multiplyScalar(lerp(0.35, 1, this.daylight));

    this.starsMaterial.opacity = clamp01(1 - this.daylight * 1.6);

    // Туман догоняет цвет неба у горизонта — граница мира не читается как обрыв.
    this.fog.color.copy(horizon).multiplyScalar(lerp(0.5, 1, this.daylight));
    this.fog.near = lerp(120, 260, this.daylight);
    this.fog.far = lerp(620, 1150, this.daylight);
  }

  /** Купол и звёзды всегда центрируются на камере. */
  follow(camera: THREE.Camera): void {
    this.dome.position.copy(camera.position);
    this.stars.position.copy(camera.position);
    this.sun.position.copy(this.sunDirection).multiplyScalar(400).add(camera.position);
    this.sun.target.position.copy(camera.position);
    this.sun.target.updateMatrixWorld();
  }

  /** Текущее направление на солнце (единичный вектор). */
  get sunVector(): THREE.Vector3 {
    return this.sunDirection;
  }

  /** Подпись времени суток для интерфейса. */
  get clockLabel(): string {
    const totalMinutes = Math.floor(this.time * 24 * 60);
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
  }

  dispose(): void {
    this.dome.geometry.dispose();
    this.material.dispose();
    this.stars.geometry.dispose();
    this.starsMaterial.dispose();
  }
}
