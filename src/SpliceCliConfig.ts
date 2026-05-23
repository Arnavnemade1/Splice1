import fs from 'node:fs';
import path from 'node:path';

export interface SpliceCliConfig {
  geminiApiKey?: string;
  defaultModel?: string;
  updatedAt?: string;
}

export class SpliceCliConfigStore {
  private readonly cliDir: string;
  private readonly configPath: string;

  constructor(private readonly workspaceRoot: string = process.cwd()) {
    this.cliDir = path.join(this.workspaceRoot, '.splice', 'cli');
    this.configPath = path.join(this.cliDir, 'config.json');
  }

  load(): SpliceCliConfig {
    if (!fs.existsSync(this.configPath)) return {};
    return JSON.parse(fs.readFileSync(this.configPath, 'utf8')) as SpliceCliConfig;
  }

  save(config: SpliceCliConfig) {
    fs.mkdirSync(this.cliDir, { recursive: true });
    fs.writeFileSync(this.configPath, JSON.stringify({
      ...config,
      updatedAt: new Date().toISOString(),
    }, null, 2));
  }

  update(partial: Partial<SpliceCliConfig>) {
    this.save({ ...this.load(), ...partial });
  }

  resolveApiKey(explicitKey?: string): string | undefined {
    const current = this.load();
    return explicitKey || process.env.SPLICE_GEMINI_API_KEY || process.env.GEMINI_API_KEY || current.geminiApiKey;
  }

  getConfigPath() {
    return this.configPath;
  }
}
