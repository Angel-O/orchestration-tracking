import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Creates the injected executable used by runtime-path tests; it never contacts a live Hub. */
export function fakeWbd(directory: string, output: string, status = 0): void {
  const command = join(directory, "wbd");
  writeFileSync(command, `#!/bin/sh\nprintf '%s' '${output}'\nexit ${status}\n`);
  chmodSync(command, 0o700);
}
