#!/usr/bin/env node
import http from 'node:http';
import { BrowserManager } from './src/BrowserManager.js';

function startFixtureServer(): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><html><body><button>Ready</button></body></html>`);
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Could not bind fixture server.');
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}

async function main() {
  const browser = new BrowserManager();
  const fixture = await startFixtureServer();

  try {
    await browser.init();
    await browser.navigate(fixture.url);

    const coordinator = browser.coordinator;
    coordinator.registerAgent('explorer-1', 'explorer');
    coordinator.registerAgent('verifier-1', 'verifier');

    coordinator.acquireOwnership('main', 'explorer-1');
    const branchId = await browser.forkState('explorer-1');
    if (coordinator.getOwner(branchId) !== 'explorer-1') {
      throw new Error('Forked branch owner was not recorded.');
    }

    let blocked = false;
    try {
      await browser.interact('non-existent', 'click', undefined, 'verifier-1');
    } catch (error: any) {
      blocked = /owned by/.test(error?.message || '');
    }
    if (!blocked) throw new Error('Ownership isolation did not block foreign writes.');

    browser.promoteFinding('auth.status', { loggedIn: true }, 0.9, 'main', 'explorer-1');
    const verifierBranch = await browser.forkState('verifier-1');
    browser.promoteFinding('auth.status', { loggedIn: false }, 0.8, verifierBranch, 'verifier-1');
    const blockedContext = coordinator.buildCanonicalContext();
    if (blockedContext.systemState !== 'quorum_blocked') {
      throw new Error('Contradictory findings did not trigger quorum blocking.');
    }

    const winner = coordinator.resolveConflict('auth.status');
    if (!winner || winner.agentId !== 'explorer-1') {
      throw new Error('Conflict resolution did not preserve the highest-confidence winner.');
    }

    browser.handoffBranch('main', 'explorer-1', 'verifier-1');
    if (coordinator.getOwner('main') !== 'verifier-1') {
      throw new Error('Branch handoff failed.');
    }

    const summon = browser.requestSummon(`${fixture.url}/checkout`, 'Validation was blocked');
    const acknowledged = browser.acknowledgeSummon(summon.id, 'verifier-1');
    if (!acknowledged || acknowledged.status !== 'acknowledged') {
      throw new Error('Summon acknowledgement failed.');
    }

    const metrics = coordinator.getCoordinationTaxMetrics();
    if (metrics.conflictsDetected < 1 || metrics.ownershipViolationAttempts < 1) {
      throw new Error('Coordination metrics were not updated.');
    }

    console.log('PASS Coordination validation');
  } finally {
    await browser.close().catch(() => {});
    await fixture.close().catch(() => {});
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
