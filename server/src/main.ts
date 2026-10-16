import { loadConfig } from './config.ts';
import { createLogger } from './logger.ts';
import { MissionControl } from './app.ts';
import { createHttpServer } from './http/server.ts';

const log = createLogger('mc');

async function main() {
  const config = loadConfig();
  if (!config.insideCmux && !config.fixtureMode) {
    log.warn('Mission Control is not running inside a cmux terminal. With the default cmux socket mode ("cmuxOnly") the connection will be refused; start it from a cmux terminal instead.');
  }
  const mc = new MissionControl({ config, log });
  const devOrigins = process.env.MC_DEV_ORIGIN ? process.env.MC_DEV_ORIGIN.split(',') : [];
  const server = createHttpServer({ mc, log: log.child('http'), host: config.host, port: config.port, staticDir: config.staticDir, devOrigins });

  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') log.error(`Port ${config.port} is already in use. Set MC_PORT to choose another.`);
    else log.error('http server error', { err });
    process.exit(1);
  });

  server.listen(config.port, config.host, () => {
    mc.start();
    const url = `http://${config.host === '::1' ? '[::1]' : config.host}:${config.port}`;
    log.info('Mission Control listening', { url, socket: config.socketPath, dataDir: config.dataDir, insideCmux: config.insideCmux });
    process.stdout.write(`\n  cmux Mission Control → ${url}\n\n`);
  });

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    log.info('shutting down', { signal });
    server.closeAllConnections();
    server.close();
    await mc.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  log.error('fatal', { err });
  process.exit(1);
});
