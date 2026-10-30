import pino from 'pino';
import { config } from './config';
export const logger = pino({ level: config.isTest ? 'silent' : config.logLevel, redact: ['req.headers.authorization', '*.password', '*.pin'] });
