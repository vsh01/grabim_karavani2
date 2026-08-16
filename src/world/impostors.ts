import * as THREE from 'three';

/**
 * Импосторы — те самые «деревья картинкой вдали».
 *
 * При запуске каждая порода дерева фотографируется с восьми сторон в общий
 * атлас. Дальний лес рисуется одним вызовом: десятки тысяч квадратиков, каждый
 * из которых повёрнут к камере и показывает снимок с нужного угла. Когда игрок
 * подходит ближе, квадратик растворяется, а на его месте проявляется настоящая
 * трёхмерная модель.
 */

export interface ImpostorAtlas {
  texture: THREE.Texture;
  /** Сколько ракурсов запечено на породу. */
  angles: number;
  /** Строк в атласе — по одной на породу. */
  rows: number;
  /** На каждую породу: ширина, высота и высота центра прямоугольника в метрах. */
  quads: Float32Array;
  dispose(): void;
}

export interface BakeOptions {
  /** Сторона одной ячейки атласа в пикселях. */
  tile?: number;
  /** Число ракурсов вокруг дерева. */
  angles?: number;
}

/**
 * Запечь атлас импосторов.
 * Возвращает текстуру-атлас и размеры прямоугольника для каждой породы, чтобы
 * билборд в мире занимал ровно то же место, что и настоящая модель.
 */
export function bakeImpostorAtlas(
  renderer: THREE.WebGLRenderer,
  geometries: readonly THREE.BufferGeometry[],
  options: BakeOptions = {},
): ImpostorAtlas {
  const tile = options.tile ?? 192;
  const angles = options.angles ?? 8;
  const rows = geometries.length;

  const target = new THREE.WebGLRenderTarget(tile * angles, tile * rows, {
    minFilter: THREE.LinearMipmapLinearFilter,
    magFilter: THREE.LinearFilter,
    wrapS: THREE.ClampToEdgeWrapping,
    wrapT: THREE.ClampToEdgeWrapping,
    format: THREE.RGBAFormat,
    type: THREE.UnsignedByteType,
    depthBuffer: true,
    stencilBuffer: false,
    generateMipmaps: true,
    colorSpace: THREE.SRGBColorSpace,
  });
  target.texture.name = 'impostor-atlas';
  target.texture.anisotropy = Math.min(4, renderer.capabilities.getMaxAnisotropy());

  const scene = new THREE.Scene();
  const material = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
  const mesh = new THREE.Mesh(geometries[0], material);
  scene.add(mesh);

  // Освещение при запекании близко к дневному, но помягче: импостор не умеет
  // менять освещение, поэтому пусть будет ближе к среднему.
  const hemisphere = new THREE.HemisphereLight(0xc2d6ea, 0x50583a, 1.35);
  const sun = new THREE.DirectionalLight(0xfff0d4, 1.25);
  sun.position.set(0.5, 1.0, 0.35);
  scene.add(hemisphere, sun, sun.target);

  const quads = new Float32Array(rows * 3);
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.5, 1200);
  const center = new THREE.Vector3();

  // Сохраняем состояние рендерера, чтобы вернуть его в исходное положение.
  const prevTarget = renderer.getRenderTarget();
  const prevAutoClear = renderer.autoClear;
  const prevClearColor = new THREE.Color();
  renderer.getClearColor(prevClearColor);
  const prevClearAlpha = renderer.getClearAlpha();
  const prevViewport = new THREE.Vector4();
  const prevScissor = new THREE.Vector4();
  renderer.getViewport(prevViewport);
  renderer.getScissor(prevScissor);
  const prevScissorTest = renderer.getScissorTest();

  renderer.setRenderTarget(target);
  renderer.setClearColor(0x000000, 0);
  renderer.clear(true, true, false);
  renderer.autoClear = false;
  renderer.setScissorTest(true);

  for (let row = 0; row < rows; row++) {
    const geometry = geometries[row];
    geometry.computeBoundingBox();
    const box = geometry.boundingBox ?? new THREE.Box3(new THREE.Vector3(-1, 0, -1), new THREE.Vector3(1, 2, 1));

    const spread = Math.max(Math.abs(box.min.x), Math.abs(box.max.x), Math.abs(box.min.z), Math.abs(box.max.z));
    const top = Math.max(0.5, box.max.y);
    const halfWidth = Math.max(0.3, spread) * 1.06;
    const halfHeight = (top / 2) * 1.06;

    quads[row * 3] = halfWidth * 2;
    quads[row * 3 + 1] = halfHeight * 2;
    quads[row * 3 + 2] = top / 2;

    mesh.geometry = geometry;
    camera.left = -halfWidth;
    camera.right = halfWidth;
    camera.top = halfHeight;
    camera.bottom = -halfHeight;
    center.set(0, top / 2, 0);

    for (let a = 0; a < angles; a++) {
      const theta = (a / angles) * Math.PI * 2;
      camera.position.set(Math.sin(theta) * 400, 0, Math.cos(theta) * 400).add(center);
      camera.up.set(0, 1, 0);
      camera.lookAt(center);
      camera.updateProjectionMatrix();

      const x = a * tile;
      const y = row * tile;
      renderer.setViewport(x, y, tile, tile);
      renderer.setScissor(x, y, tile, tile);
      renderer.render(scene, camera);
    }
  }

  renderer.autoClear = prevAutoClear;
  renderer.setRenderTarget(prevTarget);
  renderer.setClearColor(prevClearColor, prevClearAlpha);
  renderer.setViewport(prevViewport);
  renderer.setScissor(prevScissor);
  renderer.setScissorTest(prevScissorTest);

  material.dispose();
  hemisphere.dispose();
  sun.dispose();

  return {
    texture: target.texture,
    angles,
    rows,
    quads,
    dispose: () => target.dispose(),
  };
}

