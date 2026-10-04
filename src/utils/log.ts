import { blue, green, red, yellow, cyan, magenta, gray } from 'colorette';
import logSymbols from 'log-symbols';

export const logger = {
  info: (msg: string) => console.log(logSymbols.info, blue(msg)),
  success: (msg: string) => console.log(logSymbols.success, green(msg)),
  warn: (msg: string) => console.log(logSymbols.warning, yellow(msg)),
  error: (msg: string) => console.log(logSymbols.error, red(msg)),
  debug: (msg: string) => console.log(gray('→'), gray(msg)),
  step: (msg: string) => console.log(cyan('◆'), cyan(msg)),
  heading: (_msg: string) => console.log('\n' + magenta('━'.repeat(50))),
  
  // Custom emojis for Prelude-specific actions
  init: (msg: string) => console.log('🎯', blue(msg)),
  export: (msg: string) => console.log('📤', green(msg)),
  decision: (msg: string) => console.log('🧠', cyan(msg)),
  watch: (msg: string) => console.log('👀', yellow(msg)),
  scan: (msg: string) => console.log('🔍', blue(msg)),
  write: (msg: string) => console.log('✍️ ', green(msg))
};

export function logTable(data: Record<string, string | number | boolean>) {
  const maxKeyLength = Math.max(...Object.keys(data).map(k => k.length));
  
  console.log();
  for (const [key, value] of Object.entries(data)) {
    const paddedKey = key.padEnd(maxKeyLength);
    console.log(`  ${gray(paddedKey)} ${cyan('→')} ${value}`);
  }
  console.log();
}

export function spinner(text: string) {
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let i = 0;
  
  const interval = setInterval(() => {
    process.stdout.write(`\r${cyan(frames[i])} ${text}`);
    i = (i + 1) % frames.length;
  }, 80);
  
  return {
    stop: (finalText?: string) => {
      clearInterval(interval);
      process.stdout.write('\r');
      if (finalText) {
        logger.success(finalText);
      }
    }
  };
}