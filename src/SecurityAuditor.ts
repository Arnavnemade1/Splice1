import type { Page } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

export type AuditCheck = 'headers' | 'xss' | 'auth' | 'data' | 'deps' | 'exploits' | 'openclaw';

export interface AuditOptions {
  safeMode?: boolean;
  crawl?: boolean;
  maxCrawlDepth?: number;
  checks?: AuditCheck[];
}

export interface AuditFinding {
  id: string;
  url: string;
  category: AuditCheck;
  severity: 'critical' | 'warning' | 'info' | 'passed';
  title: string;
  description: string;
  recommendation: string;
  evidence: string[];
}

export interface AuditReport {
  url: string;
  safeMode: boolean;
  crawledUrls: string[];
  findings: AuditFinding[];
  totals: {
    critical: number;
    warning: number;
    info: number;
    passed: number;
  };
  agentFeedback: {
    summary: string;
    criticalActions: string[];
    warningActions: string[];
    passed: string[];
  };
}

type PageScan = {
  url: string;
  title: string;
  links: string[];
  forms: Array<{ action: string; method: string; hasPassword: boolean; hasEmail: boolean }>;
  inlineScriptCount: number;
  javascriptHrefCount: number;
  inlineEventHandlerCount: number;
  passwordFieldCount: number;
  emailFieldCount: number;
  insecureFormCount: number;
  externalScriptSources: string[];
  websocketTargets: string[];
  localStorageKeys: string[];
  sessionStorageKeys: string[];
  bodyTextSample: string;
  hasCspMeta: boolean;
};

const DEFAULT_CHECKS: AuditCheck[] = ['headers', 'xss', 'auth', 'data', 'deps', 'exploits', 'openclaw'];

export class SecurityAuditor {
  constructor(private page: Page) {}

  async audit(targetUrl: string, options: AuditOptions = {}): Promise<AuditReport> {
    const safeMode = options.safeMode !== false;
    const crawl = options.crawl !== false;
    const maxCrawlDepth = Math.max(1, options.maxCrawlDepth ?? 3);
    const checks = (options.checks?.length ? options.checks : DEFAULT_CHECKS) as AuditCheck[];
    const findings: AuditFinding[] = [];
    const crawledUrls: string[] = [];
    const queue = [targetUrl];
    const visited = new Set<string>();
    const targetOrigin = new URL(targetUrl).origin;

    while (queue.length > 0 && crawledUrls.length < maxCrawlDepth) {
      const nextUrl = queue.shift()!;
      if (visited.has(nextUrl)) continue;
      visited.add(nextUrl);

      await this.page.goto(nextUrl, { waitUntil: 'domcontentloaded' });
      await this.page.waitForLoadState('domcontentloaded').catch(() => {});

      crawledUrls.push(nextUrl);
      const scan = await this.scanPage();

      if (checks.includes('headers')) {
        findings.push(...await this.auditHeaders(nextUrl));
      }
      if (checks.includes('xss')) {
        findings.push(...this.auditXss(scan));
      }
      if (checks.includes('auth')) {
        findings.push(...this.auditAuth(scan, safeMode));
      }
      if (checks.includes('data')) {
        findings.push(...this.auditData(scan));
      }
      if (checks.includes('deps')) {
        findings.push(...this.auditDependencies(scan));
      }
      if (checks.includes('exploits')) {
        findings.push(...this.auditWorkspaceExposure(nextUrl));
      }
      if (checks.includes('openclaw')) {
        findings.push(...this.auditOpenClaw(scan));
      }

      if (crawl) {
        for (const link of scan.links) {
          if (link.startsWith(targetOrigin) && !visited.has(link)) {
            queue.push(link);
          }
        }
      }
    }

    if (findings.length === 0) {
      findings.push(this.makeFinding(targetUrl, 'headers', 'passed', 'Audit completed', 'No enabled checks produced findings.', 'No action required.', []));
    }

    const totals = {
      critical: findings.filter(f => f.severity === 'critical').length,
      warning: findings.filter(f => f.severity === 'warning').length,
      info: findings.filter(f => f.severity === 'info').length,
      passed: findings.filter(f => f.severity === 'passed').length,
    };

    const criticalActions = findings
      .filter(f => f.severity === 'critical')
      .map(f => `${f.title}: ${f.recommendation}`);
    const warningActions = findings
      .filter(f => f.severity === 'warning')
      .map(f => `${f.title}: ${f.recommendation}`);
    const passed = findings
      .filter(f => f.severity === 'passed')
      .map(f => `${f.title}: ${f.description}`);

    const summary = totals.critical > 0
      ? `Critical browser security issues were detected across ${crawledUrls.length} page(s).`
      : totals.warning > 0
        ? `The audit found launch-blocking warnings but no critical findings across ${crawledUrls.length} page(s).`
        : `The enabled checks passed cleanly across ${crawledUrls.length} page(s).`;

    return {
      url: targetUrl,
      safeMode,
      crawledUrls,
      findings,
      totals,
      agentFeedback: {
        summary,
        criticalActions,
        warningActions,
        passed,
      },
    };
  }

