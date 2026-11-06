// Minimal ambient types for the OPTIONAL onnxruntime-node dependency. The
// package is never a hard dependency (GroundingDINO grounding is available only
// when a user installs it + drops a model in); these declarations keep
// dino-inference.ts type-safe without forcing an install. The runtime is loaded
// lazily via dynamic import and every failure path degrades to "unavailable".
declare module 'onnxruntime-node' {
  export type TensorData = number[] | Float32Array;
  export class Tensor {
    constructor(type: string, data: TensorData, dims: number[]);
  }
  export interface SessionRunResult {
    [name: string]: unknown;
  }
  export interface InferenceSession {
    run(inputs: Record<string, unknown>): Promise<SessionRunResult>;
  }
  export const InferenceSession: {
    create(modelPath: string): Promise<InferenceSession>;
  };
}