const BILLBOARD_VERTEX = /* glsl */ `
  attribute vec3 iOffset;
  attribute vec3 iQuad;   // ширина, высота, высота центра — уже с учётом размера дерева
  attribute vec2 iTile;   // поворот дерева, номер строки атласа

  uniform float uAngles;
  uniform float uRows;
  uniform vec2 uFade;     // начало и конец появления билборда, метры
  uniform vec2 uFadeOut;  // где билборд растворяется в тумане

  varying vec2 vUv;
  varying float vFade;
  varying float vDepth;

  const float TAU = 6.28318530718;

  void main() {
    vec3 toCamera = cameraPosition - iOffset;
    float camYaw = atan(toCamera.x, toCamera.z);

    // Цилиндрический билборд: разворачиваем только вокруг вертикали, поэтому
    // дерево никогда не заваливается набок.
    vec3 right = vec3(cos(camYaw), 0.0, -sin(camYaw));
    vec3 worldPos = iOffset
      + right * (position.x * iQuad.x)
      + vec3(0.0, position.y * iQuad.y + iQuad.z, 0.0);

    // Ракурс выбираем по углу между камерой и собственным поворотом дерева.
    float relative = camYaw - iTile.x;
    float tile = mod(floor(fract(relative / TAU) * uAngles + 0.5), uAngles);
    vUv = vec2((uv.x + tile) / uAngles, (uv.y + iTile.y) / uRows);

    float distance = length(toCamera);
    float fadeIn = clamp((distance - uFade.x) / max(0.001, uFade.y - uFade.x), 0.0, 1.0);
    float fadeOut = 1.0 - clamp((distance - uFadeOut.x) / max(0.001, uFadeOut.y - uFadeOut.x), 0.0, 1.0);
    vFade = min(fadeIn, fadeOut);

    vec4 mvPosition = viewMatrix * vec4(worldPos, 1.0);
    vDepth = -mvPosition.z;
    gl_Position = projectionMatrix * mvPosition;
  }
`;

const BILLBOARD_FRAGMENT = /* glsl */ `
  precision highp float;

  uniform sampler2D uAtlas;
  uniform vec3 uFogColor;
  uniform vec2 uFogRange;
  uniform vec3 uTint;

  varying vec2 vUv;
  varying float vFade;
  varying float vDepth;

  // Чередующийся градиентный шум — дешёвая замена матрице Байера.
  float dither(vec2 p) {
    return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715))));
  }

  void main() {
    vec4 texel = texture2D(uAtlas, vUv);

    // Мипмапы размывают края кроны; подтягиваем альфу обратно, иначе дальний
    // лес выцветает в полупрозрачную кашу.
    float alpha = clamp((texel.a - 0.22) / 0.34, 0.0, 1.0);
    if (alpha < 0.5) discard;

    if (vFade < dither(gl_FragCoord.xy)) discard;

    vec3 color = texel.rgb * uTint;
    color = mix(color, uFogColor, smoothstep(uFogRange.x, uFogRange.y, vDepth));
    gl_FragColor = vec4(color, 1.0);
  }
`;

/**
 * Поле билбордов: один инстансный меш на весь дальний лес.
 */
export class ImpostorField {
  readonly mesh: THREE.Mesh;
  readonly material: THREE.ShaderMaterial;

