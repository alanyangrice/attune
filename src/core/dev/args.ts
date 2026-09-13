// CLI arg helpers shared by the dev harnesses: --key=value and --flag.

export const argOf = (k: string): string | undefined =>
  process.argv.find((a) => a.startsWith(`--${k}=`))?.split("=").slice(1).join("=");

export const flag = (k: string): boolean => process.argv.includes(`--${k}`);
