import pino from 'pino';

// 优先级：config.logLevel（由调用方传入） < 环境变量 LOG_LEVEL < 默认 info
const levelFromEnv = process.env.LOG_LEVEL || 'info';

// 在本地开发中使用 pretty 输出；在生产或未安装 pino-pretty 时仍可正常输出 JSON
const isPretty = process.env.PINO_PRETTY !== 'false';

let logger;
try {
  logger = pino({
    level: levelFromEnv,
    transport: isPretty ? {
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'SYS:standard',
        singleLine: false,
      }
    } : undefined,
  });
} catch (e) {
  // 当未安装 pretty transport 时回退到标准 JSON 输出
  logger = pino({ level: levelFromEnv });
}

export default logger;
