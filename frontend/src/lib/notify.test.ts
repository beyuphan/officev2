import { describe, expect, it, vi } from "vitest";
import { NOTICE, describeFailure, failed } from "./notify";

describe("notify", () => {
  it("writes what was being done and why it failed", () => {
    expect(describeFailure("Could not load the font list", new Error("HTTP 500"))).toBe("Could not load the font list: HTTP 500");
    expect(describeFailure("x", "plain text")).toBe("x: plain text");
  });
  it("sends a notice, except when the engine is down", () => {
    const seen: string[] = [];
    const listener = (e: Event) => seen.push((e as CustomEvent<{ text: string }>).detail.text);
    vi.stubGlobal("window", new EventTarget());
    window.addEventListener(NOTICE, listener);
    failed("Could not load X")(new Error("boom"));
    const down = new Error("The engine is not responding.");
    down.name = "EngineDown";
    failed("Could not load Y")(down);
    expect(seen).toEqual(["Could not load X: boom"]);
    vi.unstubAllGlobals();
  });
});
