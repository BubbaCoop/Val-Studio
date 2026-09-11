/**
 * The clarification shape (methodology §3, and §8b for a refused feedback finding).
 *
 * This is the single most important rendering contract in Studio. A blocked brief
 * and a refused feedback finding arrive in the SAME shape and are rendered by the
 * SAME component, deliberately. The fields are relayed VERBATIM — never
 * paraphrased, never softened, never collapsed into "not supported".
 *
 * ROUTE: appears only on a refusal, and is the only part that tells the designer
 * how to make the ask legal. Dropping it turns a route into a bare refusal.
 */

/** The five methodology stop triggers, plus whatever the surface block adds. */
export type StopTrigger =
  | "no-component"
  | "brief-missing-field"
  | "archetype-not-in-§2"
  | "§13-open-item"
  | "§9-forbidden"
  | (string & {});

export interface ClarificationQuestion {
  /** Q1, H1… — the id the pipeline gave it, when it has one. */
  id?: string;
  /** Q: — the question, answerable in one message. */
  question: string;
  /** TRIGGER: */
  trigger?: StopTrigger;
  /** NEEDED-FOR: the block / field / step it blocks. */
  neededFor?: string;
  /** CHECKED: the §s and library files read before asking. */
  checked?: string;
  /** COST-OF-GUESSING: what a wrong default breaks. */
  costOfGuessing?: string;
  /**
   * ROUTE: — refusals only. Names the methodology change that would make the ask
   * legal (a §12 planned addition with an interim class, or a §13 open item) and
   * says the edit is made in the methodology file and committed to git, NOT here.
   */
  route?: string;
  /** ACCEPTABLE-ANSWER: a sentence, a decision, or "out of scope". */
  acceptableAnswer?: string;
  /**
   * Every stop-trigger question is BLOCKING. The single non-blocking class is
   * missing non-legal copy, which the architect drafts and marks DRAFT.
   */
  blocking: boolean;
  /** Non-blocking questions carry the default they will take if unanswered. */
  proposedDefault?: string;
  /** The unparsed block, so the UI can always fall back to rendering it as given. */
  raw: string;
}

export interface ClarificationRound {
  /** Which gate raised these. */
  gate: number | string;
  /** `brief` (Gate 1) or `feedback` (Gate 4a refusal). Same shape, same component. */
  origin: "brief" | "concept" | "feedback" | "build";
  /** Run-relative path of the file the questions were parsed out of. */
  source: string;
  questions: ClarificationQuestion[];
  /** Verbatim NON-BLOCKING prose when the file records one (often "None."). */
  nonBlockingNote?: string;
}
