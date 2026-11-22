# mend

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/ishiemon/mend/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/ishiemon/mend/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

`mend` is a command-line tool that applies edits written by AI models to a tree of text files. Models write
edits in four formats, and mend reads all of them:

- unified diffs, including hunks whose line numbers are wrong;
- SEARCH/REPLACE blocks;
- V4A patches (`*** Begin Patch` … `*** End Patch`);
- JSON tool calls (`create`, `str_replace`, `insert`), as one array or as JSON Lines.

Old lines are found at the first of three matching tiers — exact, then ignoring trailing whitespace, then
ignoring leading and trailing whitespace — so an edit still lands when its whitespace or indentation has
drifted. Tier-2 matches re-indent the new lines onto the file's own indentation, and context lines are always
written back as the file's own lines. Every edit in a patch is applied or none is: a failed edit changes
nothing, all failures are reported in patch order, and no file is written unless every edit succeeded.

## Usage

    node main.ts [--format=NAME] [--check] [--strict] [PATCH]

- `PATCH` is the patch file, relative to the working directory, which is the root of the tree. Without it (or
  with `-`) the patch is read from standard input.
- `--format=NAME` forces one format: `unified`, `search-replace`, `v4a` or `json`. The default, `auto`,
  detects the format from the patch text.
- `--check` prints the same result and exit code but writes nothing.
- `--strict` matches lines exactly (tier 0 only).

On success mend prints one line per changed path (`A`, `D`, `M`, or `R <old> -> <new>` for a move) in byte
order, then `ok: <n> files`. On failure it prints one `error: <code> <path>` line per failed edit and
`failed: <k> of <n> edits`, and exits 1. Usage, unreadable-patch, format and parse errors exit 2 with a single
line. The full contract is [SPEC.md](SPEC.md).

## Layout

- `main.ts` — the CLI itself (Node 22, standard library only).
- `runner.ts` — the trial runner, kept as the kit ships it: when `MAKEFUN_ENV_URL` is set, `main.ts` hands
  over to it.
- `check.ts` — runs `main.ts` against the kit's public practice checks.
- `SPEC.md` — the specification mend implements.

## Bounty

Built by an AI agent for make.fun's ["Build mend, one patch tool for every AI edit format"](https://make.fun/bounty/hidden-spec-cli-01-run-20261122) bounty, $100 in USDC.

## License

MIT — see [LICENSE](LICENSE).
