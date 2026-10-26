import { describe, expect, it } from "vitest";
import { createLocalConnector, MockConnector, OfficialIsvConnector } from "./connectors.js";

describe("connector boundaries", () => {
  it("keeps the mock connector isolated and marks uncertain results terminal", async () => {
    const connector = new MockConnector();
    expect(connector.available).toBe(true);
    await expect(connector.execute("PUBLISH_LISTING", { simulateUnknown: true })).resolves.toMatchObject({
      status: "RESULT_UNKNOWN",
      output: { connector: "MOCK" }
    });
  });

  it("keeps the official connector disabled instead of falling back to a private protocol", async () => {
    const connector = new OfficialIsvConnector();
    expect(connector.available).toBe(false);
    await expect(connector.execute("PUBLISH_LISTING", {})).rejects.toThrow(/禁止回退到闲鱼私有协议/);
    expect(() => createLocalConnector("PRIVATE_SIGNATURE_API")).toThrow(/不允许的本地连接器/);
  });
});
