import { describe, expect, it } from "vitest";

import { SseFrameParser } from "@/lib/job-stream";

/**
 * The incremental SSE parser, against the frame shapes Atlas's `_write_sse` actually emits
 * (`id: <seq>\nevent: <type>\ndata: <json>\n\n`) and the chunk boundaries a network imposes.
 */
describe("SseFrameParser", () => {
  it("parses a complete Atlas-shaped frame", () => {
    const parser = new SseFrameParser();
    const frames = parser.push('id: 7\nevent: text\ndata: {"seq":7,"text":"hi"}\n\n');
    expect(frames).toEqual([{ id: "7", event: "text", data: '{"seq":7,"text":"hi"}' }]);
  });

  it("reassembles frames split at arbitrary chunk boundaries", () => {
    const parser = new SseFrameParser();
    const wire = 'id: 1\nevent: state\ndata: {"seq":1}\n\nid: 2\nevent: text\ndata: {"seq":2}\n\n';
    const frames = [];
    // Push one character at a time — the cruellest chunking a transport can produce.
    for (const char of wire) frames.push(...parser.push(char));
    expect(frames.map((frame) => frame.id)).toEqual(["1", "2"]);
    expect(frames.map((frame) => frame.event)).toEqual(["state", "text"]);
  });

  it("strips CR so CRLF framing parses identically", () => {
    const parser = new SseFrameParser();
    const frames = parser.push('id: 3\r\nevent: close\r\ndata: {"state":"failed"}\r\n\r\n');
    expect(frames).toEqual([{ id: "3", event: "close", data: '{"state":"failed"}' }]);
  });

  it("joins multi-line data with newlines", () => {
    const parser = new SseFrameParser();
    const frames = parser.push("data: one\ndata: two\n\n");
    expect(frames[0]?.data).toBe("one\ntwo");
  });

  it("ignores comment lines and unknown fields", () => {
    const parser = new SseFrameParser();
    const frames = parser.push(": keepalive comment\nretry: 100\nid: 4\ndata: {}\n\n");
    expect(frames).toEqual([{ id: "4", event: "message", data: "{}" }]);
    expect(parser.takeTransportSignals()).toEqual({ activity: true, retryMs: 100 });
  });

  it("reports comment-only activity without inventing a frame and bounds retry hints", () => {
    const parser = new SseFrameParser();
    expect(parser.push(": keepalive\n\n")).toEqual([]);
    expect(parser.takeTransportSignals()).toEqual({ activity: true, retryMs: null });

    parser.push("retry: 0\nretry: 3600001\nretry: 2500\n\n");
    expect(parser.takeTransportSignals()).toEqual({ activity: true, retryMs: 2500 });
    expect(parser.takeTransportSignals()).toEqual({ activity: false, retryMs: null });
  });

  it("defaults the event name to message and yields nothing for a data-less frame", () => {
    const parser = new SseFrameParser();
    expect(parser.push("event: ping\n\n")).toEqual([]);
    expect(parser.push("data: x\n\n")).toEqual([{ id: null, event: "message", data: "x" }]);
  });

  it("holds an unterminated frame until its blank line arrives", () => {
    const parser = new SseFrameParser();
    expect(parser.push('id: 9\ndata: {"seq":9}\n')).toEqual([]);
    expect(parser.push("\n")).toEqual([{ id: "9", event: "message", data: '{"seq":9}' }]);
  });
});
