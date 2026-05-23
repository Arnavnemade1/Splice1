import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { SpliceCliConfigStore } from './SpliceCliConfig.js';

export type AgentKind = 'review' | 'optimize' | 'secure';

export interface AgentManifest {
  id: string;
  kind: AgentKind;
  name: string;
  provider: 'gemini';
  model: string;
  targetPath: string;
  createdAt: string;
  status: 'deployed';
  prompt: string;
}

const AGENT_PROMPTS: Record<AgentKind, string> = {
  review: 'Review the codebase like a senior engineer. Prioritize correctness bugs, regressions, missing tests, and risky edge cases. Cite concrete file paths and keep findings ordered by severity.',
  optimize: 'Optimize the codebase for performance, maintainability, and developer velocity. Focus on the highest-leverage improvements first, with concrete file-level recommendations and implementation sketches.',
  secure: 'Audit the codebase for secrets exposure, unsafe defaults, injection risks, auth or data handling issues, and deployment hardening gaps. Return concrete remediations with file references.',
};

const DEFAULT_MODEL = 'gemini-2.5-flash';

export class SpliceAgentSystem {
  private readonly agentsDir: string;

  constructor(private readonly workspaceRoot: string = process.cwd()) {
    this.agentsDir = path.join(this.workspaceRoot, '.splice', 'cli', 'agents');
  }

  listAgents(): AgentManifest[] {
    if (!fs.existsSync(this.agentsDir)) return [];
    return fs.readdirSync(this.agentsDir)
      .filter(name => name.endsWith('.json'))
      .map(name => JSON.parse(fs.readFileSync(path.join(this.agentsDir, name), 'utf8')) as AgentManifest)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  deployAgent(kind: AgentKind, options: {
    targetPath?: string;
    model?: string;
    extraPrompt?: string;
  }): AgentManifest {
    const absoluteTarget = path.resolve(this.workspaceRoot, options.targetPath || '.');
    if (!fs.existsSync(absoluteTarget)) {
      throw new Error(`Target path "${absoluteTarget}" does not exist.`);
    }

    const manifest: AgentManifest = {
      id: `${kind}-${crypto.randomUUID()}`,
      kind,
      name: `splice-${kind}-agent`,
      provider: 'gemini',
      model: options.model || DEFAULT_MODEL,
      targetPath: absoluteTarget,
      createdAt: new Date().toISOString(),
      status: 'deployed',
      prompt: [AGENT_PROMPTS[kind], options.extraPrompt].filter(Boolean).join('\n\n'),
    };

    fs.mkdirSync(this.agentsDir, { recursive: true });
    fs.writeFileSync(path.join(this.agentsDir, `${manifest.id}.json`), JSON.stringify(manifest, null, 2));
    return manifest;
  }

  getAgent(id: string): AgentManifest {
    const manifestPath = path.join(this.agentsDir, `${id}.json`);
    if (!fs.existsSync(manifestPath)) {
      throw new Error(`Agent "${id}" was not found in ${this.agentsDir}.`);
    }
    return JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as AgentManifest;
  }

  async runAgent(manifest: AgentManifest, configStore: SpliceCliConfigStore, explicitApiKey?: string): Promise<string> {
    const apiKey = configStore.resolveApiKey(explicitApiKey);
    if (!apiKey) {
      throw new Error(`No Gemini API key configured. Run "splice config set-gemini-key <key>" or export GEMINI_API_KEY.`);
    }

    const context = this.collectWorkspaceContext(manifest.targetPath);
    const prompt = [
      `Agent kind: ${manifest.kind}`,
      `Workspace root: ${this.workspaceRoot}`,
      `Target path: ${manifest.targetPath}`,
      '',
      manifest.prompt,
      '',
      'Return a concise, high-signal report in Markdown.',
      context,
    ].join('\n');

    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${manifest.model}:generateContent?key=${apiKey}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        system_instruction: {
          parts: [{ text: 'You are Splice, a coding-agent control plane. Be concrete, cite files, and stay actionable.' }],
        },
        contents: [
          {
            role: 'user',
            parts: [{ text: prompt }],
          },
        ],
        generationConfig: {
          temperature: 0.2,
        },
      }),
    });

    if (!response.ok) {
      throw new Error(`Gemini request failed with ${response.status} ${response.statusText}.`);
    }

    const payload: any = await response.json();
    const text = payload?.candidates?.[0]?.content?.parts?.map((part: any) => part.text || '').join('')?.trim();
    if (!text) {
      throw new Error('Gemini returned no text response.');
    }
    return text;
  }

  private collectWorkspaceContext(targetPath: string): string {
    const absoluteTarget = path.resolve(this.workspaceRoot, targetPath);
    if (!fs.existsSync(absoluteTarget)) {
      throw new Error(`Target path "${absoluteTarget}" does not exist.`);
    }
    const files = this.walkFiles(absoluteTarget);
    const interestingFiles = files.filter(file => /\.(ts|tsx|js|jsx|py|json|md|toml|yml|yaml)$/i.test(file)).slice(0, 40);
    const chunks: string[] = [];
    let bytes = 0;

    chunks.push('Workspace summary:');
    chunks.push(`- Total candidate files: ${files.length}`);
    chunks.push(`- Included files: ${interestingFiles.length}`);

    for (const file of interestingFiles) {
      const relative = path.relative(this.workspaceRoot, file) || path.basename(file);
      const raw = fs.readFileSync(file, 'utf8');
      const snippet = raw.slice(0, 3000);
      bytes += snippet.length;
      chunks.push(`\nFILE: ${relative}\n${snippet}`);
      if (bytes > 50000) break;
    }

    return chunks.join('\n');
  }

  private walkFiles(root: string): string[] {
    const results: string[] = [];
    const ignored = new Set(['.git', '.splice', 'node_modules', 'dist', 'dist_test', 'coverage', '__pycache__']);

    const visit = (current: string) => {
      const stat = fs.statSync(current);
      if (stat.isDirectory()) {
        const name = path.basename(current);
        if (ignored.has(name)) return;
        for (const entry of fs.readdirSync(current)) {
          visit(path.join(current, entry));
        }
        return;
      }
      if (stat.size > 200_000) return;
      results.push(current);
    };

    visit(root);
    return results;
  }
}
