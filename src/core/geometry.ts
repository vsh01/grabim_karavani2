import * as THREE from 'three';

/**
 * Небольшой набор инструментов для процедурных моделей.
 *
 * Своя склейка геометрий вместо аддона BufferGeometryUtils: нам нужны ровно три
 * атрибута (позиция, нормаль, цвет), зато без лишних зависимостей и с полным
 * контролем над тем, что попадает в буфер.
 */

const ATTRIBUTES = ['position', 'normal', 'color'] as const;
type AttributeName = (typeof ATTRIBUTES)[number];

/** Гарантировать наличие атрибута цвета, залив его одним цветом. */
export function paint(
  geometry: THREE.BufferGeometry,
  color: THREE.ColorRepresentation,
  variation = 0,
): THREE.BufferGeometry {
  const base = new THREE.Color(color);
  const position = geometry.getAttribute('position');
  const count = position.count;
  const colors = new Float32Array(count * 3);

  const hsl = { h: 0, s: 0, l: 0 };
  base.getHSL(hsl);
  const tint = new THREE.Color();

  for (let i = 0; i < count; i++) {
    if (variation > 0) {
      // Лёгкий разброс яркости по вершинам — модели перестают выглядеть пластиковыми.
      const shift = (Math.sin(i * 12.9898) * 43758.5453) % 1;
      tint.setHSL(hsl.h, hsl.s, THREE.MathUtils.clamp(hsl.l + shift * variation, 0.02, 0.98));
    } else {
      tint.copy(base);
    }
    colors[i * 3] = tint.r;
    colors[i * 3 + 1] = tint.g;
    colors[i * 3 + 2] = tint.b;
  }

  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return geometry;
}

/** Сдвинуть/повернуть/масштабировать геометрию на месте. */
export function place(
  geometry: THREE.BufferGeometry,
  x: number,
  y: number,
  z: number,
  rotX = 0,
  rotY = 0,
  rotZ = 0,
  scale = 1,
): THREE.BufferGeometry {
  if (scale !== 1) geometry.scale(scale, scale, scale);
  if (rotX) geometry.rotateX(rotX);
  if (rotZ) geometry.rotateZ(rotZ);
  if (rotY) geometry.rotateY(rotY);
  geometry.translate(x, y, z);
  return geometry;
}

/**
 * Склеить несколько геометрий в одну.
 * Все входные геометрии должны быть индексированными или неиндексированными
 * одновременно — здесь мы приводим всё к индексированному виду.
 */
export function merge(geometries: THREE.BufferGeometry[]): THREE.BufferGeometry {
  if (geometries.length === 0) return new THREE.BufferGeometry();
  if (geometries.length === 1) return geometries[0];

  let totalVertices = 0;
  let totalIndices = 0;

  for (const geometry of geometries) {
    const position = geometry.getAttribute('position');
    totalVertices += position.count;
    totalIndices += geometry.index ? geometry.index.count : position.count;
  }

  const merged = new THREE.BufferGeometry();
  const buffers: Record<AttributeName, Float32Array> = {
    position: new Float32Array(totalVertices * 3),
    normal: new Float32Array(totalVertices * 3),
    color: new Float32Array(totalVertices * 3),
  };
  const indices = totalVertices > 65535 ? new Uint32Array(totalIndices) : new Uint16Array(totalIndices);

  let vertexOffset = 0;
  let indexOffset = 0;

  for (const geometry of geometries) {
    const count = geometry.getAttribute('position').count;

    for (const name of ATTRIBUTES) {
      const attribute = geometry.getAttribute(name);
      const target = buffers[name];
      if (attribute) {
        for (let i = 0; i < count; i++) {
          target[(vertexOffset + i) * 3] = attribute.getX(i);
          target[(vertexOffset + i) * 3 + 1] = attribute.getY(i);
          target[(vertexOffset + i) * 3 + 2] = attribute.getZ(i);
        }
      } else if (name === 'color') {
        target.fill(1, vertexOffset * 3, (vertexOffset + count) * 3);
      }
    }

    const index = geometry.index;
    if (index) {
      for (let i = 0; i < index.count; i++) indices[indexOffset + i] = index.getX(i) + vertexOffset;
      indexOffset += index.count;
    } else {
      for (let i = 0; i < count; i++) indices[indexOffset + i] = vertexOffset + i;
      indexOffset += count;
    }

    vertexOffset += count;
    geometry.dispose();
  }

  merged.setAttribute('position', new THREE.BufferAttribute(buffers.position, 3));
  merged.setAttribute('normal', new THREE.BufferAttribute(buffers.normal, 3));
  merged.setAttribute('color', new THREE.BufferAttribute(buffers.color, 3));
  merged.setIndex(new THREE.BufferAttribute(indices, 1));
  merged.computeBoundingBox();
  merged.computeBoundingSphere();
  return merged;
}

/** Сколько треугольников в геометрии — для отладочной статистики. */
export function triangleCount(geometry: THREE.BufferGeometry): number {
  const index = geometry.index;
  return Math.floor((index ? index.count : geometry.getAttribute('position').count) / 3);
}
