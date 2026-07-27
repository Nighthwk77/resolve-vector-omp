/**
 * Shell command safety classification for the pre-execution mutation barrier.
 * Fail closed: any command that cannot be confidently proven read-only is
 * classified as mutating.
 */

const SAFE_READ_ONLY_PREFIXES = [
  "git status",
  "git diff",
  "git log",
  "git show",
  "git branch",
  "git tag",
  "git remote",
  "git config --get",
  "ls",
  "dir",
  "cat",
  "head",
  "tail",
  "less",
  "more",
  "grep",
  "ripgrep",
  "rg",
  "find",
  "file",
  "stat",
  "wc",
  "diff",
  "pwd",
  "whoami",
  "which",
  "whereis",
  "type",
  "env",
  "printenv",
  "node -v",
  "node --version",
  "bun -v",
  "bun --version",
  "npm -v",
  "npm --version",
  "tsc --noEmit",
  "rtk git status",
  "rtk git diff",
  "rtk git log",
  "rtk git show",
  "rtk git branch",
  "rtk ls",
  "rtk cat",
  "rtk grep",
  "rtk rg",
  "rtk find",
  "rtk tsc --noEmit",
];

const MUTATING_SUBCOMMANDS_OR_OPERATORS = [
  ">",
  ">>",
  "| rm",
  "| dd",
  "rm ",
  "rmdir ",
  "mv ",
  "cp ",
  "touch ",
  "chmod ",
  "chown ",
  "mkdir ",
  "sed -i",
  "awk -i",
  "npm install",
  "npm i ",
  "npm run build",
  "bun install",
  "bun add",
  "git commit",
  "git push",
  "git checkout -b",
  "git merge",
  "git rebase",
  "git reset",
  "git apply",
];

export interface ClassificationResult {
  readOnly: boolean;
  reason?: string;
}

export function classifyShellCommand(cmd: string): ClassificationResult {
  const trimmed = cmd.trim();
  if (trimmed.length === 0) return { readOnly: true };

  // Explicit check for shell redirection operators that modify files
  if (/>|>>|\|\s*(rm|dd|tee\s|sudo\s)/.test(trimmed)) {
    return { readOnly: false, reason: "redirection or piping to mutating command" };
  }

  // Explicit check for known mutating operators
  for (const mut of MUTATING_SUBCOMMANDS_OR_OPERATORS) {
    if (trimmed.includes(mut)) {
      return { readOnly: false, reason: `contains mutating operator: ${mut}` };
    }
  }

  // Check if command starts with a known safe read-only prefix
  for (const prefix of SAFE_READ_ONLY_PREFIXES) {
    if (trimmed === prefix || trimmed.startsWith(prefix + " ") || trimmed.startsWith(prefix + "\t")) {
      return { readOnly: true };
    }
  }

  // Fail closed for any unclassified command
  return { readOnly: false, reason: "unrecognized or complex shell command (failed closed)" };
}
