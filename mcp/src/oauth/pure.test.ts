import { createHash } from "node:crypto";
import { describe, expect, test } from "vitest";
import {
  authorizationServerMetadata,
  isAllowedRedirect,
  isCimdClientId,
  parseAuthorizeQuery,
  parseScope,
  protectedResourceMetadata,
  redirectWith,
  resourceMatches,
  validateCimdDocument,
  vendorOf,
  verifyPkce,
  wwwAuthenticate,
  ISSUER,
  RESOURCE,
} from "./pure";

const verifier = "v".repeat(50);
const challenge = createHash("sha256").update(verifier).digest("base64url");
const base = {
  response_type: "code",
  client_id: "https://chatgpt.com/oauth/client.json",
  redirect_uri: "https://chatgpt.com/connector/oauth/abc",
  state: "s1",
  code_challenge: challenge,
  code_challenge_method: "S256",
  resource: RESOURCE,
};

test("metadata advertises CIMD, S256, iss and points at our resource", () => {
  const as = authorizationServerMetadata();
  expect(as).toMatchObject({
    issuer: ISSUER,
    client_id_metadata_document_supported: true,
    code_challenge_methods_supported: ["S256"],
    authorization_response_iss_parameter_supported: true,
  });
  expect(protectedResourceMetadata()).toMatchObject({
    resource: RESOURCE,
    authorization_servers: [ISSUER],
  });
  expect(wwwAuthenticate()).toContain(
    'resource_metadata="https://your-firebase-project-id.web.app/.well-known/oauth-protected-resource/mcp"',
  );
});

test("PKCE S256 only matches the right verifier", () => {
  expect(verifyPkce(verifier, challenge)).toBe(true);
  expect(verifyPkce("w".repeat(50), challenge)).toBe(false);
  expect(verifyPkce("short", challenge)).toBe(false);
});

describe("redirect allowlist", () => {
  test.each([
    ["https://chatgpt.com/connector/oauth/x", true],
    ["https://claude.ai/api/mcp/auth_callback", true],
    ["https://CLAUDE.COM/cb", true],
    ["http://chatgpt.com/cb", false],
    ["https://chatgpt.com:8443/cb", false],
    ["https://evil.com/cb", false],
    ["https://chatgpt.com.evil.com/cb", false],
    ["https://user@chatgpt.com/cb", false],
    ["https://chatgpt.com/cb#x", false],
    ["javascript:alert(1)", false],
    [42, false],
  ])("%s -> %s", (uri, ok) => expect(isAllowedRedirect(uri)).toBe(ok));
});

test("CIMD client ids need https and a path", () => {
  expect(isCimdClientId("https://chatgpt.com/oauth/client.json")).toBe(true);
  expect(isCimdClientId("https://chatgpt.com/")).toBe(false);
  expect(isCimdClientId("http://chatgpt.com/x")).toBe(false);
});

test("scope always includes read, rejects unknown, ignores offline_access", () => {
  expect(parseScope(undefined)).toEqual(["receipts:read"]);
  expect(parseScope("receipts:organize")).toEqual([
    "receipts:read",
    "receipts:organize",
  ]);
  expect(parseScope("receipts:read offline_access")).toEqual(["receipts:read"]);
  expect(parseScope("admin")).toBeNull();
});

test("resource must be our MCP URL", () => {
  expect(resourceMatches(RESOURCE)).toBe(true);
  expect(resourceMatches("HTTPS://YOUR-FIREBASE-PROJECT-ID.WEB.APP/mcp/")).toBe(
    true,
  );
  expect(resourceMatches("https://evil.com/mcp")).toBe(false);
  expect(
    resourceMatches("https://your-firebase-project-id.web.app/other"),
  ).toBe(false);
});

describe("authorize query", () => {
  test("accepts a well-formed request", () => {
    expect(parseAuthorizeQuery(base)).toMatchObject({
      ok: true,
      value: { scopes: ["receipts:read"], state: "s1" },
    });
  });
  test("never redirects for a bad client or redirect", () => {
    expect(
      parseAuthorizeQuery({ ...base, redirect_uri: "https://evil.com/cb" }),
    ).toMatchObject({ ok: false, redirectable: false });
    expect(parseAuthorizeQuery({ ...base, client_id: "evil" })).toMatchObject({
      ok: false,
      redirectable: false,
    });
    expect(
      parseAuthorizeQuery({ ...base, client_id: ["a", "b"] }),
    ).toMatchObject({ ok: false, redirectable: false });
  });
  test("redirectable errors once the redirect is trusted", () => {
    expect(
      parseAuthorizeQuery({ ...base, code_challenge_method: "plain" }),
    ).toMatchObject({ ok: false, redirectable: true });
    expect(
      parseAuthorizeQuery({ ...base, response_type: "token" }),
    ).toMatchObject({ ok: false, error: "unsupported_response_type" });
    expect(
      parseAuthorizeQuery({ ...base, resource: "https://evil.com/mcp" }),
    ).toMatchObject({ ok: false, error: "invalid_target" });
  });
});

test("redirectWith adds iss and keeps existing query", () => {
  const u = new URL(
    redirectWith("https://chatgpt.com/cb?a=1", { code: "c", state: null }),
  );
  expect(u.searchParams.get("a")).toBe("1");
  expect(u.searchParams.get("code")).toBe("c");
  expect(u.searchParams.has("state")).toBe(false);
  expect(u.searchParams.get("iss")).toBe(ISSUER);
});

test("CIMD document must match client_id and list the exact redirect", () => {
  const id = base.client_id;
  const doc = {
    client_id: id,
    client_name: "ChatGPT",
    redirect_uris: [base.redirect_uri],
    token_endpoint_auth_method: "none",
  };
  expect(validateCimdDocument(doc, id, base.redirect_uri)).toEqual({
    ok: true,
    clientName: "ChatGPT",
  });
  expect(
    validateCimdDocument(
      { ...doc, client_id: "https://example.invalid/another-client" },
      id,
      base.redirect_uri,
    ),
  ).toMatchObject({ ok: false });
  expect(validateCimdDocument(doc, id, base.redirect_uri + "x")).toMatchObject({
    ok: false,
    reason: "redirect_not_listed",
  });
  expect(
    validateCimdDocument(
      { ...doc, token_endpoint_auth_method: "client_secret_basic" },
      id,
      base.redirect_uri,
    ),
  ).toMatchObject({ ok: false });
});

test("accepts the real ChatGPT CIMD (private_key_jwt preferred but none supported) (review M6)", () => {
  const id = "https://chatgpt.com/oauth/client.json";
  const redirect = "https://chatgpt.com/connector_platform_oauth_redirect";
  const doc = {
    client_id: id,
    client_name: "ChatGPT",
    redirect_uris: [redirect],
    token_endpoint_auth_method: "private_key_jwt",
    token_endpoint_auth_methods_supported: ["none", "private_key_jwt"],
  };
  expect(validateCimdDocument(doc, id, redirect)).toEqual({
    ok: true,
    clientName: "ChatGPT",
  });
  expect(
    validateCimdDocument(
      { ...doc, token_endpoint_auth_methods_supported: ["private_key_jwt"] },
      id,
      redirect,
    ),
  ).toMatchObject({ ok: false });
});

test("vendor is derived from the trusted redirect host", () => {
  expect(vendorOf("https://chatgpt.com/cb")).toBe("ChatGPT");
  expect(vendorOf("https://claude.ai/cb")).toBe("Claude");
});
