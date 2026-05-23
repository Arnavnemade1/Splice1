import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

export interface CommandCenterLaunchResult {
  port: number;
  url: string;
  reportPath: string;
}

export class CommandCenterServer {
  private server: http.Server | null = null;
  private port: number | null = null;
  private latestReportPath: string | null = null;

  constructor(private readonly snapshotsDir: string) {}

  async start(reportPath: string, preferredPort?: number): Promise<CommandCenterLaunchResult> {
    this.latestReportPath = reportPath;

    if (this.server && this.port !== null) {
      return {
        port: this.port,
        url: `http://127.0.0.1:${this.port}`,
        reportPath,
      };
    }

    const requestedPort = preferredPort && preferredPort > 0 ? preferredPort : 4821;
    const server = http.createServer((req, res) => this.handleRequest(req, res));

    const boundPort = await new Promise<number>((resolve, reject) => {
      const tryListen = (port: number) => {
        server.once('error', (error: NodeJS.ErrnoException) => {
          if (error.code === 'EADDRINUSE' && port === requestedPort) {
            server.removeAllListeners('error');
            tryListen(0);
            return;
          }
          reject(error);
        });

        server.listen(port, '127.0.0.1', () => {
          const address = server.address();
          if (!address || typeof address === 'string') {
            reject(new Error('Failed to determine Command Center server address.'));
            return;
          }
          resolve(address.port);
        });
      };

      tryListen(requestedPort);
    });

    this.server = server;
    this.port = boundPort;

    return {
      port: boundPort,
      url: `http://127.0.0.1:${boundPort}`,
      reportPath,
    };
  }

  updateReportPath(reportPath: string) {
    this.latestReportPath = reportPath;
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    this.server = null;
    this.port = null;
  }

  private handleRequest(req: http.IncomingMessage, res: http.ServerResponse) {
    const requestUrl = new URL(req.url || '/', 'http://127.0.0.1');
    if (requestUrl.pathname === '/health') {
      this.sendJson(res, 200, {
        ok: true,
        port: this.port,
        reportPath: this.latestReportPath,
      });
      return;
    }

    if (requestUrl.pathname === '/api/latest') {
      this.sendJson(res, 200, {
        ok: true,
        reportPath: this.latestReportPath,
        snapshotsDir: this.snapshotsDir,
      });
      return;
    }

    if (!this.latestReportPath || !fs.existsSync(this.latestReportPath)) {
      this.sendHtml(res, 404, '<!doctype html><html><body><h1>Command Center not ready</h1><p>No report has been generated yet.</p></body></html>');
      return;
    }

    if (requestUrl.pathname === '/' || requestUrl.pathname === '/index.html') {
      const html = fs.readFileSync(this.latestReportPath, 'utf8');
      this.sendHtml(res, 200, html);
      return;
    }

    if (requestUrl.pathname === '/latest-report.html') {
      const html = fs.readFileSync(this.latestReportPath, 'utf8');
      this.sendHtml(res, 200, html);
      return;
    }

    const fileName = path.basename(requestUrl.pathname);
    if (fileName.startsWith('report-') || fileName.startsWith('trace-') || fileName.startsWith('audit-')) {
      const candidatePath = path.join(this.snapshotsDir, fileName);
      if (fs.existsSync(candidatePath)) {
        const body = fs.readFileSync(candidatePath);
        res.writeHead(200, { 'cache-control': 'no-store' });
        res.end(body);
        return;
      }
    }

    this.sendHtml(res, 404, '<!doctype html><html><body><h1>Not found</h1></body></html>');
  }

  private sendJson(res: http.ServerResponse, status: number, payload: unknown) {
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    });
    res.end(JSON.stringify(payload));
  }

  private sendHtml(res: http.ServerResponse, status: number, html: string) {
    res.writeHead(status, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
    });
    res.end(html);
  }
}
