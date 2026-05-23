#!/usr/bin/env node
import { runLocalValidation } from './src/validation.js';

async function main() {
  const result = await runLocalValidation();
  console.log(`\nLocal validation report: ${result.reportPath}`);
  if (result.commandCenterPath) console.log(`Command Center report: ${result.commandCenterPath}`);
  if (result.failed > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
