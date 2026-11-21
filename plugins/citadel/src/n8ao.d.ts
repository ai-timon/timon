// N8AO ships no types: the part of its pass that Citadel uses.
declare module 'n8ao' {
  export class N8AOPass {
    constructor(scene: import('three').Scene, camera: import('three').Camera, width?: number, height?: number);
    isPass: true;
    enabled: boolean;
    needsSwap: boolean;
    clear: boolean;
    renderToScreen: boolean;
    configuration: Record<string, unknown>;
    setQualityMode(mode: 'Low' | 'Medium' | 'High' | 'Ultra' | 'Performance'): void;
    setSize(width: number, height: number): void;
    render(renderer: import('three').WebGLRenderer, writeBuffer: import('three').WebGLRenderTarget, readBuffer: import('three').WebGLRenderTarget, deltaTime: number, maskActive: boolean): void;
    dispose(): void;
  }
}
