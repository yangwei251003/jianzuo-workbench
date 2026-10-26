import { describe, expect, it } from "vitest";
import { pendingReplyApprovals, pendingReplyBody } from "./inbox-approvals.js";

describe("Inbox reply approvals", () => {
  it("shows only real waiting reply actions for the selected conversation", () => {
    const actions = [
      { action_id: "wanted", action_type: "SEND_REPLY", connector: "MANAGED_BROWSER", status: "WAITING_APPROVAL", target_id: "conversation-1" },
      { action_id: "queued", action_type: "SEND_REPLY", connector: "MANAGED_BROWSER", status: "QUEUED", target_id: "conversation-1" },
      { action_id: "unknown", action_type: "SEND_REPLY", connector: "MANAGED_BROWSER", status: "RESULT_UNKNOWN", target_id: "conversation-1" },
      { action_id: "mock", action_type: "SEND_REPLY", connector: "MOCK", status: "WAITING_APPROVAL", target_id: "conversation-1" },
      { action_id: "other-conversation", action_type: "SEND_REPLY", connector: "MANAGED_BROWSER", status: "WAITING_APPROVAL", target_id: "conversation-2" },
      { action_id: "publication", action_type: "PUBLISH_LISTING", connector: "MANAGED_BROWSER", status: "WAITING_APPROVAL", target_id: "conversation-1" }
    ];

    expect(pendingReplyApprovals(actions, "conversation-1").map((action) => action.action_id)).toEqual(["wanted"]);
  });

  it("previews the approved reply body without exposing the remaining payload", () => {
    expect(pendingReplyBody({ payload_json: JSON.stringify({ body: "  可以，标准版今天可排期。  ", buyerMessage: "secret" }) }))
      .toBe("可以，标准版今天可排期。");
    expect(pendingReplyBody({ payload_json: "not-json" })).toContain("无法预览");
  });
});
