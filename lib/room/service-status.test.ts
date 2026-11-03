import { describe, expect, it } from "vitest";
import { roomServiceStatus } from "./service-status";

describe("roomServiceStatus", () => {
  it("is ONLINE only when every check is OK", () => {
    expect(roomServiceStatus(["OK", "OK"])).toBe("ONLINE");
  });
  it("says AFFECTED when any check failed, even if another has no report", () => {
    expect(roomServiceStatus(["OK", "FAIL"])).toBe("AFFECTED");
    expect(roomServiceStatus(["NO_REPORT", "FAIL"])).toBe("AFFECTED");
  });
  it("claims nothing without a recent report", () => {
    expect(roomServiceStatus(["OK", "NO_REPORT"])).toBeNull();
    expect(roomServiceStatus(["NO_REPORT", "NO_REPORT"])).toBeNull();
    expect(roomServiceStatus([])).toBeNull();
  });
});
