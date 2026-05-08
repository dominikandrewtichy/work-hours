import { Env } from './index';

export const getEnv = (): Env => ({
  SCRAPER_STATE: process.env.SCRAPER_STATE as unknown as KVNamespace,
  WP_LOGIN_URL: process.env.WP_LOGIN_URL || 'https://is.kofikofi.cz/index.php',
  WP_TARGET_URL: process.env.WP_TARGET_URL || 'https://is.kofikofi.cz/index.php',
  WP_USERNAME: process.env.WP_USERNAME || 'username',
  WP_PASSWORD: process.env.WP_PASSWORD || 'password',
  DISCORD_WEBHOOK_URL: process.env.DISCORD_WEBHOOK_URL || 'url'
});
