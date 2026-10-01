import { SCORE_LANGUAGES, type ScoreSetEntry } from "./set.server";

/**
 * The hidden run's leak check (YOY-141 AC-3): the score workflow captures the
 * runner's whole output, and this check fails the job when any hidden query
 * appears in it — before anything is printed, and without ever printing the
 * query that leaked.
 *
 * Score-table lines are matched strictly and skipped: their every cell is a
 * language code, a number, or yes/no, so they cannot carry query text, and
 * skipping them keeps a one-word hidden search such as "score" from failing
 * a clean run on the table's own header. Elsewhere a query counts as found
 * when it appears as whole words, case-insensitively.
 */

const LANGUAGE = `(?:${SCORE_LANGUAGES.join("|")})`;
const TABLE_HEADER = /^language\s+score\s+searches\s+model-written\s+under 1 s\s+failed$/;
const TABLE_ROW = new RegExp(`^${LANGUAGE}\\s+\\d+\\.\\d{3}\\s+\\d+\\s+(?:yes|no)\\s+\\d+%\\s+\\d+$`);

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
    .filter((line) => !TABLE_HEADER.test(line) && !TABLE_ROW.test(line))
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
