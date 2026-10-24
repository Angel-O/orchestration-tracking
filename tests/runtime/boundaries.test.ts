import { expect, test } from "bun:test";
import type { LaunchSessionAPI } from "../../src/runtime/launch.js";
import type { ToolRegistrar } from "../../src/runtime/tools.js";

const launchHost: LaunchSessionAPI = { update: async () => undefined };
const toolHost: ToolRegistrar = {
  transform: async () => ({ dispose: () => undefined }),
};

test("runtime consumers own only their demonstrated host capabilities", () => {
  expect(Object.keys(launchHost)).toEqual(["update"]);
  expect(Object.keys(toolHost)).toEqual(["transform"]);
});