  private readonly geometry: THREE.InstancedBufferGeometry;
  private readonly offsets: Float32Array;
  private readonly quadsAttr: Float32Array;
  private readonly tiles: Float32Array;
  private readonly offsetAttribute: THREE.InstancedBufferAttribute;
  private readonly quadAttribute: THREE.InstancedBufferAttribute;
  private readonly tileAttribute: THREE.InstancedBufferAttribute;
  private readonly atlas: ImpostorAtlas;
  private cursor = 0;

  constructor(atlas: ImpostorAtlas, readonly capacity: number) {
    this.atlas = atlas;

    const base = new THREE.PlaneGeometry(1, 1);
    this.geometry = new THREE.InstancedBufferGeometry();
    this.geometry.setIndex(base.getIndex());
    this.geometry.setAttribute('position', base.getAttribute('position'));
    this.geometry.setAttribute('uv', base.getAttribute('uv'));

    this.offsets = new Float32Array(capacity * 3);
    this.quadsAttr = new Float32Array(capacity * 3);
    this.tiles = new Float32Array(capacity * 2);

    this.offsetAttribute = new THREE.InstancedBufferAttribute(this.offsets, 3);
    this.quadAttribute = new THREE.InstancedBufferAttribute(this.quadsAttr, 3);
    this.tileAttribute = new THREE.InstancedBufferAttribute(this.tiles, 2);
    this.offsetAttribute.setUsage(THREE.DynamicDrawUsage);
    this.quadAttribute.setUsage(THREE.DynamicDrawUsage);
    this.tileAttribute.setUsage(THREE.DynamicDrawUsage);

    this.geometry.setAttribute('iOffset', this.offsetAttribute);
    this.geometry.setAttribute('iQuad', this.quadAttribute);
    this.geometry.setAttribute('iTile', this.tileAttribute);
    this.geometry.instanceCount = 0;

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uAtlas: { value: atlas.texture },
        uAngles: { value: atlas.angles },
        uRows: { value: atlas.rows },
        uFade: { value: new THREE.Vector2(150, 175) },
        uFadeOut: { value: new THREE.Vector2(700, 800) },
        uFogColor: { value: new THREE.Color(0x9fb0bd) },
        uFogRange: { value: new THREE.Vector2(240, 1150) },
        uTint: { value: new THREE.Color(1, 1, 1) },
      },
      vertexShader: BILLBOARD_VERTEX,
      fragmentShader: BILLBOARD_FRAGMENT,
      side: THREE.DoubleSide,
      transparent: false,
      depthWrite: true,
      fog: false,
    });

    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.name = 'forest-impostors';
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.renderOrder = 0;

    base.dispose();
  }

  begin(): void {
    this.cursor = 0;
  }

  /**
   * Добавить дерево в дальний лес.
   * @param scale множитель размера конкретного дерева
   * @param rotation собственный поворот дерева вокруг вертикали
   * @param species индекс породы (он же строка атласа)
   */
  push(x: number, y: number, z: number, scale: number, rotation: number, species: number): void {
    if (this.cursor >= this.capacity) return;
    const i = this.cursor++;

    this.offsets[i * 3] = x;
    this.offsets[i * 3 + 1] = y;
    this.offsets[i * 3 + 2] = z;

    const q = species * 3;
    this.quadsAttr[i * 3] = this.atlas.quads[q] * scale;
    this.quadsAttr[i * 3 + 1] = this.atlas.quads[q + 1] * scale;
    this.quadsAttr[i * 3 + 2] = this.atlas.quads[q + 2] * scale;

    this.tiles[i * 2] = rotation;
    this.tiles[i * 2 + 1] = species;
  }

  end(): void {
    this.geometry.instanceCount = this.cursor;
    this.offsetAttribute.needsUpdate = true;
    this.quadAttribute.needsUpdate = true;
    this.tileAttribute.needsUpdate = true;
  }

  get count(): number {
    return this.cursor;
  }

  /** Диапазон, на котором билборд проявляется вместо трёхмерной модели. */
  setFade(start: number, end: number): void {
    (this.material.uniforms.uFade.value as THREE.Vector2).set(start, end);
  }

  /** Дальняя граница, где билборды растворяются в тумане. */
  setFadeOut(start: number, end: number): void {
    (this.material.uniforms.uFadeOut.value as THREE.Vector2).set(start, end);
  }

  setFog(color: THREE.Color, near: number, far: number): void {
    (this.material.uniforms.uFogColor.value as THREE.Color).copy(color);
    (this.material.uniforms.uFogRange.value as THREE.Vector2).set(near, far);
  }

  /** Общий оттенок: днём белый, ночью синеватый и тёмный. */
  setTint(color: THREE.Color): void {
    (this.material.uniforms.uTint.value as THREE.Color).copy(color);
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}