  private async scanPage(): Promise<PageScan> {
    return this.page.evaluate(() => {
      const normalizeUrl = (value: string) => {
        try {
          return new URL(value, location.href).toString();
        } catch {
          return value;
        }
      };

      return {
        url: location.href,
        title: document.title,
        links: Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href]'))
          .map(link => normalizeUrl(link.href))
          .slice(0, 25),
        forms: Array.from(document.forms).map(form => ({
          action: normalizeUrl(form.getAttribute('action') || location.href),
          method: (form.getAttribute('method') || 'get').toLowerCase(),
          hasPassword: !!form.querySelector('input[type="password"]'),
          hasEmail: !!form.querySelector('input[type="email"], input[name*="email" i]'),
        })),
        inlineScriptCount: Array.from(document.scripts).filter(script => !script.src).length,
        javascriptHrefCount: Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href]'))
          .filter(link => (link.getAttribute('href') || '').trim().toLowerCase().startsWith('javascript:')).length,
        inlineEventHandlerCount: Array.from(document.querySelectorAll<HTMLElement>('*'))
          .reduce((count, el) => count + el.getAttributeNames().filter(name => name.startsWith('on')).length, 0),
        passwordFieldCount: document.querySelectorAll('input[type="password"]').length,
        emailFieldCount: document.querySelectorAll('input[type="email"], input[name*="email" i]').length,
        insecureFormCount: Array.from(document.forms)
          .filter(form => {
            const action = form.getAttribute('action') || '';
            return action.startsWith('http://');
          }).length,
        externalScriptSources: Array.from(document.scripts)
          .map(script => script.src)
          .filter(Boolean)
          .slice(0, 25),
        websocketTargets: Array.from(document.querySelectorAll('script'))
          .map(script => script.textContent || '')
          .flatMap(text => Array.from(text.matchAll(/wss?:\/\/[^\s"'`]+/g)).map(match => match[0]))
          .slice(0, 10),
        localStorageKeys: Object.keys(localStorage).slice(0, 20),
        sessionStorageKeys: Object.keys(sessionStorage).slice(0, 20),
        bodyTextSample: document.body.innerText.replace(/\s+/g, ' ').trim().slice(0, 400),
        hasCspMeta: !!document.querySelector('meta[http-equiv="Content-Security-Policy" i]'),
      };
    });
  }

  private async auditHeaders(url: string): Promise<AuditFinding[]> {
    const findings: AuditFinding[] = [];
    try {
      const response = await fetch(url, { method: 'GET', redirect: 'follow' });
      const csp = response.headers.get('content-security-policy');
      const xcto = response.headers.get('x-content-type-options');
      const xfo = response.headers.get('x-frame-options');
      const referrer = response.headers.get('referrer-policy');
      const hsts = response.headers.get('strict-transport-security');

      if (!csp) {
        findings.push(this.makeFinding(url, 'headers', 'warning', 'Missing Content-Security-Policy header', 'The response does not advertise a CSP header.', 'Add a CSP header that limits script sources and framing.', []));
      } else {
        findings.push(this.makeFinding(url, 'headers', 'passed', 'Content-Security-Policy header present', 'The response includes a CSP header.', 'Keep the CSP policy narrowly scoped.', [csp]));
      }

      if ((new URL(url)).protocol === 'https:' && !hsts) {
        findings.push(this.makeFinding(url, 'headers', 'warning', 'Missing Strict-Transport-Security header', 'HTTPS is enabled but HSTS is absent.', 'Serve a Strict-Transport-Security header for HTTPS routes.', []));
      } else if ((new URL(url)).protocol === 'https:') {
        findings.push(this.makeFinding(url, 'headers', 'passed', 'Strict-Transport-Security header present', 'The response enables HSTS.', 'Retain HSTS on production hosts.', [hsts || '']));
      }

      if (!xcto || xcto.toLowerCase() !== 'nosniff') {
        findings.push(this.makeFinding(url, 'headers', 'warning', 'Missing X-Content-Type-Options nosniff', 'The response is missing X-Content-Type-Options: nosniff.', 'Set X-Content-Type-Options to nosniff.', [xcto || 'missing']));
      } else {
        findings.push(this.makeFinding(url, 'headers', 'passed', 'X-Content-Type-Options configured', 'The response prevents MIME sniffing.', 'Keep X-Content-Type-Options: nosniff enabled.', [xcto]));
      }

      if (!xfo) {
        findings.push(this.makeFinding(url, 'headers', 'info', 'Missing X-Frame-Options header', 'Legacy clickjacking protection header is absent.', 'Use frame-ancestors in CSP and optionally set X-Frame-Options.', []));
      }
      if (!referrer) {
        findings.push(this.makeFinding(url, 'headers', 'info', 'Missing Referrer-Policy header', 'The response does not define a referrer policy.', 'Set Referrer-Policy to a least-privilege value like strict-origin-when-cross-origin.', []));
      }
    } catch (error: any) {
      findings.push(this.makeFinding(url, 'headers', 'warning', 'Header audit could not fetch target', error?.message || 'Header fetch failed.', 'Verify the target is reachable from the host running Splice.', []));
    }
    return findings;
  }

  private auditXss(scan: PageScan): AuditFinding[] {
    const findings: AuditFinding[] = [];
    if (scan.inlineScriptCount > 0) {
      findings.push(this.makeFinding(scan.url, 'xss', 'warning', 'Inline scripts detected', `The page contains ${scan.inlineScriptCount} inline script block(s).`, 'Move inline scripts behind CSP nonces or external bundles.', []));
    } else {
      findings.push(this.makeFinding(scan.url, 'xss', 'passed', 'No inline scripts detected', 'The page did not expose inline script blocks.', 'Keep script execution behind external bundles or CSP nonces.', []));
    }

    if (scan.inlineEventHandlerCount > 0) {
      findings.push(this.makeFinding(scan.url, 'xss', 'warning', 'Inline event handlers detected', `Found ${scan.inlineEventHandlerCount} DOM event handler attribute(s).`, 'Replace inline handlers with event listeners and tighten CSP.', []));
    }

    if (scan.javascriptHrefCount > 0) {
      findings.push(this.makeFinding(scan.url, 'xss', 'critical', 'javascript: URLs detected', `Found ${scan.javascriptHrefCount} link(s) using javascript: URLs.`, 'Remove javascript: URLs and route behavior through safe handlers.', []));
    }

    return findings;
  }

  private auditAuth(scan: PageScan, safeMode: boolean): AuditFinding[] {
    const findings: AuditFinding[] = [];
    const authLike = /login|sign in|authenticate|password/i.test(`${scan.title} ${scan.bodyTextSample}`);

    if (scan.passwordFieldCount > 0 && authLike) {
      findings.push(this.makeFinding(scan.url, 'auth', 'info', 'Authentication surface detected', 'Password inputs and auth-like copy are present.', safeMode ? 'Avoid destructive auth flows during safe-mode audits.' : 'Review auth workflow protections in a manual pass.', []));
    } else {
      findings.push(this.makeFinding(scan.url, 'auth', 'passed', 'No obvious authentication blocker detected', 'The current page does not look like an auth gate.', 'No immediate action required.', []));
    }

    if (scan.insecureFormCount > 0) {
      findings.push(this.makeFinding(scan.url, 'auth', 'critical', 'Insecure form action detected', `Found ${scan.insecureFormCount} form(s) submitting to http:// endpoints.`, 'Move all credential-bearing form actions to HTTPS endpoints.', []));
    }

    return findings;
  }

  private auditData(scan: PageScan): AuditFinding[] {
    const findings: AuditFinding[] = [];
    const storageKeyCount = scan.localStorageKeys.length + scan.sessionStorageKeys.length;

    if (storageKeyCount > 0) {
      findings.push(this.makeFinding(scan.url, 'data', 'info', 'Client-side storage in use', `Detected ${storageKeyCount} local/session storage key(s).`, 'Verify that tokens or sensitive user data are not stored in browser-accessible storage.', [...scan.localStorageKeys, ...scan.sessionStorageKeys].slice(0, 10)));
    } else {
      findings.push(this.makeFinding(scan.url, 'data', 'passed', 'No browser storage keys detected', 'The page did not expose localStorage or sessionStorage keys during the audit.', 'No immediate action required.', []));
    }

    const piiForm = scan.forms.find(form => form.hasEmail || form.hasPassword);
    if (piiForm && piiForm.action.startsWith('http://')) {
      findings.push(this.makeFinding(scan.url, 'data', 'critical', 'PII form posts over HTTP', `A form posting to ${piiForm.action} appears to collect email or password data.`, 'Enforce HTTPS form actions for any user data collection.', [piiForm.action]));
    }

    return findings;
  }

  private auditDependencies(scan: PageScan): AuditFinding[] {
    const findings: AuditFinding[] = [];
    const insecureScripts = scan.externalScriptSources.filter(src => src.startsWith('http://'));
    if (insecureScripts.length > 0) {
      findings.push(this.makeFinding(scan.url, 'deps', 'critical', 'External scripts loaded over HTTP', `Found ${insecureScripts.length} insecure script source(s).`, 'Serve third-party scripts over HTTPS or self-host them behind integrity controls.', insecureScripts));
    } else {
      findings.push(this.makeFinding(scan.url, 'deps', 'passed', 'External script transport looks safe', 'No HTTP script sources were detected on the page.', 'Keep third-party assets on HTTPS origins.', []));
    }
    return findings;
  }

  private auditWorkspaceExposure(url: string): AuditFinding[] {
    const findings: AuditFinding[] = [];
    const packagePath = path.join(process.cwd(), 'package.json');
    if (!fs.existsSync(packagePath)) {
      findings.push(this.makeFinding(url, 'exploits', 'info', 'No workspace package manifest found', 'Splice did not find a root package.json to inspect for workspace exposure.', 'Skip workspace exploit heuristics or point the audit at a repo root.', []));
      return findings;
    }

    try {
      const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
      const deps = {
        ...pkg.dependencies,
        ...pkg.devDependencies,
      } as Record<string, string>;
      const dependencyCount = Object.keys(deps).length;
      findings.push(this.makeFinding(url, 'exploits', 'info', 'Workspace manifest inspected', `The workspace exposes ${dependencyCount} declared npm package(s).`, 'Review dependency update cadence and lockfile hygiene separately.', Object.entries(deps).slice(0, 8).map(([name, version]) => `${name}@${version}`)));
    } catch (error: any) {
      findings.push(this.makeFinding(url, 'exploits', 'warning', 'Workspace manifest could not be parsed', error?.message || 'package.json parse failed.', 'Repair package.json parsing issues before depending on workspace exploit heuristics.', []));
    }

    return findings;
  }

  private auditOpenClaw(scan: PageScan): AuditFinding[] {
    const findings: AuditFinding[] = [];
    const suspiciousTargets = scan.websocketTargets.filter(target => !target.includes('127.0.0.1') && !target.includes('localhost'));
    if (suspiciousTargets.length > 0) {
      findings.push(this.makeFinding(scan.url, 'openclaw', 'warning', 'Non-local WebSocket targets detected', `The page includes ${suspiciousTargets.length} WebSocket target(s) that are not localhost-scoped.`, 'Verify these sockets are intentional and do not expose agent control channels.', suspiciousTargets));
    } else {
      findings.push(this.makeFinding(scan.url, 'openclaw', 'passed', 'No non-local OpenClaw-like sockets detected', 'The page did not advertise remote WebSocket control endpoints.', 'Keep agent control sockets bound to localhost only.', []));
    }
    return findings;
  }

  private makeFinding(
    url: string,
    category: AuditCheck,
    severity: AuditFinding['severity'],
    title: string,
    description: string,
    recommendation: string,
    evidence: string[]
  ): AuditFinding {
    return {
      id: `${category}-${Math.random().toString(36).slice(2, 10)}`,
      url,
      category,
      severity,
      title,
      description,
      recommendation,
      evidence,
    };
  }
}
