export const quoteShellArgument = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;

/**
 * Run a command through the device user's interactive login shell.
 *
 * Developer tools are commonly added to PATH by .bashrc/.zshrc, nvm, or
 * Conda. SSH commands and packaged GUI apps do not inherit that environment,
 * so managed terminal tools must resolve and launch in the same shell context
 * that users see in a normal terminal.
 */
export function interactiveLoginShellCommand(command: string): string {
  return `exec "\${SHELL:-/bin/sh}" -lic ${quoteShellArgument(command)}`;
}
