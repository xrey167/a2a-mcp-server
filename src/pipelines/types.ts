/**
 * Pipeline definitions — configurable multi-step project generation.
 *
 * Each pipeline describes:
 *  - what kind of project it produces
 *  - the ordered steps to go from idea → production-ready code
 *  - quality gate criteria ("Ralph Mode")
 *  - the default tech stack and scaffolding template
 */

export interface PipelineStep {
  /** Unique step id within the pipeline */
  id: string;
  /** Human-readable label for progress reporting */
  label: string;
  /** Which skill to invoke (resolved via delegate routing) */
  skillId: string;
  /** Static args merged with dynamic context at runtime */
  args?: Record<string, unknown>;
  /** If true, step output replaces the running spec (default: appends) */
  replacesSpec?: boolean;
  /** If true, failure here is non-fatal — pipeline continues */
  optional?: boolean;
}

export interface QualityGate {
  /** Dimensions scored 0-100 */
  dimensions: string[];
  /** Minimum average score to pass (0-100) */
  passThreshold: number;
  /** Maximum number of QA → fix cycles before giving up */
  maxIterations: number;
}

export interface PipelineTemplate {
  /** Directory structure entries: path → content (empty string = directory) */
  files: Record<string, string>;
}

export interface Pipeline {
  id: string;
  name: string;
  description: string;
  /** Default tech stack tags */
  stack: string[];
  /** Ordered generation steps */
  steps: PipelineStep[];
  /** Quality gate config */
  qualityGate: QualityGate;
  /** Initial project scaffold */
  template: PipelineTemplate;
  /** Prompt template for intent normalization — {{idea}} is replaced with user input */
  intentPrompt: string;
}
