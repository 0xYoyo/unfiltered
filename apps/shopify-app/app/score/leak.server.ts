import { SCORE_LANGUAGES, type ScoreSetEntry } from "./set.server";

/**
 * The hidden run's leak check (YOY-141 AC-3): the score workflow captures the
 * runner's whole output, and this check fails the job when any hidden query
 * appears in it — before anything is printed, and without ever printing the
 * query that leaked.
 *
 * Score-table lines, the cost line and the failure lines are matched strictly
 * and skipped: their every cell is a language code, a number, yes/no, a
 * stage or an error class name, so they cannot carry query text, and
 * skipping them keeps a one-word hidden search such as "score" from failing
 * a clean run on the table's own header. Elsewhere a query counts as found
 * when it appears as whole words, case-insensitively.
 */

const LANGUAGE = `(?:${SCORE_LANGUAGES.join("|")})`;
const TABLE_HEADER =
  /^language\s+score\s+searches\s+model-written\s+under 1 s \(local\)\s+no extraction\s+extraction cached\s+failed$/;
// The "no extraction" (YOY-149 AC-4) and "extraction cached" (AC-18) cells
// are each a share or an em dash.
const TABLE_ROW = new RegExp(
  `^${LANGUAGE}\\s+\\d+\\.\\d{3}\\s+\\d+\\s+(?:yes|no)\\s+\\d+%\\s+(?:\\d+%|—)\\s+(?:\\d+%|—)\\s+\\d+$`,
);
const COST_LINE = /^cost \$\d+\.\d{4} over \d+ model calls$/;
const FAILURE_LINE = /^failed (?:search|grade) [A-Za-z_$][\w$]{0,63} \d+$/;
// A multi-pass run's pass header and each pass's extraction-call count (YOY-149 AC-18).
const PASS_LINE = /^pass \d+$/;
// The runner's progress and early-stop lines (YOY-149 runner guards).
const PROGRESS_LINE = new RegExp(`^\\[\\d+/\\d+\\] ${LANGUAGE} (?:ok|fail (?:search|grade))$`);
const ABORT_LINE = /^aborted after \d+ consecutive failures$/;
const EXTRACT_LINE = /^extract calls \d+$/;
const STRICT_LINES = [
  TABLE_HEADER,
  TABLE_ROW,
  COST_LINE,
  FAILURE_LINE,
  PASS_LINE,
  EXTRACT_LINE,
  PROGRESS_LINE,
  ABORT_LINE,
];

/**
 * The query as whole words: not preceded or followed by a letter or digit,
 * so a two-letter search such as "en" is not "found" inside "hidden".
 */
function wholeWords(query: string): RegExp {
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, "u");
}

export interface LeakReport {
  /** How many hidden searches appear in the output; their text is never kept. */
  leaked: number;
}

export function findLeaks(
  output: string,
  hiddenSet: readonly ScoreSetEntry[],
): LeakReport {
  const free = output
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => !STRICT_LINES.some((shape) => shape.test(line)))
    .join("\n")
    .toLowerCase();
  let leaked = 0;
  for (const entry of hiddenSet) {
    const query = entry.query.trim().toLowerCase();
    if (query !== "" && wholeWords(query).test(free)) {
      leaked += 1;
    }
  }
  return { leaked };
}
