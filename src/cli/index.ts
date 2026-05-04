const VERSION = '0.1.0';

function help(): void {
  console.log(`devops-coder v${VERSION}

Usage:
  bun run start         Start the watcher (not yet implemented)
  bun run once          Run a single poll cycle (not yet implemented)
  bun run src/cli/index.ts version
  bun run src/cli/index.ts help

This is a milestone-1/2 skeleton — only 'help' and 'version' are wired.
Other commands print a placeholder and exit 0.
`);
}

const cmd = process.argv[2] ?? 'help';

switch (cmd) {
  case 'help':
  case '--help':
  case '-h':
    help();
    break;
  case 'version':
  case '--version':
  case '-v':
    console.log(VERSION);
    break;
  case 'watch':
  case 'run-once':
    console.log(`[devops-coder] command "${cmd}" is not yet implemented (milestone 1/2 skeleton).`);
    break;
  default:
    console.error(`Unknown command: ${cmd}`);
    help();
    process.exitCode = 1;
}
