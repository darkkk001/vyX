import { createPublicKey, createVerify, generateKeyPairSync } from "node:crypto";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { manifestExecFields, signManifest, type ClientManifest } from "./client-builds";

const base: ClientManifest = { slug: "futurixglobal", apiHost: "futurixglobal.vyxtrader.com", app: "terminal", buildId: "b1", status: "ACTIVE", minVersion: "", iat: 1, exp: 2 };

function verify(sig: { manifest: string; signature: string }, pubPem: string): boolean {
  const v = createVerify("SHA256");
  v.update(Buffer.from(sig.manifest, "base64"));
  return v.verify({ key: createPublicKey(pubPem), dsaEncoding: "ieee-p1363" }, Buffer.from(sig.signature, "base64"));
}

describe("manifest exec fields (additive, signed)", () => {
  let pub = "";
  beforeAll(() => {
    const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    process.env.CLIENT_MANIFEST_PRIVATE_KEY = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    pub = publicKey.export({ type: "spki", format: "pem" }).toString();
  });
  afterEach(() => { delete process.env.CLIENT_MANIFEST_EXEC_HOST; });

  it("terminal gets execHost (default feed.vyxtrader.com) and brokerId", () => {
    expect(manifestExecFields("terminal", "br1")).toEqual({ execHost: "feed.vyxtrader.com", brokerId: "br1" });
  });
  it("other apps get nothing extra (old shape)", () => {
    expect(manifestExecFields("backoffice", "br1")).toEqual({});
    expect(manifestExecFields("bridge", "br1")).toEqual({});
  });
  it("env overrides the host; empty switches the field off", () => {
    process.env.CLIENT_MANIFEST_EXEC_HOST = "Feed2.Example.com";
    expect(manifestExecFields("terminal", "br1").execHost).toBe("feed2.example.com");
    process.env.CLIENT_MANIFEST_EXEC_HOST = "";
    expect(manifestExecFields("terminal", "br1")).toEqual({});
  });
  it("one signature covers the old-shape and the new-shape payload; the new fields are inside the signed bytes", () => {
    const oldS = signManifest(base);
    const newS = signManifest({ ...base, ...manifestExecFields("terminal", "br1") });
    expect(verify(oldS, pub)).toBe(true);
    expect(verify(newS, pub)).toBe(true);
    const json = JSON.parse(Buffer.from(newS.manifest, "base64").toString("utf8"));
    expect(json.execHost).toBe("feed.vyxtrader.com");
    expect(json.brokerId).toBe("br1");
    expect(JSON.parse(Buffer.from(oldS.manifest, "base64").toString("utf8")).execHost).toBeUndefined();
    // tampering with execHost breaks the signature
    const forged = Buffer.from(JSON.stringify({ ...json, execHost: "evil.example.com" })).toString("base64");
    expect(verify({ manifest: forged, signature: newS.signature }, pub)).toBe(false);
  });
});
