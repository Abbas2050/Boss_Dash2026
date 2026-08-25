/**
 * CRM request configuration for the browser.
 *
 * There is deliberately NO token here, and none should ever be added.
 *
 * Browser code calls our own `/rest/*` proxy with no credential; server.js
 * attaches the CRM token upstream from `process.env.API_TOKEN`. Reading a token
 * in this layer would put it in the shipped bundle -- `VITE_API_TOKEN` used to,
 * and a build on 2026-08-21 found the value in 13 public files, 35 times over.
 *
 * Vite only exposes `VITE_`-prefixed variables to the browser, so a secret can
 * only reach this code by being marked publishable. That is the wrong marking
 * for a credential.
 */

/** CRM API version. Not a secret. The proxy fills this in if a request omits it. */
export const CRM_API_VERSION = "1.0.0";
