import { describe, expect, it } from "vitest";
import { selectBrowserRootPid } from "./browser-launcher.js";

describe("browser launcher PID handoff", () => {
  it("prefers the live spawned root when it remains present", () => {
    expect(selectBrowserRootPid("1234\r\n5678\r\n", 5678)).toBe(5678);
  });

  it("uses the discovered profile root after Chromium hands off and exits the spawned PID", () => {
    expect(selectBrowserRootPid("4321\r\n", 9999)).toBe(4321);
  });

  it("falls back safely when process discovery returns no valid PID", () => {
    expect(selectBrowserRootPid("not-a-pid\r\n", 2468)).toBe(2468);
  });
});
