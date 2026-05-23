#!/usr/bin/env node
import path from 'node:path';
import { SpliceCliConfigStore } from './SpliceCliConfig.js';
import { SpliceAgentSystem, type AgentKind } from './SpliceAgentSystem.js';
import { runLocalValidation } from './validation.js';

function logo() {
  return [
    '##   ## ####  ##     #### ## ### ####',
    '### ### ## ## ##       ## ## ## ##   ',
    '## # ## ####  ##       ## ## ## ##   ',
    '##   ## ##    ###### #### ##   ## ####',
    '',
    'Splice CLI',
    'Deploy review, optimize, and secure agents for your codebase.',
  ].join('\n');
}

function help() {
  return [
    logo(),
    '',
    'Usage:',
    '  splice logo',
    '  splice validate',
    '  splice dashboard [--port <port>]',
    '  splice config show',
    '  splice config set-gemini-key <key>',
    '  splice agents list',
    '  splice agents deploy <review|optimize|secure|all> [path] [--run] [--model <model>] [--prompt <text>]',
    '  splice agents run <agent-id>',
    '  splice agents review [path] [--model <model>] [--prompt <text>]',
    '  splice agents optimize [path] [--model <model>] [--prompt <text>]',
    '  splice agents secure [path] [--model <model>] [--prompt <text>]',
  ].join('\n');
}

function parseFlags(argv: string[]) {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) {
      positional.push(token);
      continue;
    }
    const key = token.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      flags[key] = true;
      continue;
    }
    flags[key] = next;
    i++;
  }
  return { positional, flags };
}

async function main() {
  const { positional, flags } = parseFlags(process.argv.slice(2));
  const [command, subcommand, ...rest] = positional;
  const workspaceRoot = process.cwd();
  const config = new SpliceCliConfigStore(workspaceRoot);
  const agents = new SpliceAgentSystem(workspaceRoot);

  if (!command || command === 'help' || command === '--help') {
    console.log(help());
    return;
  }

  if (command === 'logo') {
    console.log(logo());
    return;
  }

  if (command === 'validate') {
    console.log(logo());
    console.log('');
    const result = await runLocalValidation();
    console.log(`\nLocal validation report: ${result.reportPath}`);
    if (result.commandCenterPath) console.log(`Command Center report: ${result.commandCenterPath}`);
    if (result.failed > 0) process.exit(1);
    return;
  }

  if (command === 'dashboard') {
    const preferredPort = typeof flags.port === 'string' ? Number(flags.port) : undefined;
    const { BrowserManager } = await import('./BrowserManager.js');
    const browser = new BrowserManager();
    let launch;
    try {
      launch = await browser.launchCommandCenter(Number.isFinite(preferredPort) ? preferredPort : undefined);
    } catch {
      await browser.init();
      launch = await browser.launchCommandCenter(Number.isFinite(preferredPort) ? preferredPort : undefined);
    }
    console.log(`Command Center running at ${launch.url}`);
    console.log(`Latest report: ${launch.reportPath}`);
    return;
  }

  if (command === 'config') {
    if (subcommand === 'show') {
      const current = config.load();
      console.log(JSON.stringify({
        ...current,
        geminiApiKey: current.geminiApiKey ? `${current.geminiApiKey.slice(0, 6)}...${current.geminiApiKey.slice(-4)}` : undefined,
        configPath: config.getConfigPath(),
      }, null, 2));
      return;
    }

    if (subcommand === 'set-gemini-key') {
      const key = rest[0];
      if (!key) throw new Error('Missing Gemini API key.');
      config.update({ geminiApiKey: key, defaultModel: config.load().defaultModel || 'gemini-2.5-flash' });
      console.log(`Saved Gemini API key to ${config.getConfigPath()}`);
      return;
    }
  }

  if (command === 'agents') {
    if (subcommand === 'list') {
      const manifests = agents.listAgents();
      if (manifests.length === 0) {
        console.log('No deployed agents yet.');
        return;
      }
      for (const manifest of manifests) {
        console.log(`${manifest.id}  ${manifest.kind}  ${manifest.model}  ${path.relative(workspaceRoot, manifest.targetPath) || '.'}`);
      }
      return;
    }

    if (subcommand === 'run') {
      const agentId = rest[0];
      if (!agentId) throw new Error('Missing agent id.');
      const manifest = agents.getAgent(agentId);
      const output = await agents.runAgent(manifest, config, typeof flags['api-key'] === 'string' ? flags['api-key'] : undefined);
      console.log(output);
      return;
    }

    if (subcommand === 'deploy') {
      const kindToken = rest[0];
      const targetPath = rest[1];
      if (!kindToken) throw new Error('Missing agent kind.');
      if (kindToken !== 'all' && !['review', 'optimize', 'secure'].includes(kindToken)) {
        throw new Error(`Unsupported agent kind "${kindToken}". Use review, optimize, secure, or all.`);
      }
      const kinds: AgentKind[] = kindToken === 'all' ? ['review', 'optimize', 'secure'] : [kindToken as AgentKind];
      for (const kind of kinds) {
        const manifest = agents.deployAgent(kind, {
          targetPath,
          model: typeof flags.model === 'string' ? flags.model : undefined,
          extraPrompt: typeof flags.prompt === 'string' ? flags.prompt : undefined,
        });
        console.log(`Deployed ${manifest.kind} agent: ${manifest.id}`);
        if (flags.run === true) {
          console.log('');
          console.log(await agents.runAgent(manifest, config, typeof flags['api-key'] === 'string' ? flags['api-key'] : undefined));
          console.log('');
        }
      }
      return;
    }

    if (subcommand === 'review' || subcommand === 'optimize' || subcommand === 'secure') {
      const manifest = agents.deployAgent(subcommand, {
        targetPath: rest[0],
        model: typeof flags.model === 'string' ? flags.model : undefined,
        extraPrompt: typeof flags.prompt === 'string' ? flags.prompt : undefined,
      });
      console.log(`Deployed ${manifest.kind} agent: ${manifest.id}`);
      console.log('');
      console.log(await agents.runAgent(manifest, config, typeof flags['api-key'] === 'string' ? flags['api-key'] : undefined));
      return;
    }
  }

  console.log(help());
  process.exitCode = 1;
}

main().catch((error: any) => {
  console.error(error?.message || String(error));
  process.exit(1);
});
