/**
 * The score workflow's leak check (YOY-141 AC-3): exits 1 when any query of
 * the hidden set appears in a run's captured output, printing a count and
 * never the query. Reads two files; needs no env.
 */
import { leakCheckCommand } from "../app/score/cli.server";

process.exit(leakCheckCommand(process.argv.slice(2)));
