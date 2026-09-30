import { buildApp } from './app.js';
import { config } from './config/env.js';
import { logger } from './utils/logger.js';
import { sessionManager } from './services/session.service.js';

async function bootstrap() {
  try {
    const app = await buildApp();

    await app.listen({
      port: config.PORT,
      host: config.HOST,
    });

    logger.info(`====================================================`);
    logger.info(`🚀 WhatsApp API Gateway is running on port ${config.PORT}`);
    logger.info(`📖 Interactive Swagger Documentation: http://localhost:${config.PORT}/docs`);
    logger.info(`🔑 Master API Key: ${config.MASTER_API_KEY}`);
    logger.info(`🤖 AI Bridge: ${config.AI_BRIDGE_ENABLED ? 'ENABLED' : 'DISABLED'}`);
    logger.info(`🛡️ Anti-Ban Presence Typing: ${config.PRESENCE_MIN_DELAY_MS}ms - ${config.PRESENCE_MAX_DELAY_MS}ms`);
    logger.info(`====================================================`);

    // Auto-restore any existing sessions saved on disk
    await sessionManager.autoRestoreSessions();

    // Graceful Shutdown handlers
    const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM'];
    for (const signal of signals) {
      process.on(signal, async () => {
        logger.info(`Received ${signal}. Shutting down WhatsApp Gateway gracefully...`);
        try {
          await app.close();
          logger.info('Gateway server shut down cleanly.');
          process.exit(0);
        } catch (err) {
          logger.error({ err }, 'Error during graceful shutdown');
          process.exit(1);
        }
      });
    }
  } catch (error) {
    logger.fatal({ err: error }, 'Failed to bootstrap WhatsApp Gateway');
    process.exit(1);
  }
}

bootstrap();
