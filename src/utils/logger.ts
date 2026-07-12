import { logger as rootLogger } from './logger-core.js';

export const logger = {
  info(msg: any, meta?: any) {
    if (meta) {
      rootLogger.info(meta, String(msg));
    } else {
      rootLogger.info(msg);
    }
  },
  debug(msg: any, meta?: any) {
    if (meta) {
      rootLogger.debug(meta, String(msg));
    } else {
      rootLogger.debug(msg);
    }
  },
  warn(msg: any, meta?: any) {
    if (meta) {
      rootLogger.warn(meta, String(msg));
    } else {
      rootLogger.warn(msg);
    }
  },
  error(msg: any, meta?: any) {
    if (meta) {
      rootLogger.error(meta, String(msg));
    } else {
      rootLogger.error(msg);
    }
  },
  fatal(msg: any, meta?: any) {
    if (meta) {
      rootLogger.fatal(meta, String(msg));
    } else {
      rootLogger.fatal(msg);
    }
  }
};
export default logger;
