import type * as THREE from 'three';

/** The named uniforms of a shader material, checked once so the per-frame code reads them without lookups that can fail. */
export function bindUniforms<K extends string>(material: THREE.ShaderMaterial, names: readonly K[]): Record<K, THREE.IUniform> {
  const out = {} as Record<K, THREE.IUniform>;
  for (const name of names) {
    const u = material.uniforms[name];
    if (!u) throw new Error(`shader material has no uniform ${name}`);
    out[name] = u;
  }
  return out;
}
