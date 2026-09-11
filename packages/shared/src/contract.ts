/**
 * `05-package/contract.json` — the machine-readable half of the handoff package.
 *
 * Typed field-for-field against @valiify/val-core/tools/design/contract.schema.json
 * (draft-07, `additionalProperties: false`). The handoff screen renders exactly
 * these seven groups: blocks / fields / states / actions / copy / icons / planned.
 */

export interface ContractBlock {
  /** `^b[0-9]+$` — the same id the concept declared. */
  id: string;
  region?: string;
  /** Component file name when the block is its own component. */
  component?: string;
  /** Package-relative file the block is implemented in. */
  file: string;
  classes?: string[];
}

export interface ContractField {
  id: string;
  label: string;
  type: string;
  format?: string;
  required?: boolean;
  placeholder?: string;
  /** Where the option list comes from. */
  options?: string;
  /** The prop path the value binds to. */
  bind?: string;
}

export interface ContractState {
  id: string;
  /** The prop expression that produces this state. */
  when: string;
  prop?: string;
  blocks: string[];
}

export interface ContractAction {
  id: string;
  label: string;
  /** back | continue | confirm | card-advance | row | rail | utility — the methodology's action tier. */
  kind: string;
  enabledWhen?: string;
  emits?: string;
  record?: string;
}

export interface ContractCopy {
  id: string;
  role?: string;
  text: string;
  /** DRAFT means the architect wrote it under §8 and the reviewer approved it at the gate. */
  source: "brief" | "DRAFT" | "methodology";
  /** false when a type-* utility supplies the casing. */
  verbatimInMarkup?: boolean;
}

/** A methodology §12 interim class, so the dev team knows what to swap. */
export interface ContractPlanned {
  class: string;
  value?: string;
  ref: string;
  blocks?: string[];
}

export interface DesignContract {
  route: string;
  surface?: string;
  /** Step-based surfaces only. */
  step?: { n?: number; m?: number; section?: string };
  archetype: string;
  blocks: ContractBlock[];
  fields?: ContractField[];
  states: ContractState[];
  actions: ContractAction[];
  copy: ContractCopy[];
  /** Sprite symbol ids, without the `#`. */
  icons?: string[];
  planned?: ContractPlanned[];
}
