import type { PrepareStepFunction, ToolSet } from 'ai';

export const WRAP_UP_NOTE = `# Budget exhausted: write your final report now
You have used your step or time budget for this turn. Tools are disabled for this step. Do not ask to continue and do not plan further searches. Write the report now, based only on what you have already gathered, even if the investigation is incomplete:
- What you checked (ticket fields read, SPL queries run with their sid, tabs used)
- What you found, quoting key log lines with timestamps and hosts. If nothing relevant turned up, say so plainly.
- What is still unknown, and the exact next searches or checks you would run
- A likely cause only if the evidence supports one, clearly marked as a hypothesis otherwise`;

export const LOW_BUDGET_NOTE = `# Budget running low
You are close to your step or time budget for this turn. Stop widening the search. Run at most one or two more focused queries if they are essential, then write the report.`;

export interface Budget {
  maxSteps: number;
  maxMinutes: number;
  /**
   * Steps and agent time already spent earlier in this turn. A turn that pauses for a tool approval
   * resumes as a new request; without these it would get a fresh budget after every approval.
   * Time spent waiting for the user to approve is not counted.
   */
  stepsUsed?: number;
  msUsed?: number;
}

/** Steps this request may still take (at least 1, which is then the forced report). */
export function remainingSteps(b: Budget): number {
  return Math.max(1, b.maxSteps - (b.stepsUsed ?? 0));
}

/**
 * Makes sure every turn ends with a written answer. Without this, the loop stops when it hits
 * maxSteps; if that last step was a tool call, the user gets no text at all.
 *
 * - Last allowed step, or time budget used up: tools are disabled (toolChoice 'none'; they stay
 *   declared because providers reject tool history without tool definitions) and the model is
 *   told to report what it has.
 * - Within 3 steps or 80% of the time budget: a nudge to start wrapping up.
 */
export function budgetPrepareStep<T extends ToolSet>(
  budget: Budget,
  base: string,
  now: () => number = Date.now,
): PrepareStepFunction<T> {
  const start = now();
  const timeMs = budget.maxMinutes * 60_000;
  return ({ stepNumber }) => {
    const elapsed = (budget.msUsed ?? 0) + now() - start;
    const stepsLeft = remainingSteps(budget) - stepNumber; // includes this step
    if (stepsLeft <= 1 || elapsed >= timeMs) {
      return { toolChoice: 'none', instructions: `${base}\n\n${WRAP_UP_NOTE}` };
    }
    if (stepsLeft <= 4 || elapsed >= timeMs * 0.8) {
      return { instructions: `${base}\n\n${LOW_BUDGET_NOTE}` };
    }
    return { instructions: base };
  };
}
