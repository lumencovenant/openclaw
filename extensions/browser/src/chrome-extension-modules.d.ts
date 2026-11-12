declare module "*/chrome-extension/modules/strict-json.js" {
  // The browser asset validates keys but cannot express a TypeScript predicate.
  // Preserve the caller's type and add a string index for validated property access.
  // oxlint-disable-next-line typescript/no-explicit-any -- Untyped browser asset; callers own shape validation.
  export function hasExactKeys<T>(
    value: T,
    expected: readonly string[],
  ): value is T & Record<string, any>;
  // oxlint-disable-next-line typescript/no-explicit-any -- Untyped browser asset; callers own shape validation.
  export function parseStrictJsonObject(text: string): any;
}

declare module "*/chrome-extension/modules/relay-auth-v2-crypto.js" {
  export const RELAY_AUTH_LABEL: "openclaw.browser-relay.auth";
  export const RELAY_AUTH_VERSION: 2;

  export interface RelayAuthProofFields {
    keyId: string;
    instanceId: string;
    sessionId: string;
    clientNonce: string;
    serverNonce: string;
    issuedAtMs: number;
    expiresAtMs: number;
    role: string;
    transport: string;
    method: string;
    resource: string;
    flow: string;
  }

  export function canonicalRelayAuthProofBytes(
    proofKind: "server" | "client" | "accept",
    fields: RelayAuthProofFields,
    clientProof?: string,
  ): Uint8Array;
}
