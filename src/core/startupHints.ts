import { existsSync } from 'node:fs';

/**
 * #76: run by `npx` inside a container, every fresh container installs the package before the server
 * can answer (60-90 s). Under the Docker MCP gateway that is every client connection with
 * `longLived`, and every tool call without it, which outlasts the client's ~60 s tool timeout. The
 * server can't see the gateway's `longLived` setting, so it warns on the part it can see: an npx
 * install path (`.../_npx/<hash>/...`) inside a container (`/.dockerenv`). One stderr line, shown in
 * `docker logs` for the gateway.
 */
export function npxInContainerWarning(
  scriptPath: string = process.argv[1] ?? '',
  inContainer: boolean = existsSync('/.dockerenv'),
): string | null {
  if (!inContainer || !/[\\/]_npx[\\/]/.test(scriptPath)) return null;
  return 'warning: started by npx inside a container, so every new worker container installs the package first (60-90 s, longer than most clients wait for a tool call). '
    + 'Under the Docker MCP gateway, use an image with the package preinstalled and keep longLived: true: see the README, "Docker and the Docker MCP gateway" (#76).';
}
